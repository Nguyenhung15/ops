const { Router } = require('express');
const { patientPrescriptionController } = require('../../controllers/patientPrescription.controller');
const { authenticate, requireRoles } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/enums');

const router = Router();

/**
 * Route chuyên biệt cho Patient: GET /prescriptions/my-prescriptions/by-appointment/:appointmentId
 * Yêu cầu quyền PATIENT. Nếu Doctor/Receptionist gọi route này sẽ bị 403 FORBIDDEN_ROLE.
 */
router.get(
  '/my-prescriptions/by-appointment/:appointmentId',
  authenticate,
  requireRoles(ROLES.PATIENT),
  patientPrescriptionController.getPrescriptionByAppointment,
);

/**
 * Route tích hợp cho Patient & Doctor: GET /prescriptions/by-appointment/:appointmentId
 * Khớp hoàn toàn với frontend web/src/api/prescription.ts: getPrescriptionsByAppointment(appointmentId).
 * Do router feature được load trước doctorPrescriptionRoutes trong routes/index.js:
 * - Nếu user có vai trò PATIENT -> xử lý bằng controller của Patient (kiểm tra ownership, an toàn bảo mật, audit).
 * - Nếu user có vai trò khác (DOCTOR, ADMIN, RECEPTIONIST) -> gọi next() để rơi xuống doctorPrescriptionRoutes phía sau!
 */
router.get('/by-appointment/:appointmentId', authenticate, (req, res, next) => {
  const role = req.user?.role || req.user?.userType;
  if (role === ROLES.PATIENT) {
    return patientPrescriptionController.getPrescriptionByAppointment(req, res, next);
  }
  return next();
});

module.exports = {
  basePath: '/prescriptions',
  router,
};
