const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const { getHealth } = require('../controllers/health.controller');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const adminRoutes = require('./admin.routes');
const adminGroupHealthRoutes = require('./adminGroupHealth.routes');
const adminAnalyticsRoutes = require('./adminAnalytics.routes');
const doctorRoutes = require('./doctor.routes');
const receptionistRoutes = require('./receptionist.routes');
const specialtyRoutes = require('./specialty.routes');
const imageRoutes = require('./image.routes');
const patientShiftRoutes = require('./patientShift.routes');
const doctorShiftRoutes = require('./doctorShift.routes');
const patientAppointmentRoutes = require('./patientAppointment.routes');
const doctorAppointmentRoutes = require('./doctorAppointment.routes');
const receptionistAppointmentRoutes = require('./receptionistAppointment.routes');
const doctorPrescriptionRoutes = require('./doctorPrescription.routes');
const doctorGroupHealthRoutes = require('./doctorGroupHealth.routes');
const rssNewsRoutes = require('./rssNews.routes');
const patientProfileRoutes = require('./patientProfile.routes');
const receptionistEventRoutes = require('./receptionistEvent.routes');
const voucherRoutes = require('./voucher.routes');

const router = Router();

// --- 1. Dynamic Features Loader (Mount FIRST so Patient feature routes aren't blocked by role guards) ---
const featuresDir = path.join(__dirname, 'features');
if (fs.existsSync(featuresDir)) {
  const featureFiles = fs
    .readdirSync(featuresDir)
    .filter((file) => file.endsWith('.routes.js'))
    .sort();

  for (const file of featureFiles) {
    const featureModule = require(path.join(featuresDir, file));
    const basePath = featureModule.basePath || featureModule.prefix;
    const featureRouter = featureModule.router || featureModule.default;

    if (basePath && featureRouter) {
      router.use(basePath, featureRouter);
    }
  }
}

// --- 2. Core & Legacy Routers ---
router.get('/health', getHealth);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/admin/group-health', adminGroupHealthRoutes);
router.use('/admin/analytics', adminAnalyticsRoutes);
router.use('/admin/rss-sources', rssNewsRoutes);
router.use('/admin', adminRoutes);
router.use('/doctors', doctorRoutes);
router.use('/receptionists', receptionistRoutes);
router.use('/reception', receptionistEventRoutes);
router.use('/specialties', specialtyRoutes);
router.use('/images', imageRoutes);
router.use('/shifts', patientShiftRoutes);
router.use('/shifts', doctorShiftRoutes);
router.use('/appointments', patientAppointmentRoutes);
router.use('/appointments', receptionistAppointmentRoutes);
router.use('/appointments', doctorAppointmentRoutes);
router.use('/prescriptions', doctorPrescriptionRoutes);
router.use('/group-health', doctorGroupHealthRoutes);
router.use('/rss-sources', rssNewsRoutes);
router.use('/patients-info', patientProfileRoutes);
router.use('/vouchers', voucherRoutes);

module.exports = router;
