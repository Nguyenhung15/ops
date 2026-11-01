const { Router } = require('express');
const adminController = require('../controllers/admin.controller');
const specialtyController = require('../controllers/specialty.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

/**
 * Public read required by Frontend:
 * Guest pages (`Doctors.tsx`, `DoctorsSection.tsx`) call `GET /api/admin/doctors`.
 */
router.get('/doctors', adminController.listDoctors);

// All remaining `/api/admin/*` routes require JWT authentication
router.use(authenticate);

// Shared Admin + Receptionist routes (Receptionist is strictly scoped to Patient accounts in service layer)
router.get(
  '/users',
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  adminController.listUsers,
);
router.get(
  '/all-including-disabled',
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  adminController.listAllIncludingDisabled,
);
router.get(
  '/disabled',
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  adminController.listDisabledUsers,
);
router.get(
  '/patients',
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  adminController.listPatients,
);
router.delete(
  '/users/:userId',
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  adminController.deleteOrLockUser,
);
router.post(
  '/activate/:userId',
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  adminController.unlockUser,
);

// Strictly Admin-only routes (UC-ADM-01 full user & role & audit management)
router.get(
  '/receptionists',
  authorize(ROLES.ADMIN),
  adminController.listReceptionists,
);
router.get(
  '/audit-logs',
  authorize(ROLES.ADMIN),
  adminController.listAuditLogs,
);
router.get(
  '/users/:id',
  authorize(ROLES.ADMIN),
  adminController.getUserDetail,
);
router.post(
  '/create-user',
  authorize(ROLES.ADMIN),
  adminController.createUser,
);
router.post(
  '/users',
  authorize(ROLES.ADMIN),
  adminController.createUser,
);
router.put(
  '/users/:id',
  authorize(ROLES.ADMIN),
  adminController.updateUser,
);
router.patch(
  '/users/:id/role',
  authorize(ROLES.ADMIN),
  adminController.changeUserRole,
);
router.patch(
  '/users/:id/status',
  authorize(ROLES.ADMIN),
  adminController.setUserStatus,
);
router.put(
  '/update-doctor/:id',
  authorize(ROLES.ADMIN),
  adminController.updateDoctor,
);
router.get(
  '/doctors/:id',
  authorize(ROLES.ADMIN),
  adminController.getUserDetail,
);
router.put(
  '/doctors/:id',
  authorize(ROLES.ADMIN),
  adminController.updateDoctor,
);
router.delete(
  '/doctors/:id',
  authorize(ROLES.ADMIN),
  adminController.deleteDoctor,
);
router.get(
  '/receptionists/:id',
  authorize(ROLES.ADMIN),
  adminController.getUserDetail,
);
router.delete(
  '/receptionists/:id',
  authorize(ROLES.ADMIN),
  adminController.deleteReceptionist,
);
router.delete(
  '/staff/:id',
  authorize(ROLES.ADMIN),
  adminController.deleteStaff,
);

// Specialty management under /api/admin/specialties
router.get(
  '/specialties',
  authorize(ROLES.ADMIN),
  specialtyController.getAllSpecialties,
);
router.post(
  '/specialties',
  authorize(ROLES.ADMIN),
  specialtyController.createSpecialty,
);
router.put(
  '/specialties/:id',
  authorize(ROLES.ADMIN),
  specialtyController.updateSpecialty,
);
router.delete(
  '/specialties/:id',
  authorize(ROLES.ADMIN),
  specialtyController.deleteSpecialty,
);

module.exports = router;

