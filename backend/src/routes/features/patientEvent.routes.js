const { Router } = require('express');
const patientEventController = require('../../controllers/patientEvent.controller');
const { authenticate, requireRoles, optionalAuthenticate } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/enums');

const router = Router();

// GET /events - Lấy danh sách sự kiện đang mở (Public / Optional Auth để kèm registrationStatus nếu user đã đăng nhập)
router.get('/', optionalAuthenticate, patientEventController.getAvailableEvents);

// GET /events/my - Danh sách sự kiện người dùng đã đăng ký (Bắt buộc Patient đăng nhập)
router.get('/my', authenticate, requireRoles(ROLES.PATIENT), patientEventController.getMyEvents);

// POST /events/:eventId/register - Đăng ký tham gia sự kiện (Bắt buộc Patient đăng nhập)
router.post('/:eventId/register', authenticate, requireRoles(ROLES.PATIENT), patientEventController.registerEvent);

module.exports = {
  basePath: '/events',
  router,
};
