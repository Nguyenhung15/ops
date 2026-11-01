const { Router } = require('express');
const paymentController = require('../../controllers/payment.controller');
const { authenticate, requireRoles } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/enums');

const router = Router();

// 1. Tạo thanh toán VNPay (hỗ trợ cả POST theo chuẩn RESTful và GET theo web/src/pages/appointments/steps/Step4.tsx)
router.post('/create', authenticate, requireRoles(ROLES.PATIENT), paymentController.createPayment);
router.get('/create', authenticate, requireRoles(ROLES.PATIENT), paymentController.createPayment);

// 2. Callback từ VNPay (Public nhưng bắt buộc kiểm tra chữ ký HMAC-SHA512)
router.get('/vnpay-return', paymentController.vnpayReturn);
router.get('/vnpay-ipn', paymentController.vnpayIpn);

// 3. Danh sách giao dịch cá nhân (GET /payment/my và GET /payment)
router.get('/my', authenticate, requireRoles(ROLES.PATIENT), paymentController.getMyPayments);
router.get('/', authenticate, requireRoles(ROLES.PATIENT), paymentController.getMyPayments);

module.exports = {
  basePath: '/payment',
  router,
};
