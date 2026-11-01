const patientEventService = require('../services/patientEvent.service');

/**
 * GET /events
 * UC-PAT-08: Lấy danh sách sự kiện đang mở
 */
async function getAvailableEvents(req, res, next) {
  try {
    const events = await patientEventService.getAvailableEvents(req.user);
    return res.json({
      success: true,
      data: events,
      items: events,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /events/:eventId/register
 * UC-PAT-08: Bệnh nhân đăng ký tham gia sự kiện
 */
async function registerEvent(req, res, next) {
  try {
    const result = await patientEventService.registerEvent(req.user, req.params.eventId, req);
    return res.status(201).json({
      success: true,
      message: 'Đăng ký tham gia sự kiện thành công',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /events/my
 * UC-PAT-08: Bệnh nhân xem danh sách sự kiện đã đăng ký
 */
async function getMyEvents(req, res, next) {
  try {
    const result = await patientEventService.getMyEvents(req.user, req.query);
    // Return array in items / data for FE pickArray compatibility
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

module.exports = {
  getAvailableEvents,
  registerEvent,
  getMyEvents,
};
