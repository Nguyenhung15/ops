const { Router } = require('express');
const eventController = require('../controllers/event.controller');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

// 1. Public / Patient: List active events
router.get('/', optionalAuthenticate, eventController.getAvailableEvents);

// 2. Admin: List all events
router.get(
  '/all',
  authenticate,
  authorize(ROLES.ADMIN),
  eventController.getAllEvents,
);

// 3. Patient: Personal registered events
router.get(
  '/my',
  authenticate,
  authorize(ROLES.PATIENT),
  eventController.getMyEvents,
);

// 4. Admin CRUD
router.post(
  '/create',
  authenticate,
  authorize(ROLES.ADMIN),
  eventController.createEvent,
);

router.put(
  '/update/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  eventController.updateEvent,
);

router.delete(
  '/delete/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  eventController.deleteEvent,
);

// 5. Patient: Register for an event
router.post(
  '/:eventId/register',
  authenticate,
  authorize(ROLES.PATIENT),
  eventController.registerEvent,
);

// 6. View single event
router.get('/:id', optionalAuthenticate, eventController.getEventById);

module.exports = router;
