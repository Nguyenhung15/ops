const receptionistSearchService = require('../services/receptionistSearch.service');

/**
 * GET /users/search?keyword=...&page=...&limit=...
 * UC-REC-01: Lễ tân / Admin tra cứu user
 */
async function searchUsers(req, res, next) {
  try {
    const result = await receptionistSearchService.searchUsers(req.user, req.query, req);
    // Return array directly for frontend pickArray / pickObject compatibility
    // While attaching pagination headers or payload
    return res.json({
      success: true,
      message: 'Tra cứu người dùng thành công',
      data: result.users,
      pagination: result.pagination,
      // Provide top-level array support if FE calls extractArray(res.data)
      items: result.users,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /vouchers/user/:userId
 * UC-REC-01: Lễ tân / Admin xem voucher của user
 */
async function getUserVouchers(req, res, next) {
  try {
    const vouchers = await receptionistSearchService.getUserVouchers(req.user, req.params.userId, req);
    return res.json(vouchers);
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /vouchers/:voucherId/use?userId=...
 * Receptionist / Admin uses a voucher for user
 */
async function useVoucher(req, res, next) {
  try {
    const userId = req.query.userId || req.body?.userId;
    const updated = await receptionistSearchService.markVoucherAsUsed(
      req.user,
      req.params.voucherId,
      userId,
      req,
    );
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  searchUsers,
  getUserVouchers,
  useVoucher,
};
