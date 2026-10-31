const mongoose = require('mongoose');
const { Appointment, DoctorShift, User, Specialty } = require('../models');
const { ROLES } = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const { clock } = require('./clock.service');
const { toClinicDateString, DEFAULT_TIMEZONE } = require('../utils/timezone');

/**
 * Validate ISO date string "YYYY-MM-DD"
 */
function isValidDateString(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str);
  return !Number.isNaN(d.getTime());
}

/**
 * Truncate reason string if longer than maxLength
 */
function truncateReason(reason, maxLength = 100) {
  if (!reason || typeof reason !== 'string') return null;
  const clean = reason.trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

/**
 * Sanitize appointment item for operational schedule view:
 * Minimal PII: patientName, appointmentTime, doctorName, doctorId, type (ONLINE/OFFLINE), status, reason (truncated).
 * STRICTLY EXCLUDES: prescriptions, medical history, passwords/passwordHash, full PII documents.
 */
function sanitizeAppointmentItem(appt, patientMap = new Map(), doctorMap = new Map(), specialtyMap = new Map()) {
  const patient = patientMap.get(appt.patientId);
  const doctor = doctorMap.get(appt.doctorId);
  const specialty = specialtyMap.get(appt.specialtyId);

  // Patient name derivation (from snapshot patients or user fullName)
  let patientName = '—';
  if (Array.isArray(appt.patients) && appt.patients.length > 0 && appt.patients[0].fullName) {
    patientName = appt.patients[0].fullName;
  } else if (patient?.fullName) {
    patientName = patient.fullName;
  }

  return {
    id: appt.id ?? appt._id,
    appointmentNo: appt.appointmentNo,
    appointmentDate: appt.appointmentDate,
    appointmentTime: appt.appointmentTime,
    patientName,
    doctorName: doctor?.fullName || '—',
    doctorId: appt.doctorId,
    specialtyName: specialty?.name || '—',
    specialtyId: appt.specialtyId,
    shiftId: appt.shiftId,
    type: appt.type || 'OFFLINE',
    status: appt.status,
    reason: truncateReason(appt.reason, 100),
    checkedIn: Boolean(appt.checkedIn),
    checkedInAt: appt.checkedInAt ? appt.checkedInAt.toISOString() : null,
    confirmedAt: appt.confirmedAt ? appt.confirmedAt.toISOString() : null,
    createdAt: appt.createdAt ? appt.createdAt.toISOString() : null,
  };
}

/**
 * Format doctor shift for operational schedule view
 */
function sanitizeShiftItem(shift, doctorMap = new Map(), specialtyMap = new Map()) {
  const doctor = doctorMap.get(shift.doctorId);
  const specialty = doctor?.specialtyId ? specialtyMap.get(doctor.specialtyId) : null;
  const slots = Array.isArray(shift.slots) ? shift.slots : [];
  const availableSlots = slots.filter((s) => s.status === 'AVAILABLE').length;

  return {
    id: shift.id ?? shift._id,
    date: shift.date,
    shiftDate: shift.date,
    shift: shift.shift,
    shiftType: shift.shift,
    startTime: shift.startTime,
    endTime: shift.endTime,
    doctorId: shift.doctorId,
    doctorName: doctor?.fullName || '—',
    specialtyId: doctor?.specialtyId || null,
    specialtyName: specialty?.name || '—',
    status: shift.status,
    availableSlots,
    maxPatients: shift.maxPatients,
    slots: slots.map((s) => ({
      id: s.id,
      slotNumber: s.slotNumber,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      bookingRef: s.bookingRef || null,
    })),
  };
}

/**
 * Validate date range (maximum 31 days)
 */
function resolveDateRange(query) {
  const defaultToday = clock.today();

  let startDate = query.startDate || query.from || query.date;
  let endDate = query.endDate || query.to || query.date;

  if (!startDate && !endDate) {
    startDate = defaultToday;
    endDate = defaultToday;
  } else if (startDate && !endDate) {
    endDate = startDate;
  } else if (!startDate && endDate) {
    startDate = endDate;
  }

  if (!isValidDateString(startDate)) {
    throw new ApiError(400, `Ngày bắt đầu không hợp lệ (YYYY-MM-DD): ${startDate}`, 'INVALID_START_DATE');
  }
  if (!isValidDateString(endDate)) {
    throw new ApiError(400, `Ngày kết thúc không hợp lệ (YYYY-MM-DD): ${endDate}`, 'INVALID_END_DATE');
  }

  if (startDate > endDate) {
    throw new ApiError(400, 'Ngày bắt đầu không được lớn hơn ngày kết thúc', 'INVALID_DATE_RANGE');
  }

  // Calculate day difference
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const diffDays = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24)) + 1;

  if (diffDays > 31) {
    throw new ApiError(400, `Khoảng thời gian tra cứu tối đa là 31 ngày (yêu cầu: ${diffDays} ngày)`, 'DATE_RANGE_EXCEEDED');
  }

  return { startDate, endDate, isSingleDate: startDate === endDate };
}

/**
 * UC-REC-02: Lễ tân / Admin xem lịch vận hành (Appointments + Shifts).
 *
 * Requirements:
 * - Role: RECEPTIONIST, ADMIN
 * - Filters: date / startDate + endDate (max 31 days -> 400), doctorId, status
 * - Pagination: page, limit (default 20, max 100)
 * - Sort: by appointmentDate ASC, appointmentTime ASC
 * - Minimal PII: patientName, appointmentTime, doctorName, doctorId, type (ONLINE/OFFLINE), status, reason (truncated).
 * - Indexed queries on doctorId + appointmentDate + status
 */
async function getOperationalSchedule(actor, query = {}) {
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role ?? actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ lễ tân hoặc quản trị viên mới có quyền xem lịch vận hành', 'FORBIDDEN_ROLE');
  }

  const { startDate, endDate } = resolveDateRange(query);

  // Pagination bounds: default 20, max 100
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const skip = (page - 1) * limit;

  // Build filter for Appointment
  const apptFilter = {};
  if (startDate === endDate) {
    apptFilter.appointmentDate = startDate;
  } else {
    apptFilter.appointmentDate = { $gte: startDate, $lte: endDate };
  }

  if (query.doctorId !== undefined && query.doctorId !== '') {
    const numDoctorId = Number(query.doctorId);
    apptFilter.doctorId = Number.isSafeInteger(numDoctorId) ? numDoctorId : query.doctorId;
  }

  if (query.status && query.status !== 'ALL') {
    // Support comma-separated or single status, e.g. "CONFIRMED,CHECKED_IN"
    const statuses = String(query.status)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (statuses.length === 1) {
      apptFilter.status = statuses[0];
    } else if (statuses.length > 1) {
      apptFilter.status = { $in: statuses };
    }
  }

  // Execute indexed appointment queries: sort by date ASC, time ASC
  const [appointments, totalAppointments] = await Promise.all([
    Appointment.find(apptFilter)
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Appointment.countDocuments(apptFilter),
  ]);

  // Build filter for DoctorShift of the same date range & doctorId
  const shiftFilter = {};
  if (startDate === endDate) {
    shiftFilter.date = startDate;
  } else {
    shiftFilter.date = { $gte: startDate, $lte: endDate };
  }
  if (apptFilter.doctorId) {
    shiftFilter.doctorId = apptFilter.doctorId;
  }

  const shifts = await DoctorShift.find(shiftFilter)
    .sort({ date: 1, startTime: 1 })
    .lean();

  // Load referenced Patients, Doctors, and Specialties in batches
  const patientIds = [...new Set(appointments.map((a) => a.patientId).filter(Boolean))];
  const doctorIds = [
    ...new Set([
      ...appointments.map((a) => a.doctorId).filter(Boolean),
      ...shifts.map((s) => s.doctorId).filter(Boolean),
    ]),
  ];

  const [patients, doctors, specialties] = await Promise.all([
    User.find({ id: { $in: patientIds } }, 'id fullName email phoneNumber').lean(),
    User.find({ id: { $in: doctorIds } }, 'id fullName email specialtyId').lean(),
    Specialty.find({}, 'id name').lean(),
  ]);

  const patientMap = new Map(patients.map((p) => [p.id, p]));
  const doctorMap = new Map(doctors.map((d) => [d.id, d]));
  const specialtyMap = new Map(specialties.map((s) => [s.id, s]));

  const sanitizedAppointments = appointments.map((a) =>
    sanitizeAppointmentItem(a, patientMap, doctorMap, specialtyMap),
  );

  const sanitizedShifts = shifts.map((s) =>
    sanitizeShiftItem(s, doctorMap, specialtyMap),
  );

  return {
    appointments: sanitizedAppointments,
    shifts: sanitizedShifts,
    pagination: {
      page,
      limit,
      total: totalAppointments,
      totalPages: Math.ceil(totalAppointments / limit) || 1,
    },
    filter: {
      startDate,
      endDate,
      doctorId: apptFilter.doctorId || null,
      status: query.status || null,
    },
  };
}

/**
 * Helper for Frontend backward compatibility:
 * GET /appointments/by-date?date=YYYY-MM-DD
 * Returns flat array of normalized appointments
 */
async function getAppointmentsByDate(actor, query = {}) {
  const result = await getOperationalSchedule(actor, query);
  return result.appointments;
}

/**
 * Helper for Frontend backward compatibility:
 * GET /shifts/by-date?date=YYYY-MM-DD
 * Returns flat array of doctor shifts
 */
async function getShiftsByDate(actor, query = {}) {
  const result = await getOperationalSchedule(actor, query);
  return result.shifts;
}

/**
 * Helper for Frontend backward compatibility:
 * GET /appointments/by-shift/:shiftId
 * Returns flat array of normalized appointments for a specific shift
 */
async function getAppointmentsByShift(actor, shiftId) {
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role ?? actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ lễ tân hoặc quản trị viên mới có quyền xem lịch hẹn theo ca', 'FORBIDDEN_ROLE');
  }

  const numShiftId = Number(shiftId);
  const matchShiftId = Number.isSafeInteger(numShiftId) ? numShiftId : shiftId;

  const appointments = await Appointment.find({ shiftId: matchShiftId })
    .sort({ appointmentDate: 1, appointmentTime: 1 })
    .lean();

  const patientIds = [...new Set(appointments.map((a) => a.patientId).filter(Boolean))];
  const doctorIds = [...new Set(appointments.map((a) => a.doctorId).filter(Boolean))];

  const [patients, doctors, specialties] = await Promise.all([
    User.find({ id: { $in: patientIds } }, 'id fullName email phoneNumber').lean(),
    User.find({ id: { $in: doctorIds } }, 'id fullName email specialtyId').lean(),
    Specialty.find({}, 'id name').lean(),
  ]);

  const patientMap = new Map(patients.map((p) => [p.id, p]));
  const doctorMap = new Map(doctors.map((d) => [d.id, d]));
  const specialtyMap = new Map(specialties.map((s) => [s.id, s]));

  return appointments.map((a) => sanitizeAppointmentItem(a, patientMap, doctorMap, specialtyMap));
}

module.exports = {
  getOperationalSchedule,
  getAppointmentsByDate,
  getAppointmentsByShift,
  getShiftsByDate,
  resolveDateRange,
  sanitizeAppointmentItem,
  sanitizeShiftItem,
};

