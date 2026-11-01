const { Router } = require('express');
const onlineConsultationController = require('../../controllers/onlineConsultation.controller');
const { authenticate, requireRoles } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/enums');

const router = Router();

// POST /appointments/:id/join-online - Bệnh nhân vào phòng khám trực tuyến
router.post(
  '/:id/join-online',
  authenticate,
  requireRoles(ROLES.PATIENT),
  onlineConsultationController.joinOnline,
);

module.exports = {
  basePath: '/appointments',
  router,
};
