const { Router } = require('express');
const { feedbackController } = require('../../controllers/feedback.controller');
const { authenticate, requireRoles } = require('../../middlewares/auth.middleware');
const { createRateLimiter } = require('../../middlewares/rateLimiter.middleware');
const { ROLES } = require('../../constants/enums');
const { configService } = require('../../config/config.service');

const router = Router();

// Rate limiter cho gửi feedback theo giờ (FEEDBACK_RATE_PER_HOUR)
const feedbackPostLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 giờ
  max: configService.feedbackRatePerHour || 10,
  message: 'Bạn đã gửi phản hồi quá số lần cho phép trong một giờ. Vui lòng thử lại sau',
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?.userId;
    return `feedback:post:${uid || req.ip}`;
  },
});

/**
 * UC-PAT-12 Routes: /feedbacks
 * Tất cả các endpoints đều yêu cầu quyền PATIENT
 */

// POST /feedbacks - Gửi phản hồi cho ca khám
router.post(
  '/',
  authenticate,
  requireRoles(ROLES.PATIENT),
  feedbackPostLimiter,
  feedbackController.createFeedback,
);

// GET /feedbacks/my - Xem danh sách phản hồi của chính mình
router.get(
  '/my',
  authenticate,
  requireRoles(ROLES.PATIENT),
  feedbackController.getMyFeedbacks,
);

// PUT /feedbacks/:id - Cập nhật phản hồi
router.put(
  '/:id',
  authenticate,
  requireRoles(ROLES.PATIENT),
  feedbackController.updateFeedback,
);

// DELETE /feedbacks/:id - Xóa mềm phản hồi
router.delete(
  '/:id',
  authenticate,
  requireRoles(ROLES.PATIENT),
  feedbackController.deleteFeedback,
);

module.exports = {
  basePath: '/feedbacks',
  router,
};
