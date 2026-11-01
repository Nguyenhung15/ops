const { ROLES } = require('../constants/enums');
const userService = require('../services/user.service');
const { sendSuccess } = require('../utils/response');

const getAllReceptionists = async (_req, res) => {
  const receptionists = await userService.listUsers({
    role: ROLES.RECEPTIONIST,
    includeDisabled: false,
  });
  return sendSuccess(res, { data: receptionists });
};

const getReceptionistById = async (req, res) => {
  const receptionist = await userService.getUserById(req.params.id, {
    expectedRole: ROLES.RECEPTIONIST,
  });
  return sendSuccess(res, { data: receptionist });
};

const updateReceptionist = async (req, res) => {
  const updated = await userService.updateUser(req.user, req.params.id, req.body, {
    expectedCurrentRole: ROLES.RECEPTIONIST,
    req,
  });
  return sendSuccess(res, {
    message: 'Cập nhật thông tin lễ tân thành công',
    data: updated,
  });
};

const deleteReceptionist = async (req, res) => {
  const result = await userService.deleteStaff(req.user, req.params.id, {
    expectedRole: ROLES.RECEPTIONIST,
    req,
  });
  return sendSuccess(res, {
    message: result.message,
    data: result,
  });
};

module.exports = {
  getAllReceptionists,
  getReceptionistById,
  updateReceptionist,
  deleteReceptionist,
};

