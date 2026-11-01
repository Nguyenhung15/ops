const { Router } = require('express');
const patientVoucherController = require('../../controllers/patientVoucher.controller');
const { authenticate, requireRoles } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/enums');

const router = Router();

// GET /vouchers/my - Bệnh nhân xem danh sách voucher của mình
router.get('/my', authenticate, requireRoles(ROLES.PATIENT), patientVoucherController.getMyVouchers);

// POST /vouchers/my/:userVoucherId/redeem - Bệnh nhân áp dụng voucher cho lịch hẹn
router.post('/my/:userVoucherId/redeem', authenticate, requireRoles(ROLES.PATIENT), patientVoucherController.redeemVoucher);

module.exports = {
  basePath: '/vouchers',
  router,
};
