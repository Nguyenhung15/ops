const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/response');
const { ROLES } = require('../constants/enums');
const userService = require('../services/user.service');
const auditService = require('../services/audit.service');

const listUsers = async (req, res) => {
  const users = await userService.listUsers({
    actor: req.user,
    role: req.query.role || null,
    includeDisabled: false,
    keyword: req.query.search || req.query.keyword || null,
  });
  return sendSuccess(res, { data: users });
};

const listAllIncludingDisabled = async (req, res) => {
  const users = await userService.listUsers({
    actor: req.user,
    role: req.query.role || null,
    includeDisabled: true,
    keyword: req.query.search || req.query.keyword || null,
  });
  return sendSuccess(res, { data: users });
};

const listDisabledUsers = async (req, res) => {
  const users = await userService.listUsers({
    actor: req.user,
    role: req.query.role || null,
    onlyDisabled: true,
    keyword: req.query.search || req.query.keyword || null,
  });
  return sendSuccess(res, { data: users });
};

const listPatients = async (req, res) => {
  const patients = await userService.listUsers({
    actor: req.user,
    role: ROLES.PATIENT,
    includeDisabled: false,
    keyword: req.query.search || req.query.keyword || null,
  });
  return sendSuccess(res, { data: patients });
};

const listReceptionists = async (_req, res) => {
  const receptionists = await userService.listUsers({
    role: ROLES.RECEPTIONIST,
    includeDisabled: false,
  });
  return sendSuccess(res, { data: receptionists });
};

const listDoctors = async (_req, res) => {
  const doctors = await userService.listUsers({
    role: ROLES.DOCTOR,
    includeDisabled: false,
  });
  return sendSuccess(res, { data: doctors });
};

const getUserDetail = async (req, res) => {
  const user = await userService.getUserById(req.params.id, {
    includeRelations: true,
  });
  return sendSuccess(res, { data: user });
};

const createUser = async (req, res) => {
  const created = await userService.createUser(req.user, req.body, req);
  return sendSuccess(res, {
    statusCode: 201,
    message: `Tạo tài khoản ${created.userType} thành công`,
    data: created,
  });
};

const updateUser = async (req, res) => {
  const updated = await userService.updateUser(req.user, req.params.id, req.body, {
    req,
  });
  return sendSuccess(res, {
    message: 'Cập nhật tài khoản thành công',
    data: updated,
  });
};

const changeUserRole = async (req, res) => {
  if (!req.body?.userType && !req.body?.role) {
    throw new ApiError(400, 'Vui lòng cung cấp vai trò mới (userType)');
  }
  const updated = await userService.updateUser(
    req.user,
    req.params.id,
    {
      ...req.body,
      userType: req.body.userType || req.body.role,
    },
    { req },
  );
  return sendSuccess(res, {
    message: `Chuyển vai trò sang ${updated.userType} thành công`,
    data: updated,
  });
};

const updateDoctor = async (req, res) => {
  const updated = await userService.updateUser(req.user, req.params.id, req.body, {
    expectedCurrentRole: ROLES.DOCTOR,
    req,
  });
  return sendSuccess(res, {
    message: 'Cập nhật thông tin bác sĩ thành công',
    data: updated,
  });
};

const lockUser = async (req, res) => {
  const reason = req.body?.reason || req.query?.reason || null;
  const locked = await userService.lockUser(req.user, req.params.userId, {
    reason,
    req,
  });
  return sendSuccess(res, {
    message: 'Đã khóa tài khoản thành công',
    data: locked,
  });
};

const unlockUser = async (req, res) => {
  const reason = req.body?.reason || req.query?.reason || null;
  const unlocked = await userService.unlockUser(req.user, req.params.userId, {
    reason,
    req,
  });
  return sendSuccess(res, {
    message: 'Đã mở khóa tài khoản thành công',
    data: unlocked,
  });
};

const setUserStatus = async (req, res) => {
  const rawStatus =
    req.body?.isEnable !== undefined ? req.body.isEnable : req.body?.isEnabled;
  if (typeof rawStatus !== 'boolean') {
    throw new ApiError(400, 'Trường isEnable (boolean) là bắt buộc');
  }
  const reason = req.body?.reason || null;
  const result = rawStatus
    ? await userService.unlockUser(req.user, req.params.id, { reason, req })
    : await userService.lockUser(req.user, req.params.id, { reason, req });

  return sendSuccess(res, {
    message: rawStatus
      ? 'Đã mở khóa tài khoản thành công'
      : 'Đã khóa tài khoản thành công',
    data: result,
  });
};

const deleteStaff = async (req, res) => {
  const result = await userService.deleteStaff(req.user, req.params.id, {
    req,
  });
  return sendSuccess(res, {
    message: result.message,
    data: result,
  });
};

const deleteDoctor = async (req, res) => {
  const result = await userService.deleteStaff(req.user, req.params.id, {
    expectedRole: ROLES.DOCTOR,
    req,
  });
  return sendSuccess(res, {
    message: result.message,
    data: result,
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

const deleteOrLockUser = async (req, res) => {
  const isHardDelete = req.query?.hard === 'true' || req.query?.permanent === 'true';
  if (isHardDelete) {
    const result = await userService.deleteStaff(req.user, req.params.userId, { req });
    return sendSuccess(res, {
      message: result.message,
      data: result,
    });
  }
  return lockUser(req, res);
};

const listAuditLogs = async (req, res) => {
  const logs = await auditService.queryAuditLogs({
    targetType: req.query.targetType,
    targetId: req.query.targetId,
    actorId: req.query.actorId,
    action: req.query.action,
    page: req.query.page,
    limit: req.query.limit,
  });
  return sendSuccess(res, { data: logs });
};

module.exports = {
  listUsers,
  listAllIncludingDisabled,
  listDisabledUsers,
  listPatients,
  listReceptionists,
  listDoctors,
  getUserDetail,
  createUser,
  updateUser,
  changeUserRole,
  updateDoctor,
  lockUser,
  unlockUser,
  deleteOrLockUser,
  deleteStaff,
  deleteDoctor,
  deleteReceptionist,
  setUserStatus,
  listAuditLogs,
};

