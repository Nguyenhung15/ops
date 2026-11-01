const {
  Feedback,
  Appointment,
  User,
} = require('../models');
const {
  ROLES,
  AUDIT_ACTIONS,
  FEEDBACK_STATUSES,
  APPOINTMENT_STATUSES,
} = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const auditService = require('./audit.service');
const { configService } = require('../config/config.service');
const { getClock } = require('./clock.service');

/**
 * Sanitize plain text để loại bỏ hoàn toàn các thẻ HTML, script, style nhằm chống XSS.
 * @param {string} raw
 * @param {number} maxLength
 * @returns {string}
 */
function sanitizeComment(raw, maxLength = 1000) {
  if (!raw || typeof raw !== 'string') return '';
  const withoutDangerousBlocks = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutDangerousBlocks.replace(/<[^>]+>/g, ' ');
  const normalized = withoutTags.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, maxLength);
}

/**
 * Rút gọn tên hiển thị cho ẩn danh (ví dụ: 'Nguyễn Văn Hùng' -> 'N. V. Hùng' hoặc 'Bệnh nhân N.')
 */
function maskName(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'Ẩn danh';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return `${parts[0].slice(0, 1)}***`;
  return `${parts[0].slice(0, 1)}. ${parts.slice(1).join(' ')}`;
}

class FeedbackService {
  /**
   * UC-PAT-12: Patient tạo feedback mới cho lịch hẹn đã hoàn thành (COMPLETED)
   *
   * Quy tắc:
   * 1. appointmentId bắt buộc, thuộc user (sai -> 404).
   * 2. Lịch phải ở trạng thái COMPLETED (sai -> 409 APPOINTMENT_NOT_COMPLETED).
   * 3. Mỗi lịch chỉ 1 feedback đang hoạt động (deletedAt == null); trùng -> 409 FEEDBACK_EXISTS.
   *    (Bản đã xóa mềm deletedAt != null không tính).
   * 4. doctorId tự động lấy từ appointment (không phụ thuộc client).
   * 5. rating nguyên từ 1..5 (sai -> 400).
   * 6. comment bắt buộc, trim tối đa 1000 ký tự, sanitize chống XSS (loại bỏ HTML).
   * 7. status mặc định: PENDING.
   * 8. Ghi Audit CREATE_FEEDBACK.
   */
  async createFeedback(user, payload = {}, req = null) {
    if (!user || (user.userType !== ROLES.PATIENT && user.role !== ROLES.PATIENT)) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền gửi đánh giá phản hồi', 'FORBIDDEN_ROLE');
    }

    const userId = Number(user.id || user.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
    }

    const { appointmentId, rating, comment, title, category, isAnonymous } = payload;

    // Validate appointmentId
    const numApptId = Number(appointmentId);
    if (!Number.isSafeInteger(numApptId) || numApptId <= 0) {
      throw new ApiError(400, 'appointmentId phải là số nguyên dương hợp lệ', 'INVALID_APPOINTMENT_ID');
    }

    // Validate rating: nguyên 1..5
    const numRating = Number(rating);
    if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
      throw new ApiError(400, 'rating phải là số nguyên từ 1 đến 5', 'INVALID_RATING');
    }

    // Validate comment: sanitize chống XSS, tối đa 1000 ký tự
    const cleanComment = sanitizeComment(comment, 1000);
    if (!cleanComment) {
      throw new ApiError(400, 'Nội dung phản hồi (comment) không được để trống', 'EMPTY_COMMENT');
    }

    // Validate title (tùy chọn)
    const cleanTitle = title && typeof title === 'string' ? sanitizeComment(title, 255) : null;
    const cleanCategory = category && typeof category === 'string' ? category.trim().slice(0, 100) : null;
    const anonymousFlag = Boolean(isAnonymous);

    // Kiểm tra lịch hẹn: Phải thuộc user (hoặc profile phụ thuộc của user) và status COMPLETED
    const appointment = await Appointment.findOne({ id: numApptId }).lean();
    if (!appointment) {
      throw new ApiError(404, 'Không tìm thấy lịch hẹn', 'APPOINTMENT_NOT_FOUND');
    }

    // Kiểm tra quyền sở hữu lịch hẹn
    const isOwner = appointment.patientId === userId;
    if (!isOwner) {
      // Trường hợp không thuộc user -> 404 để chống enumeration
      throw new ApiError(404, 'Lịch hẹn không thuộc quyền quản lý của bạn', 'APPOINTMENT_NOT_FOUND');
    }

    // Kiểm tra trạng thái lịch hẹn: BẮT BUỘC COMPLETED
    if (appointment.status !== APPOINTMENT_STATUSES.COMPLETED) {
      throw new ApiError(409, 'Chỉ có thể đánh giá lịch hẹn đã hoàn thành khám', 'APPOINTMENT_NOT_COMPLETED');
    }

    // Kiểm tra trùng: Mỗi lịch một feedback (bản xóa mềm deletedAt != null không tính)
    const existingFeedback = await Feedback.findOne({
      appointmentId: numApptId,
      userId,
      deletedAt: null,
    }).lean();

    if (existingFeedback) {
      throw new ApiError(409, 'Lịch hẹn này đã có đánh giá phản hồi', 'FEEDBACK_EXISTS');
    }

    const clock = getClock();
    const now = clock.now();

    // Tạo feedback mới
    const createdFeedback = await Feedback.create({
      userId,
      appointmentId: numApptId,
      doctorId: appointment.doctorId || null,
      rating: numRating,
      comment: cleanComment,
      title: cleanTitle,
      category: cleanCategory,
      isAnonymous: anonymousFlag,
      status: FEEDBACK_STATUSES.PENDING,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // Ghi Audit CREATE_FEEDBACK
    await auditService.log({
      actor: {
        userId,
        role: user.userType || user.role,
        email: user.email,
      },
      action: AUDIT_ACTIONS.CREATE_FEEDBACK,
      resource: {
        type: 'Feedback',
        id: createdFeedback.id,
      },
      reason: `Bệnh nhân #${userId} gửi phản hồi cho lịch hẹn #${numApptId}`,
      changes: {
        appointmentId: numApptId,
        rating: numRating,
        doctorId: appointment.doctorId,
      },
      req,
    });

    return this.serializeFeedbackItem(createdFeedback, user);
  }

  /**
   * UC-PAT-12: Patient xem danh sách feedback của chính mình (GET /feedbacks/my)
   * Phân trang kèm status, lọc bỏ bản xóa mềm (deletedAt: null).
   */
  async getMyFeedbacks(user, query = {}) {
    if (!user || (user.userType !== ROLES.PATIENT && user.role !== ROLES.PATIENT)) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền xem danh sách phản hồi cá nhân', 'FORBIDDEN_ROLE');
    }

    const userId = Number(user.id || user.userId);
    const filter = {
      userId,
      deletedAt: null,
    };

    if (query.status && Object.values(FEEDBACK_STATUSES).includes(query.status)) {
      filter.status = query.status;
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [feedbacks, total] = await Promise.all([
      Feedback.find(filter)
        .sort({ createdAt: -1, id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Feedback.countDocuments(filter),
    ]);

    const items = feedbacks.map((fb) => this.serializeFeedbackItem(fb, user));

    return {
      items,
      data: items, // tương thích frontend
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * UC-PAT-12: Patient cập nhật feedback của mình (PUT /feedbacks/:id)
   *
   * Quy tắc:
   * 1. Chỉ sửa của chính mình trong FEEDBACK_EDIT_DAYS ngày kể từ createdAt (sai -> 409 FEEDBACK_EDIT_WINDOW_CLOSED).
   * 2. Người khác hoặc không tồn tại -> 404 (chống enumeration).
   * 3. Sửa bản PUBLISHED thì tự động quay về PENDING để kiểm duyệt lại.
   * 4. Ghi Audit UPDATE_FEEDBACK.
   */
  async updateFeedback(user, feedbackId, payload = {}, req = null) {
    if (!user || (user.userType !== ROLES.PATIENT && user.role !== ROLES.PATIENT)) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền chỉnh sửa phản hồi cá nhân', 'FORBIDDEN_ROLE');
    }

    const userId = Number(user.id || user.userId);
    const numFbId = Number(feedbackId);
    if (!Number.isSafeInteger(numFbId) || numFbId <= 0) {
      throw new ApiError(400, 'id phản hồi không hợp lệ', 'INVALID_FEEDBACK_ID');
    }

    const feedback = await Feedback.findOne({
      id: numFbId,
      userId,
      deletedAt: null,
    });

    if (!feedback) {
      throw new ApiError(404, 'Không tìm thấy phản hồi hoặc phản hồi không thuộc về bạn', 'FEEDBACK_NOT_FOUND');
    }

    // Kiểm tra giới hạn ngày sửa (FEEDBACK_EDIT_DAYS)
    const clock = getClock();
    const now = clock.now();
    const editDaysAllowed = configService.feedbackEditDays || 7;
    const createdAtTime = new Date(feedback.createdAt).getTime();
    const elapsedDays = (now.getTime() - createdAtTime) / (1000 * 60 * 60 * 24);

    if (elapsedDays > editDaysAllowed) {
      throw new ApiError(
        409,
        `Thời hạn chỉnh sửa phản hồi (${editDaysAllowed} ngày) đã kết thúc`,
        'FEEDBACK_EDIT_WINDOW_CLOSED',
      );
    }

    const updateFields = {};

    // Validate rating nếu có cập nhật
    if (payload.rating !== undefined) {
      const numRating = Number(payload.rating);
      if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
        throw new ApiError(400, 'rating phải là số nguyên từ 1 đến 5', 'INVALID_RATING');
      }
      updateFields.rating = numRating;
    }

    // Validate comment nếu có cập nhật
    if (payload.comment !== undefined) {
      const cleanComment = sanitizeComment(payload.comment, 1000);
      if (!cleanComment) {
        throw new ApiError(400, 'Nội dung phản hồi không được để trống', 'EMPTY_COMMENT');
      }
      updateFields.comment = cleanComment;
    }

    if (payload.title !== undefined) {
      updateFields.title = payload.title ? sanitizeComment(payload.title, 255) : null;
    }
    if (payload.category !== undefined) {
      updateFields.category = payload.category ? String(payload.category).trim().slice(0, 100) : null;
    }
    if (payload.isAnonymous !== undefined) {
      updateFields.isAnonymous = Boolean(payload.isAnonymous);
    }

    // Nếu sửa bản PUBLISHED thì quay về PENDING
    if (feedback.status === FEEDBACK_STATUSES.PUBLISHED) {
      updateFields.status = FEEDBACK_STATUSES.PENDING;
    }

    updateFields.updatedAt = now;

    Object.assign(feedback, updateFields);
    await feedback.save();

    // Ghi Audit UPDATE_FEEDBACK
    await auditService.log({
      actor: {
        userId,
        role: user.userType || user.role,
        email: user.email,
      },
      action: AUDIT_ACTIONS.UPDATE_FEEDBACK,
      resource: {
        type: 'Feedback',
        id: feedback.id,
      },
      reason: `Bệnh nhân #${userId} cập nhật phản hồi #${feedback.id}`,
      changes: {
        feedbackId: feedback.id,
        newStatus: feedback.status,
      },
      req,
    });

    return this.serializeFeedbackItem(feedback, user);
  }

  /**
   * UC-PAT-12: Patient xóa feedback của mình (DELETE /feedbacks/:id)
   *
   * Quy tắc:
   * 1. Xóa mềm (gán deletedAt = clock.now()).
   * 2. Chỉ xóa trong FEEDBACK_EDIT_DAYS ngày (quá hạn -> 409 FEEDBACK_EDIT_WINDOW_CLOSED).
   * 3. Người khác hoặc không tồn tại -> 404 (chống enumeration).
   * 4. Sau khi xóa mềm, patient có quyền gửi lại feedback mới cho lịch hẹn đó.
   * 5. Ghi Audit DELETE_FEEDBACK.
   */
  async deleteFeedback(user, feedbackId, req = null) {
    if (!user || (user.userType !== ROLES.PATIENT && user.role !== ROLES.PATIENT)) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền xóa phản hồi cá nhân', 'FORBIDDEN_ROLE');
    }

    const userId = Number(user.id || user.userId);
    const numFbId = Number(feedbackId);
    if (!Number.isSafeInteger(numFbId) || numFbId <= 0) {
      throw new ApiError(400, 'id phản hồi không hợp lệ', 'INVALID_FEEDBACK_ID');
    }

    const feedback = await Feedback.findOne({
      id: numFbId,
      userId,
      deletedAt: null,
    });

    if (!feedback) {
      throw new ApiError(404, 'Không tìm thấy phản hồi hoặc phản hồi không thuộc về bạn', 'FEEDBACK_NOT_FOUND');
    }

    // Kiểm tra thời hạn xóa
    const clock = getClock();
    const now = clock.now();
    const editDaysAllowed = configService.feedbackEditDays || 7;
    const createdAtTime = new Date(feedback.createdAt).getTime();
    const elapsedDays = (now.getTime() - createdAtTime) / (1000 * 60 * 60 * 24);

    if (elapsedDays > editDaysAllowed) {
      throw new ApiError(
        409,
        `Thời hạn xóa phản hồi (${editDaysAllowed} ngày) đã kết thúc`,
        'FEEDBACK_EDIT_WINDOW_CLOSED',
      );
    }

    feedback.deletedAt = now;
    await feedback.save();

    // Ghi Audit DELETE_FEEDBACK
    await auditService.log({
      actor: {
        userId,
        role: user.userType || user.role,
        email: user.email,
      },
      action: AUDIT_ACTIONS.DELETE_FEEDBACK,
      resource: {
        type: 'Feedback',
        id: feedback.id,
      },
      reason: `Bệnh nhân #${userId} xóa mềm phản hồi #${feedback.id}`,
      changes: {
        feedbackId: feedback.id,
        appointmentId: feedback.appointmentId,
      },
      req,
    });

    return {
      success: true,
      message: 'Xóa phản hồi thành công',
      id: feedback.id,
    };
  }

  /**
   * UC-PAT-12: Viết sẵn hàm query public (getPublishedAnonymous)
   *
   * Quy tắc:
   * 1. CHỈ lấy các bản ghi PUBLISHED (status === 'PUBLISHED') và chưa bị xóa mềm (deletedAt: null).
   * 2. TUYỆT ĐỐI KHÔNG trả trường userId, email thật.
   * 3. Tên người đánh giá: nếu isAnonymous = true -> hiển thị 'Ẩn danh'; nếu false -> hiển thị tên rút gọn (ví dụ 'N. V. Hùng').
   * 4. CHƯA mở endpoint public, chờ policy Guest.
   */
  async getPublishedAnonymous(query = {}) {
    const filter = {
      status: FEEDBACK_STATUSES.PUBLISHED,
      deletedAt: null,
    };

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
    const skip = (page - 1) * limit;

    const feedbacks = await Feedback.find(filter)
      .sort({ createdAt: -1, id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Lấy tên các user để làm mask (nếu không ẩn danh)
    const userIds = [...new Set(feedbacks.map((f) => f.userId).filter(Boolean))];
    const users = await User.find({ id: { $in: userIds } })
      .select('id fullName')
      .lean();
    const userMap = new Map(users.map((u) => [u.id, u.fullName]));

    return feedbacks.map((fb) => {
      const isAnon = Boolean(fb.isAnonymous);
      const originalName = userMap.get(fb.userId) || 'Bệnh nhân';
      const patientName = isAnon ? 'Ẩn danh' : maskName(originalName);

      return {
        id: fb.id,
        // TUYỆT ĐỐI KHÔNG có userId hay patientEmail
        patientName,
        rating: fb.rating,
        title: fb.title || undefined,
        comment: fb.comment,
        category: fb.category || undefined,
        isAnonymous: isAnon,
        adminResponse: fb.adminResponse || undefined,
        adminRespondedAt: fb.adminRespondedAt ? new Date(fb.adminRespondedAt).toISOString() : undefined,
        createdAt: fb.createdAt ? new Date(fb.createdAt).toISOString() : new Date().toISOString(),
      };
    });
  }

  /**
   * Helper serialize FeedbackItem khớp interface frontend web/src/api/feedback.ts
   */
  serializeFeedbackItem(feedback, currentUser = null) {
    const isDoc = feedback.toObject ? feedback.toObject() : feedback;
    const isOwner = currentUser ? (currentUser.id === isDoc.userId || currentUser.userId === isDoc.userId) : false;

    return {
      id: isDoc.id,
      userId: isOwner ? isDoc.userId : undefined,
      appointmentId: isDoc.appointmentId,
      doctorId: isDoc.doctorId || undefined,
      patientName: currentUser?.fullName || 'Bệnh nhân',
      patientEmail: isOwner ? currentUser?.email : undefined,
      rating: isDoc.rating,
      title: isDoc.title || undefined,
      comment: isDoc.comment,
      category: isDoc.category || undefined,
      status: isDoc.status,
      isAnonymous: Boolean(isDoc.isAnonymous),
      adminResponse: isDoc.adminResponse || undefined,
      adminRespondedAt: isDoc.adminRespondedAt ? new Date(isDoc.adminRespondedAt).toISOString() : undefined,
      createdAt: isDoc.createdAt ? new Date(isDoc.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: isDoc.updatedAt ? new Date(isDoc.updatedAt).toISOString() : undefined,
      isOwner,
    };
  }
}

const feedbackService = new FeedbackService();
module.exports = {
  feedbackService,
  FeedbackService,
  sanitizeComment,
  maskName,
};
