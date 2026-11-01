const { Router } = require('express');
const specialtyController = require('../controllers/specialty.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

// Public routes
router.get('/all', specialtyController.getAllSpecialties);
router.get('/:id', specialtyController.getSpecialtyById);

// Admin-only management routes
router.post(
  '/create',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.createSpecialty,
);
router.post(
  '/',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.createSpecialty,
);
router.put(
  '/update/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.updateSpecialty,
);
router.put(
  '/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.updateSpecialty,
);
router.delete(
  '/delete/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.deleteSpecialty,
);
router.delete(
  '/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.deleteSpecialty,
);
router.patch(
  '/:id/status',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.setSpecialtyStatus,
);
router.post(
  '/:id/doctors',
  authenticate,
  authorize(ROLES.ADMIN),
  specialtyController.assignDoctors,
);

module.exports = router;

