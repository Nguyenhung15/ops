const {
  DoctorShift,
  User,
  Specialty,
  Appointment,
  getNextSequence,
} = require('../models');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { ROLES, AUDIT_ACTIONS, ACTIVE_APPOINTMENT_STATUSES } = require('../constants/enums');
const { recordAudit, buildAuditDiff, sanitizeSnapshot } = require('./audit.service');
const { parsePositiveInt } = require('../utils/normalizers');

const SHIFT_TIMES = {
  MORNING: { startTime: '08:00', endTime: '12:00' },
  AFTERNOON: { startTime: '13:00', endTime: '17:00' },
  EVENING: { startTime: '18:00', endTime: '21:00' },
};
const SLOT_DURATION_MINUTES = 45;
const BUFFER_MINUTES = 15;

const today = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: env.clinicTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const currentTime = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: env.clinicTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());

const validDate = (date) =>
  typeof date === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
  new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

const addDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const minutes = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const formatTime = (value) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

const buildSlots = (start, end, maxPatients) => {
  const slots = [];
  for (
    let value = minutes(start);
    value + SLOT_DURATION_MINUTES <= minutes(end) && slots.length < maxPatients;
    value += SLOT_DURATION_MINUTES + BUFFER_MINUTES
  ) {
    slots.push({
      id: null,
      slotNumber: slots.length + 1,
      startTime: formatTime(value),
      endTime: formatTime(value + SLOT_DURATION_MINUTES),
      status: 'AVAILABLE',
    });
  }
  if (!slots.length) throw new ApiError(400, 'Shift is too short to contain an appointment slot');
  return slots;
};

const serialize = (shift, doctor) => ({
  id: shift.id,
  doctorId: shift.doctorId,
  doctorName: doctor?.fullName,
  date: shift.date,
  shift: shift.shift,
  shiftType: shift.shift,
  startTime: shift.startTime,
  endTime: shift.endTime,
  maxPatients: shift.maxPatients,
  note: shift.note,
  repeatWeekly: shift.repeatWeekly,
  repeatCount: shift.repeatCount,
  status: shift.status,
  availableSlots: Array.isArray(shift.slots)
    ? shift.slots.filter((slot) => slot.status === 'AVAILABLE').length
    : 0,
  slots: Array.isArray(shift.slots)
    ? shift.slots.map((slot) => ({ ...(slot.toObject?.() || slot), slotStatus: slot.status }))
    : [],
});

/**
 * UC-ADM-04 & Doctor Self-service: Create shift(s) with automatic slot generation & weekly repeats.
 */
const createShift = async (actor, payload, req) => {
  if (!actor || ![ROLES.ADMIN, ROLES.DOCTOR].includes(actor.userType)) {
    throw new ApiError(403, 'Chỉ Bác sĩ hoặc Quản trị viên mới có quyền tạo ca trực');
  }

  let doctorId;
  if (actor.userType === ROLES.ADMIN) {
    if (!payload?.doctorId) {
      throw new ApiError(400, 'Admin tạo ca trực bắt buộc phải cung cấp doctorId');
    }
    doctorId = parsePositiveInt(payload.doctorId, 'doctorId');
  } else {
    doctorId = actor.id;
  }

  const doctor = await User.findOne({ id: doctorId, userType: ROLES.DOCTOR });
  if (!doctor) {
    throw new ApiError(404, `Không tìm thấy bác sĩ với ID #${doctorId}`);
  }
  if (!doctor.isEnable) {
    throw new ApiError(400, `Bác sĩ ${doctor.fullName} hiện đang bị khóa tài khoản`);
  }

  const date = payload?.date;
  const shiftType = payload?.shift;
  const maxPatients = payload?.maxPatients === undefined ? 10 : Number(payload.maxPatients);
  const repeatWeekly = payload?.repeatWeekly === undefined ? false : Boolean(payload.repeatWeekly);
  const repeatCount = payload?.repeatCount === undefined ? 0 : Number(payload.repeatCount);
  const note = payload?.note == null ? '' : String(payload.note);

  if (!validDate(date)) throw new ApiError(400, 'date must be a valid YYYY-MM-DD date');
  if (date < today()) throw new ApiError(400, 'Cannot create a shift in the past');
  if (!SHIFT_TIMES[shiftType]) throw new ApiError(400, 'shift must be MORNING, AFTERNOON, or EVENING');
  if (date === today() && SHIFT_TIMES[shiftType].startTime <= currentTime()) {
    throw new ApiError(400, 'Cannot create a shift that has already started');
  }
  if (!Number.isInteger(maxPatients) || maxPatients < 1 || maxPatients > 100) {
    throw new ApiError(400, 'maxPatients must be an integer between 1 and 100');
  }
  if (typeof note !== 'string' || note.length > 255) {
    throw new ApiError(400, 'note must be a string of at most 255 characters');
  }
  if (!Number.isInteger(repeatCount) || repeatCount < 0 || repeatCount > 3) {
    throw new ApiError(400, 'Invalid weekly repeat settings');
  }

  const dates = Array.from(
    { length: repeatWeekly ? repeatCount + 1 : 1 },
    (_, index) => addDays(date, index * 7),
  );

  // Conflict check: Check existing active shifts for this doctor on primary date
  const primaryConflict = await DoctorShift.findOne({
    doctorId: doctor.id,
    date,
    shift: shiftType,
    status: { $ne: 'CANCELLED' },
  }).lean();

  if (primaryConflict) {
    throw new ApiError(
      409,
      `Bác sĩ ${doctor.fullName} đã có ca trực (${primaryConflict.shift}) vào ngày ${primaryConflict.date}`,
    );
  }

  // Find all existing shifts across the repeat dates to skip duplicate repeating weeks
  const existingShifts = await DoctorShift.find({
    doctorId: doctor.id,
    date: { $in: dates },
    shift: shiftType,
    status: { $ne: 'CANCELLED' },
  }).lean();
  const existingDateSet = new Set(existingShifts.map((s) => s.date));

  const time = SHIFT_TIMES[shiftType];
  const created = [];

  for (const [index, shiftDate] of dates.entries()) {
    // If repeat date is already registered, skip it per BACKEND_AGENT_GUIDE.md line 152
    if (index > 0 && existingDateSet.has(shiftDate)) {
      continue;
    }

    const slots = buildSlots(time.startTime, time.endTime, maxPatients);
    for (const slot of slots) slot.id = await getNextSequence('shift_slots');

    const shift = await DoctorShift.create({
      doctorId: doctor.id,
      date: shiftDate,
      shift: shiftType,
      startTime: time.startTime,
      endTime: time.endTime,
      slotDurationMinutes: SLOT_DURATION_MINUTES,
      bufferMinutes: BUFFER_MINUTES,
      maxPatients,
      note: note.trim(),
      repeatWeekly: index === 0 && repeatWeekly,
      repeatCount: index === 0 ? repeatCount : 0,
      status: 'ACTIVE',
      slots,
    });

    if (actor) {
      await recordAudit({
        actor,
        action: AUDIT_ACTIONS.SHIFT_CREATE,
        targetType: 'DoctorShift',
        targetId: shift.id,
        reason:
          actor.userType === ROLES.ADMIN
            ? `Admin xếp ca trực cho bác sĩ #${doctor.id} (${doctor.fullName})`
            : `Bác sĩ tự đăng ký ca trực`,
        changes: { after: sanitizeSnapshot(shift) },
        req,
      });
    }

    created.push(serialize(shift, doctor));
  }

  return created;
};

/**
 * Doctor-specific shift retrieval.
 */
const getMyShifts = async (doctor, week, date) => {
  const query = { doctorId: doctor.id };
  if (date !== undefined) {
    if (!validDate(date)) throw new ApiError(400, 'date must be a valid YYYY-MM-DD date');
    query.date = date;
  }
  if (week === 'current' || week === 'next') {
    const current = today();
    const d = new Date(`${current}T00:00:00Z`).getUTCDay();
    let start = addDays(current, -((d + 6) % 7));
    if (week === 'next') start = addDays(start, 7);
    query.date = { $gte: start, $lte: addDays(start, 6) };
  } else if (week !== undefined) throw new ApiError(400, 'week must be current or next');
  if (date !== undefined && week !== undefined) throw new ApiError(400, 'Use either date or week, not both');
  return (await DoctorShift.find(query).sort({ date: 1, startTime: 1 }).lean()).map((shift) =>
    serialize(shift, doctor),
  );
};

/**
 * UC-ADM-04: Admin view weekly schedule across all doctors.
 * Frontend calls `GET /api/shifts/admin/week?start=YYYY-MM-DD&end=YYYY-MM-DD`.
 */
const getShiftsInWeek = async (startISO, endISO, options = {}) => {
  if (!startISO || !endISO) {
    const todayDate = new Date();
    const day = todayDate.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const mon = new Date(todayDate);
    mon.setDate(todayDate.getDate() + diff);
    startISO = mon.toISOString().slice(0, 10);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    endISO = sun.toISOString().slice(0, 10);
  } else {
    if (!validDate(startISO) || !validDate(endISO)) {
      throw new ApiError(400, 'start and end must be valid YYYY-MM-DD dates');
    }
    if (startISO > endISO) {
      throw new ApiError(400, 'start date cannot be after end date');
    }
  }

  const query = {
    date: { $gte: startISO, $lte: endISO },
  };

  const shifts = await DoctorShift.find(query).sort({ date: 1, startTime: 1 }).lean();
  if (shifts.length === 0) return [];

  // Batch-fetch doctors and specialties to avoid N+1 queries
  const doctorIds = [...new Set(shifts.map((s) => s.doctorId))];
  const doctors = await User.find({ id: { $in: doctorIds } }).lean();
  const specialtyIds = [...new Set(doctors.map((d) => d.specialtyId).filter(Boolean))];
  const specialties = await Specialty.find({ id: { $in: specialtyIds } }).lean();

  const specialtyMap = new Map(specialties.map((s) => [s.id, s.name]));
  const doctorMap = new Map(
    doctors.map((d) => [
      d.id,
      {
        fullName: d.fullName,
        specialtyId: d.specialtyId,
        specialtyName: d.specialtyId ? specialtyMap.get(d.specialtyId) || '' : '',
      },
    ]),
  );

  let results = shifts.map((shift) => {
    const docInfo = doctorMap.get(shift.doctorId);
    const slots = Array.isArray(shift.slots) ? shift.slots : [];
    const availableSlots = slots.filter((s) => s.status === 'AVAILABLE').length;
    const bookedSlots = slots.filter((s) => s.status === 'BOOKED').length;

    return {
      id: shift.id,
      date: shift.date,
      shiftType: shift.shift,
      shift: shift.shift,
      doctorId: shift.doctorId,
      doctorName: docInfo?.fullName || 'Bác sĩ',
      specialtyId: docInfo?.specialtyId || null,
      specialtyName: docInfo?.specialtyName || '',
      startTime: shift.startTime,
      endTime: shift.endTime,
      maxPatients: shift.maxPatients,
      availableSlots,
      bookedSlots,
      status: shift.status,
    };
  });

  if (options.specialtyId) {
    const targetSpecId = parsePositiveInt(options.specialtyId, 'specialtyId');
    results = results.filter((r) => r.specialtyId === targetSpecId);
  }

  return results;
};

/**
 * UC-ADM-04: Adjust a shift's capacity, note, or status.
 * Hard constraint: MUST NOT break/delete already booked slots!
 */
const adjustShift = async (actor, shiftId, payload, req) => {
  if (!actor || ![ROLES.ADMIN, ROLES.DOCTOR].includes(actor.userType)) {
    throw new ApiError(403, 'Chỉ Quản trị viên hoặc Bác sĩ mới có quyền điều chỉnh ca trực');
  }

  const id = parsePositiveInt(shiftId, 'shiftId');
  const shift = await DoctorShift.findOne({ id });
  if (!shift) {
    throw new ApiError(404, `Không tìm thấy ca trực với ID #${id}`);
  }

  // Doctor can only adjust their own shift
  if (actor.userType === ROLES.DOCTOR && shift.doctorId !== actor.id) {
    throw new ApiError(403, 'Bác sĩ chỉ có quyền điều chỉnh ca trực của chính mình');
  }

  const beforeSnap = sanitizeSnapshot(shift);

  // Active appointments inspection
  const bookedAppointments = await Appointment.find({
    shiftId: shift.id,
    status: { $in: ACTIVE_APPOINTMENT_STATUSES },
  }).lean();

  const bookedSlotIds = new Set(bookedAppointments.flatMap((a) => a.slotIds || []));

  // 1. Note update
  if (payload?.note !== undefined) {
    const trimmedNote = String(payload.note).trim();
    if (trimmedNote.length > 255) {
      throw new ApiError(400, 'note không được vượt quá 255 ký tự');
    }
    shift.note = trimmedNote;
  }

  // 2. Capacity adjustment (maxPatients)
  // Hard constraint: Cannot reduce capacity below already booked slots
  if (payload?.maxPatients !== undefined) {
    const newMax = Number(payload.maxPatients);
    if (!Number.isInteger(newMax) || newMax < 1 || newMax > 100) {
      throw new ApiError(400, 'maxPatients phải là số nguyên từ 1 đến 100');
    }

    if (newMax < bookedSlotIds.size) {
      throw new ApiError(
        409,
        `Không thể giảm số lượng bệnh nhân xuống ${newMax} vì ca trực đã có ` +
          `${bookedSlotIds.size} slot đã được bệnh nhân đặt khám.`,
      );
    }

    shift.maxPatients = newMax;

    // Adjust slots array preserving all existing booked slots
    const currentSlots = shift.slots || [];
    if (newMax > currentSlots.length) {
      // Add more slots if time allows
      const time = SHIFT_TIMES[shift.shift];
      const maxPossibleSlots = buildSlots(time.startTime, time.endTime, newMax);
      for (let i = currentSlots.length; i < maxPossibleSlots.length; i++) {
        const slotData = maxPossibleSlots[i];
        slotData.id = await getNextSequence('shift_slots');
        shift.slots.push(slotData);
      }
    } else if (newMax < currentSlots.length) {
      // Shrink available slots from the end, ensuring none of removed slots are booked
      const kept = [];
      let removableNeeded = currentSlots.length - newMax;
      for (let i = currentSlots.length - 1; i >= 0; i--) {
        const slot = currentSlots[i];
        if (slot.status === 'AVAILABLE' && !bookedSlotIds.has(slot.id) && removableNeeded > 0) {
          removableNeeded -= 1;
        } else {
          kept.unshift(slot);
        }
      }
      shift.slots = kept;
    }
  }

  // 3. Status adjustment
  if (payload?.status !== undefined) {
    const nextStatus = String(payload.status).toUpperCase();
    if (!['ACTIVE', 'CANCELLED', 'GROUP_BLOCKED'].includes(nextStatus)) {
      throw new ApiError(400, 'status phải là ACTIVE, CANCELLED hoặc GROUP_BLOCKED');
    }

    if (nextStatus === 'GROUP_BLOCKED' && bookedSlotIds.size > 0) {
      throw new ApiError(
        409,
        `Không thể chuyển ca trực sang khám đoàn (GROUP_BLOCKED) vì đã có ` +
          `${bookedSlotIds.size} lịch hẹn cá nhân được đặt trước.`,
      );
    }

    shift.status = nextStatus;
  }

  await shift.save();

  const doctor = await User.findOne({ id: shift.doctorId }).lean();

  if (actor) {
    const isCancelled = shift.status === 'CANCELLED';
    await recordAudit({
      actor,
      action: isCancelled ? AUDIT_ACTIONS.SHIFT_CANCEL : AUDIT_ACTIONS.SHIFT_UPDATE,
      targetType: 'DoctorShift',
      targetId: shift.id,
      reason: payload?.reason || `Điều chỉnh ca trực #${shift.id}`,
      changes: buildAuditDiff(beforeSnap, shift),
      req,
    });
  }

  return serialize(shift, doctor);
};

/**
 * Detailed shift inspection including slots & linked appointments.
 */
const getShiftDetailWithBookings = async (shiftId) => {
  const id = parsePositiveInt(shiftId, 'shiftId');
  const shift = await DoctorShift.findOne({ id }).lean();
  if (!shift) {
    throw new ApiError(404, `Không tìm thấy ca trực với ID #${id}`);
  }

  const [doctor, appointments] = await Promise.all([
    User.findOne({ id: shift.doctorId }).lean(),
    Appointment.find({ shiftId: shift.id }).sort({ appointmentTime: 1 }).lean(),
  ]);

  let specialtyName = '';
  if (doctor?.specialtyId) {
    const spec = await Specialty.findOne({ id: doctor.specialtyId }).lean();
    if (spec) specialtyName = spec.name;
  }

  const slots = Array.isArray(shift.slots) ? shift.slots : [];
  const availableSlots = slots.filter((s) => s.status === 'AVAILABLE').length;
  const bookedSlots = slots.filter((s) => s.status === 'BOOKED').length;

  return {
    id: shift.id,
    date: shift.date,
    shift: shift.shift,
    shiftType: shift.shift,
    startTime: shift.startTime,
    endTime: shift.endTime,
    maxPatients: shift.maxPatients,
    note: shift.note || '',
    status: shift.status,
    doctorId: shift.doctorId,
    doctorName: doctor?.fullName || 'Bác sĩ',
    specialtyName,
    availableSlots,
    bookedSlots,
    slots,
    appointments: appointments.map((a) => ({
      id: a.id,
      appointmentNo: a.appointmentNo,
      patientId: a.patientId,
      patientName: a.patients?.[0]?.fullName || 'N/A',
      appointmentTime: a.appointmentTime,
      type: a.type,
      status: a.status,
      slotIds: a.slotIds,
    })),
  };
};

/**
 * Fetch all shifts for a specific date (used by Receptionist & Admin).
 */
const getAllShiftsByDate = async (dateParam) => {
  if (!validDate(dateParam)) {
    throw new ApiError(400, 'date must be a valid YYYY-MM-DD date');
  }

  const shifts = await DoctorShift.find({ date: dateParam }).sort({ startTime: 1 }).lean();
  if (shifts.length === 0) return [];

  const doctorIds = [...new Set(shifts.map((s) => s.doctorId))];
  const doctors = await User.find({ id: { $in: doctorIds } }).lean();
  const specialtyIds = [...new Set(doctors.map((d) => d.specialtyId).filter(Boolean))];
  const specialties = await Specialty.find({ id: { $in: specialtyIds } }).lean();

  const specialtyMap = new Map(specialties.map((s) => [s.id, s.name]));
  const doctorMap = new Map(
    doctors.map((d) => [
      d.id,
      {
        fullName: d.fullName,
        specialtyName: d.specialtyId ? specialtyMap.get(d.specialtyId) || '' : '',
      },
    ]),
  );

  return shifts.map((shift) => {
    const docInfo = doctorMap.get(shift.doctorId);
    return {
      ...serialize(shift, { fullName: docInfo?.fullName }),
      doctorName: docInfo?.fullName || 'Bác sĩ',
      specialtyName: docInfo?.specialtyName || '',
    };
  });
};

/**
 * UC-ADM-04: Delete shift.
 * Hard constraint: Cannot delete if active appointments are booked.
 */
const deleteShift = async (actor, shiftId, req) => {
  if (!actor || actor.userType !== ROLES.ADMIN) {
    throw new ApiError(403, 'Chỉ Quản trị viên mới có quyền xóa ca trực');
  }

  const id = parsePositiveInt(shiftId, 'shiftId');
  const shift = await DoctorShift.findOne({ id });
  if (!shift) {
    throw new ApiError(404, `Không tìm thấy ca trực với ID #${id}`);
  }

  const activeBookingsCount = await Appointment.countDocuments({
    shiftId: shift.id,
    status: { $in: ACTIVE_APPOINTMENT_STATUSES },
  });

  if (activeBookingsCount > 0) {
    throw new ApiError(
      409,
      `Không thể xóa ca trực #${shift.id} vì đang có ${activeBookingsCount} lịch hẹn khám đã được đặt. ` +
        `Vui lòng hủy hoặc dời lịch khám trước khi xóa ca.`,
    );
  }

  const beforeSnap = sanitizeSnapshot(shift);
  await DoctorShift.deleteOne({ id: shift.id });

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.SHIFT_CANCEL,
      targetType: 'DoctorShift',
      targetId: shift.id,
      reason: `Xóa ca trực #${shift.id} (${shift.date} - ${shift.shift})`,
      changes: { before: beforeSnap, after: null },
      req,
    });
  }

  return {
    deleted: true,
    id: shift.id,
    message: `Đã xóa ca trực #${shift.id} thành công`,
  };
};

module.exports = {
  createShift,
  getMyShifts,
  getShiftsInWeek,
  adjustShift,
  deleteShift,
  getShiftDetailWithBookings,
  getAllShiftsByDate,
  validDate,
  today,
  currentTime,
  SHIFT_TIMES,
};
