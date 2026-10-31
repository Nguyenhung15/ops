const { Router } = require('express');
const receptionistAppointmentController = require('../controllers/receptionistAppointment.controller');
const { authenticate, requireRoles } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

// UC-REC-03: Lễ tân / Admin xác nhận lịch hẹn
// Endpoint: PUT /appointments/confirm/:id
// Allowed roles: RECEPTIONIST, ADMIN
router.put(
  '/confirm/:id',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistAppointmentController.confirmAppointment,
);

// UC-REC-04: Lễ tân / Admin check-in bệnh nhân
// Endpoint: PUT /appointments/checkin/:id
// Allowed roles: RECEPTIONIST, ADMIN
router.put(
  '/checkin/:id',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistAppointmentController.checkinAppointment,
);

// UC-REC-05: Lễ tân / Admin hủy lịch hẹn
// Endpoint: PUT /appointments/cancel/:id
// Allowed roles: RECEPTIONIST, ADMIN
router.put(
  '/cancel/:id',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistAppointmentController.cancelAppointment,
);

// UC-REC-05: Lễ tân / Admin đổi lịch hẹn (reschedule)
// Endpoint: PUT /appointments/reschedule/:id
// Allowed roles: RECEPTIONIST, ADMIN
router.put(
  '/reschedule/:id',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistAppointmentController.rescheduleAppointment,
);

const receptionistScheduleController = require('../controllers/receptionistSchedule.controller');

// UC-REC-02: Lễ tân / Admin xem lịch vận hành (Appointments + Shifts)
// GET /appointments/schedule
// Allowed roles: RECEPTIONIST, ADMIN
router.get(
  '/schedule',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistScheduleController.getOperationalSchedule,
);

// GET /appointments/by-date?date=YYYY-MM-DD
// Allowed roles: RECEPTIONIST, ADMIN
router.get(
  '/by-date',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistScheduleController.getAppointmentsByDate,
);

// GET /appointments/status/:status
// Allowed roles: RECEPTIONIST, ADMIN
router.get(
  '/status/:status',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistScheduleController.getAppointmentsByStatus,
);

// GET /appointments/by-shift/:shiftId
// Allowed roles: RECEPTIONIST, ADMIN
router.get(
  '/by-shift/:shiftId',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistScheduleController.getAppointmentsByShift,
);

module.exports = router;


