const { Router } = require('express');
const userController = require('../controllers/user.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

const receptionistSearchController = require('../controllers/receptionistSearch.controller');
const { createRateLimiter } = require('../middlewares/rateLimiter.middleware');
const env = require('../config/env');

const searchRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: env.receptionSearchRatePerMin || 30,
  message: 'Bạn đã thực hiện quá nhiều lượt tìm kiếm. Vui lòng thử lại sau 1 phút.',
});

router.get('/me', authenticate, userController.getMe);
router.put('/update', authenticate, userController.updateMe);

// UC-REC-01: Lễ tân / Admin tra cứu user theo keyword
router.get(
  '/search',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  searchRateLimiter,
  receptionistSearchController.searchUsers,
);

module.exports = router;

