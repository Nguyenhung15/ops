const bcrypt = require('bcryptjs');
const ApiError = require('../utils/ApiError');
const {
  normalizeEmail,
  normalizePhoneNumber,
  normalizeGender,
  normalizeRole,
  parsePositiveInt,
  escapeRegex,
} = require('../utils/normalizers');
const {
  ROLES,
  AUTH_PROVIDERS,
  AUDIT_ACTIONS,
  ACTIVE_APPOINTMENT_STATUSES,
} = require('../constants/enums');
const {
  User,
  Specialty,
  DoctorShift,
  Appointment,
  Prescription,
  PaymentTransaction,
  GroupHealthAssignment,
  ShiftCancellationRequest,
  Image,
} = require('../models');
const { resolveSpecialty } = require('./specialty.service');
const { BCRYPT_ROUNDS, validatePasswordStrength } = require('./auth.service');
const { recordAudit, buildAuditDiff, sanitizeSnapshot } = require('./audit.service');

/**
 * Batch-enrich user DTOs with `specialtyName` (avoids N+1 queries on list endpoints).
 */
async function enrichUsersWithSpecialty(userDocs) {
  const list = Array.isArray(userDocs) ? userDocs : [];
  if (list.length === 0) return [];

  const plainUsers = list.map((u) => (typeof u.toJSON === 'function' ? u.toJSON() : { ...u }));
  const specialtyIds = [
    ...new Set(
      plainUsers
        .map((u) => u.specialtyId)
        .filter((id) => typeof id === 'number' && id > 0),
    ),
  ];

  let specialtyMap = new Map();
  if (specialtyIds.length > 0) {
    const specialties = await Specialty.find({ id: { $in: specialtyIds } }).lean();
    specialtyMap = new Map(specialties.map((sp) => [sp.id, sp.name]));
  }

  return plainUsers.map((u) => ({
    ...u,
    specialtyName: u.specialtyId ? specialtyMap.get(u.specialtyId) || null : null,
  }));
}

async function enrichSingleUser(userDoc) {
  const [enriched] = await enrichUsersWithSpecialty([userDoc]);
  return enriched;
}

/**
 * Summarize medical, schedule, and payment relations linked to a user account.
 * Used both for Admin detail inspection and UC-ADM-01 role-change / history protection checks.
 */
async function getUserRelationSummary(userId) {
  const [
    activeShiftsCount,
    totalShiftsCount,
    doctorAppointmentsTotal,
    doctorAppointmentsActive,
    patientAppointmentsTotal,
    patientAppointmentsActive,
    receptionistActiveConfirmedCount,
    linkedAppointments,
  ] = await Promise.all([
    DoctorShift.countDocuments({ doctorId: userId, status: 'ACTIVE' }),
    DoctorShift.countDocuments({ doctorId: userId }),
    Appointment.countDocuments({ doctorId: userId }),
    Appointment.countDocuments({
      doctorId: userId,
      status: { $in: ACTIVE_APPOINTMENT_STATUSES },
    }),
    Appointment.countDocuments({ patientId: userId }),
    Appointment.countDocuments({
      patientId: userId,
      status: { $in: ACTIVE_APPOINTMENT_STATUSES },
    }),
    Appointment.countDocuments({
      confirmedBy: userId,
      status: { $in: ACTIVE_APPOINTMENT_STATUSES },
    }),
    Appointment.find(
      { $or: [{ doctorId: userId }, { patientId: userId }] },
      { id: 1, _id: 0 },
    ).lean(),
  ]);

  const appointmentIds = linkedAppointments.map((apt) => apt.id);
  let prescriptionsCount = 0;
  let paymentTransactionsCount = 0;

  if (appointmentIds.length > 0) {
    [prescriptionsCount, paymentTransactionsCount] = await Promise.all([
      Prescription.countDocuments({ appointmentId: { $in: appointmentIds } }),
      PaymentTransaction.countDocuments({ appointmentId: { $in: appointmentIds } }),
    ]);
  }

  return {
    activeShiftsCount,
    totalShiftsCount,
    doctorAppointmentsTotal,
    doctorAppointmentsActive,
    patientAppointmentsTotal,
    patientAppointmentsActive,
    receptionistActiveConfirmedCount,
    prescriptionsCount,
    paymentTransactionsCount,
  };
}

/**
 * Ensure at least one active Admin remains in the system before locking or demoting an Admin.
 */
async function ensureNotLastActiveAdmin(targetUser, actionVerb = 'thao tác') {
  if (targetUser.userType !== ROLES.ADMIN || !targetUser.isEnable) return;

  const otherActiveAdmins = await User.countDocuments({
    userType: ROLES.ADMIN,
    isEnable: true,
    id: { $ne: targetUser.id },
  });

  if (otherActiveAdmins === 0) {
    throw new ApiError(
      409,
      `Không thể ${actionVerb} tài khoản Admin đang hoạt động cuối cùng của hệ thống`,
    );
  }
}

/**
 * UC-ADM-01: Validate relational constraints before changing a user's `userType` (role).
 */
async function validateRoleTransition(actor, targetUser, nextRole) {
  if (targetUser.userType === nextRole) return null;

  if (actor && actor.id === targetUser.id) {
    throw new ApiError(400, 'Không thể tự chuyển đổi vai trò của chính mình');
  }

  await ensureNotLastActiveAdmin(targetUser, 'chuyển đổi vai trò của');

  const relations = await getUserRelationSummary(targetUser.id);

  if (targetUser.userType === ROLES.DOCTOR) {
    if (
      relations.activeShiftsCount > 0 ||
      relations.doctorAppointmentsTotal > 0 ||
      relations.prescriptionsCount > 0
    ) {
      throw new ApiError(
        409,
        `Không thể chuyển vai trò Bác sĩ sang '${nextRole}' vì tài khoản đang gắn với dữ liệu y tế/lịch trực ` +
          `(${relations.activeShiftsCount} ca trực đang mở, ${relations.doctorAppointmentsTotal} lịch khám, ` +
          `${relations.prescriptionsCount} đơn thuốc). Vui lòng khóa tài khoản để bảo toàn lịch sử y tế.`,
      );
    }
  }

  if (targetUser.userType === ROLES.PATIENT) {
    if (
      relations.patientAppointmentsTotal > 0 ||
      relations.paymentTransactionsCount > 0
    ) {
      throw new ApiError(
        409,
        `Không thể chuyển vai trò Bệnh nhân sang '${nextRole}' vì tài khoản đã phát sinh lịch sử khám/thanh toán ` +
          `(${relations.patientAppointmentsTotal} lịch hẹn, ${relations.paymentTransactionsCount} giao dịch thanh toán).`,
      );
    }
  }

  if (targetUser.userType === ROLES.RECEPTIONIST) {
    if (relations.receptionistActiveConfirmedCount > 0) {
      throw new ApiError(
        409,
        `Không thể chuyển vai trò Lễ tân sang '${nextRole}' khi đang phụ trách ` +
          `${relations.receptionistActiveConfirmedCount} lịch hẹn chưa hoàn tất.`,
      );
    }
  }

  return relations;
}

/**
 * List users with flexible filters & Receptionist scope enforcement.
 */
async function listUsers({
  actor = null,
  role = null,
  includeDisabled = false,
  onlyDisabled = false,
  specialtyId = null,
  keyword = null,
} = {}) {
  const filter = {};

  // Receptionist scope protection: Receptionists may only inspect Patient accounts
  if (actor && actor.userType === ROLES.RECEPTIONIST) {
    filter.userType = ROLES.PATIENT;
  } else if (role) {
    filter.userType = normalizeRole(role);
  }

  if (onlyDisabled) {
    filter.isEnable = false;
  } else if (!includeDisabled) {
    filter.isEnable = true;
  }

  if (specialtyId !== null && specialtyId !== undefined && specialtyId !== '') {
    filter.specialtyId = parsePositiveInt(specialtyId, 'specialtyId');
  }

  if (typeof keyword === 'string' && keyword.trim()) {
    const safeRegex = new RegExp(escapeRegex(keyword.trim()), 'i');
    filter.$or = [
      { fullName: safeRegex },
      { email: safeRegex },
      { phoneNumber: safeRegex },
    ];
  }

  const docs = await User.find(filter).sort({ id: -1 });
  return enrichUsersWithSpecialty(docs);
}

/**
 * Get user by numeric ID, optionally enforcing expected role and attaching relation summary.
 */
async function getUserById(id, { expectedRole = null, includeRelations = false } = {}) {
  const numericId = parsePositiveInt(id, 'userId');
  const filter = { id: numericId };
  if (expectedRole) {
    filter.userType = expectedRole;
  }

  const user = await User.findOne(filter);
  if (!user) {
    const label = expectedRole || 'người dùng';
    throw new ApiError(404, `Không tìm thấy ${label} với ID #${numericId}`);
  }

  const dto = await enrichSingleUser(user);
  if (includeRelations) {
    dto.relations = await getUserRelationSummary(user.id);
  }
  return dto;
}

/**
 * UC-ADM-01: Admin creates a user of any valid role (Doctor, Receptionist, Patient, Admin).
 */
async function createUser(actor, payload, req) {
  const fullName = typeof payload?.fullName === 'string' ? payload.fullName.trim() : '';
  if (!fullName) {
    throw new ApiError(400, 'Họ và tên không được để trống');
  }

  const email = normalizeEmail(payload?.email);
  validatePasswordStrength(payload?.password);
  const userType = normalizeRole(payload?.userType || ROLES.PATIENT);

  const existing = await User.findOne({ email });
  if (existing) {
    throw new ApiError(409, 'Email đã tồn tại trong hệ thống');
  }

  const userData = {
    fullName,
    email,
    phoneNumber: normalizePhoneNumber(payload?.phoneNumber),
    password: await bcrypt.hash(payload.password, BCRYPT_ROUNDS),
    gender: normalizeGender(payload?.gender),
    userType,
    isEnable:
      payload?.isEnable !== undefined
        ? Boolean(payload.isEnable)
        : payload?.isEnabled !== undefined
        ? Boolean(payload.isEnabled)
        : true,
    authProvider: AUTH_PROVIDERS.LOCAL,
  };

  if (userType === ROLES.DOCTOR) {
    const specialty = await resolveSpecialty({
      specialtyId: payload?.specialtyId,
      specialization: payload?.specialization,
    });
    userData.specialtyId = specialty.id;
    userData.degree = payload?.degree ? String(payload.degree).trim() : null;
    userData.description = payload?.description ? String(payload.description).trim() : null;
    userData.experience = payload?.experience ? String(payload.experience).trim() : null;
    
    let consultationFee = null;
    if (payload?.consultationFee !== undefined && payload?.consultationFee !== null && payload?.consultationFee !== '') {
      const feeNum = Number(payload.consultationFee);
      if (Number.isNaN(feeNum) || feeNum < 0) {
        throw new ApiError(400, 'Phí khám (consultationFee) phải là số không âm (>= 0)');
      }
      consultationFee = feeNum;
    }
    userData.consultationFee = consultationFee;
    userData.isVip = Boolean(payload?.isVip);
  }

  const created = await User.create(userData);
  const enriched = await enrichSingleUser(created);

  await recordAudit({
    actor,
    action: AUDIT_ACTIONS.USER_CREATE,
    targetType: 'User',
    targetId: created.id,
    reason: payload?.reason || `Tạo tài khoản ${userType} mới`,
    changes: { before: null, after: sanitizeSnapshot(enriched) },
    req,
  });

  return enriched;
}

/**
 * UC-ADM-01: Update user details (and optionally transition `userType` role with relation checks).
 */
async function updateUser(actor, targetId, payload, { expectedCurrentRole = null, req = null } = {}) {
  const numericId = parsePositiveInt(targetId, 'userId');
  const user = await User.findOne({ id: numericId });
  if (!user) {
    throw new ApiError(404, `Không tìm thấy người dùng với ID #${numericId}`);
  }

  if (expectedCurrentRole && user.userType !== expectedCurrentRole) {
    throw new ApiError(
      400,
      `Tài khoản #${numericId} không phải vai trò '${expectedCurrentRole}' (hiện tại: '${user.userType}')`,
    );
  }

  const beforeSnap = await enrichSingleUser(user);
  const previousRole = user.userType;
  const nextRole =
    payload?.userType !== undefined ? normalizeRole(payload.userType) : previousRole;
  const roleChanged = nextRole !== previousRole;

  if (roleChanged) {
    await validateRoleTransition(actor, user, nextRole);
    user.userType = nextRole;
  }

  // Update email if provided and changed (enforce uniqueness)
  if (payload?.email !== undefined) {
    const normalizedEmail = normalizeEmail(payload.email);
    if (normalizedEmail !== user.email) {
      const emailConflict = await User.findOne({
        email: normalizedEmail,
        id: { $ne: user.id },
      });
      if (emailConflict) {
        throw new ApiError(409, 'Email đã tồn tại trong hệ thống');
      }
      user.email = normalizedEmail;
    }
  }

  if (payload?.fullName !== undefined) {
    const trimmedName = String(payload.fullName).trim();
    if (!trimmedName) {
      throw new ApiError(400, 'Họ và tên không được để trống');
    }
    user.fullName = trimmedName;
  }

  if (payload?.phoneNumber !== undefined) {
    user.phoneNumber = normalizePhoneNumber(payload.phoneNumber);
  }

  if (payload?.gender !== undefined) {
    user.gender = normalizeGender(payload.gender);
  }

  if (payload?.password !== undefined && payload.password !== '') {
    validatePasswordStrength(payload.password);
    user.password = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);
  }

  // Handle status update (isEnable / isEnabled)
  if (payload?.isEnable !== undefined || payload?.isEnabled !== undefined) {
    const nextStatus =
      payload.isEnable !== undefined ? Boolean(payload.isEnable) : Boolean(payload.isEnabled);
    if (nextStatus !== user.isEnable) {
      if (!nextStatus) {
        await ensureNotLastActiveAdmin(user, 'khóa');
        user.isEnable = false;
        user.disabledAt = new Date();
        user.disabledBy = actor.id;
        user.disabledReason =
          typeof payload?.disabledReason === 'string' && payload.disabledReason.trim()
            ? payload.disabledReason.trim()
            : typeof payload?.reason === 'string' && payload.reason.trim()
            ? payload.reason.trim()
            : 'Vô hiệu hóa tài khoản qua cập nhật hồ sơ';
      } else {
        user.isEnable = true;
        user.disabledAt = null;
        user.disabledBy = null;
        user.disabledReason = null;
      }
    }
  }

  // Handle Doctor-specific fields
  if (nextRole === ROLES.DOCTOR) {
    const wantsSpecialtyUpdate =
      roleChanged ||
      payload?.specialtyId !== undefined ||
      payload?.specialization !== undefined;

    if (wantsSpecialtyUpdate) {
      const specialty = await resolveSpecialty({
        specialtyId: payload?.specialtyId ?? user.specialtyId,
        specialization: payload?.specialization,
      });
      // UC-ADM-02: Updating doctor's specialty affects future scheduling.
      // Existing Appointment records preserve their immutable `appointment.specialtyId`
      // so past medical & appointment histories remain 100% intact.
      user.specialtyId = specialty.id;
    }

    if (payload?.degree !== undefined) {
      user.degree = payload.degree ? String(payload.degree).trim() : null;
    }
    if (payload?.description !== undefined) {
      user.description = payload.description ? String(payload.description).trim() : null;
    }
    if (payload?.experience !== undefined) {
      user.experience = payload.experience ? String(payload.experience).trim() : null;
    }
    if (payload?.consultationFee !== undefined) {
      if (payload.consultationFee === null || payload.consultationFee === '') {
        user.consultationFee = null;
      } else {
        const feeNum = Number(payload.consultationFee);
        if (Number.isNaN(feeNum) || feeNum < 0) {
          throw new ApiError(400, 'Phí khám (consultationFee) phải là số không âm (>= 0)');
        }
        user.consultationFee = feeNum;
      }
    }
    if (payload?.isVip !== undefined) {
      user.isVip = Boolean(payload.isVip);
    }
  } else if (roleChanged && previousRole === ROLES.DOCTOR) {
    // Transitioned away from Doctor (verified 0 relations above): clear Doctor-only attributes
    user.specialtyId = null;
    user.degree = null;
    user.description = null;
    user.experience = null;
    user.consultationFee = null;
    user.isVip = false;
  }

  await user.save();
  const afterSnap = await enrichSingleUser(user);

  await recordAudit({
    actor,
    action: roleChanged ? AUDIT_ACTIONS.USER_ROLE_CHANGE : AUDIT_ACTIONS.USER_UPDATE,
    targetType: 'User',
    targetId: user.id,
    reason:
      payload?.reason ||
      (roleChanged
        ? `Chuyển vai trò từ ${previousRole} sang ${nextRole}`
        : `Cập nhật thông tin tài khoản ${user.userType}`),
    changes: buildAuditDiff(beforeSnap, afterSnap),
    req,
  });

  return afterSnap;
}

/**
 * UC-ADM-01: Soft-lock (disable) user account.
 * NEVER hard-deletes users so medical & payment history remain 100% intact.
 */
async function lockUser(actor, targetId, { reason = null, req = null } = {}) {
  const numericId = parsePositiveInt(targetId, 'userId');
  const user = await User.findOne({ id: numericId });
  if (!user) {
    throw new ApiError(404, `Không tìm thấy người dùng với ID #${numericId}`);
  }

  if (actor.id === user.id) {
    throw new ApiError(400, 'Không thể tự khóa tài khoản của chính mình');
  }

  if (actor.userType === ROLES.RECEPTIONIST && user.userType !== ROLES.PATIENT) {
    throw new ApiError(403, 'Lễ tân chỉ được phép khóa tài khoản Bệnh nhân');
  }

  await ensureNotLastActiveAdmin(user, 'khóa');

  const beforeSnap = await enrichSingleUser(user);
  const resolvedReason =
    typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : 'Khóa tài khoản bởi quản trị viên';

  user.isEnable = false;
  user.disabledAt = new Date();
  user.disabledBy = actor.id;
  user.disabledReason = resolvedReason;
  await user.save();

  const afterSnap = await enrichSingleUser(user);

  await recordAudit({
    actor,
    action: AUDIT_ACTIONS.USER_LOCK,
    targetType: 'User',
    targetId: user.id,
    reason: resolvedReason,
    changes: buildAuditDiff(beforeSnap, afterSnap, [
      'isEnable',
      'isEnabled',
      'disabledAt',
      'disabledBy',
      'disabledReason',
    ]),
    req,
  });

  return afterSnap;
}

/**
 * UC-ADM-01: Unlock (activate) a previously disabled user account.
 */
async function unlockUser(actor, targetId, { reason = null, req = null } = {}) {
  const numericId = parsePositiveInt(targetId, 'userId');
  const user = await User.findOne({ id: numericId });
  if (!user) {
    throw new ApiError(404, `Không tìm thấy người dùng với ID #${numericId}`);
  }

  if (actor.userType === ROLES.RECEPTIONIST && user.userType !== ROLES.PATIENT) {
    throw new ApiError(403, 'Lễ tân chỉ được phép mở khóa tài khoản Bệnh nhân');
  }

  const beforeSnap = await enrichSingleUser(user);
  const resolvedReason =
    typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : 'Mở khóa tài khoản bởi quản trị viên';

  user.isEnable = true;
  user.disabledAt = null;
  user.disabledBy = null;
  user.disabledReason = null;
  await user.save();

  const afterSnap = await enrichSingleUser(user);

  await recordAudit({
    actor,
    action: AUDIT_ACTIONS.USER_UNLOCK,
    targetType: 'User',
    targetId: user.id,
    reason: resolvedReason,
    changes: buildAuditDiff(beforeSnap, afterSnap, [
      'isEnable',
      'isEnabled',
      'disabledAt',
      'disabledBy',
      'disabledReason',
    ]),
    req,
  });

  return afterSnap;
}

/**
 * Self-service profile update (`PUT /api/users/update`).
 */
async function updateOwnProfile(actor, payload, req) {
  const user = await User.findOne({ id: actor.id });
  if (!user) {
    throw new ApiError(404, 'Không tìm thấy tài khoản');
  }

  const beforeSnap = sanitizeSnapshot(user);

  if (payload?.fullName !== undefined) {
    const trimmed = String(payload.fullName).trim();
    if (!trimmed) {
      throw new ApiError(400, 'Họ và tên không được để trống');
    }
    user.fullName = trimmed;
  }
  if (payload?.phoneNumber !== undefined) {
    user.phoneNumber = normalizePhoneNumber(payload.phoneNumber);
  }
  if (payload?.gender !== undefined) {
    user.gender = normalizeGender(payload.gender);
  }

  await user.save();
  const afterSnap = await enrichSingleUser(user);

  await recordAudit({
    actor: user,
    action: AUDIT_ACTIONS.USER_UPDATE,
    targetType: 'User',
    targetId: user.id,
    reason: 'Người dùng tự cập nhật hồ sơ cá nhân',
    changes: buildAuditDiff(beforeSnap, afterSnap),
    req,
  });

  return afterSnap;
}

/**
 * Search users by keyword (`GET /api/users/search?keyword=...` for Receptionist/Admin).
 */
async function searchUsers(keyword = '') {
  const filter = { isEnable: true };
  if (typeof keyword === 'string' && keyword.trim()) {
    const safeRegex = new RegExp(escapeRegex(keyword.trim()), 'i');
    filter.$or = [
      { fullName: safeRegex },
      { email: safeRegex },
      { phoneNumber: safeRegex },
    ];
  }
  const users = await User.find(filter).sort({ id: 1 }).limit(50);
  return users.map((u) => ({
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phoneNumber: u.phoneNumber,
    phone: u.phoneNumber,
    userType: u.userType,
  }));
}

/**
 * UC-ADM-02: Delete staff (Doctor / Receptionist).
 * Exception / Hard constraint: NEVER delete staff with existing history
 * (shifts, appointments, prescriptions, group health assignments, cancellation requests).
 */
async function deleteStaff(actor, targetId, { expectedRole = null, req = null } = {}) {
  if (!actor || actor.userType !== ROLES.ADMIN) {
    throw new ApiError(403, 'Chỉ Quản trị viên (Admin) mới có quyền xóa nhân sự');
  }

  const numericId = parsePositiveInt(targetId, 'staffId');
  const user = await User.findOne({ id: numericId });
  if (!user) {
    const label = expectedRole || 'nhân sự';
    throw new ApiError(404, `Không tìm thấy ${label} với ID #${numericId}`);
  }

  if (expectedRole && user.userType !== expectedRole) {
    throw new ApiError(
      400,
      `Tài khoản #${numericId} không phải vai trò '${expectedRole}' (hiện tại: '${user.userType}')`,
    );
  }

  if (![ROLES.DOCTOR, ROLES.RECEPTIONIST].includes(user.userType)) {
    throw new ApiError(
      400,
      `Chỉ có thể xóa nhân sự thuộc vai trò Bác sĩ hoặc Lễ tân (tài khoản này là '${user.userType}')`,
    );
  }

  if (actor.id === user.id) {
    throw new ApiError(400, 'Không thể tự xóa tài khoản của chính mình');
  }

  // Check history across medical and operational records
  const historyItems = [];

  if (user.userType === ROLES.DOCTOR) {
    const [shiftsCount, appointmentsCount, assignmentsCount, cancelReqsCount] =
      await Promise.all([
        DoctorShift.countDocuments({ doctorId: user.id }),
        Appointment.countDocuments({ doctorId: user.id }),
        GroupHealthAssignment
          ? GroupHealthAssignment.countDocuments({ doctorId: user.id })
          : 0,
        ShiftCancellationRequest
          ? ShiftCancellationRequest.countDocuments({ doctorId: user.id })
          : 0,
      ]);

    if (shiftsCount > 0) historyItems.push(`${shiftsCount} ca trực`);
    if (appointmentsCount > 0) historyItems.push(`${appointmentsCount} lịch hẹn khám`);
    if (assignmentsCount > 0) historyItems.push(`${assignmentsCount} phân công khám đoàn`);
    if (cancelReqsCount > 0) historyItems.push(`${cancelReqsCount} yêu cầu hủy ca`);

    if (appointmentsCount > 0) {
      const aptDocs = await Appointment.find({ doctorId: user.id }, { id: 1, _id: 0 }).lean();
      const aptIds = aptDocs.map((a) => a.id);
      if (aptIds.length > 0) {
        const prescriptionsCount = await Prescription.countDocuments({
          appointmentId: { $in: aptIds },
        });
        if (prescriptionsCount > 0) {
          historyItems.push(`${prescriptionsCount} đơn thuốc`);
        }
      }
    }
  } else if (user.userType === ROLES.RECEPTIONIST) {
    const confirmedCount = await Appointment.countDocuments({ confirmedBy: user.id });
    if (confirmedCount > 0) {
      historyItems.push(`đã xác nhận ${confirmedCount} lịch hẹn`);
    }
  }

  // Hard constraint: Staff with existing history MUST NOT be deleted
  if (historyItems.length > 0) {
    throw new ApiError(
      409,
      `Không thể xóa nhân sự #${user.id} (${user.fullName} - ${user.userType}) vì đã có lịch sử hoạt động ` +
        `(${historyItems.join(', ')}). Vui lòng khóa tài khoản (disable) thay vì xóa để bảo toàn dữ liệu y tế.`,
    );
  }

  // Safe deletion: staff has 0 history records
  const beforeSnap = await enrichSingleUser(user);

  if (Image) {
    await Image.deleteMany({ doctorId: user.id });
  }

  await User.deleteOne({ id: user.id });

  await recordAudit({
    actor,
    action: AUDIT_ACTIONS.USER_DELETE,
    targetType: 'User',
    targetId: user.id,
    reason: `Xóa nhân sự ${user.userType} chưa có lịch sử hoạt động (#${user.id} - ${user.fullName})`,
    changes: { before: sanitizeSnapshot(beforeSnap), after: null },
    req,
  });

  return {
    deleted: true,
    id: user.id,
    fullName: user.fullName,
    userType: user.userType,
    message: `Đã xóa nhân sự #${user.id} (${user.fullName}) thành công`,
  };
}

module.exports = {
  enrichUsersWithSpecialty,
  enrichSingleUser,
  getUserRelationSummary,
  validateRoleTransition,
  listUsers,
  getUserById,
  createUser,
  updateUser,
  lockUser,
  unlockUser,
  deleteStaff,
  updateOwnProfile,
  searchUsers,
};

