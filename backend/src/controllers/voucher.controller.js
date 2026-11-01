const voucherService = require('../services/voucher.service');
const { sendSuccess } = require('../utils/response');

const getAllVouchers = async (_req, res) => {
  const vouchers = await voucherService.getAllVouchers();
  return sendSuccess(res, { data: vouchers });
};

const getVoucherById = async (req, res) => {
  const voucher = await voucherService.getVoucherById(req.params.id);
  return sendSuccess(res, { data: voucher });
};

const createVoucher = async (req, res) => {
  const voucher = await voucherService.createVoucher(req.user, req.body, req);
  return sendSuccess(res, {
    statusCode: 201,
    message: 'Tạo voucher thành công',
    data: voucher,
  });
};

const updateVoucher = async (req, res) => {
  const voucher = await voucherService.updateVoucher(req.user, req.params.id, req.body, req);
  return sendSuccess(res, {
    message: 'Cập nhật voucher thành công',
    data: voucher,
  });
};

const deleteVoucher = async (req, res) => {
  const result = await voucherService.deleteVoucher(req.user, req.params.id, req);
  return sendSuccess(res, {
    message: result.message,
    data: result,
  });
};

const getMyVouchers = async (req, res) => {
  const vouchers = await voucherService.getMyVouchers(req.user);
  return sendSuccess(res, { data: vouchers });
};

const getVoucherOwners = async (req, res) => {
  const owners = await voucherService.getVoucherOwners(req.params.voucherId);
  return sendSuccess(res, { data: owners });
};

const getUserVouchers = async (req, res) => {
  const vouchers = await voucherService.getUserVouchers(req.params.userId);
  return sendSuccess(res, { data: vouchers });
};

const useVoucher = async (req, res) => {
  const userId = req.query.userId || req.body?.userId;
  const result = await voucherService.useVoucher(req.user, req.params.voucherId, userId, req);
  return sendSuccess(res, {
    message: 'Sử dụng voucher thành công',
    data: result,
  });
};

module.exports = {
  getAllVouchers,
  getVoucherById,
  createVoucher,
  updateVoucher,
  deleteVoucher,
  getMyVouchers,
  getVoucherOwners,
  getUserVouchers,
  useVoucher,
};
