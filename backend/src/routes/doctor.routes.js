const { Router } = require('express');
const doctorController = require('../controllers/doctor.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

router.get('/search', doctorController.searchDoctors);
router.get('/by-specialty/:specialtyId', doctorController.getDoctorsBySpecialty);
router.get('/:id', doctorController.getDoctorById);

// Admin staff deletion
router.delete('/:id', authenticate, authorize(ROLES.ADMIN), doctorController.deleteDoctor);

module.exports = router;

