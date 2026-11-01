const { paymentService } = require('../services/payment.service');

/**
 * Tạo URL thanh toán VNPay (Hỗ trợ cả POST và GET cho FE Step4.tsx)
 */
async function createPayment(req, res, next) {
  try {
    const { appointmentId, appointmentNo, userVoucherId } = {
      ...req.query,
      ...req.body,
    };

    const result = await paymentService.createPaymentUrl({
      user: req.user,
      appointmentId,
      appointmentNo,
      userVoucherId,
      req,
    });

    return res.status(200).json({
      ok: true,
      data: result,
      paymentUrl: result.paymentUrl,
      transactionNo: result.transactionNo,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Xử lý Return URL từ VNPay khi người dùng chuyển hướng về FE
 * GET /payment/vnpay-return
 */
async function vnpayReturn(req, res, next) {
  try {
    const result = await paymentService.processVNPayCallback(req.query, req, false);
    return res.status(200).json({
      ok: true,
      data: result,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Xử lý IPN URL từ VNPay server-to-server
 * GET /payment/vnpay-ipn
 */
async function vnpayIpn(req, res, next) {
  try {
    const result = await paymentService.processVNPayCallback(req.query, req, true);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

/**
 * Lấy lịch sử giao dịch thanh toán của cá nhân
 * GET /payments hoặc GET /payment/my
 */
async function getMyPayments(req, res, next) {
  try {
    const result = await paymentService.getMyPayments(req.user, req.query);
    return res.status(200).json({
      ok: true,
      data: result.items,
      pagination: result.pagination,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createPayment,
  vnpayReturn,
  vnpayIpn,
  getMyPayments,
};
