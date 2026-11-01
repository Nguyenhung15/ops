const specialtyService = require('../services/specialty.service');
const { sendSuccess } = require('../utils/response');

const getAllSpecialties = async (req, res) => {
  const onlyActive = req.query?.onlyActive === 'true';
  const specialties = await specialtyService.listSpecialties({ onlyActive });
  return sendSuccess(res, { data: specialties });
};

const getSpecialtyById = async (req, res) => {
  const specialty = await specialtyService.getSpecialtyById(req.params.id);
  return sendSuccess(res, { data: specialty.toJSON() });
};

const createSpecialty = async (req, res) => {
  const created = await specialtyService.createSpecialty(req.user, req.body, req);
  return res.status(201).json({
    success: true,
    message: 'Tạo chuyên khoa thành công',
    data: created,
    ...created,
  });
};

const updateSpecialty = async (req, res) => {
  const updated = await specialtyService.updateSpecialty(
    req.user,
    req.params.id,
    req.body,
    req,
  );
  return res.status(200).json({
    success: true,
    message: 'Cập nhật chuyên khoa thành công',
    data: updated,
    ...updated,
  });
};

const deleteSpecialty = async (req, res) => {
  const migrateToSpecialtyId =
    req.body?.migrateToSpecialtyId || req.query?.migrateToSpecialtyId || null;
  const result = await specialtyService.deleteSpecialty(req.user, req.params.id, {
    migrateToSpecialtyId,
    req,
  });
  return sendSuccess(res, {
    message: result.message,
    data: result,
  });
};

const setSpecialtyStatus = async (req, res) => {
  const isEnable =
    req.body?.isEnable !== undefined ? req.body.isEnable : req.body?.isEnabled;
  const updated = await specialtyService.setSpecialtyStatus(
    req.user,
    req.params.id,
    Boolean(isEnable),
    req,
  );
  return sendSuccess(res, {
    message: isEnable ? 'Kích hoạt chuyên khoa thành công' : 'Vô hiệu hóa chuyên khoa thành công',
    data: updated,
  });
};

const assignDoctors = async (req, res) => {
  const doctorIds = req.body?.doctorIds || req.body?.doctorId;
  const result = await specialtyService.assignDoctorsToSpecialty(
    req.user,
    req.params.id,
    doctorIds,
    req,
  );
  return sendSuccess(res, {
    message: 'Gắn bác sĩ vào chuyên khoa thành công',
    data: result,
  });
};

module.exports = {
  getAllSpecialties,
  getSpecialtyById,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
  setSpecialtyStatus,
  assignDoctors,
};

