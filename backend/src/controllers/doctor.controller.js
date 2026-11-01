const { ROLES } = require('../constants/enums');
const userService = require('../services/user.service');
const { sendSuccess } = require('../utils/response');

const getDoctorsBySpecialty = async (req, res) => {
  const doctors = await userService.listUsers({
    role: ROLES.DOCTOR,
    specialtyId: req.params.specialtyId,
    includeDisabled: false,
  });
  return sendSuccess(res, { data: doctors });
};

const getDoctorById = async (req, res) => {
  const doctor = await userService.getUserById(req.params.id, {
    expectedRole: ROLES.DOCTOR,
  });
  return sendSuccess(res, { data: doctor });
};

const searchDoctors = async (req, res) => {
  const doctors = await userService.listUsers({
    role: ROLES.DOCTOR,
    keyword: req.query.keyword || '',
    includeDisabled: false,
  });
  return sendSuccess(res, { data: doctors });
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

module.exports = {
  getDoctorsBySpecialty,
  getDoctorById,
  searchDoctors,
  deleteDoctor,
};

