const { Router } = require('express');
const receptionistSearchController = require('../controllers/receptionistSearch.controller');
const { authenticate, requireRoles } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

const { createRateLimiter } = require('../middlewares/rateLimiter.middleware');
const env = require('../config/env');

const voucherRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: env.receptionSearchRatePerMin || 30,
  message: 'Bạn đã thực hiện quá nhiều yêu cầu xem voucher. Vui lòng thử lại sau 1 phút.',
});

// UC-REC-01: Lễ tân / Admin xem danh sách voucher của user
// GET /vouchers/user/:userId
router.get(
  '/user/:userId',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  voucherRateLimiter,
  receptionistSearchController.getUserVouchers,
);

// Lễ tân / Admin sử dụng voucher cho user
// POST /vouchers/:voucherId/use
router.post(
  '/:voucherId/use',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistSearchController.useVoucher,
);

module.exports = router;
