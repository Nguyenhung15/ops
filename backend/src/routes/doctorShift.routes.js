const { Router } = require('express');
const doctorShiftController = require('../controllers/doctorShift.controller');
const shiftCancellationController = require('../controllers/shiftCancellation.controller');
const { authenticate, requireRoles, authorize } = require('../middlewares/auth.middleware');
const { ROLES } = require('../constants/enums');

const router = Router();

// ==========================================
// 1. Receptionist & Admin: Shift Cancellation Requests Management (UC-REC-06)
// ==========================================

// GET /shifts/cancellation-requests/pending - Danh sách yêu cầu chờ duyệt kèm tổng hợp
router.get(
  '/cancellation-requests/pending',
  authenticate,
  authorize(ROLES.RECEPTIONIST, ROLES.ADMIN),
  shiftCancellationController.getPending,
);

// PUT /shifts/cancellation-requests/:id/approve - Duyệt yêu cầu hủy ca
router.put(
  '/cancellation-requests/:id/approve',
  authenticate,
  authorize(ROLES.RECEPTIONIST, ROLES.ADMIN),
  shiftCancellationController.approve,
);

// PUT /shifts/cancellation-requests/:id/reject - Từ chối yêu cầu hủy ca (bắt buộc note)
router.put(
  '/cancellation-requests/:id/reject',
  authenticate,
  authorize(ROLES.RECEPTIONIST, ROLES.ADMIN),
  shiftCancellationController.reject,
);

router.get(
  '/by-date',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST),
  doctorShiftController.getAllShiftsByDate,
);

// ==========================================
// 2. Admin routes
// ==========================================
router.get(
  '/admin/week',
  authenticate,
  authorize(ROLES.ADMIN),
  doctorShiftController.getShiftsInWeek,
);

router.post(
  '/admin/create',
  authenticate,
  authorize(ROLES.ADMIN),
  doctorShiftController.createShift,
);

router.get(
  '/admin/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  doctorShiftController.getShiftDetail,
);

router.put(
  '/admin/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  doctorShiftController.adjustShift,
);

router.delete(
  '/admin/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  doctorShiftController.deleteShift,
);

// ==========================================
// 3. Doctor routes
// ==========================================
router.get(
  '/my',
  authenticate,
  authorize(ROLES.DOCTOR),
  doctorShiftController.getMyShifts,
);

router.get(
  '/cancellation-requests/my',
  authenticate,
  authorize(ROLES.DOCTOR),
  shiftCancellationController.getMine,
);

router.post(
  '/:shiftId/cancellation-requests',
  authenticate,
  authorize(ROLES.DOCTOR),
  shiftCancellationController.create,
);

// ==========================================
// 4. Common / Dual-role routes (Admin & Doctor)
// ==========================================
router.post(
  '/create',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.DOCTOR),
  doctorShiftController.createShift,
);

router.get(
  '/:id',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.DOCTOR, ROLES.RECEPTIONIST),
  doctorShiftController.getShiftDetail,
);

router.put(
  '/:id',
  authenticate,
  authorize(ROLES.ADMIN, ROLES.DOCTOR),
  doctorShiftController.adjustShift,
);

router.delete(
  '/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  doctorShiftController.deleteShift,
);

module.exports = router;

