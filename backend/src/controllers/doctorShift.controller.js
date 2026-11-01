const doctorShiftService = require('../services/doctorShift.service');
const { sendSuccess } = require('../utils/response');

const createShift = async (req, res) => {
  const created = await doctorShiftService.createShift(req.user, req.body || {}, req);
  res.status(201).json({
    success: true,
    message: 'Shift created successfully',
    data: created[0],
    occurrences: created,
  });
};

const getMyShifts = async (req, res) => {
  const shifts = await doctorShiftService.getMyShifts(req.user, req.query.week, req.query.date);
  return sendSuccess(res, {
    message: 'Your registered shifts',
    data: shifts,
  });
};

const getShiftsInWeek = async (req, res) => {
  const shifts = await doctorShiftService.getShiftsInWeek(req.query.start, req.query.end, {
    specialtyId: req.query.specialtyId,
  });
  return sendSuccess(res, { data: shifts });
};

const adjustShift = async (req, res) => {
  const updated = await doctorShiftService.adjustShift(req.user, req.params.id, req.body, req);
  return sendSuccess(res, {
    message: 'Điều chỉnh ca trực thành công',
    data: updated,
  });
};

const getShiftDetail = async (req, res) => {
  const detail = await doctorShiftService.getShiftDetailWithBookings(req.params.id);
  return sendSuccess(res, { data: detail });
};

const getAllShiftsByDate = async (req, res) => {
  const shifts = await doctorShiftService.getAllShiftsByDate(req.query.date);
  return sendSuccess(res, { data: shifts });
};

const deleteShift = async (req, res) => {
  const result = await doctorShiftService.deleteShift(req.user, req.params.id, req);
  return sendSuccess(res, {
    message: result.message,
    data: result,
  });
};

module.exports = {
  createShift,
  getMyShifts,
  getShiftsInWeek,
  adjustShift,
  getShiftDetail,
  getAllShiftsByDate,
  deleteShift,
};
