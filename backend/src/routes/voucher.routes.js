const { Router } = require('express');
const receptionistSearchController = require('../controllers/receptionistSearch.controller');
const { authenticate, requireRoles } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

// UC-REC-01: Lễ tân / Admin xem danh sách voucher của user
// GET /vouchers/user/:userId
router.get(
  '/user/:userId',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
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
