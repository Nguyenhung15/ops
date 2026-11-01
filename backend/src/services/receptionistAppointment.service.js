const { Appointment, DoctorShift, User, Specialty } = require('../models');
const { ROLES, APPOINTMENT_STATUSES, AUDIT_ACTIONS } = require('../constants/enums');
const { appointmentStateService } = require('./appointmentState.service');
const { holdSlot, releaseSlot } = require('./appointmentSlot.service');
const { clock } = require('./clock.service');
const ApiError = require('../utils/ApiError');

/**
 * Build flexible query for Appointment identifier.
 * @param {string|number} identifier
 * @returns {Record<string, any>}
 */
function buildAppointmentQuery(identifier) {
  if (identifier === null || identifier === undefined) {
    throw new ApiError(400, 'Mã lịch hẹn không được để trống');
  }

  const str = String(identifier).trim();
  const num = Number(str);
  const conditions = [];

  if (Number.isSafeInteger(num) && num > 0) {
    conditions.push({ id: num });
  }
  if (str.length === 24 && /^[0-9a-fA-F]{24}$/.test(str)) {
    conditions.push({ _id: str });
  }
  conditions.push({ appointmentNo: str });

  return conditions.length === 1 ? conditions[0] : { $or: conditions };
}

/**
 * Check if the appointment's scheduled date and time is already in the past.
 * @param {string} appointmentDate "YYYY-MM-DD"
 * @param {string} appointmentTime "HH:mm"
 * @returns {boolean}
 */
function isAppointmentExpired(appointmentDate, appointmentTime) {
  const today = clock.today();
  if (appointmentDate < today) {
    return true;
  }
  if (appointmentDate === today && appointmentTime) {
    const currentTime = clock.currentTime();
    if (appointmentTime < currentTime) {
      return true;
    }
  }
  return false;
}

/**
 * UC-REC-03: Receptionist / Admin confirms an appointment.
 * 
 * Rules:
 * - Allowed roles: RECEPTIONIST, ADMIN.
 * - Only PENDING_CONFIRMATION -> CONFIRMED via AppointmentStateService.
 * - Records confirmedBy = userId from JWT (or authPrincipal) and confirmedAt (UTC).
 * - If already CONFIRMED: returns current state, HTTP 200 (idempotent).
 * - If in CANCELLED / EXPIRED / COMPLETED / etc.: HTTP 409 INVALID_STATE.
 * - Validates appointment is still valid (not expired, shift still ACTIVE); otherwise 409.
 * - If appointment does not exist: 404 APPOINTMENT_NOT_FOUND.
 * - Records Outbox event to notify patient via email.
 * - Records Audit log CONFIRM_APPOINTMENT.
 * - Concurrent requests: only one writes state change, both receive CONFIRMED.
 *
 * @param {object} actor - Authenticated user principal { userId, role, email, fullName }
 * @param {string|number} appointmentId - Numeric id, ObjectId string, or appointmentNo
 * @returns {Promise<object>} Result containing appointment and status
 */
async function confirmAppointment(actor, appointmentId) {
  // 1. Role verification (defense-in-depth, service layer)
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role || actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ Lễ tân hoặc Quản trị viên mới có quyền xác nhận lịch hẹn', 'FORBIDDEN_ROLE');
  }

  // 2. Fetch appointment to inspect current state & validity
  const query = buildAppointmentQuery(appointmentId);
  const appointment = await Appointment.findOne(query);

  if (!appointment) {
    throw new ApiError(404, `Không tìm thấy lịch hẹn với định danh: ${appointmentId}`, 'APPOINTMENT_NOT_FOUND');
  }

  // 3. Idempotency fast check: if already CONFIRMED, return current state directly (HTTP 200)
  if (appointment.status === APPOINTMENT_STATUSES.CONFIRMED) {
    return {
      appointment: appointment.toJSON ? appointment.toJSON() : appointment,
      status: APPOINTMENT_STATUSES.CONFIRMED,
      idempotent: true,
      message: 'Lịch hẹn đã được xác nhận trước đó',
    };
  }

  // 4. State validation: only PENDING_CONFIRMATION can be transitioned to CONFIRMED
  if (appointment.status !== APPOINTMENT_STATUSES.PENDING_CONFIRMATION) {
    throw new ApiError(
      409,
      `Không thể xác nhận lịch hẹn ở trạng thái '${appointment.status}'. Chỉ chấp nhận lịch đang ở trạng thái 'PENDING_CONFIRMATION'`,
      'INVALID_STATE',
    );
  }

  // 5. Validity check: Check if appointment date/time is expired
  if (isAppointmentExpired(appointment.appointmentDate, appointment.appointmentTime)) {
    throw new ApiError(
      409,
      `Lịch hẹn ngày ${appointment.appointmentDate} lúc ${appointment.appointmentTime} đã quá hạn, không thể xác nhận`,
      'APPOINTMENT_EXPIRED',
    );
  }

  // 6. Validity check: Check if shift still exists and is ACTIVE
  const shift = await DoctorShift.findOne({ id: appointment.shiftId });
  if (!shift || shift.status !== 'ACTIVE') {
    throw new ApiError(
      409,
      'Ca trực tương ứng của bác sĩ không còn tồn tại hoặc không ở trạng thái hoạt động (ACTIVE)',
      'SHIFT_NOT_ACTIVE',
    );
  }

  // 7. Fetch patient info for outbox email notification payload
  let patientEmail = null;
  let patientName = null;
  try {
    const patientUser = await User.findOne({ id: appointment.patientId }).select('email fullName').lean();
    if (patientUser) {
      patientEmail = patientUser.email;
      patientName = patientUser.fullName;
    }
  } catch (err) {
    // Non-critical: outbox will still be created with patientId
  }

  // 8. Execute atomic state transition via AppointmentStateService
  // State machine guarantees:
  // - Conditional atomic update { _id, status: 'PENDING_CONFIRMATION' } -> 'CONFIRMED'
  // - Sets confirmedBy = actor.userId, confirmedAt = nowUtc
  // - Idempotent concurrent resolution (second racer gets fresh CONFIRMED document)
  // - Creates Outbox event and Audit log
  const transitionResult = await appointmentStateService.transition({
    appointmentId: appointment.id || appointment._id,
    fromStatus: [APPOINTMENT_STATUSES.PENDING_CONFIRMATION],
    toStatus: APPOINTMENT_STATUSES.CONFIRMED,
    actor: {
      userId: String(actor.userId || actor.id),
      role: actorRole,
      email: actor.email,
    },
    extraFields: {
      confirmedBy: Number(actor.userId) || actor.userId,
    },
    options: {
      auditAction: AUDIT_ACTIONS.CONFIRM_APPOINTMENT,
      outboxEventType: 'APPOINTMENT_CONFIRMED',
      outboxChannel: 'EMAIL',
      outboxPayload: {
        recipientEmail: patientEmail,
        recipientName: patientName,
        appointmentNo: appointment.appointmentNo,
        appointmentDate: appointment.appointmentDate,
        appointmentTime: appointment.appointmentTime,
        type: appointment.type,
      },
    },
  });

  return {
    appointment: transitionResult.appointment,
    status: transitionResult.status,
    idempotent: transitionResult.idempotent,
    message: transitionResult.idempotent
      ? 'Lịch hẹn đã được xác nhận trước đó'
      : 'Xác nhận lịch hẹn thành công',
  };
}

/**
 * Convert "HH:mm" to minutes from 00:00
 * @param {string} timeStr "HH:mm"
 * @returns {number}
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const [hh, mm] = timeStr.split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
}

/**
 * UC-REC-04: Receptionist / Admin checks in a patient.
 *
 * Rules:
 * - Allowed roles: RECEPTIONIST, ADMIN.
 * - Only CONFIRMED -> CHECKED_IN via AppointmentStateService.
 * - Idempotency: if already CHECKED_IN, return current state directly (HTTP 200).
 * - Invalid status (e.g. PENDING_CONFIRMATION, CANCELLED, COMPLETED): return HTTP 409 INVALID_STATE.
 * - Check date: must match today's date in clinic timezone. If not today -> 409 (CHECKIN_WINDOW_CLOSED or CHECKIN_TOO_EARLY).
 * - Check time window: from CHECKIN_EARLY_MINUTES before appointment slot time to shift end time.
 *   - If before slotTime - earlyMinutes: 409 CHECKIN_TOO_EARLY
 *   - If after shift endTime: 409 CHECKIN_WINDOW_CLOSED
 * - Identity verification:
 *   - Request body can supply { identityVerified: true } OR { verifyPhoneLast4: '1234' }.
 *   - If neither is provided -> 400 MISSING_VERIFICATION_INFO
 *   - If verifyPhoneLast4 is provided, it must match the last 4 digits of patient's phone (either from appointment snapshot or User account).
 *   - If verifyPhoneLast4 does not match -> 409 IDENTITY_VERIFICATION_FAILED
 * - Populates checkedIn = true, checkedInAt = nowUtc, checkedInBy = actor.userId.
 * - Post-commit: Transactional Outbox notification to doctor (DOCTOR_PATIENT_CHECKED_IN).
 * - Audit log: CHECKIN.
 *
 * @param {object} actor - Authenticated user principal { userId, role, email, fullName }
 * @param {string|number} appointmentId - Numeric id, ObjectId string, or appointmentNo
 * @param {object} [verificationPayload={}] - { verifyPhoneLast4, identityVerified }
 * @returns {Promise<object>}
 */
async function checkinAppointment(actor, appointmentId, verificationPayload = {}) {
  // 1. Role verification (defense-in-depth, service layer)
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role || actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ Lễ tân hoặc Quản trị viên mới có quyền check-in lịch hẹn', 'FORBIDDEN_ROLE');
  }

  // 2. Fetch appointment
  const query = buildAppointmentQuery(appointmentId);
  const appointment = await Appointment.findOne(query);

  if (!appointment) {
    throw new ApiError(404, `Không tìm thấy lịch hẹn với định danh: ${appointmentId}`, 'APPOINTMENT_NOT_FOUND');
  }

  // 3. Idempotency fast check: if already CHECKED_IN, return current state directly (HTTP 200)
  if (appointment.status === APPOINTMENT_STATUSES.CHECKED_IN) {
    return {
      appointment: appointment.toJSON ? appointment.toJSON() : appointment,
      status: APPOINTMENT_STATUSES.CHECKED_IN,
      idempotent: true,
      message: 'Bệnh nhân đã được check-in trước đó',
    };
  }

  // 4. Status validation: only CONFIRMED can transition to CHECKED_IN
  if (appointment.status !== APPOINTMENT_STATUSES.CONFIRMED) {
    throw new ApiError(
      409,
      `Không thể check-in lịch hẹn ở trạng thái '${appointment.status}'. Chỉ chấp nhận lịch đang ở trạng thái 'CONFIRMED'`,
      'INVALID_STATE',
    );
  }

  // 5. Date validation: must match today's date in clinic timezone
  const todayClinic = clock.today();
  if (appointment.appointmentDate !== todayClinic) {
    if (appointment.appointmentDate > todayClinic) {
      throw new ApiError(
        409,
        `Chưa đến ngày khám (${appointment.appointmentDate}). Hôm nay là ${todayClinic}. Không thể check-in quá sớm`,
        'CHECKIN_TOO_EARLY',
      );
    }
    throw new ApiError(
      409,
      `Lịch hẹn ngày ${appointment.appointmentDate} đã qua ngày khám hôm nay (${todayClinic}). Cửa sổ check-in đã đóng`,
      'CHECKIN_WINDOW_CLOSED',
    );
  }

  // 6. Time Window validation: from CHECKIN_EARLY_MINUTES before slot time to shift endTime
  const shift = await DoctorShift.findOne({ id: appointment.shiftId });
  if (!shift || shift.status !== 'ACTIVE') {
    throw new ApiError(409, 'Ca trực của lịch hẹn không còn tồn tại hoặc không ở trạng thái ACTIVE', 'SHIFT_NOT_ACTIVE');
  }

  const currentMinutes = parseTimeToMinutes(clock.currentTime());
  const slotMinutes = parseTimeToMinutes(appointment.appointmentTime);
  const shiftEndMinutes = parseTimeToMinutes(shift.endTime);

  const env = require('../config/env');
  const earlyMinutes = env.checkinEarlyMinutes !== undefined ? env.checkinEarlyMinutes : 60;
  const earliestCheckinMinutes = slotMinutes - earlyMinutes;

  if (currentMinutes < earliestCheckinMinutes) {
    throw new ApiError(
      409,
      `Chưa đến giờ check-in. Khung giờ check-in mở trước giờ khám ${earlyMinutes} phút (từ ${Math.floor(earliestCheckinMinutes / 60).toString().padStart(2, '0')}:${(earliestCheckinMinutes % 60).toString().padStart(2, '0')})`,
      'CHECKIN_TOO_EARLY',
    );
  }

  if (currentMinutes > shiftEndMinutes) {
    throw new ApiError(
      409,
      `Đã quá giờ kết thúc ca trực (${shift.endTime}). Cửa sổ check-in cho ca trực này đã đóng`,
      'CHECKIN_WINDOW_CLOSED',
    );
  }

  // 7. Identity verification validation
  const { verifyPhoneLast4, identityVerified } = verificationPayload || {};
  const isDirectlyVerified = identityVerified === true || identityVerified === 'true';

  if (!isDirectlyVerified && (verifyPhoneLast4 === undefined || verifyPhoneLast4 === null || String(verifyPhoneLast4).trim() === '')) {
    throw new ApiError(
      400,
      'Vui lòng cung cấp 4 số cuối số điện thoại (verifyPhoneLast4) hoặc xác nhận danh tính trực tiếp (identityVerified=true)',
      'MISSING_VERIFICATION_INFO',
    );
  }

  if (!isDirectlyVerified) {
    const inputLast4 = String(verifyPhoneLast4).trim();
    if (!/^\d{4}$/.test(inputLast4)) {
      throw new ApiError(400, '4 số cuối điện thoại phải là chuỗi đúng 4 chữ số', 'INVALID_PHONE_LAST4_FORMAT');
    }

    // Gather candidate phone numbers from appointment patient snapshots and patient User account
    const candidatePhones = [];
    if (Array.isArray(appointment.patients)) {
      for (const p of appointment.patients) {
        if (p?.phoneNumber) candidatePhones.push(String(p.phoneNumber).trim());
      }
    }
    const patientUser = await User.findOne({ id: appointment.patientId }).select('phoneNumber email fullName').lean();
    if (patientUser?.phoneNumber) {
      candidatePhones.push(String(patientUser.phoneNumber).trim());
    }

    const matched = candidatePhones.some((phone) => {
      const cleanDigits = phone.replace(/\D/g, '');
      return cleanDigits.endsWith(inputLast4);
    });

    if (!matched) {
      throw new ApiError(
        409,
        '4 số cuối điện thoại không khớp với hồ sơ bệnh nhân đăng ký lịch khám',
        'IDENTITY_VERIFICATION_FAILED',
      );
    }
  }

  // 8. Fetch doctor info for outbox notification payload
  let doctorEmail = null;
  let doctorName = null;
  try {
    const doctorUser = await User.findOne({ id: appointment.doctorId }).select('email fullName').lean();
    if (doctorUser) {
      doctorEmail = doctorUser.email;
      doctorName = doctorUser.fullName;
    }
  } catch (err) {
    // Non-critical
  }

  // 9. Execute atomic state transition via AppointmentStateService
  const transitionResult = await appointmentStateService.transition({
    appointmentId: appointment.id || appointment._id,
    fromStatus: [APPOINTMENT_STATUSES.CONFIRMED],
    toStatus: APPOINTMENT_STATUSES.CHECKED_IN,
    actor: {
      userId: String(actor.userId || actor.id),
      role: actorRole,
      email: actor.email,
    },
    extraFields: {
      checkedIn: true,
      checkedInBy: Number(actor.userId) || actor.userId,
    },
    options: {
      auditAction: AUDIT_ACTIONS.CHECKIN,
      outboxEventType: 'DOCTOR_PATIENT_CHECKED_IN',
      outboxChannel: 'ALL',
      outboxPayload: {
        doctorId: appointment.doctorId,
        doctorEmail,
        doctorName,
        appointmentNo: appointment.appointmentNo,
        appointmentDate: appointment.appointmentDate,
        appointmentTime: appointment.appointmentTime,
        patientId: appointment.patientId,
        verificationMethod: isDirectlyVerified ? 'IDENTITY_CONFIRMED' : 'PHONE_LAST_4',
      },
    },
  });

  return {
    appointment: transitionResult.appointment,
    status: transitionResult.status,
    idempotent: transitionResult.idempotent,
    message: transitionResult.idempotent
      ? 'Bệnh nhân đã được check-in trước đó'
      : 'Check-in bệnh nhân thành công',
  };
}

/**
 * UC-REC-05: Receptionist / Admin cancels an appointment.
 *
 * Rules:
 * - Allowed roles: RECEPTIONIST, ADMIN.
 * - Non-empty `reason` required.
 * - Only appointments not in terminal states (COMPLETED, CANCELLED, EXPIRED, NO_SHOW).
 * - If already CANCELLED, idempotent HTTP 200.
 * - Transition CANCELLED via AppointmentStateService, storing cancelledBy, cancelledAt, cancelReason.
 * - Release booked slot (BOOKED -> AVAILABLE) in atomic step with matching bookingRef.
 * - Staff is NOT constrained by 24h/48h window and does NOT increment patient's cancel lock counter.
 * - If already paid (or payment transaction exists with SUCCESS/00), flag refundRequired = true.
 * - Post-commit Outbox notification to patient and doctor; Audit log CANCEL_APPOINTMENT.
 *
 * @param {object} actor - Authenticated user principal { userId, role, email }
 * @param {string|number} appointmentId
 * @param {object} options - { reason }
 * @returns {Promise<object>}
 */
async function cancelAppointmentByStaff(actor, appointmentId, { reason } = {}) {
  // 1. Role verification
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role || actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ Lễ tân hoặc Quản trị viên mới có quyền hủy lịch hẹn', 'FORBIDDEN_ROLE');
  }

  // 2. Validate reason: must be a non-empty string
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ApiError(400, 'Lý do hủy lịch hẹn không được để trống', 'REASON_REQUIRED');
  }
  const cleanReason = reason.trim();

  // 3. Fetch appointment
  const query = buildAppointmentQuery(appointmentId);
  const appointment = await Appointment.findOne(query);

  if (!appointment) {
    throw new ApiError(404, `Không tìm thấy lịch hẹn với định danh: ${appointmentId}`, 'APPOINTMENT_NOT_FOUND');
  }

  // 4. Idempotency: if already CANCELLED, return 200 idempotent
  if (appointment.status === APPOINTMENT_STATUSES.CANCELLED) {
    return {
      appointment: appointment.toJSON ? appointment.toJSON() : appointment,
      status: APPOINTMENT_STATUSES.CANCELLED,
      idempotent: true,
      message: 'Lịch hẹn đã được hủy trước đó',
    };
  }

  // 5. Terminal state check: cannot cancel COMPLETED, EXPIRED, NO_SHOW
  const terminalStatuses = [
    APPOINTMENT_STATUSES.COMPLETED,
    APPOINTMENT_STATUSES.EXPIRED,
    APPOINTMENT_STATUSES.NO_SHOW,
  ];
  if (terminalStatuses.includes(appointment.status)) {
    throw new ApiError(
      409,
      `Không thể hủy lịch hẹn đã ở trạng thái kết thúc: ${appointment.status}`,
      'INVALID_STATE',
    );
  }

  // 6. Check if payment exists and was successful to flag refundRequired
  let refundRequired = Boolean(appointment.refundRequired);
  try {
    const { PaymentTransaction } = require('../models');
    if (PaymentTransaction) {
      const payment = await PaymentTransaction.findOne({
        appointmentId: appointment.id,
        $or: [
          { status: 'SUCCESS' },
          { responseCode: '00' },
          { transactionStatus: '00' },
          { transactionStatus: 'SUCCESS' },
        ],
      }).lean();
      if (payment) {
        refundRequired = true;
      }
    }
  } catch (err) {
    // Non-blocking payment inspection
  }

  // 7. Atomic slot release: Release booked slot (BOOKED -> AVAILABLE)
  // ONLY release if slot belongs to this appointment (bookingRef matches appointmentNo)
  const slotIds = Array.isArray(appointment.slotIds) ? appointment.slotIds : [];
  if (appointment.shiftId && slotIds.length > 0) {
    await releaseSlot({
      shiftId: appointment.shiftId,
      slotIds,
      bookingRef: appointment.appointmentNo,
    });
  }

  // 8. Transition appointment state to CANCELLED via AppointmentStateService
  const cancelledAt = clock.now();
  const transitionResult = await appointmentStateService.transition({
    appointmentId: appointment.id,
    fromStatuses: [
      APPOINTMENT_STATUSES.PENDING_PAYMENT,
      APPOINTMENT_STATUSES.PENDING_CONFIRMATION,
      APPOINTMENT_STATUSES.CONFIRMED,
      APPOINTMENT_STATUSES.CHECKED_IN,
    ],
    toStatus: APPOINTMENT_STATUSES.CANCELLED,
    actor,
    extraFields: {
      cancelReason: cleanReason,
      cancelledBy: actor.userId || actor.id,
      cancelledByRole: actorRole,
      cancelledAt,
      refundRequired,
    },
    options: {
      auditAction: AUDIT_ACTIONS.CANCEL_APPOINTMENT,
      auditReason: cleanReason,
      outboxEventType: 'APPOINTMENT_CANCELLED_BY_STAFF',
      outboxPayload: {
        appointmentId: appointment.id,
        appointmentNo: appointment.appointmentNo,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        shiftId: appointment.shiftId,
        cancelReason: cleanReason,
        cancelledBy: actor.userId || actor.id,
        cancelledByRole: actorRole,
        cancelledAt: cancelledAt.toISOString(),
        refundRequired,
      },
    },
  });

  return {
    appointment: transitionResult.appointment,
    status: transitionResult.status,
    idempotent: transitionResult.idempotent,
    message: 'Hủy lịch hẹn thành công',
  };
}

/**
 * UC-REC-05: Receptionist / Admin reschedules an appointment.
 *
 * Rules:
 * - Allowed roles: RECEPTIONIST, ADMIN.
 * - Input: appointmentId, newShiftId (+ optional newSlotId), reason.
 * - Validate reason: must be non-empty string.
 * - Validate old appointment: not in terminal states (COMPLETED, CANCELLED, EXPIRED, NO_SHOW).
 * - Validate new shift: exists, status ACTIVE, matches doctor and valid date.
 * - Atomic conditional reserve on new slot: if unavailable/taken -> 409 and make NO changes.
 * - Transition old appointment -> RESCHEDULED.
 * - Create new appointment with generated appointmentNo, preserving patient snapshot, type, reason.
 * - Target state of new appointment: CONFIRMED if old status was CONFIRMED or above; otherwise preserve old status.
 * - Link rescheduledFromId on new appointment and rescheduledToId on old appointment.
 * - Release old slot from old shift.
 * - Compensation: if any error occurs midway, rollback newly booked slot back to AVAILABLE.
 * - Post-commit Outbox notification and Audit log RESCHEDULE_APPOINTMENT.
 *
 * @param {object} actor - Authenticated user principal { userId, role, email }
 * @param {string|number} appointmentId
 * @param {object} params - { newShiftId, newSlotId, reason }
 * @returns {Promise<object>}
 */
async function rescheduleAppointmentByStaff(
  actor,
  appointmentId,
  { newShiftId, newSlotId, reason } = {},
) {
  // 1. Role verification
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role || actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ Lễ tân hoặc Quản trị viên mới có quyền đổi lịch hẹn', 'FORBIDDEN_ROLE');
  }

  // 2. Validate reason: non-empty string
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ApiError(400, 'Lý do đổi lịch hẹn không được để trống', 'REASON_REQUIRED');
  }
  const cleanReason = reason.trim();

  // 3. Validate newShiftId
  if (!newShiftId) {
    throw new ApiError(400, 'Vui lòng chọn ca trực mới để dời lịch', 'NEW_SHIFT_REQUIRED');
  }
  const targetShiftId = Number(newShiftId);
  if (!Number.isSafeInteger(targetShiftId) || targetShiftId <= 0) {
    throw new ApiError(400, 'Mã ca trực mới không hợp lệ', 'INVALID_NEW_SHIFT_ID');
  }

  // 4. Fetch old appointment
  const query = buildAppointmentQuery(appointmentId);
  const oldAppointment = await Appointment.findOne(query);

  if (!oldAppointment) {
    throw new ApiError(404, `Không tìm thấy lịch hẹn với định danh: ${appointmentId}`, 'APPOINTMENT_NOT_FOUND');
  }

  // 5. Terminal state check
  const terminalStatuses = [
    APPOINTMENT_STATUSES.COMPLETED,
    APPOINTMENT_STATUSES.CANCELLED,
    APPOINTMENT_STATUSES.EXPIRED,
    APPOINTMENT_STATUSES.NO_SHOW,
    APPOINTMENT_STATUSES.RESCHEDULED,
  ];
  if (terminalStatuses.includes(oldAppointment.status)) {
    throw new ApiError(
      409,
      `Không thể đổi lịch hẹn đã ở trạng thái kết thúc: ${oldAppointment.status}`,
      'INVALID_STATE',
    );
  }

  // 6. Validate new shift
  const newShift = await DoctorShift.findOne({ id: targetShiftId });
  if (!newShift) {
    throw new ApiError(404, 'Ca trực mới không tồn tại', 'NEW_SHIFT_NOT_FOUND');
  }
  if (newShift.status !== 'ACTIVE') {
    throw new ApiError(409, 'Ca trực mới không ở trạng thái hoạt động (ACTIVE)', 'SHIFT_NOT_ACTIVE');
  }
  if (newShift.doctorId !== oldAppointment.doctorId) {
    throw new ApiError(409, 'Ca trực mới phải thuộc cùng bác sĩ của lịch hẹn hiện tại', 'DOCTOR_MISMATCH');
  }

  // 7. Find candidate slot in new shift
  const slots = Array.isArray(newShift.slots) ? newShift.slots : [];
  let candidateSlot = null;
  if (newSlotId !== undefined && newSlotId !== null && String(newSlotId).trim() !== '') {
    const targetSlotId = Number(newSlotId);
    candidateSlot = slots.find((s) => s.id === targetSlotId);
    if (!candidateSlot) {
      throw new ApiError(404, `Không tìm thấy slot ${newSlotId} trong ca trực mới`, 'SLOT_NOT_FOUND');
    }
    if (candidateSlot.status !== 'AVAILABLE') {
      throw new ApiError(409, 'Slot khám đã được người khác đặt hoặc không khả dụng', 'SLOT_ALREADY_BOOKED');
    }
  } else {
    // Pick first available slot in new shift
    candidateSlot = slots.find((s) => s.status === 'AVAILABLE');
    if (!candidateSlot) {
      throw new ApiError(409, 'Ca trực mới không còn slot trống nào khả dụng', 'NO_AVAILABLE_SLOTS');
    }
  }

  // 8. Atomic conditional reservation on new slot using appointmentSlotService
  const crypto = require('crypto');
  const tempHoldRef = `HOLD_RESCHED_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  await holdSlot({
    shiftId: newShift.id,
    slotId: candidateSlot.id,
    bookingRef: tempHoldRef,
  });

  // Step 9: Compensation wrapper for appointment creation & state updates
  let newAppointment = null;
  const newAppointmentNo = `OFF${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  
  // Determine target state for new appointment:
  // If old appointment was CONFIRMED or CHECKED_IN -> new appointment is CONFIRMED
  // Otherwise preserve old appointment status (e.g. PENDING_CONFIRMATION / PENDING_PAYMENT)
  let newStatus = APPOINTMENT_STATUSES.PENDING_CONFIRMATION;
  if (
    oldAppointment.status === APPOINTMENT_STATUSES.CONFIRMED ||
    oldAppointment.status === APPOINTMENT_STATUSES.CHECKED_IN
  ) {
    newStatus = APPOINTMENT_STATUSES.CONFIRMED;
  } else if (oldAppointment.status === APPOINTMENT_STATUSES.PENDING_PAYMENT) {
    newStatus = APPOINTMENT_STATUSES.PENDING_PAYMENT;
  }

  try {
    // 9.1 Create new appointment
    newAppointment = await Appointment.create({
      appointmentNo: newAppointmentNo,
      patientId: oldAppointment.patientId,
      doctorId: oldAppointment.doctorId,
      specialtyId: oldAppointment.specialtyId,
      shiftId: newShift.id,
      slotIds: [candidateSlot.id],
      appointmentDate: newShift.date,
      appointmentTime: candidateSlot.startTime,
      type: oldAppointment.type || 'OFFLINE',
      status: newStatus,
      reason: cleanReason,
      patients: oldAppointment.patients || [],
      rescheduledFromId: oldAppointment.id,
      confirmedBy: newStatus === APPOINTMENT_STATUSES.CONFIRMED ? (actor.userId || actor.id) : null,
      confirmedAt: newStatus === APPOINTMENT_STATUSES.CONFIRMED ? clock.now() : null,
    });

    // 9.2 Bind new appointmentNo to the newly reserved slot
    await DoctorShift.updateOne(
      {
        id: newShift.id,
        'slots.id': candidateSlot.id,
        'slots.bookingRef': tempHoldRef,
      },
      {
        $set: {
          'slots.$.bookingRef': newAppointment.appointmentNo,
        },
      },
    );

    // 9.3 Transition old appointment to RESCHEDULED via AppointmentStateService
    await appointmentStateService.transition({
      appointmentId: oldAppointment.id,
      fromStatuses: [
        APPOINTMENT_STATUSES.PENDING_PAYMENT,
        APPOINTMENT_STATUSES.PENDING_CONFIRMATION,
        APPOINTMENT_STATUSES.CONFIRMED,
        APPOINTMENT_STATUSES.CHECKED_IN,
      ],
      toStatus: APPOINTMENT_STATUSES.RESCHEDULED,
      actor,
      extraFields: {
        rescheduledToId: newAppointment.id,
      },
      options: {
        auditAction: AUDIT_ACTIONS.RESCHEDULE_APPOINTMENT,
        auditReason: cleanReason,
      },
    });

    // 9.4 Release old slot from old shift (only if slot belongs to this old appointment)
    const oldSlotIds = Array.isArray(oldAppointment.slotIds) ? oldAppointment.slotIds : [];
    if (oldAppointment.shiftId && oldSlotIds.length > 0) {
      await releaseSlot({
        shiftId: oldAppointment.shiftId,
        slotIds: oldSlotIds,
        bookingRef: oldAppointment.appointmentNo,
      });
    }

    // 9.5 Outbox event after commit
    const outboxService = require('./outbox.service');
    await outboxService.recordEvent({
      eventType: 'APPOINTMENT_RESCHEDULED_BY_STAFF',
      payload: {
        oldAppointmentId: oldAppointment.id,
        oldAppointmentNo: oldAppointment.appointmentNo,
        newAppointmentId: newAppointment.id,
        newAppointmentNo: newAppointment.appointmentNo,
        patientId: oldAppointment.patientId,
        doctorId: oldAppointment.doctorId,
        newShiftId: newShift.id,
        newDate: newShift.date,
        newTime: candidateSlot.startTime,
        rescheduledBy: actor.userId || actor.id,
        reason: cleanReason,
      },
    });

  } catch (err) {
    // COMPENSATION ROLLBACK: Revert the reserved slot back to AVAILABLE
    try {
      await releaseSlot({
        shiftId: newShift.id,
        slotIds: [candidateSlot.id],
        bookingRef: tempHoldRef,
      });
      if (newAppointment && newAppointment.appointmentNo) {
        await releaseSlot({
          shiftId: newShift.id,
          slotIds: [candidateSlot.id],
          bookingRef: newAppointment.appointmentNo,
        });
      }
      // Clean up new appointment document if it was created
      if (newAppointment && newAppointment._id) {
        await Appointment.deleteOne({ _id: newAppointment._id });
      }
    } catch (compensationErr) {
      console.error('Lỗi khi thực hiện bồi hoàn compensation slot:', compensationErr);
    }
    throw err;
  }

  return {
    appointment: newAppointment.toJSON ? newAppointment.toJSON() : newAppointment,
    status: newAppointment.status,
    oldAppointmentId: oldAppointment.id,
    newAppointmentId: newAppointment.id,
    message: 'Đổi lịch hẹn thành công',
  };
}

module.exports = {
  buildAppointmentQuery,
  isAppointmentExpired,
  confirmAppointment,
  checkinAppointment,
  cancelAppointmentByStaff,
  rescheduleAppointmentByStaff,
};


