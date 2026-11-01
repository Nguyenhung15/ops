const { Router } = require('express');
const eventController = require('../controllers/event.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

router.use(authenticate, authorize(ROLES.RECEPTIONIST, ROLES.ADMIN));

router.get('/events', eventController.getReceptionEvents);
router.post('/events/:eventId/confirm/:userId', eventController.confirmEventAttendance);

module.exports = router;
