const {
  Feedback,
  Appointment,
  User,
} = require('../models');
const {
  ROLES,
  AUDIT_ACTIONS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_VALUES,
  APPOINTMENT_STATUSES,
} = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const { parsePositiveInt } = require('../utils/normalizers');
const { recordAudit } = require('./audit.service');
const { clock } = require('./clock.service');
const { configService } = require('../config/config.service');

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

/**
 * Format feedback document into standard FeedbackItem.
 */
function serializeFeedback(doc, authorUser, viewer = null, isAdmin = false) {
  const f = doc.toJSON ? doc.toJSON() : doc;
  const author = authorUser || {};

  const viewerId = viewer ? Number(viewer.id || viewer.userId) : null;
  const isOwner = viewerId ? viewerId === Number(f.userId) : false;
  const isAnonymous = Boolean(f.isAnonymous);

  const showAuthor = isAdmin || isOwner || !isAnonymous;

  const result = {
    id: f.id,
    userId: showAuthor ? f.userId : undefined,
    appointmentId: f.appointmentId || undefined,
    doctorId: f.doctorId || undefined,
    patientName: showAuthor ? (author.fullName || 'Bệnh nhân') : 'Bệnh nhân ẩn danh',
    patientEmail: showAuthor ? author.email : undefined,
    rating: f.rating,
    title: f.title || '',
    comment: f.comment,
    category: f.category || 'Khác',
    isAnonymous,
    adminResponse: f.adminResponse || undefined,
    adminRespondedAt: f.adminRespondedAt instanceof Date ? f.adminRespondedAt.toISOString() : (f.adminRespondedAt || undefined),
    createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : (f.createdAt || new Date().toISOString()),
    updatedAt: f.updatedAt instanceof Date ? f.updatedAt.toISOString() : (f.updatedAt || undefined),
    isOwner,
  };

  if (isAdmin || isOwner) {
    result.status = f.status;
  }

  if (isAdmin) {
    result.adminRespondedBy = f.adminRespondedBy ?? null;
    result.moderatedBy = f.moderatedBy ?? null;
    result.moderatedAt = f.moderatedAt instanceof Date ? f.moderatedAt.toISOString() : (f.moderatedAt || null);
  }

  return result;
}

class FeedbackService {
  serializeFeedbackItem(feedback, currentUser = null) {
    const isDoc = feedback.toObject ? feedback.toObject() : feedback;
    const userId = currentUser ? Number(currentUser.id || currentUser.userId) : null;
    const isOwner = userId ? userId === Number(isDoc.userId) : false;

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

  async createFeedback(user, payload = {}, req = null) {
    if (!user || (user.userType !== ROLES.PATIENT && user.role !== ROLES.PATIENT)) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền gửi đánh giá phản hồi', 'FORBIDDEN_ROLE');
    }

    const userId = Number(user.id || user.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
    }

    const { appointmentId, rating, comment, title, category, isAnonymous } = payload;

    const numRating = Number(rating);
    if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
      throw new ApiError(400, 'rating phải là số nguyên từ 1 đến 5', 'INVALID_RATING');
    }

    const cleanComment = sanitizeComment(comment, 2000);
    if (!cleanComment) {
      throw new ApiError(400, 'Nội dung phản hồi (comment) không được để trống', 'EMPTY_COMMENT');
    }

    const cleanTitle = title && typeof title === 'string' ? sanitizeComment(title, 255) : null;
    const cleanCategory = category && typeof category === 'string' ? category.trim().slice(0, 100) : 'Khác';
    const anonymousFlag = Boolean(isAnonymous);

    let docDoctorId = null;
    let numApptId = null;

    if (appointmentId !== undefined && appointmentId !== null && appointmentId !== '') {
      numApptId = Number(appointmentId);
      if (!Number.isSafeInteger(numApptId) || numApptId <= 0) {
        throw new ApiError(400, 'appointmentId phải là số nguyên dương hợp lệ', 'INVALID_APPOINTMENT_ID');
      }

      const appointment = await Appointment.findOne({ id: numApptId }).lean();
      if (!appointment) {
        throw new ApiError(404, 'Không tìm thấy lịch hẹn', 'APPOINTMENT_NOT_FOUND');
      }

      const isOwner = appointment.patientId === userId;
      if (!isOwner) {
        throw new ApiError(404, 'Lịch hẹn không thuộc quyền quản lý của bạn', 'APPOINTMENT_NOT_FOUND');
      }

      if (appointment.status !== APPOINTMENT_STATUSES.COMPLETED) {
        throw new ApiError(409, 'Chỉ có thể đánh giá cho lịch hẹn đã hoàn thành khám', 'APPOINTMENT_NOT_COMPLETED');
      }

      const existingActive = await Feedback.findOne({
        appointmentId: numApptId,
        userId,
        deletedAt: null,
      }).lean();
      if (existingActive) {
        throw new ApiError(409, 'Bạn đã gửi đánh giá cho lịch hẹn này rồi', 'FEEDBACK_EXISTS');
      }

      docDoctorId = appointment.doctorId || null;
    }

    const initialStatus = numApptId ? FEEDBACK_STATUSES.PENDING : FEEDBACK_STATUSES.APPROVED;

    let created;
    try {
      created = await Feedback.create({
        userId,
        appointmentId: numApptId,
        doctorId: docDoctorId,
        rating: numRating,
        title: cleanTitle,
        comment: cleanComment,
        category: cleanCategory,
        isAnonymous: anonymousFlag,
        status: initialStatus,
        deletedAt: null,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        throw new ApiError(409, 'Bạn đã gửi đánh giá cho lịch hẹn này rồi', 'FEEDBACK_EXISTS');
      }
      throw err;
    }

    // Ghi audit CREATE_FEEDBACK
    try {
      await recordAudit({
        actor: {
          id: userId,
          userId,
          role: user.userType || user.role || ROLES.PATIENT,
          email: user.email,
        },
        action: AUDIT_ACTIONS.CREATE_FEEDBACK || 'CREATE_FEEDBACK',
        targetType: 'Feedback',
        targetId: created.id,
        reason: `Bệnh nhân #${userId} gửi phản hồi #${created.id}`,
        changes: {
          feedbackId: created.id,
          appointmentId: numApptId,
          rating: numRating,
          status: created.status,
        },
        req,
      });
    } catch (auditErr) {
      // Non-blocking audit failure
    }

    const author = await User.findOne({ id: userId }).select('id fullName email').lean();
    return serializeFeedback(created, author, user);
  }

  async getMyFeedbacks(user, query = {}) {
    if (!user) {
      throw new ApiError(401, 'Vui lòng đăng nhập', 'UNAUTHORIZED');
    }
    const userId = Number(user.id || user.userId);
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const filter = { userId, deletedAt: null };
    const [items, total] = await Promise.all([
      Feedback.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Feedback.countDocuments(filter),
    ]);

    const author = await User.findOne({ id: userId }).select('id fullName email').lean();
    return {
      items: items.map((f) => serializeFeedback(f, author, user)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async updateFeedback(user, feedbackId, payload = {}, req = null) {
    const id = parsePositiveInt(feedbackId, 'Feedback ID');
    const feedback = await Feedback.findOne({ id, deletedAt: null });
    if (!feedback) {
      throw new ApiError(404, `Không tìm thấy đánh giá #${id}`, 'FEEDBACK_NOT_FOUND');
    }

    const userId = Number(user.id || user.userId);
    const isAdmin = user && (user.userType === 'Admin' || user.role === 'Admin');
    if (!isAdmin && Number(feedback.userId) !== userId) {
      throw new ApiError(404, `Không tìm thấy đánh giá #${id}`, 'FEEDBACK_NOT_FOUND');
    }

    // Kiểm tra thời hạn sửa (nếu là bệnh nhân)
    const now = clock.now();
    if (!isAdmin) {
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
    }

    if (payload.rating !== undefined) {
      const numRating = Number(payload.rating);
      if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
        throw new ApiError(400, 'rating phải là số nguyên từ 1 đến 5', 'INVALID_RATING');
      }
      feedback.rating = numRating;
    }

    if (payload.comment !== undefined) {
      const cleanComment = sanitizeComment(payload.comment, 2000);
      if (!cleanComment) {
        throw new ApiError(400, 'Nội dung phản hồi không được để trống', 'EMPTY_COMMENT');
      }
      feedback.comment = cleanComment;
    }

    if (payload.title !== undefined) {
      feedback.title = payload.title ? sanitizeComment(payload.title, 255) : null;
    }

    if (payload.category !== undefined) {
      feedback.category = payload.category ? String(payload.category).trim().slice(0, 100) : feedback.category;
    }

    if (payload.isAnonymous !== undefined) {
      feedback.isAnonymous = Boolean(payload.isAnonymous);
    }

    // Nếu sửa bản PUBLISHED thì tự động quay về PENDING
    if (feedback.status === FEEDBACK_STATUSES.PUBLISHED) {
      feedback.status = FEEDBACK_STATUSES.PENDING;
    }

    await feedback.save();

    // Ghi Audit UPDATE_FEEDBACK
    try {
      await recordAudit({
        actor: {
          id: userId,
          userId,
          role: user.userType || user.role || 'PATIENT',
          email: user.email,
        },
        action: AUDIT_ACTIONS.UPDATE_FEEDBACK || 'UPDATE_FEEDBACK',
        targetType: 'Feedback',
        targetId: feedback.id,
        reason: `Người dùng #${userId} cập nhật phản hồi #${feedback.id}`,
        changes: {
          feedbackId: feedback.id,
          newStatus: feedback.status,
          rating: feedback.rating,
        },
        req,
      });
    } catch (auditErr) {
      // Non-blocking
    }

    const author = await User.findOne({ id: feedback.userId }).select('id fullName email').lean();
    return serializeFeedback(feedback, author, user);
  }

  async updateFeedbackByOwner(user, idParam, payload, req = null) {
    return this.updateFeedback(user, idParam, payload, req);
  }

  async deleteFeedback(actor, idParam, req = null) {
    const id = parsePositiveInt(idParam, 'Feedback ID');
    const feedback = await Feedback.findOne({ id });
    const isAdmin = actor && (actor.userType === 'Admin' || actor.role === 'Admin');

    if (!feedback || (feedback.deletedAt && !isAdmin)) {
      throw new ApiError(404, `Không tìm thấy đánh giá #${id}`, 'FEEDBACK_NOT_FOUND');
    }

    const isOwner = actor && Number(actor.id || actor.userId) === Number(feedback.userId);

    if (!isAdmin && !isOwner) {
      throw new ApiError(404, `Không tìm thấy đánh giá #${id}`, 'FEEDBACK_NOT_FOUND');
    }

    const now = clock.now();

    if (isAdmin) {
      await Feedback.deleteOne({ id });
    } else {
      // Kiểm tra thời hạn xóa
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
    }

    // Ghi Audit DELETE_FEEDBACK
    try {
      await recordAudit({
        actor: {
          id: actor.id || actor.userId,
          userId: actor.id || actor.userId,
          role: actor.userType || actor.role,
          email: actor.email,
        },
        action: AUDIT_ACTIONS.DELETE_FEEDBACK || 'DELETE_FEEDBACK',
        targetType: 'Feedback',
        targetId: feedback.id,
        reason: `Người dùng xóa phản hồi #${feedback.id}`,
        changes: {
          feedbackId: feedback.id,
          appointmentId: feedback.appointmentId,
        },
        req,
      });
    } catch (auditErr) {
      // Non-blocking
    }

    return {
      success: true,
      deleted: true,
      message: 'Xóa đánh giá thành công',
      id: feedback.id,
    };
  }

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

  async getPublicFeedbacks(query = {}, viewer = null) {
    const filter = {
      status: FEEDBACK_STATUSES.APPROVED,
      deletedAt: null,
    };

    if (query.rating) {
      const r = Number(query.rating);
      if (Number.isInteger(r) && r >= 1 && r <= 5) filter.rating = r;
    }

    const feedbacks = await Feedback.find(filter).sort({ createdAt: -1 });
    if (feedbacks.length === 0) return [];

    const userIds = [...new Set(feedbacks.map((f) => f.userId).filter(Boolean))];
    const users = await User.find({ id: { $in: userIds } }).select('id fullName email').lean();
    const userMap = new Map(users.map((u) => [u.id, u]));

    return feedbacks.map((f) => serializeFeedback(f, userMap.get(f.userId), viewer, false));
  }

  async getFeedbackStats() {
    const feedbacks = await Feedback.find({
      status: FEEDBACK_STATUSES.APPROVED,
      deletedAt: null,
    }).select('rating').lean();

    const totalFeedbacks = feedbacks.length;
    const starCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;

    for (const f of feedbacks) {
      const r = f.rating;
      if (r >= 1 && r <= 5) {
        starCounts[r] = (starCounts[r] || 0) + 1;
        sum += r;
      }
    }

    const averageRating = totalFeedbacks > 0 ? Number((sum / totalFeedbacks).toFixed(1)) : 0;

    return {
      totalFeedbacks,
      averageRating,
      starCounts,
    };
  }

  async getAllFeedbacksForAdmin(filters = {}) {
    const query = { deletedAt: null };

    if (filters.status && FEEDBACK_STATUS_VALUES.includes(String(filters.status).toUpperCase())) {
      query.status = String(filters.status).toUpperCase();
    }

    if (filters.rating) {
      const r = Number(filters.rating);
      if (Number.isInteger(r) && r >= 1 && r <= 5) {
        query.rating = r;
      }
    }

    if (filters.category && typeof filters.category === 'string' && filters.category.trim()) {
      query.category = filters.category.trim();
    }

    const feedbacks = await Feedback.find(query).sort({ createdAt: -1 });
    if (feedbacks.length === 0) return [];

    const userIds = new Set();
    for (const item of feedbacks) {
      if (item.userId) userIds.add(item.userId);
      if (item.adminRespondedBy) userIds.add(item.adminRespondedBy);
      if (item.moderatedBy) userIds.add(item.moderatedBy);
    }

    const users = await User.find({ id: { $in: [...userIds] } }).select('id fullName email').lean();
    const userMap = new Map(users.map((u) => [u.id, u]));

    return feedbacks.map((f) => {
      const item = serializeFeedback(f, userMap.get(f.userId), null, true);
      if (f.adminRespondedBy) {
        item.adminRespondedByName = userMap.get(f.adminRespondedBy)?.fullName || null;
      }
      if (f.moderatedBy) {
        item.moderatedByName = userMap.get(f.moderatedBy)?.fullName || null;
      }
      return item;
    });
  }

  async getFeedbackDetailForAdmin(idParam) {
    const id = parsePositiveInt(idParam, 'Feedback ID');
    const feedback = await Feedback.findOne({ id });
    if (!feedback) {
      throw new ApiError(404, `Không tìm thấy đánh giá #${id}`);
    }

    const userIds = [feedback.userId, feedback.adminRespondedBy, feedback.moderatedBy].filter(Boolean);
    const users = await User.find({ id: { $in: userIds } }).select('id fullName email').lean();
    const userMap = new Map(users.map((u) => [u.id, u]));

    const item = serializeFeedback(feedback, userMap.get(feedback.userId), null, true);
    if (feedback.adminRespondedBy) {
      item.adminRespondedByName = userMap.get(feedback.adminRespondedBy)?.fullName || null;
    }
    if (feedback.moderatedBy) {
      item.moderatedByName = userMap.get(feedback.moderatedBy)?.fullName || null;
    }

    return item;
  }

  async respondToFeedback(actor, idParam, payload = {}, req = null) {
    const id = parsePositiveInt(idParam, 'Feedback ID');
    const feedback = await Feedback.findOne({ id });
    if (!feedback) {
      throw new ApiError(404, `Không tìm thấy đánh giá #${id}`);
    }

    const rawResponse = payload.adminResponse !== undefined ? payload.adminResponse : payload.response;
    if (!rawResponse || typeof rawResponse !== 'string' || !rawResponse.trim()) {
      throw new ApiError(400, 'Nội dung phản hồi của Admin không được để trống');
    }

    const responseText = rawResponse.trim();
    if (responseText.length > 2000) {
      throw new ApiError(400, 'Nội dung phản hồi không được vượt quá 2000 ký tự');
    }

    const beforeSnap = {
      adminResponse: feedback.adminResponse,
      adminRespondedAt: feedback.adminRespondedAt,
      adminRespondedBy: feedback.adminRespondedBy,
    };

    const respondedAt = new Date();
    feedback.adminResponse = responseText;
    feedback.adminRespondedAt = respondedAt;
    feedback.adminRespondedBy = actor.id;

    await feedback.save();

    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.FEEDBACK_RESPONSE,
      targetType: 'Feedback',
      targetId: feedback.id,
      reason: `Admin phản hồi đánh giá #${feedback.id}`,
      changes: {
        before: beforeSnap,
        after: {
          adminResponse: responseText,
          adminRespondedAt: respondedAt.toISOString(),
          adminRespondedBy: actor.id,
        },
      },
      req,
    });

    return this.getFeedbackDetailForAdmin(id);
  }

  async changeFeedbackStatus(actor, idParam, payload = {}, req = null) {
    const id = parsePositiveInt(idParam, 'Feedback ID');
    const feedback = await Feedback.findOne({ id });
    if (!feedback) {
      throw new ApiError(404, `Không tìm thấy đánh giá #${id}`);
    }

    const rawStatus = payload.status ? String(payload.status).trim().toUpperCase() : '';
    if (!FEEDBACK_STATUS_VALUES.includes(rawStatus)) {
      throw new ApiError(
        400,
        `Trạng thái kiểm duyệt không hợp lệ. Hỗ trợ: ${FEEDBACK_STATUS_VALUES.join(', ')}`,
      );
    }

    const beforeSnap = {
      status: feedback.status,
      moderatedBy: feedback.moderatedBy,
      moderatedAt: feedback.moderatedAt,
    };

    const moderatedAt = new Date();
    feedback.status = rawStatus;
    feedback.moderatedBy = actor.id;
    feedback.moderatedAt = moderatedAt;

    await feedback.save();

    let action = AUDIT_ACTIONS.FEEDBACK_STATUS_CHANGE;
    if (rawStatus === FEEDBACK_STATUSES.APPROVED) action = AUDIT_ACTIONS.FEEDBACK_PUBLISH;
    if (rawStatus === FEEDBACK_STATUSES.HIDDEN || rawStatus === FEEDBACK_STATUSES.REJECTED) {
      action = AUDIT_ACTIONS.FEEDBACK_HIDE;
    }

    await recordAudit({
      actor,
      action,
      targetType: 'Feedback',
      targetId: feedback.id,
      reason: payload.reason || `Admin thay đổi trạng thái đánh giá #${feedback.id} sang ${rawStatus}`,
      changes: {
        before: beforeSnap,
        after: {
          status: rawStatus,
          moderatedBy: actor.id,
          moderatedAt: moderatedAt.toISOString(),
        },
      },
      req,
    });

    return this.getFeedbackDetailForAdmin(id);
  }
}

const feedbackService = new FeedbackService();

module.exports = {
  feedbackService,
  FeedbackService,
  sanitizeComment,
  maskName,
  getPublicFeedbacks: feedbackService.getPublicFeedbacks.bind(feedbackService),
  getFeedbackStats: feedbackService.getFeedbackStats.bind(feedbackService),
  getMyFeedbacks: feedbackService.getMyFeedbacks.bind(feedbackService),
  createFeedback: feedbackService.createFeedback.bind(feedbackService),
  updateFeedback: feedbackService.updateFeedback.bind(feedbackService),
  updateFeedbackByOwner: feedbackService.updateFeedbackByOwner.bind(feedbackService),
  deleteFeedback: feedbackService.deleteFeedback.bind(feedbackService),
  getPublishedAnonymous: feedbackService.getPublishedAnonymous.bind(feedbackService),
  getAllFeedbacksForAdmin: feedbackService.getAllFeedbacksForAdmin.bind(feedbackService),
  getFeedbackDetailForAdmin: feedbackService.getFeedbackDetailForAdmin.bind(feedbackService),
  respondToFeedback: feedbackService.respondToFeedback.bind(feedbackService),
  changeFeedbackStatus: feedbackService.changeFeedbackStatus.bind(feedbackService),
};
