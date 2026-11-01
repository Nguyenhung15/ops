const { Router } = require('express');
const feedbackController = require('../controllers/feedback.controller');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

// ==========================================
// 1. Public endpoints
// ==========================================
router.get('/public', optionalAuthenticate, feedbackController.getPublicFeedbacks);
router.get('/stats', feedbackController.getFeedbackStats);

// ==========================================
// 2. Patient personal endpoints
// ==========================================
router.get('/my', authenticate, authorize(ROLES.PATIENT), feedbackController.getMyFeedbacks);
router.post('/', authenticate, authorize(ROLES.PATIENT), feedbackController.createFeedback);
router.put('/:id', authenticate, authorize(ROLES.PATIENT), feedbackController.updateFeedback);

// ==========================================
// 3. UC-ADM-11: Admin / Moderator endpoints
// ==========================================
router.get('/all', authenticate, authorize(ROLES.ADMIN), feedbackController.getAllFeedbacksForAdmin);
router.get('/admin/all', authenticate, authorize(ROLES.ADMIN), feedbackController.getAllFeedbacksForAdmin);
router.get('/admin/:id', authenticate, authorize(ROLES.ADMIN), feedbackController.getFeedbackDetailForAdmin);
router.post('/admin/:id/respond', authenticate, authorize(ROLES.ADMIN), feedbackController.respondToFeedback);
router.put('/admin/:id/respond', authenticate, authorize(ROLES.ADMIN), feedbackController.respondToFeedback);
router.put('/admin/:id/status', authenticate, authorize(ROLES.ADMIN), feedbackController.changeFeedbackStatus);
router.patch('/admin/:id/status', authenticate, authorize(ROLES.ADMIN), feedbackController.changeFeedbackStatus);
router.delete('/admin/:id', authenticate, authorize(ROLES.ADMIN), feedbackController.deleteFeedback);

// ==========================================
// 4. Common delete endpoint (Owner or Admin)
// ==========================================
router.delete(
  '/:id',
  authenticate,
  authorize(ROLES.PATIENT, ROLES.ADMIN),
  feedbackController.deleteFeedback,
);

module.exports = router;
