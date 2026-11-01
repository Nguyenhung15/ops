const eventService = require('../services/event.service');
const { sendSuccess } = require('../utils/response');

const getAvailableEvents = async (_req, res) => {
  const events = await eventService.getAvailableEvents();
  return sendSuccess(res, { data: events });
};

const getAllEvents = async (_req, res) => {
  const events = await eventService.getAllEvents();
  return sendSuccess(res, { data: events });
};

const getEventById = async (req, res) => {
  const event = await eventService.getEventById(req.params.id);
  return sendSuccess(res, { data: event });
};

const createEvent = async (req, res) => {
  const event = await eventService.createEvent(req.user, req.body, req);
  return sendSuccess(res, {
    statusCode: 201,
    message: 'Tạo sự kiện thành công',
    data: event,
  });
};

const updateEvent = async (req, res) => {
  const event = await eventService.updateEvent(req.user, req.params.id, req.body, req);
  return sendSuccess(res, {
    message: 'Cập nhật sự kiện thành công',
    data: event,
  });
};

const deleteEvent = async (req, res) => {
  const result = await eventService.deleteEvent(req.user, req.params.id, req);
  return sendSuccess(res, {
    message: result.message,
    data: result,
  });
};

const registerEvent = async (req, res) => {
  const result = await eventService.registerEvent(req.user, req.params.eventId);
  return sendSuccess(res, {
    message: result.message,
    data: result.data,
  });
};

const getMyEvents = async (req, res) => {
  const events = await eventService.getMyEvents(req.user);
  return sendSuccess(res, { data: events });
};

const getReceptionEvents = async (_req, res) => {
  const events = await eventService.getReceptionEvents();
  return sendSuccess(res, { data: events });
};

const confirmEventAttendance = async (req, res) => {
  const result = await eventService.confirmEventAttendance(
    req.user,
    req.params.eventId,
    req.params.userId,
    req,
  );
  return sendSuccess(res, {
    message: 'Xác nhận tham gia sự kiện thành công',
    data: result,
  });
};

module.exports = {
  getAvailableEvents,
  getAllEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  registerEvent,
  getMyEvents,
  getReceptionEvents,
  confirmEventAttendance,
};
