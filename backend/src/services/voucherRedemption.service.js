const { Voucher, UserVoucher, Appointment, PaymentTransaction } = require('../models');
const { ROLES, AUDIT_ACTIONS, APPOINTMENT_STATUSES, PAYMENT_STATUSES } = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const auditService = require('./audit.service');
const { clock } = require('./clock.service');

/**
 * Tính toán số tiền được giảm từ Voucher dựa trên loại giảm giá (discountType) và giá trị (discountValue)
 * Quy tắc:
 * - discountType: 'AMOUNT' -> giảm đúng discountValue (hoặc tối đa tổng tiền)
 * - discountType: 'PERCENT' -> giảm (totalAmount * discountValue / 100), làm tròn số nguyên Math.round
 * - discountType: 'SERVICE_TICKET' -> không giảm tiền trực tiếp trên hóa đơn khám (trả về 0)
 * - Số tiền giảm không bao giờ âm và không bao giờ vượt quá totalAmount
 *
 * @param {object} voucherInfo - { discountType, discountValue, type }
 * @param {number} totalAmount - Tổng số tiền trước khi giảm
 * @returns {number} discountAmount - Số nguyên >= 0
 */
function calculateDiscount(voucherInfo, totalAmount = 0) {
  const total = Math.max(0, Math.floor(Number(totalAmount) || 0));
  if (total <= 0 || !voucherInfo) return 0;

  // Loại vé dịch vụ không giảm tiền trực tiếp
  if (voucherInfo.type === 'SERVICE_TICKET') {
    return 0;
  }

  const rawVal = Number(voucherInfo.discountValue);
  if (!Number.isFinite(rawVal) || rawVal <= 0) {
    return 0;
  }

  let calculated = 0;
  const discountType = String(voucherInfo.discountType || '').toUpperCase();

  if (discountType === 'PERCENT') {
    calculated = Math.round((total * rawVal) / 100);
  } else {
    // Mặc định hoặc 'AMOUNT'
    calculated = Math.round(rawVal);
  }

  // Không vượt quá tổng tiền và không âm
  return Math.min(total, Math.max(0, calculated));
}

/**
 * UC-PAT-09: Bệnh nhân xem danh sách voucher của mình
 * GET /vouchers/my
 *
 * Requirements:
 * - Trả về danh sách userVouchers của user (phân trang)
 * - Trạng thái dẫn xuất derivedStatus: 'AVAILABLE' | 'USED' | 'EXPIRED' dựa trên used và clock.now()
 * - Tuyệt đối không trả voucher của người khác
 */
async function getMyVouchers(actor, query = {}) {
  if (!actor || (actor.role !== ROLES.PATIENT && actor.userType !== ROLES.PATIENT)) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền xem danh sách voucher của mình', 'FORBIDDEN_ROLE');
  }

  const numUserId = Number(actor.id || actor.userId);
  if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
    throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
  const skip = (page - 1) * limit;

  const now = clock.now();

  const [userVouchers, total] = await Promise.all([
    UserVoucher.find({ userId: numUserId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    UserVoucher.countDocuments({ userId: numUserId }),
  ]);

  // Lấy thông tin voucher gốc để kiểm tra enable & discountType nếu cần
  const voucherIds = [...new Set(userVouchers.map((uv) => uv.voucherId).filter(Boolean))];
  const parentVouchers = voucherIds.length > 0
    ? await Voucher.find({ id: { $in: voucherIds } }).lean()
    : [];
  const parentVoucherMap = new Map(parentVouchers.map((v) => [v.id, v]));

  const formattedItems = userVouchers.map((uv) => {
    const parent = parentVoucherMap.get(uv.voucherId);
    let derivedStatus = 'AVAILABLE';
    const isExpired = uv.expiryDate && new Date(uv.expiryDate) < now;

    if (uv.used) {
      derivedStatus = 'USED';
    } else if (isExpired || (parent && parent.enable === false)) {
      derivedStatus = 'EXPIRED';
    }

    return {
      id: uv.id,
      userVoucherId: uv.id,
      voucherId: uv.voucherId,
      code: uv.voucherCode || parent?.code || '',
      voucherCode: uv.voucherCode || parent?.code || '',
      name: uv.voucherName || parent?.name || null,
      voucherName: uv.voucherName || parent?.name || null,
      discountValue: uv.discountValue ?? parent?.discountValue ?? null,
      discountType: parent?.discountType || 'AMOUNT',
      type: uv.type || parent?.type || 'SERVICE_TICKET',
      expiryDate: uv.expiryDate ? uv.expiryDate.toISOString() : null,
      issuedAt: uv.issuedAt ? uv.issuedAt.toISOString() : null,
      used: Boolean(uv.used),
      usedAt: uv.usedAt ? uv.usedAt.toISOString() : null,
      appointmentId: uv.appointmentId || null,
      userId: uv.userId,
      derivedStatus,
      status: derivedStatus,
    };
  });

  return {
    items: formattedItems,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

/**
 * UC-PAT-09 / PAT-10: Áp dụng (Redeem) voucher cho lịch hẹn
 * POST /vouchers/my/:userVoucherId/redeem
 *
 * Requirements:
 * - userVoucher phải thuộc user (404 NOT_FOUND nếu không đúng user)
 * - voucher.enable !== false (409 VOUCHER_DISABLED)
 * - chưa quá expiryDate (409 VOUCHER_EXPIRED)
 * - appointmentId (tùy chọn): nếu có, phải thuộc user và ở trạng thái hợp lệ (chưa bị hủy/hoàn thành)
 * - Atomic updateOne({ id: userVoucherId, userId, used: false }, { $set: { used: true, usedAt: now, appointmentId } })
 *   -> matchedCount === 0 -> 409 VOUCHER_ALREADY_USED
 * - Audit log: REDEEM_VOUCHER
 *
 * @param {object} actor - User JWT payload
 * @param {number} userVoucherId - ID bản ghi UserVoucher
 * @param {object} options - { appointmentId, totalAmount, req }
 * @returns {Promise<object>}
 */
async function redeem(actor, userVoucherId, options = {}) {
  const { appointmentId = null, totalAmount = 0, req = null } = options;

  if (!actor || (actor.role !== ROLES.PATIENT && actor.userType !== ROLES.PATIENT)) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền sử dụng voucher cá nhân', 'FORBIDDEN_ROLE');
  }

  const numUserId = Number(actor.id || actor.userId);
  const numUserVoucherId = Number(userVoucherId);

  if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
    throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
  }
  if (!Number.isSafeInteger(numUserVoucherId) || numUserVoucherId <= 0) {
    throw new ApiError(400, 'Định danh voucher không hợp lệ', 'INVALID_VOUCHER_ID');
  }

  // 1. Kiểm tra UserVoucher có tồn tại và thuộc về user không
  const existingUserVoucher = await UserVoucher.findOne({ id: numUserVoucherId });
  if (!existingUserVoucher || existingUserVoucher.userId !== numUserId) {
    throw new ApiError(404, 'Không tìm thấy voucher của người dùng', 'VOUCHER_NOT_FOUND');
  }

  if (existingUserVoucher.used) {
    throw new ApiError(409, 'Voucher đã được sử dụng', 'VOUCHER_ALREADY_USED');
  }

  const now = clock.now();

  // 2. Kiểm tra ngày hết hạn của UserVoucher
  if (existingUserVoucher.expiryDate && new Date(existingUserVoucher.expiryDate) < now) {
    throw new ApiError(409, 'Voucher đã hết hạn sử dụng', 'VOUCHER_EXPIRED');
  }

  // 3. Kiểm tra Voucher gốc (parent voucher)
  let parentVoucher = null;
  if (existingUserVoucher.voucherId) {
    parentVoucher = await Voucher.findOne({ id: existingUserVoucher.voucherId }).lean();
    if (parentVoucher) {
      if (parentVoucher.enable === false) {
        throw new ApiError(409, 'Voucher đã bị vô hiệu hóa', 'VOUCHER_DISABLED');
      }
      if (parentVoucher.expiryDate && new Date(parentVoucher.expiryDate) < now) {
        throw new ApiError(409, 'Voucher đã hết hạn sử dụng', 'VOUCHER_EXPIRED');
      }
    }
  }

  // 4. Kiểm tra lịch hẹn (nếu có appointmentId truyền vào)
  let numAppointmentId = null;
  if (appointmentId !== null && appointmentId !== undefined && appointmentId !== '') {
    numAppointmentId = Number(appointmentId);
    if (!Number.isSafeInteger(numAppointmentId) || numAppointmentId <= 0) {
      throw new ApiError(400, 'Định danh lịch hẹn không hợp lệ', 'INVALID_APPOINTMENT_ID');
    }

    const appt = await Appointment.findOne({ id: numAppointmentId }).lean();
    if (!appt || appt.patientId !== numUserId) {
      throw new ApiError(404, 'Không tìm thấy lịch hẹn hoặc lịch hẹn không thuộc về bạn', 'APPOINTMENT_NOT_FOUND');
    }

    const invalidStatuses = [
      APPOINTMENT_STATUSES.CANCELLED,
      APPOINTMENT_STATUSES.COMPLETED,
      APPOINTMENT_STATUSES.EXPIRED,
      APPOINTMENT_STATUSES.NO_SHOW,
    ];
    if (invalidStatuses.includes(appt.status)) {
      throw new ApiError(409, `Không thể áp dụng voucher cho lịch hẹn ở trạng thái ${appt.status}`, 'INVALID_APPOINTMENT_STATE');
    }
  }

  // 5. Cập nhật nguyên tử (Atomic conditional update)
  const updateResult = await UserVoucher.updateOne(
    {
      id: numUserVoucherId,
      userId: numUserId,
      used: false,
    },
    {
      $set: {
        used: true,
        usedAt: now,
        appointmentId: numAppointmentId,
      },
    },
  );

  if (updateResult.matchedCount === 0) {
    throw new ApiError(409, 'Voucher đã được sử dụng', 'VOUCHER_ALREADY_USED');
  }

  // 6. Tính số tiền giảm giá trên server
  const voucherDiscountInfo = {
    discountType: parentVoucher?.discountType || 'AMOUNT',
    discountValue: existingUserVoucher.discountValue ?? parentVoucher?.discountValue ?? 0,
    type: existingUserVoucher.type || parentVoucher?.type || 'SERVICE_TICKET',
  };
  const discountAmount = calculateDiscount(voucherDiscountInfo, totalAmount);

  // 7. Ghi Audit Log REDEEM_VOUCHER
  await auditService.log({
    actor: {
      userId: numUserId,
      role: actor.role || actor.userType,
      email: actor.email,
    },
    action: AUDIT_ACTIONS.REDEEM_VOUCHER,
    resource: {
      type: 'UserVoucher',
      id: numUserVoucherId,
    },
    reason: `Bệnh nhân #${numUserId} sử dụng voucher #${existingUserVoucher.voucherCode || numUserVoucherId}${numAppointmentId ? ` cho lịch hẹn #${numAppointmentId}` : ''}`,
    changes: {
      userVoucherId: numUserVoucherId,
      voucherId: existingUserVoucher.voucherId,
      appointmentId: numAppointmentId,
      discountAmount,
      totalAmount,
      used: true,
      usedAt: now.toISOString(),
    },
    req,
  });

  return {
    success: true,
    userVoucherId: numUserVoucherId,
    voucherCode: existingUserVoucher.voucherCode || parentVoucher?.code || '',
    voucherName: existingUserVoucher.voucherName || parentVoucher?.name || null,
    discountAmount,
    totalAmount,
    appointmentId: numAppointmentId,
    used: true,
    usedAt: now.toISOString(),
  };
}

/**
 * UC-PAT-09 / PAT-10: Hoàn lại (Release) voucher khi hủy lịch hoặc giao dịch thất bại
 *
 * Requirements:
 * - Chỉ hoàn khi voucher đang gắn đúng appointmentId
 * - Không cho hoàn nếu lịch hẹn đã có thanh toán thành công (PAYMENT_STATUSES.SUCCESS)
 * - Cập nhật nguyên tử: used: true -> false, usedAt: null, appointmentId: null (không xóa cứng lịch sử)
 * - Audit log: RELEASE_VOUCHER
 *
 * @param {number} userVoucherId
 * @param {number} appointmentId
 * @param {object} actor - Actor thực hiện (User hoặc System)
 * @param {object} [req=null]
 * @returns {Promise<object>}
 */
async function release(userVoucherId, appointmentId, actor = null, req = null) {
  const numUserVoucherId = Number(userVoucherId);
  const numAppointmentId = Number(appointmentId);

  if (!Number.isSafeInteger(numUserVoucherId) || !Number.isSafeInteger(numAppointmentId)) {
    throw new ApiError(400, 'Định danh voucher hoặc lịch hẹn không hợp lệ', 'INVALID_PARAMS');
  }

  const userVoucher = await UserVoucher.findOne({ id: numUserVoucherId });
  if (!userVoucher) {
    throw new ApiError(404, 'Không tìm thấy voucher của người dùng', 'VOUCHER_NOT_FOUND');
  }

  // Phải gắn đúng appointmentId
  if (userVoucher.appointmentId !== numAppointmentId) {
    throw new ApiError(400, 'Voucher không được gắn vào lịch hẹn này', 'VOUCHER_APPOINTMENT_MISMATCH');
  }

  // Kiểm tra nếu đã có thanh toán thành công thì không được tự ý hoàn lại
  const successPayment = await PaymentTransaction.findOne({
    appointmentId: numAppointmentId,
    status: PAYMENT_STATUSES.SUCCESS,
  }).lean();

  if (successPayment) {
    throw new ApiError(409, 'Không thể hoàn lại voucher đã được thanh toán thành công', 'PAYMENT_ALREADY_SUCCESS');
  }

  // Cập nhật nguyên tử giải phóng voucher
  const updateResult = await UserVoucher.updateOne(
    {
      id: numUserVoucherId,
      appointmentId: numAppointmentId,
      used: true,
    },
    {
      $set: {
        used: false,
        usedAt: null,
        appointmentId: null,
      },
    },
  );

  if (updateResult.matchedCount === 0) {
    return {
      success: false,
      message: 'Voucher không ở trạng thái cần giải phóng',
    };
  }

  // Ghi Audit Log RELEASE_VOUCHER
  const actorObj = actor || { userId: userVoucher.userId, role: ROLES.PATIENT };
  await auditService.log({
    actor: {
      userId: actorObj.id || actorObj.userId || 'SYSTEM',
      role: actorObj.role || actorObj.userType || 'SYSTEM',
      email: actorObj.email || null,
    },
    action: AUDIT_ACTIONS.RELEASE_VOUCHER,
    resource: {
      type: 'UserVoucher',
      id: numUserVoucherId,
    },
    reason: `Giải phóng voucher #${userVoucher.voucherCode || numUserVoucherId} khỏi lịch hẹn #${numAppointmentId}`,
    changes: {
      userVoucherId: numUserVoucherId,
      appointmentId: numAppointmentId,
      used: false,
      usedAt: null,
    },
    req,
  });

  return {
    success: true,
    userVoucherId: numUserVoucherId,
    releasedFromAppointmentId: numAppointmentId,
    used: false,
  };
}

module.exports = {
  getMyVouchers,
  redeem,
  release,
  calculateDiscount,
};
