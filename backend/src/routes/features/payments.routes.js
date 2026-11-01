const { Router } = require('express');
const paymentController = require('../../controllers/payment.controller');
const { authenticate, requireRoles } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/enums');

const router = Router();

// Hỗ trợ alias /payments giống /payment
router.get('/', authenticate, requireRoles(ROLES.PATIENT), paymentController.getMyPayments);
router.get('/my', authenticate, requireRoles(ROLES.PATIENT), paymentController.getMyPayments);
router.post('/create', authenticate, requireRoles(ROLES.PATIENT), paymentController.createPayment);
router.get('/create', authenticate, requireRoles(ROLES.PATIENT), paymentController.createPayment);
router.get('/vnpay-return', paymentController.vnpayReturn);
router.get('/vnpay-ipn', paymentController.vnpayIpn);

module.exports = {
  basePath: '/payments',
  router,
};
