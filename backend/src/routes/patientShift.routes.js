const { Router } = require('express');
const patientShiftController = require('../controllers/patientShift.controller');
const { optionalAuthenticate } = require('../middlewares/auth.middleware');

const receptionistScheduleController = require('../controllers/receptionistSchedule.controller');
const { authenticate, requireRoles } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

// GET /shifts/by-date?date=YYYY-MM-DD
// Receptionist and Admin operational schedule view
router.get(
  '/by-date',
  authenticate,
  requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN),
  receptionistScheduleController.getShiftsByDate,
);

router.get(
  '/by-doctor/:doctorId',
  optionalAuthenticate,
  patientShiftController.getShiftsByDoctor,
);

module.exports = router;


