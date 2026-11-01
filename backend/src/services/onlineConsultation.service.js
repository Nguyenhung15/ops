const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  Appointment,
  DoctorShift,
  PaymentTransaction,
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
const { clock } = require('./clock.service');
const { parseClinicDateTimeToUtc } = require('../utils/timezone');
const { paymentService } = require('./payment.service');

/**
 * UC-PAT-07: Patient vào khám online
 */
class OnlineConsultationService {
  /**
   * Bệnh nhân tham gia phòng khám online
   * POST /appointments/:id/join-online
   *
   * @param {object} actor - User trích xuất từ JWT ({ id, userId, role, email })
   * @param {string|number} appointmentId - ID hoặc appointmentNo của lịch hẹn
   * @param {object} [req=null] - Express request (phục vụ audit & metadata)
   * @returns {Promise<object>} { meetingUrl, joinToken, meetingCode, availableUntil }
   */
  async joinOnline(actor, appointmentId, req = null) {
    // 0. Phân quyền: Chỉ bệnh nhân (PATIENT) mới có quyền tham gia với vai trò bệnh nhân
    const userRole = actor?.role || actor?.userType;
    if (userRole !== ROLES.PATIENT) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền tham gia phòng khám trực tuyến', 'FORBIDDEN_ROLE');
    }

    const numUserId = Number(actor.id || actor.userId);
    if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
      throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
    }

    // 1. Kiểm tra lịch hẹn tồn tại và thuộc về user (sai hoặc không tồn tại -> cùng mã 404 để tránh user enumeration)
    const numApptId = Number(appointmentId);
    const filter = Number.isSafeInteger(numApptId) && numApptId > 0
      ? { id: numApptId }
      : { appointmentNo: String(appointmentId).trim() };

    const appointment = await Appointment.findOne(filter);
    if (!appointment || appointment.patientId !== numUserId) {
      throw new ApiError(404, 'Không tìm thấy lịch hẹn hoặc lịch hẹn không thuộc về bạn', 'APPOINTMENT_NOT_FOUND');
    }

    // 2. Kiểm tra type: Bắt buộc là ONLINE, nếu không -> 409 NOT_ONLINE_APPOINTMENT
    if (appointment.type !== 'ONLINE') {
      throw new ApiError(409, 'Lịch khám này không phải hình thức khám trực tuyến (ONLINE)', 'NOT_ONLINE_APPOINTMENT');
    }

    // 3. Kiểm tra State: Phải là CONFIRMED (cho vào lại khi CHECKED_IN hoặc IN_PROGRESS), khác thì 409
    const allowedStatuses = [
      APPOINTMENT_STATUSES.CONFIRMED,
      APPOINTMENT_STATUSES.CHECKED_IN,
      APPOINTMENT_STATUSES.IN_PROGRESS,
    ];
    if (!allowedStatuses.includes(appointment.status)) {
      throw new ApiError(
        409,
        `Lịch hẹn ở trạng thái '${appointment.status}' không thể tham gia khám online`,
        'INVALID_APPOINTMENT_STATUS',
      );
    }

    // 4. Kiểm tra thanh toán nếu cờ ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN bật
    if (env.onlineRequirePaymentBeforeJoin) {
      const successPayment = await PaymentTransaction.findOne({
        appointmentId: appointment.id,
        status: PAYMENT_STATUSES.SUCCESS,
      }).lean();

      if (!successPayment) {
        // Tạo paymentUrl tách riêng để bệnh nhân có thể thanh toán trước khi vào
        let paymentUrl = null;
        try {
          const createRes = await paymentService.createPaymentUrl({
            user: actor,
            appointmentId: appointment.id,
            req,
          });
          paymentUrl = createRes.paymentUrl;
        } catch {
          // Bỏ qua lỗi nếu tạo paymentUrl gặp xung đột, chỉ ném 409 PAYMENT_REQUIRED
        }

        throw new ApiError(
          409,
          'Lịch hẹn khám trực tuyến yêu cầu thanh toán thành công trước khi vào phòng khám',
          'PAYMENT_REQUIRED',
          paymentUrl ? { paymentUrl } : undefined,
        );
      }
    }

    // 5. Kiểm tra thời gian theo clock + timezone clinic:
    // Slot window: [slotStart - JOIN_EARLY_MINUTES, slotEnd + JOIN_LATE_GRACE_MINUTES]
    const tz = env.clinicTimeZone || 'Asia/Ho_Chi_Minh';
    const appointmentDateStr = appointment.appointmentDate;
    const appointmentTimeStr = appointment.appointmentTime; // "HH:mm"

    if (!appointmentDateStr || !appointmentTimeStr) {
      throw new ApiError(500, 'Lịch hẹn thiếu thông tin ngày hoặc giờ khám', 'MISSING_DATETIME');
    }

    const slotStartUtc = parseClinicDateTimeToUtc(appointmentDateStr, appointmentTimeStr, tz);

    // Tính slotEndUtc:
    // Tìm slot trong DoctorShift.slots của ca khám
    let slotEndUtc = null;
    const shift = await DoctorShift.findOne({ id: appointment.shiftId }).lean();
    if (shift && Array.isArray(shift.slots)) {
      const bookedSlot = shift.slots.find((s) =>
        (Array.isArray(appointment.slotIds) && appointment.slotIds.includes(s.id)) ||
        s.bookingRef === appointment.appointmentNo,
      );
      if (bookedSlot && bookedSlot.endTime) {
        slotEndUtc = parseClinicDateTimeToUtc(appointmentDateStr, bookedSlot.endTime, tz);
      }
    }

    // Fallback: Nếu không tìm thấy slot.endTime cụ thể, dùng slotDurationMinutes của shift (hoặc mặc định 45 phút)
    if (!slotEndUtc) {
      const durationMin = Number(shift?.slotDurationMinutes) || 45;
      slotEndUtc = new Date(slotStartUtc.getTime() + durationMin * 60 * 1000);
    }

    const joinEarlyMinutes = env.joinEarlyMinutes ?? 15;
    const joinLateGraceMinutes = env.joinLateGraceMinutes ?? 15;

    const windowStart = new Date(slotStartUtc.getTime() - joinEarlyMinutes * 60 * 1000);
    const windowEnd = new Date(slotEndUtc.getTime() + joinLateGraceMinutes * 60 * 1000);

    const now = clock.now();

    if (now < windowStart) {
      throw new ApiError(
        409,
        `Chưa đến thời gian mở phòng khám online. Phòng khám mở trước ca khám ${joinEarlyMinutes} phút.`,
        'JOIN_TOO_EARLY',
        { availableFrom: windowStart.toISOString() },
      );
    }

    if (now > windowEnd) {
      throw new ApiError(
        409,
        `Thời gian tham gia phòng khám online đã kết thúc (quá thời hạn ${joinLateGraceMinutes} phút sau giờ kết thúc ca).`,
        'JOIN_WINDOW_CLOSED',
      );
    }

    // 6. Kiểm tra JOIN_TOKEN_SECRET cấu hình riêng
    const joinTokenSecret = env.joinTokenSecret;
    if (!joinTokenSecret || typeof joinTokenSecret !== 'string' || joinTokenSecret.trim() === '') {
      throw new ApiError(
        500,
        'Cấu hình máy chủ thiếu khóa bảo mật JOIN_TOKEN_SECRET',
        'MISSING_JOIN_TOKEN_SECRET',
      );
    }

    // 7. Meeting code & URL: Đảm bảo 2 request song song sinh cùng một meetingCode
    let meetingCode = appointment.meeting?.code || appointment.joinCode;
    let meetingUrl = appointment.meeting?.url || appointment.meetingUrl;

    if (!meetingCode) {
      const generatedCode = crypto.randomBytes(6).toString('hex').toUpperCase();
      const generatedUrl = `/video-call/${generatedCode}`;

      // Conditional update để tránh ghi đè và đảm bảo tính idempotent/concurrency
      const updateRes = await Appointment.findOneAndUpdate(
        {
          id: appointment.id,
          $or: [
            { 'meeting.code': null },
            { 'meeting.code': { $exists: false } },
            { meeting: null },
          ],
        },
        {
          $set: {
            'meeting.code': generatedCode,
            'meeting.url': generatedUrl,
            'meeting.createdAt': now,
            meetingUrl: generatedUrl,
            joinCode: generatedCode,
          },
        },
        { returnDocument: 'after' },
      );

      if (updateRes && (updateRes.meeting?.code || updateRes.joinCode)) {
        meetingCode = updateRes.meeting?.code || updateRes.joinCode;
        meetingUrl = updateRes.meeting?.url || updateRes.meetingUrl;
      } else {
        // Đã có tiến trình khác cập nhật trước đó
        const latestAppt = await Appointment.findOne({ id: appointment.id }).lean();
        meetingCode = latestAppt?.meeting?.code || latestAppt?.joinCode;
        meetingUrl = latestAppt?.meeting?.url || latestAppt?.meetingUrl;
      }
    }

    // 8. Sinh joinToken ngắn hạn ký bằng JOIN_TOKEN_SECRET riêng
    // Hạn dùng token không vượt quá windowEnd (thời điểm đóng cửa sổ join)
    const tokenExpSeconds = Math.max(60, Math.floor((windowEnd.getTime() - now.getTime()) / 1000));
    const tokenPayload = {
      appointmentId: appointment.id,
      appointmentNo: appointment.appointmentNo,
      userId: numUserId,
      role: userRole,
    };

    const joinToken = jwt.sign(tokenPayload, joinTokenSecret, {
      expiresIn: tokenExpSeconds,
    });

    // 9. Ghi Audit Log JOIN_ONLINE (Tuyệt đối không log token, không rò rỉ secret)
    await auditService.log({
      actor: {
        userId: numUserId,
        role: userRole,
        email: actor.email,
      },
      action: AUDIT_ACTIONS.JOIN_ONLINE,
      resource: {
        type: 'Appointment',
        id: appointment.id,
      },
      reason: `Bệnh nhân #${numUserId} tham gia phòng khám online cho lịch #${appointment.appointmentNo}`,
      changes: {
        appointmentId: appointment.id,
        meetingCode,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      },
      req,
    });

    // 10. Trả về kết quả (không chứa PII thừa)
    return {
      appointmentId: appointment.id,
      appointmentNo: appointment.appointmentNo,
      meetingUrl,
      meetingCode,
      joinToken,
      availableUntil: windowEnd.toISOString(),
    };
  }
}

const onlineConsultationService = new OnlineConsultationService();
module.exports = {
  onlineConsultationService,
  OnlineConsultationService,
};
