const { Router } = require('express');
const voucherController = require('../controllers/voucher.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { createRateLimiter } = require('../middlewares/rateLimiter.middleware');
const env = require('../config/env');
const { ROLES } = require('../constants/enums');

const router = Router();

const voucherRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: env.receptionSearchRatePerMin || 30,
  message: 'Bạn đã thực hiện quá nhiều yêu cầu xem voucher. Vui lòng thử lại sau 1 phút.',
});

// 1. Patient personal vouchers
router.get(
  '/my',
  authenticate,
  authorize(ROLES.PATIENT),
  voucherController.getMyVouchers,
);

// 2. Admin & Receptionist: View all & owner lookups
router.get(
  '/all',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  voucherController.getAllVouchers,
);

router.get(
  '/:voucherId/owners',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  voucherController.getVoucherOwners,
);

router.get(
  '/user/:userId',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  voucherRateLimiter,
  voucherController.getUserVouchers,
);

router.post(
  '/:voucherId/use',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  voucherController.useVoucher,
);

// 3. Admin CRUD
router.post(
  '/create',
  authenticate,
  authorize(ROLES.ADMIN),
  voucherController.createVoucher,
);

router.put(
  '/update/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  voucherController.updateVoucher,
);

router.delete(
  '/delete/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  voucherController.deleteVoucher,
);

// 4. Single Voucher inspection
router.get(
  '/:id',
  authenticate,
  voucherController.getVoucherById,
);

module.exports = router;
