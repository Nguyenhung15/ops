const voucherRedemptionService = require('../services/voucherRedemption.service');

/**
 * GET /vouchers/my
 * UC-PAT-09: Bệnh nhân xem danh sách voucher của mình
 */
async function getMyVouchers(req, res, next) {
  try {
    const result = await voucherRedemptionService.getMyVouchers(req.user, req.query);
    return res.json({
      success: true,
      data: result.items,
      items: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /vouchers/my/:userVoucherId/redeem
 * UC-PAT-09: Bệnh nhân áp dụng voucher cho lịch hẹn
 */
async function redeemVoucher(req, res, next) {
  try {
    const { appointmentId, totalAmount } = req.body || {};
    const result = await voucherRedemptionService.redeem(
      req.user,
      req.params.userVoucherId,
      {
        appointmentId,
        totalAmount,
        req,
      },
    );
    return res.json({
      success: true,
      message: 'Áp dụng voucher thành công',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMyVouchers,
  redeemVoucher,
};
