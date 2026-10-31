const receptionistScheduleService = require('../services/receptionistSchedule.service');

/**
 * UC-REC-02: Lễ tân / Admin xem lịch vận hành
 * GET /appointments/schedule
 * Query parameters:
 *   - date / startDate, endDate (max 31 days)
 *   - doctorId
 *   - status
 *   - page (default 1)
 *   - limit (default 20, max 100)
 */
async function getOperationalSchedule(req, res, next) {
  try {
    const result = await receptionistScheduleService.getOperationalSchedule(req.user, req.query);
    return res.json({
      success: true,
      message: 'Operational schedule retrieved successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /appointments/by-date?date=YYYY-MM-DD
 * Frontend backward compatibility: returns list of appointments
 */
async function getAppointmentsByDate(req, res, next) {
  try {
    const appointments = await receptionistScheduleService.getAppointmentsByDate(req.user, req.query);
    return res.json(appointments);
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /appointments/status/:status?date=YYYY-MM-DD
 * Frontend backward compatibility: returns list of appointments filtered by status
 */
async function getAppointmentsByStatus(req, res, next) {
  try {
    const query = { ...req.query, status: req.params.status };
    const appointments = await receptionistScheduleService.getAppointmentsByDate(req.user, query);
    return res.json(appointments);
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /appointments/by-shift/:shiftId
 * Frontend backward compatibility: returns list of appointments for a specific shift
 */
async function getAppointmentsByShift(req, res, next) {
  try {
    const appointments = await receptionistScheduleService.getAppointmentsByShift(req.user, req.params.shiftId);
    return res.json(appointments);
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /shifts/by-date?date=YYYY-MM-DD
 * Frontend backward compatibility: returns list of doctor shifts for that date
 */
async function getShiftsByDate(req, res, next) {
  try {
    const shifts = await receptionistScheduleService.getShiftsByDate(req.user, req.query);
    return res.json(shifts);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getOperationalSchedule,
  getAppointmentsByDate,
  getAppointmentsByStatus,
  getAppointmentsByShift,
  getShiftsByDate,
};
