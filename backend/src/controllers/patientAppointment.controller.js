const patientAppointmentService = require('../services/patientAppointment.service');
const { sendSuccess } = require('../utils/response');

const createAppointment = async (req, res) => {
  const result = await patientAppointmentService.bookAppointment(
    req.user,
    req.query,
    req.body,
  );
  return sendSuccess(res, {
    statusCode: 201,
    message: 'Đặt lịch khám thành công',
    data: result,
  });
};

const getMyUpcomingAppointments = async (req, res) => {
  const result = await patientAppointmentService.getMyUpcomingAppointments(req.user);
  return sendSuccess(res, {
    statusCode: 200,
    message: 'Lấy danh sách lịch hẹn sắp tới thành công',
    data: result,
  });
};

const getMyCompletedAppointments = async (req, res) => {
  const result = await patientAppointmentService.getMyCompletedAppointments(req.user, req.query);
  return sendSuccess(res, {
    statusCode: 200,
    message: 'Lấy danh sách lịch sử lịch hẹn thành công',
    data: result,
  });
};

const getAppointmentDetail = async (req, res) => {
  const result = await patientAppointmentService.getPatientAppointmentDetail(
    req.user,
    req.params.id,
  );
  return sendSuccess(res, {
    statusCode: 200,
    message: 'Lấy chi tiết lịch hẹn thành công',
    data: result,
  });
};


const cancelAppointment = async (req, res) => {
  const result = await patientAppointmentService.cancelPatientAppointment(
    req.user,
    req.params.id,
    req.body,
    req,
  );
  return sendSuccess(res, {
    statusCode: 200,
    message: 'Hủy lịch khám thành công',
    data: result,
  });
};

module.exports = {
  createAppointment,
  getMyUpcomingAppointments,
  getMyCompletedAppointments,
  getAppointmentDetail,
  cancelAppointment,
};
