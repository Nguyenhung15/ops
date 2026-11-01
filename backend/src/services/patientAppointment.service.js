const crypto = require('crypto');
const {
  Appointment,
  DoctorShift,
  User,
  Specialty,
  PatientProfile,
  Prescription,
  UserVoucher,
} = require('../models');
const { ROLES, APPOINTMENT_STATUSES, AUDIT_ACTIONS } = require('../constants/enums');
const { recordAudit } = require('./audit.service');
const ApiError = require('../utils/ApiError');
const { parsePositiveInt, normalizeGender } = require('../utils/normalizers');
const patientProfileService = require('./patientProfile.service');
const voucherRedemptionService = require('./voucherRedemption.service');
const { clock } = require('./clock.service');
const env = require('../config/env');

const getTodayString = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: env.clinicTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const getCurrentTimeString = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: env.clinicTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());

const generateAppointmentNo = (type = 'OFFLINE') => {
  const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
  const prefix = String(type).toUpperCase() === 'ONLINE' ? 'ONL' : 'OFF';
  return `${prefix}${randomHex}`;
};

/**
 * UC-PAT-04: Book appointment with atomic slot reservation.
 */
async function bookAppointment(user, query = {}, body = {}) {
  if (!user || user.userType !== ROLES.PATIENT) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền đặt lịch khám');
  }

  // 0. Check cancellation lock policy (BR-03, A6)
  const patientUser = await User.findOne({ id: user.id }).lean();
  const checkTime = new Date();

  // Restriction lasts 24 hours: expires automatically when bookingLockedUntil <= now
  const isLockActive = Boolean(
    patientUser?.bookingLockedUntil
      ? new Date(patientUser.bookingLockedUntil) > checkTime
      : patientUser?.isBookingLocked && patientUser?.bookingLockedAt
        ? new Date(patientUser.bookingLockedAt).getTime() + (env.bookingLockDurationHours || 24) * 3600 * 1000 > checkTime.getTime()
        : false,
  );

  if (isLockActive) {
    throw new ApiError(
      403,
      `Tài khoản của bạn đã bị khóa quyền đặt lịch mới do đạt ngưỡng ${env.cancelLockThreshold} lần hủy lịch khám`,
    );
  }

  // 1. Validate query and inputs
  const shiftId = parsePositiveInt(body.shiftId, 'shiftId');
  const specialtyId = parsePositiveInt(query.specialtyId, 'specialtyId');

  const specialty = await Specialty.findOne({ id: specialtyId }).lean();
  if (!specialty) {
    throw new ApiError(404, 'Chuyên khoa không tồn tại');
  }

  // 2. Fetch and validate DoctorShift
  const shift = await DoctorShift.findOne({ id: shiftId }).lean();
  if (!shift) {
    throw new ApiError(404, 'Ca trực không tồn tại');
  }
  if (shift.status !== 'ACTIVE') {
    throw new ApiError(400, 'Ca trực không còn khả dụng hoặc đã bị hủy');
  }

  // 3. Validate Doctor
  let doctorId = shift.doctorId;
  if (query.doctorId != null && String(query.doctorId).trim() !== '') {
    const queryDoctorId = parsePositiveInt(query.doctorId, 'doctorId');
    if (queryDoctorId !== shift.doctorId) {
      throw new ApiError(400, 'Bác sĩ được chọn không khớp với ca trực');
    }
    doctorId = queryDoctorId;
  }

  const doctor = await User.findOne({
    id: doctorId,
    userType: ROLES.DOCTOR,
    isEnable: true,
  }).lean();

  if (!doctor) {
    throw new ApiError(404, 'Bác sĩ không tồn tại hoặc đã ngừng hoạt động');
  }

  if (doctor.specialtyId !== specialty.id) {
    throw new ApiError(400, 'Chuyên khoa không khớp với chuyên khoa của bác sĩ phụ trách ca trực');
  }

  // 4. Validate Date and Time (must not be past)
  const today = getTodayString();
  const currentTime = getCurrentTimeString();
  if (shift.date < today) {
    throw new ApiError(400, 'Không thể đặt lịch cho ca trực trong quá khứ');
  }

  // 5. Validate Patients payload
  const rawPatients = Array.isArray(body.patients) ? body.patients : [];
  const maxPatients = env.maxPatientsPerAppointment || 4;

  if (rawPatients.length < 1) {
    throw new ApiError(400, 'Vui lòng cung cấp ít nhất một người khám bệnh');
  }
  if (rawPatients.length > maxPatients) {
    throw new ApiError(
      400,
      `Số lượng người khám vượt quá giới hạn tối đa cho phép (${maxPatients} người)`,
    );
  }

  // Check duplicate patient IDs in the same request
  const patientIds = rawPatients
    .map((p) => (p.id != null ? Number(p.id) : null))
    .filter((id) => id != null && !Number.isNaN(id));

  if (new Set(patientIds).size !== patientIds.length) {
    throw new ApiError(400, 'Không được chọn trùng hồ sơ bệnh nhân trong cùng một lịch hẹn');
  }

  // 6. Check pending appointments limit for patient
  const maxPending = env.maxPendingAppointmentsPerPatient || 5;
  const pendingCount = await Appointment.countDocuments({
    patientId: user.id,
    status: { $in: ['PENDING_CONFIRMATION', 'PENDING_PAYMENT'] },
  });

  if (pendingCount >= maxPending) {
    throw new ApiError(
      400,
      `Bạn đang có ${pendingCount} lịch hẹn đang chờ xử lý, vượt quá giới hạn cho phép (${maxPending})`,
    );
  }

  // 7. Validate and prepare patient snapshots
  const snapshotPatients = [];
  const newPatientsToSave = [];

  for (let i = 0; i < rawPatients.length; i += 1) {
    const p = rawPatients[i];
    if (!p || typeof p !== 'object') {
      throw new ApiError(400, `Thông tin bệnh nhân thứ ${i + 1} không hợp lệ`);
    }

    if (p.id != null && String(p.id).trim() !== '') {
      // Existing profile: must belong to owner and NOT be archived
      const profile = await patientProfileService.getActiveProfileForOwner(user.id, p.id);
      snapshotPatients.push({
        id: profile.id,
        fullName: profile.fullName,
        gender: profile.gender,
        phoneNumber: profile.phoneNumber,
        dob: profile.dob,
        relationship: profile.relationship,
      });
    } else {
      // New profile entered inline
      const fullName = typeof p.fullName === 'string' ? p.fullName.trim() : '';
      if (!fullName) {
        throw new ApiError(400, `Họ và tên của bệnh nhân thứ ${i + 1} không được để trống`);
      }
      if (fullName.length > 255) {
        throw new ApiError(400, `Họ và tên của bệnh nhân thứ ${i + 1} không được vượt quá 255 ký tự`);
      }

      const gender = normalizeGender(p.gender);
      let phoneNumber = null;
      if (p.phoneNumber != null && String(p.phoneNumber).trim() !== '') {
        const phone = String(p.phoneNumber).trim();
        const phoneRegex = /^(?:\+84|0)[1-9]\d{8}$/;
        if (!phoneRegex.test(phone)) {
          throw new ApiError(
            400,
            `Số điện thoại bệnh nhân thứ ${i + 1} không hợp lệ (yêu cầu 10 chữ số)`,
          );
        }
        phoneNumber = phone;
      }

      let dob = null;
      if (p.dob != null && String(p.dob).trim() !== '') {
        const parsedDob = new Date(String(p.dob).trim());
        if (Number.isNaN(parsedDob.getTime())) {
          throw new ApiError(400, `Ngày sinh của bệnh nhân thứ ${i + 1} không hợp lệ`);
        }
        const isoDob = parsedDob.toISOString().slice(0, 10);
        if (isoDob > today) {
          throw new ApiError(
            400,
            `Ngày sinh của bệnh nhân thứ ${i + 1} không được lớn hơn ngày hiện tại`,
          );
        }
        dob = isoDob;
      }

      let relationship = null;
      if (p.relationship != null && String(p.relationship).trim() !== '') {
        relationship = String(p.relationship).trim().slice(0, 100);
      }

      snapshotPatients.push({
        id: null,
        fullName,
        gender,
        phoneNumber,
        dob,
        relationship,
      });

      newPatientsToSave.push({
        fullName,
        gender,
        phoneNumber,
        dob,
        relationship,
      });
    }
  }

  const requestedSlotsCount = snapshotPatients.length;
  const rawType = body.appointment?.type || body.type || query.type || shift.type;
  const appointmentType = String(rawType).toUpperCase() === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
  const reason =
    typeof body.appointment?.reason === 'string' ? body.appointment.reason.trim() : null;

  // 8. Atomic slot reservation loop (max 3 retries on concurrency collision)
  let reservedSlotIds = [];
  let firstSlotTime = null;
  let reservationHeld = false;
  const holdToken = `HOLD_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const now = new Date();

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const currentShift = await DoctorShift.findOne({ id: shift.id, status: 'ACTIVE' }).lean();
    if (!currentShift) {
      throw new ApiError(400, 'Ca trực không còn khả dụng hoặc đã bị hủy');
    }

    const rawSlots = Array.isArray(currentShift.slots) ? currentShift.slots : [];
    // Only slots AVAILABLE and (if today) start time strictly in future
    const availableSlots = rawSlots.filter((slot) => {
      if (slot.status !== 'AVAILABLE') return false;
      if (shift.date === today && slot.startTime <= currentTime) return false;
      return true;
    });

    if (availableSlots.length < requestedSlotsCount) {
      throw new ApiError(
        409,
        `Ca trực không đủ chỗ trống (cần ${requestedSlotsCount} slot, hiện còn ${availableSlots.length} slot khả dụng)`,
      );
    }

    const candidateSlots = availableSlots.slice(0, requestedSlotsCount);
    const candidateIds = candidateSlots.map((s) => s.id);

    // Atomic update on single document: verify ALL selected slots are still AVAILABLE
    const updateResult = await DoctorShift.updateOne(
      {
        id: shift.id,
        status: 'ACTIVE',
        slots: {
          $all: candidateIds.map((sid) => ({
            $elemMatch: { id: sid, status: 'AVAILABLE' },
          })),
        },
      },
      {
        $set: {
          'slots.$[elem].status': 'BOOKED',
          'slots.$[elem].bookingRef': holdToken,
          'slots.$[elem].bookedAt': now,
        },
      },
      {
        arrayFilters: [{ 'elem.id': { $in: candidateIds } }],
      },
    );

    if (updateResult.modifiedCount === 1) {
      reservedSlotIds = candidateIds;
      firstSlotTime = candidateSlots[0].startTime;
      reservationHeld = true;
      break;
    }

    // modifiedCount === 0 means race condition (another request took one of candidateIds)
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15) + 5));
    if (attempt === MAX_ATTEMPTS) {
      throw new ApiError(
        409,
        'Không thể giữ chỗ do có lượt đặt khác diễn ra đồng thời, vui lòng thử lại',
      );
    }
  }

  // Xác định phí khám và chính sách thanh toán cho lịch hẹn
  const doctorFee = (doctor && Number.isFinite(Number(doctor.consultationFee)))
    ? Math.max(0, Math.floor(Number(doctor.consultationFee)))
    : 0;
  const totalConsultationFee = doctorFee * requestedSlotsCount;
  const requiresPayment = Boolean(
    appointmentType === 'ONLINE' &&
    env.onlineRequirePaymentBeforeJoin &&
    totalConsultationFee > 0,
  );
  const initialStatus = requiresPayment
    ? APPOINTMENT_STATUSES.PENDING_PAYMENT
    : APPOINTMENT_STATUSES.PENDING_CONFIRMATION;
  const initialPaymentStatus = requiresPayment ? 'PENDING' : null;

  // 9. Create Appointment record with retry on unique appointmentNo (max 3 times)
  let appointment = null;
  let createError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const appointmentNo = generateAppointmentNo(appointmentType);
    try {
      appointment = await Appointment.create({
        appointmentNo,
        patientId: user.id,
        doctorId: doctor.id,
        specialtyId: specialty.id,
        shiftId: shift.id,
        slotIds: reservedSlotIds,
        appointmentDate: shift.date,
        appointmentTime: firstSlotTime,
        type: appointmentType,
        status: initialStatus,
        paymentStatus: initialPaymentStatus,
        reason,
        patients: snapshotPatients,
        createdAt: clock.now(),
      });
      break;
    } catch (err) {
      if (err.code === 11000 && attempt < 3) {
        continue; // Retry duplicate appointmentNo
      }
      createError = err;
      break;
    }
  }

  // Compensate / Rollback slots ONLY IF Appointment was NOT created
  if (!appointment) {
    if (reservationHeld) {
      try {
        await DoctorShift.updateOne(
          { id: shift.id },
          {
            $set: {
              'slots.$[elem].status': 'AVAILABLE',
              'slots.$[elem].bookingRef': null,
              'slots.$[elem].bookedAt': null,
            },
          },
          {
            arrayFilters: [{ 'elem.id': { $in: reservedSlotIds }, 'elem.bookingRef': holdToken }],
          },
        );
      } catch (rollbackErr) {
        console.error('Failed to rollback slots on appointment creation error:', rollbackErr);
      }
    }
    throw createError || new ApiError(500, 'Không thể khởi tạo lịch hẹn, vui lòng thử lại');
  }

  // Appointment created successfully: DO NOT rollback slots from this point onwards.
  // Associate slot bookingRef with official appointmentNo in isolated try/catch.
  try {
    await DoctorShift.updateOne(
      { id: shift.id },
      {
        $set: {
          'slots.$[elem].bookingRef': appointment.appointmentNo,
        },
      },
      {
        arrayFilters: [{ 'elem.id': { $in: reservedSlotIds }, 'elem.bookingRef': holdToken }],
      },
    );
  } catch (updateRefErr) {
    // Log failure, but do NOT fail or rollback appointment; reconciliation handles via slotIds
    console.error('Failed to update slot bookingRef to appointmentNo:', updateRefErr);
  }

  // 10. Best-effort auto-save new patient profiles (failures will not roll back appointment)
  for (const newP of newPatientsToSave) {
    try {
      const exists = await PatientProfile.findOne({
        ownerId: user.id,
        fullName: newP.fullName,
        dob: newP.dob,
        phoneNumber: newP.phoneNumber,
        isArchived: false,
      });

      if (!exists) {
        const count = await PatientProfile.countDocuments({
          ownerId: user.id,
          isArchived: false,
        });
        if (count < patientProfileService.MAX_PROFILES_PER_USER) {
          await PatientProfile.create({
            ownerId: user.id,
            fullName: newP.fullName,
            gender: newP.gender,
            phoneNumber: newP.phoneNumber,
            dob: newP.dob,
            relationship: newP.relationship,
            isArchived: false,
          });
        }
      }
    } catch (saveErr) {
      // Log error silently, do not fail the appointment
    }
  }

  // Tính thời hạn thanh toán nếu cần thanh toán
  const holdMinutes = env.paymentAppointmentHoldMinutes || 30;
  const createdAtDate = appointment.createdAt ? new Date(appointment.createdAt) : new Date();
  const paymentDueAt = requiresPayment
    ? new Date(createdAtDate.getTime() + holdMinutes * 60 * 1000).toISOString()
    : undefined;

  // 11. Format final response
  return {
    id: appointment.id,
    appointmentNo: appointment.appointmentNo,
    patientId: appointment.patientId,
    doctorId: appointment.doctorId,
    specialtyId: appointment.specialtyId,
    shiftId: appointment.shiftId,
    slotIds: appointment.slotIds,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    type: appointment.type,
    status: appointment.status,
    patientName: snapshotPatients[0]?.fullName || user.fullName,
    doctorName: doctor.fullName,
    specialtyName: specialty.name,
    reason: appointment.reason,
    patients: appointment.patients,
    paymentStatus: appointment.paymentStatus || undefined,
    requiresPayment,
    paymentDueAt,
  };
}

/**
 * Reconciliation helper: clean up orphaned 'BOOKED' slots older than `maxAgeMinutes`
 * that have no active Appointment record.
 */
async function reconcileOrphanSlots(maxAgeMinutes = 10) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const shiftsWithBookedSlots = await DoctorShift.find({
    'slots.status': 'BOOKED',
    'slots.bookedAt': { $lte: cutoff },
  });

  let reconciledCount = 0;

  for (const s of shiftsWithBookedSlots) {
    const staleSlots = (s.slots || []).filter(
      (slot) => slot.status === 'BOOKED' && slot.bookedAt && slot.bookedAt <= cutoff,
    );

    for (const slot of staleSlots) {
      // Check if an active appointment exists for this slot
      const appointmentExists = await Appointment.exists({
        shiftId: s.id,
        slotIds: slot.id,
        status: { $nin: ['CANCELLED', 'EXPIRED'] },
      });

      if (!appointmentExists) {
        const updateRes = await DoctorShift.updateOne(
          {
            id: s.id,
            slots: {
              $elemMatch: {
                id: slot.id,
                status: 'BOOKED',
                bookedAt: slot.bookedAt,
              },
            },
          },
          {
            $set: {
              'slots.$[elem].status': 'AVAILABLE',
              'slots.$[elem].bookingRef': null,
              'slots.$[elem].bookedAt': null,
            },
          },
          {
            arrayFilters: [
              {
                'elem.id': slot.id,
                'elem.status': 'BOOKED',
                'elem.bookedAt': slot.bookedAt,
              },
            ],
          },
        );
        if (updateRes.modifiedCount === 1) {
          reconciledCount += 1;
        }
      }
    }
  }

  return { reconciledCount };
}

/**
 * Helper to serialize an appointment for Patient response,
 * matching frontend normalizeAppointment contract.
 */
function serializePatientAppointment(
  appointment,
  doctorMap = new Map(),
  specialtyMap = new Map(),
  prescriptions = [],
) {
  const doctorName = doctorMap.get(appointment.doctorId) || 'N/A';
  const specialtyName = specialtyMap.get(appointment.specialtyId) || 'N/A';
  const primaryPatientName = appointment.patients?.[0]?.fullName || 'N/A';

  const serialized = {
    id: appointment.id,
    appointmentNo: appointment.appointmentNo,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    status: appointment.status,
    patientName: primaryPatientName,
    doctorId: appointment.doctorId,
    doctorName,
    specialtyId: appointment.specialtyId,
    specialtyName,
    shiftId: appointment.shiftId,
    actualStartTime: appointment.actualStartTime || null,
    actualEndTime: appointment.actualEndTime || null,
    reason: appointment.reason || undefined,
    type: appointment.type || 'OFFLINE',
    patients: (appointment.patients || []).map((p) => ({
      id: p.id,
      fullName: p.fullName,
      gender: p.gender,
      phoneNumber: p.phoneNumber,
      dob: p.dob,
      relationship: p.relationship,
    })),
    cancelReason: appointment.cancelReason || undefined,
    cancelledAt: appointment.cancelledAt
      ? new Date(appointment.cancelledAt).toISOString()
      : undefined,
    createdAt: appointment.createdAt
      ? new Date(appointment.createdAt).toISOString()
      : undefined,
    updatedAt: appointment.updatedAt
      ? new Date(appointment.updatedAt).toISOString()
      : undefined,
  };

  if (prescriptions && prescriptions.length > 0) {
    serialized.prescriptions = prescriptions.map((p) => ({
      id: p.id,
      medicineName: p.medicineName,
      dosage: p.dosage,
      duration: p.duration,
      instructions: p.instructions,
    }));
  }

  return serialized;
}

/**
 * UC-PAT-05: Get upcoming appointments for current Patient.
 * Statuses: PENDING_CONFIRMATION, CONFIRMED, CHECKED_IN.
 * Ordered by appointmentDate ASC, appointmentTime ASC.
 */
async function getMyUpcomingAppointments(user) {
  if (!user || user.userType !== ROLES.PATIENT) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền truy cập');
  }

  const upcomingStatuses = [
    APPOINTMENT_STATUSES.PENDING_PAYMENT,
    APPOINTMENT_STATUSES.PENDING_CONFIRMATION,
    APPOINTMENT_STATUSES.CONFIRMED,
    APPOINTMENT_STATUSES.CHECKED_IN,
  ];

  const appointments = await Appointment.find({
    patientId: user.id,
    status: { $in: upcomingStatuses },
  })
    .sort({ appointmentDate: 1, appointmentTime: 1, id: 1 })
    .lean();

  if (!appointments.length) {
    return [];
  }

  const doctorIds = [...new Set(appointments.map((a) => a.doctorId))];
  const specialtyIds = [...new Set(appointments.map((a) => a.specialtyId))];

  const [doctors, specialties] = await Promise.all([
    User.find({ id: { $in: doctorIds } }).select('id fullName').lean(),
    Specialty.find({ id: { $in: specialtyIds } }).select('id name').lean(),
  ]);

  const doctorMap = new Map(doctors.map((d) => [d.id, d.fullName]));
  const specialtyMap = new Map(specialties.map((s) => [s.id, s.name]));

  return appointments.map((a) =>
    serializePatientAppointment(a, doctorMap, specialtyMap),
  );
}

/**
 * UC-PAT-05: Get history/completed appointments for current Patient.
 * Statuses: COMPLETED.
 * Ordered by appointmentDate DESC, appointmentTime DESC.
 */
async function getMyCompletedAppointments(user, query = {}) {
  if (!user || user.userType !== ROLES.PATIENT) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền truy cập');
  }

  const completedStatuses = [APPOINTMENT_STATUSES.COMPLETED];
  const filter = {
    patientId: user.id,
    status: { $in: completedStatuses },
  };

  const { fromDate, toDate, startDate, endDate } = query || {};
  const from = fromDate || startDate;
  const to = toDate || endDate;

  if (from || to) {
    filter.appointmentDate = {};
    if (from) filter.appointmentDate.$gte = String(from).trim();
    if (to) filter.appointmentDate.$lte = String(to).trim();
  }

  const appointments = await Appointment.find(filter)
    .sort({ appointmentDate: -1, appointmentTime: -1, id: -1 })
    .lean();

  if (!appointments.length) {
    return [];
  }

  const doctorIds = [...new Set(appointments.map((a) => a.doctorId))];
  const specialtyIds = [...new Set(appointments.map((a) => a.specialtyId))];

  const [doctors, specialties] = await Promise.all([
    User.find({ id: { $in: doctorIds } }).select('id fullName').lean(),
    Specialty.find({ id: { $in: specialtyIds } }).select('id name').lean(),
  ]);

  const doctorMap = new Map(doctors.map((d) => [d.id, d.fullName]));
  const specialtyMap = new Map(specialties.map((s) => [s.id, s.name]));

  return appointments.map((a) =>
    serializePatientAppointment(a, doctorMap, specialtyMap),
  );
}

/**
 * UC-PAT-05: Get single appointment detail for current Patient.
 * Must belong to current Patient (patientId === user.id); otherwise 404.
 */
async function getPatientAppointmentDetail(user, appointmentId) {
  if (!user || user.userType !== ROLES.PATIENT) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền truy cập');
  }

  const id = parsePositiveInt(appointmentId, 'id');

  const appointment = await Appointment.findOne({
    id,
    patientId: user.id,
  }).lean();

  if (!appointment) {
    throw new ApiError(404, 'Không tìm thấy lịch hẹn');
  }

  const [doctor, specialty, prescriptions] = await Promise.all([
    User.findOne({ id: appointment.doctorId }).select('id fullName').lean(),
    Specialty.findOne({ id: appointment.specialtyId }).select('id name').lean(),
    Prescription.find({ appointmentId: appointment.id }).sort({ id: 1 }).lean(),
  ]);

  const doctorMap = new Map([[appointment.doctorId, doctor?.fullName || 'N/A']]);
  const specialtyMap = new Map([[appointment.specialtyId, specialty?.name || 'N/A']]);

  return serializePatientAppointment(
    appointment,
    doctorMap,
    specialtyMap,
    prescriptions,
  );
}


/**
 * Helper to compute Date object for appointment date & time in clinic timezone.
 */
function getAppointmentStartDateTime(dateStr, timeStr, timeZone = env.clinicTimeZone) {
  const [hours, minutes] = (timeStr || '00:00').split(':').map((s) => s.padStart(2, '0'));
  const [year, month, day] = (dateStr || '').split('-').map(Number);

  const tempDate = new Date();
  const utcStr = tempDate.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = tempDate.toLocaleString('en-US', { timeZone });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();

  const utcEquivalent = Date.UTC(year, month - 1, day, Number(hours), Number(minutes), 0, 0);
  return new Date(utcEquivalent - diffMs);
}

/**
 * Best-effort cancellation notification helper (A10).
 */
async function sendCancellationNotification(patient, appointment) {
  try {
    console.log(
      `[Notification] Cancellation notification dispatched for appointment ${appointment.appointmentNo} (Patient: ${patient.id})`,
    );
    return { sent: true };
  } catch (err) {
    console.error(
      `[Notification] Failed to send cancellation notification for appointment ${appointment.appointmentNo}:`,
      err,
    );
    return { sent: false, error: err.message };
  }
}

/**
 * UC-PAT-06: Cancel appointment by Patient.
 * Enforces ownership (BR-01), 24h limit (BR-02), lock threshold (BR-03),
 * status validation (BR-04), atomic slot release (BR-05), audit log (BR-06).
 */
async function cancelPatientAppointment(user, appointmentId, body = {}, req = null) {
  if (!user || user.userType !== ROLES.PATIENT) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền hủy lịch khám');
  }

  const id = parsePositiveInt(appointmentId, 'id');

  // 1. Fetch appointment & verify existence (A1) and ownership (BR-01, A2)
  const appointment = await Appointment.findOne({ id }).lean();
  if (!appointment) {
    throw new ApiError(404, 'Không tìm thấy lịch hẹn');
  }

  if (appointment.patientId !== user.id) {
    throw new ApiError(403, 'Bạn không có quyền truy cập hoặc hủy lịch hẹn này');
  }

  // 2. Idempotency: If already CANCELLED, return current state without double release (BR-05, A8)
  if (appointment.status === APPOINTMENT_STATUSES.CANCELLED) {
    const [doctor, specialty] = await Promise.all([
      User.findOne({ id: appointment.doctorId }).select('id fullName').lean(),
      Specialty.findOne({ id: appointment.specialtyId }).select('id name').lean(),
    ]);
    const doctorMap = new Map([[appointment.doctorId, doctor?.fullName || 'N/A']]);
    const specialtyMap = new Map([[appointment.specialtyId, specialty?.name || 'N/A']]);
    return serializePatientAppointment(appointment, doctorMap, specialtyMap);
  }

  // 3. Status validation: Cannot cancel completed or already started appointments (BR-04, A4, A5)
  const nonCancellableStatuses = [
    APPOINTMENT_STATUSES.CHECKED_IN,
    APPOINTMENT_STATUSES.IN_PROGRESS,
    APPOINTMENT_STATUSES.COMPLETED,
    APPOINTMENT_STATUSES.EXPIRED,
    APPOINTMENT_STATUSES.NO_SHOW,
  ];
  if (nonCancellableStatuses.includes(appointment.status)) {
    throw new ApiError(400, 'Không thể hủy lịch khám đã hoàn tất hoặc đã bắt đầu khám');
  }

  const cancellableStatuses = [
    APPOINTMENT_STATUSES.PENDING_CONFIRMATION,
    APPOINTMENT_STATUSES.CONFIRMED,
    APPOINTMENT_STATUSES.PENDING_PAYMENT,
  ];
  if (!cancellableStatuses.includes(appointment.status)) {
    throw new ApiError(400, `Không thể hủy lịch khám ở trạng thái ${appointment.status}`);
  }

  // 4. Time limit check: Reject if less than 24h before start time or in past (BR-02, A3, A4)
  const now = new Date();
  const startDateTime = getAppointmentStartDateTime(
    appointment.appointmentDate,
    appointment.appointmentTime,
    env.clinicTimeZone,
  );
  const diffMs = startDateTime.getTime() - now.getTime();
  const diffHours = diffMs / (3600 * 1000);

  if (diffMs <= 0) {
    throw new ApiError(400, 'Lịch khám đã bắt đầu hoặc đã qua thời gian khám, không thể hủy');
  }

  if (diffHours < env.cancelMinHours) {
    throw new ApiError(
      400,
      `Không thể hủy lịch khám trong vòng ${env.cancelMinHours} giờ trước giờ bắt đầu ca khám`,
    );
  }

  // 5. Cancellation reason validation (Main Flow 6, A7)
  let cancelReason = 'Bệnh nhân yêu cầu hủy';
  if (body && body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string') {
      throw new ApiError(400, 'Lý do hủy không hợp lệ');
    }
    const trimmed = body.reason.trim();
    if (!trimmed) {
      throw new ApiError(400, 'Lý do hủy không được để trống');
    }
    if (trimmed.length > 500) {
      throw new ApiError(400, 'Lý do hủy không được vượt quá 500 ký tự');
    }
    cancelReason = trimmed;
  }

  // 6. Atomic status transition on Appointment
  const previousStatus = appointment.status;
  const updatedAppointment = await Appointment.findOneAndUpdate(
    {
      id: appointment.id,
      patientId: user.id,
      status: { $in: cancellableStatuses },
    },
    {
      $set: {
        status: APPOINTMENT_STATUSES.CANCELLED,
        cancelReason,
        cancelledAt: now,
      },
    },
    { returnDocument: 'after' },
  ).lean();

  if (!updatedAppointment) {
    // Concurrent request already modified status; check for idempotency (A8)
    const fresh = await Appointment.findOne({ id: appointment.id }).lean();
    if (fresh && fresh.status === APPOINTMENT_STATUSES.CANCELLED) {
      const [doctor, specialty] = await Promise.all([
        User.findOne({ id: fresh.doctorId }).select('id fullName').lean(),
        Specialty.findOne({ id: fresh.specialtyId }).select('id name').lean(),
      ]);
      const doctorMap = new Map([[fresh.doctorId, doctor?.fullName || 'N/A']]);
      const specialtyMap = new Map([[fresh.specialtyId, specialty?.name || 'N/A']]);
      return serializePatientAppointment(fresh, doctorMap, specialtyMap);
    }
    throw new ApiError(409, 'Lịch khám đang được xử lý hoặc đã thay đổi trạng thái');
  }

  // 7. Atomic slot release on DoctorShift (BR-05)
  const slotIdsToRelease = Array.isArray(appointment.slotIds) ? appointment.slotIds : [];
  if (slotIdsToRelease.length > 0) {
    try {
      await DoctorShift.updateOne(
        { id: appointment.shiftId },
        {
          $set: {
            'slots.$[elem].status': 'AVAILABLE',
            'slots.$[elem].bookingRef': null,
            'slots.$[elem].bookedAt': null,
          },
        },
        {
          arrayFilters: [
            {
              'elem.id': { $in: slotIdsToRelease },
              'elem.status': 'BOOKED',
              'elem.bookingRef': appointment.appointmentNo,
            },
          ],
        },
      );
    } catch (slotErr) {
      // A9: Rollback appointment update if slot release fails
      console.error(
        `[cancelPatientAppointment] Slot release failed for shift ${appointment.shiftId}:`,
        slotErr,
      );
      await Appointment.updateOne(
        { id: appointment.id },
        {
          $set: {
            status: previousStatus,
            cancelReason: null,
            cancelledAt: null,
          },
        },
      );
      throw new ApiError(500, 'Không thể giải phóng khung giờ khám, thao tác hủy đã được hoàn tác');
    }
  }

  // 7.1 Giải phóng voucher đang giữ cho lịch hẹn (nếu có)
  try {
    const heldVoucher = await UserVoucher.findOne({
      appointmentId: appointment.id,
      used: true,
    }).lean();
    if (heldVoucher) {
      await voucherRedemptionService.release(heldVoucher.id, appointment.id, user, req);
    }
  } catch (voucherErr) {
    console.error(`[cancelPatientAppointment] Không thể giải phóng voucher cho lịch hẹn ${appointment.id}:`, voucherErr);
  }

  // 8. Enforce 3-cancellation booking lock policy for 24 hours (BR-03, A6)
  // Only cancellations initiated by the Patient count against their lock threshold.
  // Cancellations initiated by clinic staff (Receptionist/Admin) do not penalize the Patient.
  const totalCancelled = await Appointment.countDocuments({
    patientId: user.id,
    status: APPOINTMENT_STATUSES.CANCELLED,
    $or: [
      { cancelledBy: null },
      { cancelledBy: user.id },
      { cancelledBy: String(user.id) },
    ],
  });

  const lockThreshold = env.cancelLockThreshold || 3;
  const lockDurationHours = env.bookingLockDurationHours || 24;
  let isLockActivated = false;
  let lockedUntil = null;

  if (totalCancelled >= lockThreshold) {
    isLockActivated = true;
    lockedUntil = new Date(now.getTime() + lockDurationHours * 3600 * 1000);

    await User.updateOne(
      { id: user.id },
      {
        $set: {
          isBookingLocked: true,
          bookingLockedAt: now,
          bookingLockedUntil: lockedUntil,
          bookingLockedReason: `Đạt ngưỡng ${lockThreshold} lần hủy lịch khám (khóa quyền đặt lịch trong ${lockDurationHours} giờ)`,
        },
      },
    );
  }

  // 9. Record AuditLog (BR-06)
  try {
    await recordAudit({
      actor: user,
      action: AUDIT_ACTIONS.APPOINTMENT_CANCEL,
      targetType: 'APPOINTMENT',
      targetId: appointment.id,
      reason: cancelReason,
      changes: {
        previousStatus,
        newStatus: APPOINTMENT_STATUSES.CANCELLED,
        releasedSlotIds: slotIdsToRelease,
        cancelledAt: now,
        totalCancellations: totalCancelled,
        bookingLocked: isLockActivated,
        bookingLockedUntil: lockedUntil,
      },
      req,
    });
  } catch (auditErr) {
    console.error('[cancelPatientAppointment] Failed to record AuditLog:', auditErr);
  }

  // 10. Best-effort notification (Main Flow 13, A10)
  await sendCancellationNotification(user, updatedAppointment);

  // 11. Serialize and return response (Main Flow 14)
  const [doctor, specialty] = await Promise.all([
    User.findOne({ id: updatedAppointment.doctorId }).select('id fullName').lean(),
    Specialty.findOne({ id: updatedAppointment.specialtyId }).select('id name').lean(),
  ]);

  const doctorMap = new Map([[updatedAppointment.doctorId, doctor?.fullName || 'N/A']]);
  const specialtyMap = new Map([[updatedAppointment.specialtyId, specialty?.name || 'N/A']]);

  return serializePatientAppointment(updatedAppointment, doctorMap, specialtyMap);
}

module.exports = {
  bookAppointment,
  reconcileOrphanSlots,
  generateAppointmentNo,
  getMyUpcomingAppointments,
  getMyCompletedAppointments,
  getPatientAppointmentDetail,
  serializePatientAppointment,
  cancelPatientAppointment,
  getAppointmentStartDateTime,
};

