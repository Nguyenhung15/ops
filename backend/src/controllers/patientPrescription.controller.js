const { patientPrescriptionService } = require('../services/patientPrescription.service');

class PatientPrescriptionController {
  /**
   * UC-PAT-11: GET /prescriptions/by-appointment/:appointmentId?version=...
   * Hoặc GET /prescriptions/my-prescriptions/by-appointment/:appointmentId?version=...
   */
  async getPrescriptionByAppointment(req, res, next) {
    try {
      const result = await patientPrescriptionService.getPrescriptionByAppointment(
        req.user,
        req.params.appointmentId,
        req.query,
        req,
      );

      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Lấy đơn thuốc thành công',
        appointmentId: result.appointmentId,
        appointmentNo: result.appointmentNo,
        appointmentStatus: result.appointmentStatus,
        doctor: result.doctor,
        version: result.version,
        prescribedAt: result.prescribedAt,
        data: result.medicines,
        medicines: result.medicines,
      });
    } catch (error) {
      return next(error);
    }
  }
}

const patientPrescriptionController = new PatientPrescriptionController();
module.exports = {
  patientPrescriptionController,
  PatientPrescriptionController,
};
