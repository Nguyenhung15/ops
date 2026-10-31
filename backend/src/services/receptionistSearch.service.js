const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const { escapeRegex } = require('../utils/normalizers');
const { maskEmail, maskPhone } = require('../utils/masking');
const { User, Voucher, UserVoucher } = require('../models');
const { ROLES, AUDIT_ACTIONS } = require('../constants/enums');
const { recordAudit } = require('./audit.service');

/**
 * Hash keyword for audit logging without storing raw PII
 */
function hashKeyword(keyword) {
  if (!keyword || typeof keyword !== 'string') return '';
  return crypto.createHash('sha256').update(keyword.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * UC-REC-01: Lễ tân / Admin tra cứu người dùng
 * Requirements:
 * - Allowed roles: RECEPTIONIST, ADMIN
 * - Search by keyword (name / email / phone): min 3 chars, reject empty/wildcard (400)
 * - Pagination: page, limit (max 20)
 * - Escape regex to prevent ReDoS / injection
 * - Minimal fields with masked PII: id, fullName, email (masked), phone/phoneNumber (masked), role/userType, isEnabled/isEnable
 * - Strictly exclude: password, passwordHash, OAuth data, medical history
 * - Audit log: actor, hashed keyword, result count
 */
async function searchUsers(actor, query = {}, req = null) {
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role ?? actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ lễ tân hoặc quản trị viên mới có quyền tra cứu người dùng', 'FORBIDDEN_ROLE');
  }

  const rawKeyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';

  // Validate keyword: at least 3 characters, no empty or purely wildcard strings
  if (!rawKeyword || rawKeyword.length < 3) {
    throw new ApiError(400, 'Từ khóa tìm kiếm phải có tối thiểu 3 ký tự', 'INVALID_KEYWORD_LENGTH');
  }

  // Reject wildcard-only keywords like ".*", "*", "%", "_"
  if (/^[\s.*%_?^${}()|[\]\\]+$/.test(rawKeyword)) {
    throw new ApiError(400, 'Từ khóa tìm kiếm không hợp lệ', 'INVALID_KEYWORD_FORMAT');
  }

  // Escape regex to prevent ReDoS / regex injection
  const safeRegex = new RegExp(escapeRegex(rawKeyword), 'i');

  // Pagination: default 10, max 20
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(20, Math.max(1, Number(query.limit) || 10));
  const skip = (page - 1) * limit;

  const filter = {
    $or: [
      { fullName: safeRegex },
      { email: safeRegex },
      { phoneNumber: safeRegex },
    ],
  };

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('id fullName email phoneNumber userType isEnable')
      .sort({ id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  // Mask PII
  const sanitizedUsers = users.map((u) => ({
    id: u.id,
    fullName: u.fullName,
    email: maskEmail(u.email),
    phoneNumber: maskPhone(u.phoneNumber),
    phone: maskPhone(u.phoneNumber),
    userType: u.userType,
    role: u.userType,
    isEnabled: Boolean(u.isEnable),
    isEnable: Boolean(u.isEnable),
  }));

  // Audit log with hashed keyword and count
  await recordAudit({
    actor,
    action: AUDIT_ACTIONS.SEARCH_USERS,
    targetType: 'User',
    targetId: null,
    reason: `Tra cứu người dùng (keywordHash: ${hashKeyword(rawKeyword)}, results: ${sanitizedUsers.length}/${total})`,
    changes: {
      keywordHash: hashKeyword(rawKeyword),
      keywordLength: rawKeyword.length,
      resultCount: sanitizedUsers.length,
      totalCount: total,
    },
    req,
  });

  return {
    users: sanitizedUsers,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

/**
 * UC-REC-01: Lễ tân / Admin xem danh sách voucher của người dùng
 * Requirements:
 * - Allowed roles: RECEPTIONIST, ADMIN
 * - Returns: id, code/voucherCode, name/voucherName, value/discountValue, type, expiryDate, used, usedAt
 * - Audit log: actor, targetUserId, voucher count
 */
async function getUserVouchers(actor, targetUserId, req = null) {
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role ?? actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ lễ tân hoặc quản trị viên mới có quyền xem voucher của người dùng', 'FORBIDDEN_ROLE');
  }

  const numUserId = Number(targetUserId);
  if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
    throw new ApiError(400, 'Định danh người dùng không hợp lệ', 'INVALID_USER_ID');
  }

  const user = await User.findOne({ id: numUserId }, 'id fullName').lean();
  if (!user) {
    throw new ApiError(404, 'Không tìm thấy người dùng', 'USER_NOT_FOUND');
  }

  const userVouchers = await UserVoucher.find({ userId: numUserId })
    .sort({ createdAt: -1 })
    .lean();

  const formattedVouchers = userVouchers.map((uv) => ({
    id: uv.id ?? uv._id,
    voucherId: uv.voucherId,
    code: uv.voucherCode,
    voucherCode: uv.voucherCode,
    name: uv.voucherName,
    voucherName: uv.voucherName,
    discountValue: uv.discountValue,
    type: uv.type,
    expiryDate: uv.expiryDate ? uv.expiryDate.toISOString() : null,
    issuedAt: uv.issuedAt ? uv.issuedAt.toISOString() : null,
    used: Boolean(uv.used),
    usedAt: uv.usedAt ? uv.usedAt.toISOString() : null,
    userId: uv.userId,
    userFullName: user.fullName,
  }));

  await recordAudit({
    actor,
    action: AUDIT_ACTIONS.VIEW_USER_VOUCHERS,
    targetType: 'UserVoucher',
    targetId: numUserId,
    reason: `Xem danh sách voucher của người dùng #${numUserId} (${formattedVouchers.length} vouchers)`,
    changes: {
      userId: numUserId,
      voucherCount: formattedVouchers.length,
    },
    req,
  });

  return formattedVouchers;
}

/**
 * Lễ tân / Admin đánh dấu sử dụng voucher tại quầy
 * POST /vouchers/:voucherId/use?userId=...
 */
async function markVoucherAsUsed(actor, userVoucherId, userId, req = null) {
  const allowedRoles = [ROLES.RECEPTIONIST, ROLES.ADMIN];
  const actorRole = actor?.role ?? actor?.userType;
  if (!actor || !allowedRoles.includes(actorRole)) {
    throw new ApiError(403, 'Chỉ lễ tân hoặc quản trị viên mới có quyền sử dụng voucher', 'FORBIDDEN_ROLE');
  }

  const numVoucherId = Number(userVoucherId);
  const numUserId = Number(userId);

  const filter = {
    $or: [{ id: numVoucherId }, { voucherId: numVoucherId }],
    userId: numUserId,
  };

  const userVoucher = await UserVoucher.findOne(filter);
  if (!userVoucher) {
    throw new ApiError(404, 'Không tìm thấy voucher của người dùng', 'VOUCHER_NOT_FOUND');
  }

  if (userVoucher.used) {
    return {
      id: userVoucher.id,
      voucherId: userVoucher.voucherId,
      voucherCode: userVoucher.voucherCode,
      voucherName: userVoucher.voucherName,
      used: true,
      usedAt: userVoucher.usedAt ? userVoucher.usedAt.toISOString() : null,
      userId: userVoucher.userId,
    };
  }

  userVoucher.used = true;
  userVoucher.usedAt = new Date();
  await userVoucher.save();

  await recordAudit({
    actor,
    action: AUDIT_ACTIONS.USE_VOUCHER,
    targetType: 'UserVoucher',
    targetId: userVoucher.id,
    reason: `Sử dụng voucher #${userVoucher.voucherCode} cho người dùng #${numUserId}`,
    changes: {
      voucherId: userVoucher.voucherId,
      userId: numUserId,
      used: true,
      usedAt: userVoucher.usedAt.toISOString(),
    },
    req,
  });

  return {
    id: userVoucher.id,
    voucherId: userVoucher.voucherId,
    voucherCode: userVoucher.voucherCode,
    voucherName: userVoucher.voucherName,
    used: true,
    usedAt: userVoucher.usedAt.toISOString(),
    userId: userVoucher.userId,
  };
}

module.exports = {
  searchUsers,
  getUserVouchers,
  markVoucherAsUsed,
  hashKeyword,
};
