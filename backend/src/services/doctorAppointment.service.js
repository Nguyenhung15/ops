const { Appointment, DoctorShift, Prescription } = require('../models');
const ApiError = require('../utils/ApiError');
const { appointmentStateService } = require('./appointmentState.service');
const { clock } = require('./clock.service');

const STATUSES = new Set(['CANCELLED', 'CHECKED_IN', 'COMPLETED', 'CONFIRMED', 'EXPIRED', 'IN_PROGRESS', 'NO_SHOW', 'PENDING_CONFIRMATION', 'PENDING_PAYMENT', 'RESCHEDULED']);
const idOf = (value) => { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(400, 'Invalid numeric ID'); return id; };
const validDate = (date) => { if (date === undefined) return; if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new ApiError(400, 'date must be a valid YYYY-MM-DD date'); return date; };
const serialize = (appointment, doctorName) => ({
  id: appointment.id, appointmentNo: appointment.appointmentNo, appointmentDate: appointment.appointmentDate,
  appointmentTime: appointment.appointmentTime, createdAt: appointment.createdAt?.toISOString ? appointment.createdAt.toISOString() : (appointment.createdAt ? new Date(appointment.createdAt).toISOString() : undefined), status: appointment.status,
  patientName: appointment.patients?.[0]?.fullName || 'N/A', patientId: appointment.patientId, doctorName,
  doctorId: appointment.doctorId, shiftId: appointment.shiftId, specialtyId: appointment.specialtyId,
  reason: appointment.reason || undefined, type: appointment.type,
});
const getOwned = (doctor, appointmentId) => Appointment.findOne({ id: idOf(appointmentId), doctorId: doctor.id });

const getMyByStatus = async (doctor, status, date) => {
  const normalized = String(status || '').toUpperCase();
  if (normalized !== 'ALL' && !STATUSES.has(normalized)) throw new ApiError(400, 'Unknown appointment status');
  const query = { doctorId: doctor.id };
  if (normalized !== 'ALL') query.status = normalized;
  const appointmentDate = validDate(date); if (appointmentDate) query.appointmentDate = appointmentDate;
  return (await Appointment.find(query).sort({ appointmentDate: 1, appointmentTime: 1 }).lean()).map((a) => serialize(a, doctor.fullName));
};
const getByMyShift = async (doctor, shiftId) => {
  const shift = await DoctorShift.findOne({ id: idOf(shiftId), doctorId: doctor.id }).lean();
  if (!shift) throw new ApiError(404, 'Shift not found');
  return (await Appointment.find({ doctorId: doctor.id, shiftId: shift.id }).sort({ appointmentTime: 1 }).lean()).map((a) => serialize(a, doctor.fullName));
};
const getMyDetail = async (doctor, appointmentId) => {
  const appointment = await getOwned(doctor, appointmentId).lean();
  if (!appointment) throw new ApiError(404, 'Appointment not found');
  return serialize(appointment, doctor.fullName);
};
const startAppointment = async (doctor, appointmentId) => {
  const id = idOf(appointmentId);
  const current = await getOwned(doctor, id).lean();
  if (!current) throw new ApiError(404, 'Appointment not found');
  if (current.status === 'IN_PROGRESS') return serialize(current, doctor.fullName);
  if (current.status !== 'CHECKED_IN') throw new ApiError(409, 'Only a checked-in appointment can be started');

  const nowIso = clock.toISOString();
  const actor = {
    userId: doctor.id,
    id: doctor.id,
    role: doctor.userType || 'DOCTOR',
    email: doctor.email,
  };

  const { appointment } = await appointmentStateService.transition({
    appointmentId: id,
    fromStatus: 'CHECKED_IN',
    toStatus: 'IN_PROGRESS',
    actor,
    extraFields: {
      actualStartTime: nowIso,
    },
  });

  return serialize(appointment, doctor.fullName);
};
const completeAppointment = async (doctor, appointmentId) => {
  const id = idOf(appointmentId);
  const current = await getOwned(doctor, id).lean();
  if (!current) throw new ApiError(404, 'Appointment not found');
  if (current.status === 'COMPLETED') return serialize(current, doctor.fullName);
  if (current.status !== 'IN_PROGRESS') throw new ApiError(409, 'Only an in-progress appointment can be completed');
  if (!(await Prescription.exists({ appointmentId: id }))) throw new ApiError(409, 'Add at least one prescription before completing this appointment');

  const nowIso = clock.toISOString();
  const actor = {
    userId: doctor.id,
    id: doctor.id,
    role: doctor.userType || 'DOCTOR',
    email: doctor.email,
  };

  const { appointment } = await appointmentStateService.transition({
    appointmentId: id,
    fromStatus: 'IN_PROGRESS',
    toStatus: 'COMPLETED',
    actor,
    extraFields: {
      actualEndTime: nowIso,
    },
  });

  return serialize(appointment, doctor.fullName);
};
module.exports = { getMyByStatus, getByMyShift, getMyDetail, startAppointment, completeAppointment };
