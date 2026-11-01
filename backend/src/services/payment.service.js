const crypto = require('crypto');
const {
  PaymentTransaction,
  Appointment,
  User,
} = require('../models');
const {
  ROLES,
  AUDIT_ACTIONS,
  APPOINTMENT_STATUSES,
  PAYMENT_STATUSES,
} = require('../constants/enums');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const auditService = require('./audit.service');
const outboxService = require('./outbox.service');
const { appointmentStateService } = require('./appointmentState.service');
const voucherRedemptionService = require('./voucherRedemption.service');
const { clock } = require('./clock.service');

/**
 * Format Date to VNPay vnp_CreateDate / vnp_ExpireDate (YYYYMMDDHHmmss) in GMT+7
 */
function formatVNPayDate(date) {
  const d = new Date(date);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: env.clinicTimeZone || 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

/**
 * Build sorted query string and HMAC-SHA512 checksum according to VNPay specifications.
 * All keys sorted alphabetically A-Z, encoded URL query.
 */
function buildSignedVNPayUrl(baseUrl, params, secret) {
  const sortedKeys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && String(params[k]).trim() !== '')
    .sort();

  const signParts = [];
  const queryParts = [];

  for (const key of sortedKeys) {
    const val = String(params[key]);
    const encodedKey = encodeURIComponent(key);
    const encodedVal = encodeURIComponent(val);
    signParts.push(`${encodedKey}=${encodedVal}`);
    queryParts.push(`${encodedKey}=${encodedVal}`);
  }

  const signData = signParts.join('&');
  const hmac = crypto.createHmac('sha512', secret || '');
  const secureHash = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

  const sep = baseUrl.includes('?') ? '&' : '?';
  const finalQuery = `${queryParts.join('&')}&vnp_SecureHash=${secureHash}`;
  return `${baseUrl}${sep}${finalQuery}`;
}

/**
 * Verify VNPay secure hash using timing-safe comparison.
 */
function verifyVNPayHash(queryParams, secret) {
  const secureHash = queryParams.vnp_SecureHash || queryParams.vnp_securehash;
  if (!secureHash) return false;

  const filteredParams = {};
  for (const [k, v] of Object.entries(queryParams)) {
    if (k === 'vnp_SecureHash' || k === 'vnp_SecureHashType' || k === 'vnp_securehash') {
      continue;
    }
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      filteredParams[k] = v;
    }
  }

  const sortedKeys = Object.keys(filteredParams).sort();
  const signParts = [];
  for (const key of sortedKeys) {
    signParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(filteredParams[key]))}`);
  }
  const signData = signParts.join('&');
  const hmac = crypto.createHmac('sha512', secret || '');
  const calculatedHash = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

  try {
    const hashBuf = Buffer.from(String(secureHash).toLowerCase(), 'utf-8');
    const calcBuf = Buffer.from(calculatedHash.toLowerCase(), 'utf-8');
    if (hashBuf.length !== calcBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(hashBuf, calcBuf);
  } catch {
    return false;
  }
}

class PaymentService {
  /**
   * UC-PAT-10: Tạo URL thanh toán VNPay
   * Input: appointmentId (hoặc appointmentNo) + userVoucherId
   */
  async createPaymentUrl({ user, appointmentId, appointmentNo, userVoucherId = null, req = null }) {
    if (!user || (user.role !== ROLES.PATIENT && user.userType !== ROLES.PATIENT)) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền tạo giao dịch thanh toán', 'FORBIDDEN_ROLE');
    }

    const numUserId = Number(user.id || user.userId);
    if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
      throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
    }

    // 1. Tìm lịch hẹn theo appointmentId hoặc appointmentNo
    const query = {};
    if (appointmentId !== undefined && appointmentId !== null && appointmentId !== '') {
      const numApptId = Number(appointmentId);
      if (Number.isSafeInteger(numApptId)) {
        query.id = numApptId;
      } else {
        query.appointmentNo = String(appointmentId);
      }
    } else if (appointmentNo) {
      query.appointmentNo = String(appointmentNo);
    } else {
      throw new ApiError(400, 'Thiếu thông tin lịch hẹn (appointmentId hoặc appointmentNo)', 'MISSING_APPOINTMENT');
    }

    const appointment = await Appointment.findOne(query);
    if (!appointment || appointment.patientId !== numUserId) {
      throw new ApiError(404, 'Không tìm thấy lịch hẹn hoặc lịch hẹn không thuộc về bạn', 'APPOINTMENT_NOT_FOUND');
    }

    // 2. Kiểm tra trạng thái lịch hẹn: phải là PENDING_PAYMENT
    if (appointment.status !== APPOINTMENT_STATUSES.PENDING_PAYMENT) {
      throw new ApiError(
        400,
        `Lịch hẹn ở trạng thái ${appointment.status} không cho phép thực hiện thanh toán`,
        'INVALID_APPOINTMENT_STATE',
      );
    }

    // 3. Kiểm tra xem đã có giao dịch SUCCESS chưa
    const existingSuccess = await PaymentTransaction.findOne({
      appointmentId: appointment.id,
      status: PAYMENT_STATUSES.SUCCESS,
    }).lean();
    if (existingSuccess) {
      throw new ApiError(409, 'Lịch hẹn này đã được thanh toán thành công', 'ALREADY_PAID');
    }

    const now = clock.now();

    // 4. Tính toán chi phí khám trên server (không tin client)
    let consultationFee = 0;
    if (appointment.doctorId) {
      const doctor = await User.findOne({ id: appointment.doctorId }).lean();
      if (doctor && Number.isFinite(Number(doctor.consultationFee))) {
        consultationFee = Math.max(0, Math.floor(Number(doctor.consultationFee)));
      }
    }
    const patientCount = Array.isArray(appointment.patients) && appointment.patients.length > 0
      ? appointment.patients.length
      : 1;
    const totalAmount = consultationFee * patientCount;

    // 5. Áp dụng voucher (nếu có userVoucherId)
    let discountAmount = 0;
    let appliedVoucherId = null;

    if (userVoucherId !== undefined && userVoucherId !== null && userVoucherId !== '') {
      const numVoucherId = Number(userVoucherId);
      const redeemRes = await voucherRedemptionService.redeem(user, numVoucherId, {
        appointmentId: appointment.id,
        totalAmount,
        req,
      });
      discountAmount = redeemRes.discountAmount || 0;
      appliedVoucherId = numVoucherId;
    }

    const finalAmount = Math.max(0, totalAmount - discountAmount);

    // 6. Xử lý giao dịch PENDING cũ cho cùng lịch hẹn:
    // Hủy các giao dịch PENDING trước đó (vô hiệu hóa) để không để nhiều giao dịch hợp lệ song song
    const oldPendingList = await PaymentTransaction.find({
      appointmentId: appointment.id,
      status: PAYMENT_STATUSES.PENDING,
    });
    for (const oldPending of oldPendingList) {
      await PaymentTransaction.updateOne(
        { id: oldPending.id, status: PAYMENT_STATUSES.PENDING },
        { $set: { status: PAYMENT_STATUSES.EXPIRED } },
      );
      // Nếu giao dịch cũ có voucher khác với voucher mới, giải phóng voucher cũ
      if (oldPending.userVoucherId && oldPending.userVoucherId !== appliedVoucherId) {
        try {
          await voucherRedemptionService.release(oldPending.userVoucherId, appointment.id, user, req);
        } catch {
          // Ignore release errors on old transactions
        }
      }
    }

    // 7. Tạo PaymentTransaction mới với transactionNo ngẫu nhiên mạnh
    const randomHex = crypto.randomBytes(8).toString('hex').toUpperCase();
    const transactionNo = `TXN${Date.now()}${randomHex}`;
    const ttlMinutes = env.paymentPendingTtlMinutes || 15;
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    const transaction = await PaymentTransaction.create({
      appointmentId: appointment.id,
      userId: numUserId,
      transactionNo,
      amount: finalAmount,
      discountAmount,
      userVoucherId: appliedVoucherId,
      status: PAYMENT_STATUSES.PENDING,
      orderInfo: `Thanh toan lich hen ${appointment.appointmentNo}`,
      expiresAt,
    });

    // 8. Tạo tham số và ký HMAC-SHA512 VNPay
    const ipAddr =
      req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
      req?.connection?.remoteAddress ||
      req?.socket?.remoteAddress ||
      '127.0.0.1';

    const vnpParams = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: env.vnpTmnCode,
      vnp_Amount: Math.round(finalAmount * 100), // nhân 100 theo VNPay
      vnp_CreateDate: formatVNPayDate(now),
      vnp_CurrCode: 'VND',
      vnp_IpAddr: ipAddr,
      vnp_Locale: 'vn',
      vnp_OrderInfo: `Thanh toan lich hen ${appointment.appointmentNo}`,
      vnp_OrderType: 'other',
      vnp_ReturnUrl: env.vnpReturnUrl,
      vnp_TxnRef: transactionNo,
      vnp_ExpireDate: formatVNPayDate(expiresAt),
    };

    const paymentUrl = buildSignedVNPayUrl(env.vnpUrl, vnpParams, env.vnpHashSecret);

    // 9. Audit log PAYMENT_CREATED
    await auditService.log({
      actor: {
        userId: numUserId,
        role: user.role || user.userType,
        email: user.email,
      },
      action: AUDIT_ACTIONS.PAYMENT_CREATED,
      resource: {
        type: 'PaymentTransaction',
        id: transaction.id,
      },
      reason: `Khởi tạo giao dịch thanh toán cho lịch hẹn #${appointment.id}`,
      changes: {
        transactionNo,
        amount: finalAmount,
        discountAmount,
        totalAmount,
        appointmentId: appointment.id,
        status: PAYMENT_STATUSES.PENDING,
        expiresAt: expiresAt.toISOString(),
      },
      req,
    });

    return {
      success: true,
      transactionId: transaction.id,
      transactionNo,
      appointmentId: appointment.id,
      appointmentNo: appointment.appointmentNo,
      amount: finalAmount,
      discountAmount,
      paymentUrl, // Tách biệt khỏi meetingUrl
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Xử lý kết quả thanh toán từ VNPay callback (Dùng chung logic idempotent giữa Return và IPN)
   */
  async processVNPayCallback(queryParams, req = null, isIpn = false) {
    // 1. Verify chữ ký bằng timingSafeEqual
    const isValidSignature = verifyVNPayHash(queryParams, env.vnpHashSecret);
    if (!isValidSignature) {
      if (isIpn) {
        return { RspCode: '97', Message: 'Invalid Checksum' };
      }
      throw new ApiError(400, 'Chữ ký không hợp lệ', 'INVALID_SIGNATURE');
    }

    const txnRef = queryParams.vnp_TxnRef;
    if (!txnRef) {
      if (isIpn) return { RspCode: '01', Message: 'Order not found' };
      throw new ApiError(400, 'Thiếu mã giao dịch vnp_TxnRef', 'MISSING_TXN_REF');
    }

    // 2. Tìm PaymentTransaction theo transactionNo
    const transaction = await PaymentTransaction.findOne({ transactionNo: txnRef });
    if (!transaction) {
      if (isIpn) return { RspCode: '01', Message: 'Order not found' };
      throw new ApiError(404, 'Không tìm thấy giao dịch thanh toán', 'TRANSACTION_NOT_FOUND');
    }

    // 3. Đối chiếu số tiền vnp_Amount
    const vnpAmount = Number(queryParams.vnp_Amount);
    const expectedVnpAmount = Math.round(Number(transaction.amount) * 100);
    if (vnpAmount !== expectedVnpAmount) {
      if (isIpn) return { RspCode: '04', Message: 'Invalid amount' };
      throw new ApiError(400, 'Số tiền giao dịch không khớp', 'INVALID_AMOUNT');
    }

    // 4. Idempotency check: Nếu giao dịch đã kết thúc (SUCCESS hoặc FAILED hoặc EXPIRED)
    if (transaction.status !== PAYMENT_STATUSES.PENDING) {
      if (isIpn) {
        return { RspCode: '02', Message: 'Order already confirmed' };
      }
      return {
        success: transaction.status === PAYMENT_STATUSES.SUCCESS,
        status: transaction.status,
        transactionNo: transaction.transactionNo,
        appointmentId: transaction.appointmentId,
        alreadyProcessed: true,
      };
    }

    const responseCode = queryParams.vnp_ResponseCode;
    const transactionStatus = queryParams.vnp_TransactionStatus;
    const isSuccess = responseCode === '00' && (transactionStatus === '00' || !transactionStatus);
    const payDateStr = queryParams.vnp_PayDate;
    let payDate = null;
    if (payDateStr && payDateStr.length === 14) {
      const yr = payDateStr.slice(0, 4);
      const mo = payDateStr.slice(4, 6);
      const dy = payDateStr.slice(6, 8);
      const hr = payDateStr.slice(8, 10);
      const mi = payDateStr.slice(10, 12);
      const sc = payDateStr.slice(12, 14);
      payDate = new Date(`${yr}-${mo}-${dy}T${hr}:${mi}:${sc}+07:00`);
    } else {
      payDate = clock.now();
    }

    const bankCode = queryParams.vnp_BankCode || null;

    if (isSuccess) {
      // 5. THÀNH CÔNG: Conditional update PENDING -> SUCCESS
      const updateResult = await PaymentTransaction.updateOne(
        { id: transaction.id, status: PAYMENT_STATUSES.PENDING },
        {
          $set: {
            status: PAYMENT_STATUSES.SUCCESS,
            bankCode,
            payDate,
            responseCode,
            transactionStatus: transactionStatus || '00',
          },
        },
      );

      if (updateResult.matchedCount === 0) {
        // Đã được xử lý bởi tiến trình song song (idempotent)
        if (isIpn) return { RspCode: '02', Message: 'Order already confirmed' };
        return {
          success: true,
          status: PAYMENT_STATUSES.SUCCESS,
          transactionNo: transaction.transactionNo,
          appointmentId: transaction.appointmentId,
          alreadyProcessed: true,
        };
      }

      // 6. Chuyển trạng thái Appointment qua appointmentStateService
      const appointment = await Appointment.findOne({ id: transaction.appointmentId });
      if (appointment) {
        const isOnline = appointment.type === 'ONLINE';
        const targetState = isOnline
          ? env.paymentSuccessTargetStateOnline || 'CONFIRMED'
          : env.paymentSuccessTargetStateOffline || 'PENDING_CONFIRMATION';

        try {
          await appointmentStateService.transition({
            appointmentId: appointment.id,
            fromStatus: APPOINTMENT_STATUSES.PENDING_PAYMENT,
            toStatus: targetState,
            actor: {
              userId: transaction.userId || appointment.patientId,
              role: 'SYSTEM',
              email: 'system@clinicbooking.local',
            },
            extraFields: {
              paymentStatus: PAYMENT_STATUSES.SUCCESS,
              paidAmount: transaction.amount,
            },
            options: { req },
          });
        } catch (transitionErr) {
          // Log warning if transition was already in target state
        }
      }

      // 7. Ghi nhận Outbox Event và Audit Log
      await outboxService.recordEvent({
        eventType: 'PAYMENT_SUCCESS',
        payload: {
          transactionNo: transaction.transactionNo,
          appointmentId: transaction.appointmentId,
          amount: transaction.amount,
          payDate: payDate.toISOString(),
        },
      });

      await auditService.log({
        actor: {
          userId: transaction.userId,
          role: 'SYSTEM',
          email: 'system@clinicbooking.local',
        },
        action: AUDIT_ACTIONS.PAYMENT_SUCCESS,
        resource: {
          type: 'PaymentTransaction',
          id: transaction.id,
        },
        reason: `Giao dịch ${transaction.transactionNo} thanh toán thành công qua VNPay`,
        changes: {
          status: PAYMENT_STATUSES.SUCCESS,
          bankCode,
          responseCode,
          payDate: payDate.toISOString(),
        },
        req,
      });

      if (isIpn) {
        return { RspCode: '00', Message: 'Confirm Success' };
      }
      return {
        success: true,
        status: PAYMENT_STATUSES.SUCCESS,
        transactionNo: transaction.transactionNo,
        appointmentId: transaction.appointmentId,
      };
    } else {
      // 8. THẤT BẠI: Conditional update PENDING -> FAILED
      const updateResult = await PaymentTransaction.updateOne(
        { id: transaction.id, status: PAYMENT_STATUSES.PENDING },
        {
          $set: {
            status: PAYMENT_STATUSES.FAILED,
            bankCode,
            responseCode,
            transactionStatus: transactionStatus || responseCode,
          },
        },
      );

      if (updateResult.matchedCount === 0) {
        if (isIpn) return { RspCode: '02', Message: 'Order already confirmed' };
        return {
          success: false,
          status: PAYMENT_STATUSES.FAILED,
          transactionNo: transaction.transactionNo,
          appointmentId: transaction.appointmentId,
          alreadyProcessed: true,
        };
      }

      // Hoàn lại voucher nếu có
      if (transaction.userVoucherId) {
        try {
          await voucherRedemptionService.release(
            transaction.userVoucherId,
            transaction.appointmentId,
            { userId: transaction.userId, role: 'SYSTEM' },
            req,
          );
        } catch {
          // Ignore release errors on failure
        }
      }

      // Outbox và Audit Log PAYMENT_FAILED
      await outboxService.recordEvent({
        eventType: 'PAYMENT_FAILED',
        payload: {
          transactionNo: transaction.transactionNo,
          appointmentId: transaction.appointmentId,
          responseCode,
        },
      });

      await auditService.log({
        actor: {
          userId: transaction.userId,
          role: 'SYSTEM',
          email: 'system@clinicbooking.local',
        },
        action: AUDIT_ACTIONS.PAYMENT_FAILED,
        resource: {
          type: 'PaymentTransaction',
          id: transaction.id,
        },
        reason: `Giao dịch ${transaction.transactionNo} thanh toán thất bại (mã phản hồi ${responseCode})`,
        changes: {
          status: PAYMENT_STATUSES.FAILED,
          responseCode,
        },
        req,
      });

      if (isIpn) {
        return { RspCode: '00', Message: 'Confirm Success' };
      }
      return {
        success: false,
        status: PAYMENT_STATUSES.FAILED,
        transactionNo: transaction.transactionNo,
        appointmentId: transaction.appointmentId,
      };
    }
  }

  /**
   * UC-SYS-03: Dọn dẹp giao dịch PENDING quá hạn (expiresAt <= now)
   * Idempotent batch processing, release voucher.
   */
  async cleanupExpiredTransactions() {
    const now = clock.now();
    const expiredList = await PaymentTransaction.find({
      status: PAYMENT_STATUSES.PENDING,
      expiresAt: { $lte: now },
    }).limit(100);

    let cleanedCount = 0;
    for (const txn of expiredList) {
      const res = await PaymentTransaction.updateOne(
        { id: txn.id, status: PAYMENT_STATUSES.PENDING },
        { $set: { status: PAYMENT_STATUSES.EXPIRED } },
      );

      if (res.modifiedCount > 0) {
        cleanedCount += 1;
        if (txn.userVoucherId) {
          try {
            await voucherRedemptionService.release(
              txn.userVoucherId,
              txn.appointmentId,
              { userId: txn.userId, role: 'SYSTEM' },
            );
          } catch {
            // Ignore voucher release failure
          }
        }
      }
    }

    return { cleanedCount };
  }

  /**
   * GET /payments: Lấy lịch sử giao dịch của user trong JWT, có phân trang
   */
  async getMyPayments(user, query = {}) {
    if (!user) {
      throw new ApiError(401, 'Yêu cầu đăng nhập', 'UNAUTHORIZED');
    }

    const numUserId = Number(user.id || user.userId);
    if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
      throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      PaymentTransaction.find({ userId: numUserId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentTransaction.countDocuments({ userId: numUserId }),
    ]);

    return {
      items: payments.map((p) => ({
        id: p.id,
        appointmentId: p.appointmentId,
        transactionNo: p.transactionNo,
        amount: Number(p.amount) || 0,
        discountAmount: p.discountAmount || 0,
        userVoucherId: p.userVoucherId,
        status: p.status,
        bankCode: p.bankCode,
        payDate: p.payDate,
        orderInfo: p.orderInfo,
        createdAt: p.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}

const paymentService = new PaymentService();
module.exports = {
  paymentService,
  PaymentService,
  buildSignedVNPayUrl,
  verifyVNPayHash,
  formatVNPayDate,
};
