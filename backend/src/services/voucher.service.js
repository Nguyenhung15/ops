const {
  Voucher,
  UserVoucher,
  Event,
  User,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { parseFlexibleDate } = require('../utils/dateParser');
const { parsePositiveInt } = require('../utils/normalizers');
const { VOUCHER_TYPES, AUDIT_ACTIONS } = require('../constants/enums');
const { recordAudit, buildAuditDiff, sanitizeSnapshot } = require('./audit.service');

const serializeVoucher = (voucher) => {
  const v = voucher.toJSON ? voucher.toJSON() : voucher;
  return {
    id: v.id,
    code: v.code,
    name: v.name || '',
    discountValue: v.discountValue,
    type: v.type,
    enable: typeof v.enable === 'boolean' ? v.enable : true,
    expiryDate: v.expiryDate instanceof Date ? v.expiryDate.toISOString() : (v.expiryDate || null),
  };
};

const serializeUserVoucher = (uv, voucher, user) => {
  const uvObj = uv.toJSON ? uv.toJSON() : uv;
  const v = voucher || {};
  const u = user || {};

  return {
    id: uvObj.id,
    voucherId: uvObj.voucherId,
    voucherCode: v.code || '',
    voucherName: v.name || null,
    discountValue: v.discountValue !== undefined ? v.discountValue : null,
    type: v.type || VOUCHER_TYPES.SERVICE_TICKET,
    expiryDate: v.expiryDate instanceof Date ? v.expiryDate.toISOString() : (v.expiryDate || null),
    issuedAt: uvObj.issuedAt instanceof Date ? uvObj.issuedAt.toISOString() : (uvObj.issuedAt || null),
    used: Boolean(uvObj.used),
    userId: uvObj.userId,
    userFullName: u.fullName || null,
  };
};

/**
 * Fetch all vouchers for Admin & Receptionist.
 */
const getAllVouchers = async () => {
  const vouchers = await Voucher.find({}).sort({ createdAt: -1 });
  return vouchers.map(serializeVoucher);
};

/**
 * Fetch voucher details by ID.
 */
const getVoucherById = async (idParam) => {
  const id = parsePositiveInt(idParam, 'Voucher ID');
  const voucher = await Voucher.findOne({ id });
  if (!voucher) {
    throw new ApiError(404, `Không tìm thấy voucher #${id}`);
  }
  return serializeVoucher(voucher);
};

/**
 * Admin creates a new voucher.
 * Validates unique code, type, discountValue, and expiryDate.
 */
const createVoucher = async (actor, payload, req) => {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError(400, 'Dữ liệu voucher không hợp lệ');
  }

  const rawCode = payload.code ? String(payload.code).trim().toUpperCase() : '';
  if (!rawCode) {
    throw new ApiError(400, 'Mã voucher (code) không được để trống');
  }
  if (!/^[A-Z0-9_-]{3,50}$/.test(rawCode)) {
    throw new ApiError(400, 'Mã voucher phải từ 3 đến 50 ký tự (chữ hoa, số, gạch nối hoặc gạch dưới)');
  }

  // Check unique code constraint
  const existing = await Voucher.findOne({ code: rawCode }).lean();
  if (existing) {
    throw new ApiError(409, `Mã voucher '${rawCode}' đã tồn tại trong hệ thống`);
  }

  const rawType = payload.type ? String(payload.type).toUpperCase() : VOUCHER_TYPES.SERVICE_TICKET;
  if (![VOUCHER_TYPES.DISCOUNT, VOUCHER_TYPES.SERVICE_TICKET].includes(rawType)) {
    throw new ApiError(400, 'Loại voucher phải là DISCOUNT hoặc SERVICE_TICKET');
  }

  let discountValue = null;
  if (payload.discountValue !== undefined && payload.discountValue !== null && payload.discountValue !== '') {
    discountValue = Number(payload.discountValue);
    if (Number.isNaN(discountValue) || discountValue < 0) {
      throw new ApiError(400, 'Giá trị giảm (discountValue) phải là số dương');
    }
    if (rawType === VOUCHER_TYPES.DISCOUNT && (discountValue < 1 || discountValue > 100)) {
      throw new ApiError(400, 'Voucher giảm giá (DISCOUNT) phải có giá trị từ 1% đến 100%');
    }
  }

  const expiryDate = parseFlexibleDate(payload.expiryDate, 'Hạn sử dụng', false);

  const enable = payload.enable !== undefined ? Boolean(payload.enable) : true;
  const name = payload.name ? String(payload.name).trim() : null;

  const voucher = await Voucher.create({
    code: rawCode,
    name,
    discountValue,
    type: rawType,
    enable,
    expiryDate,
  });

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.VOUCHER_CREATE,
      targetType: 'Voucher',
      targetId: voucher.id,
      reason: `Tạo voucher mới [${voucher.code}]`,
      changes: { after: sanitizeSnapshot(voucher) },
      req,
    });
  }

  return serializeVoucher(voucher);
};

/**
 * Admin updates an existing voucher.
 */
const updateVoucher = async (actor, idParam, payload, req) => {
  const id = parsePositiveInt(idParam, 'Voucher ID');
  const voucher = await Voucher.findOne({ id });
  if (!voucher) {
    throw new ApiError(404, `Không tìm thấy voucher #${id}`);
  }

  const beforeSnap = sanitizeSnapshot(voucher);

  // Update code with unique check
  if (payload?.code !== undefined) {
    const rawCode = String(payload.code).trim().toUpperCase();
    if (!rawCode) {
      throw new ApiError(400, 'Mã voucher (code) không được để trống');
    }
    if (!/^[A-Z0-9_-]{3,50}$/.test(rawCode)) {
      throw new ApiError(400, 'Mã voucher phải từ 3 đến 50 ký tự (chữ hoa, số, gạch nối hoặc gạch dưới)');
    }
    if (rawCode !== voucher.code) {
      const existing = await Voucher.findOne({ code: rawCode, id: { $ne: id } }).lean();
      if (existing) {
        throw new ApiError(409, `Mã voucher '${rawCode}' đã được sử dụng bởi voucher khác`);
      }
      voucher.code = rawCode;
    }
  }

  if (payload?.name !== undefined) {
    voucher.name = payload.name ? String(payload.name).trim() : null;
  }

  if (payload?.type !== undefined) {
    const rawType = String(payload.type).toUpperCase();
    if (![VOUCHER_TYPES.DISCOUNT, VOUCHER_TYPES.SERVICE_TICKET].includes(rawType)) {
      throw new ApiError(400, 'Loại voucher phải là DISCOUNT hoặc SERVICE_TICKET');
    }
    voucher.type = rawType;
  }

  if (payload?.discountValue !== undefined) {
    if (payload.discountValue === null || payload.discountValue === '') {
      voucher.discountValue = null;
    } else {
      const val = Number(payload.discountValue);
      if (Number.isNaN(val) || val < 0) {
        throw new ApiError(400, 'Giá trị giảm (discountValue) phải là số dương');
      }
      if (voucher.type === VOUCHER_TYPES.DISCOUNT && (val < 1 || val > 100)) {
        throw new ApiError(400, 'Voucher giảm giá (DISCOUNT) phải có giá trị từ 1% đến 100%');
      }
      voucher.discountValue = val;
    }
  }

  if (payload?.expiryDate !== undefined) {
    voucher.expiryDate = parseFlexibleDate(payload.expiryDate, 'Hạn sử dụng', false);
  }

  let statusChanged = false;
  if (payload?.enable !== undefined) {
    const newEnable = Boolean(payload.enable);
    if (voucher.enable !== newEnable) {
      voucher.enable = newEnable;
      statusChanged = true;
    }
  }

  await voucher.save();

  if (actor) {
    let action = AUDIT_ACTIONS.VOUCHER_UPDATE;
    if (statusChanged) {
      action = voucher.enable ? AUDIT_ACTIONS.VOUCHER_ENABLE : AUDIT_ACTIONS.VOUCHER_DISABLE;
    }
    await recordAudit({
      actor,
      action,
      targetType: 'Voucher',
      targetId: voucher.id,
      reason: `Cập nhật voucher [${voucher.code}]`,
      changes: buildAuditDiff(beforeSnap, voucher),
      req,
    });
  }

  return serializeVoucher(voucher);
};

/**
 * Admin deletes a voucher.
 * Constraint: If voucher has redemption history or linked events, DO NOT HARD DELETE.
 * Instead, automatically soft-disable to preserve redemption records.
 */
const deleteVoucher = async (actor, idParam, req) => {
  const id = parsePositiveInt(idParam, 'Voucher ID');
  const voucher = await Voucher.findOne({ id });
  if (!voucher) {
    throw new ApiError(404, `Không tìm thấy voucher #${id}`);
  }

  const userVoucherCount = await UserVoucher.countDocuments({ voucherId: id });
  const eventCount = await Event.countDocuments({ voucherId: id });

  if (userVoucherCount > 0 || eventCount > 0) {
    // Preserve redemption & distribution history
    voucher.enable = false;
    await voucher.save();

    if (actor) {
      await recordAudit({
        actor,
        action: AUDIT_ACTIONS.VOUCHER_DISABLE,
        targetType: 'Voucher',
        targetId: voucher.id,
        reason: `Vô hiệu hóa voucher do đã có ${userVoucherCount} lượt cấp / ${eventCount} sự kiện liên kết`,
        changes: { after: { enable: false, reason: 'PRESERVE_REDEMPTION_HISTORY' } },
        req,
      });
    }

    return {
      success: true,
      softDeleted: true,
      message: `Voucher đã phát sinh ${userVoucherCount} lượt cấp và ${eventCount} sự kiện liên kết. Hệ thống đã tự động vô hiệu hóa để bảo toàn lịch sử redemption.`,
    };
  }

  // Safe to hard delete because no redemption history exists
  await Voucher.deleteOne({ id });

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.VOUCHER_DELETE,
      targetType: 'Voucher',
      targetId: id,
      reason: `Xóa voucher #${id} [${voucher.code}] (chưa phát sinh giao dịch)`,
      changes: { before: sanitizeSnapshot(voucher) },
      req,
    });
  }

  return {
    success: true,
    deleted: true,
    message: 'Xóa voucher thành công',
  };
};

/**
 * Patient fetches personal vouchers.
 */
const getMyVouchers = async (patientUser) => {
  const userVouchers = await UserVoucher.find({ userId: patientUser.id }).sort({ createdAt: -1 });
  if (userVouchers.length === 0) return [];

  const voucherIds = [...new Set(userVouchers.map((uv) => uv.voucherId))];
  const vouchers = await Voucher.find({ id: { $in: voucherIds } });
  const voucherMap = new Map(vouchers.map((v) => [v.id, v]));

  return userVouchers.map((uv) => serializeUserVoucher(uv, voucherMap.get(uv.voucherId), patientUser));
};

/**
 * Fetch all users who own a specific voucher (Admin & Receptionist).
 */
const getVoucherOwners = async (voucherIdParam) => {
  const voucherId = parsePositiveInt(voucherIdParam, 'Voucher ID');
  const voucher = await Voucher.findOne({ id: voucherId });
  if (!voucher) {
    throw new ApiError(404, `Không tìm thấy voucher #${voucherId}`);
  }

  const userVouchers = await UserVoucher.find({ voucherId }).sort({ createdAt: -1 });
  if (userVouchers.length === 0) return [];

  const userIds = [...new Set(userVouchers.map((uv) => uv.userId))];
  const users = await User.find({ id: { $in: userIds } }).lean();
  const userMap = new Map(users.map((u) => [u.id, u]));

  return userVouchers.map((uv) => serializeUserVoucher(uv, voucher, userMap.get(uv.userId)));
};

/**
 * Fetch all vouchers belonging to a specific user (Admin & Receptionist).
 */
const getUserVouchers = async (userIdParam) => {
  const userId = parsePositiveInt(userIdParam, 'User ID');
  const targetUser = await User.findOne({ id: userId }).lean();
  if (!targetUser) {
    throw new ApiError(404, `Không tìm thấy người dùng #${userId}`);
  }

  const userVouchers = await UserVoucher.find({ userId }).sort({ createdAt: -1 });
  if (userVouchers.length === 0) return [];

  const voucherIds = [...new Set(userVouchers.map((uv) => uv.voucherId))];
  const vouchers = await Voucher.find({ id: { $in: voucherIds } });
  const voucherMap = new Map(vouchers.map((v) => [v.id, v]));

  return userVouchers.map((uv) => serializeUserVoucher(uv, voucherMap.get(uv.voucherId), targetUser));
};

/**
 * Receptionist / Admin marks a user voucher as used.
 */
const useVoucher = async (actor, voucherIdParam, userIdParam, req) => {
  const voucherId = parsePositiveInt(voucherIdParam, 'Voucher ID');
  const userId = parsePositiveInt(userIdParam, 'User ID');

  const voucher = await Voucher.findOne({ id: voucherId });
  if (!voucher) {
    throw new ApiError(404, `Không tìm thấy voucher #${voucherId}`);
  }

  const user = await User.findOne({ id: userId }).lean();
  if (!user) {
    throw new ApiError(404, `Không tìm thấy người dùng #${userId}`);
  }

  // Find unused user voucher
  const userVoucher = await UserVoucher.findOne({ voucherId, userId, used: false });
  if (!userVoucher) {
    throw new ApiError(400, `Người dùng #${userId} không sở hữu hoặc đã sử dụng voucher này`);
  }

  // Check voucher expiration
  if (voucher.expiryDate && new Date(voucher.expiryDate).getTime() < Date.now()) {
    throw new ApiError(400, `Voucher [${voucher.code}] đã hết hạn sử dụng`);
  }

  userVoucher.used = true;
  userVoucher.usedAt = new Date();
  await userVoucher.save();

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.VOUCHER_REDEEM,
      targetType: 'UserVoucher',
      targetId: userVoucher.id,
      reason: `Sử dụng voucher [${voucher.code}] cho bệnh nhân #${userId} (${user.fullName})`,
      changes: { after: { used: true, usedAt: userVoucher.usedAt } },
      req,
    });
  }

  return serializeUserVoucher(userVoucher, voucher, user);
};

module.exports = {
  getAllVouchers,
  getVoucherById,
  createVoucher,
  updateVoucher,
  deleteVoucher,
  getMyVouchers,
  getVoucherOwners,
  getUserVouchers,
  useVoucher,
};
