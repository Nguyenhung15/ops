const {
  Appointment,
  Prescription,
  PatientProfile,
  User,
} = require('../models');
const {
  ROLES,
  AUDIT_ACTIONS,
  APPOINTMENT_STATUSES,
} = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const auditService = require('./audit.service');

class PatientPrescriptionService {
  /**
   * UC-PAT-11: Bệnh nhân xem đơn thuốc theo lịch hẹn
   * Endpoint: GET /prescriptions/by-appointment/:appointmentId?version=...
   *
   * Yêu cầu bảo mật:
   * 1. Quyền sở hữu (Ownership) được kiểm tra trực tiếp trong câu query CSDL (appointment.patientId === user.id hoặc appointment.patients.id thuộc PatientProfile do user sở hữu).
   * 2. Lịch không thuộc về user hoặc không tồn tại -> Đều trả về 404 APPOINTMENT_NOT_FOUND (tránh user enumeration).
   * 3. Trả danh sách thuốc medicines (tên, liều lượng, thời gian, hướng dẫn), thông tin bác sĩ kê, ngày kê, version mới nhất (hoặc version theo query).
   * 4. Lịch chưa COMPLETED hoặc chưa có đơn: trả về danh sách rỗng (hoặc báo rõ chưa có đơn), không lỗi 500.
   * 5. Không trả ghi chú nội bộ của bác sĩ, không trả dữ liệu bệnh nhân khác.
   * 6. Audit VIEW_PRESCRIPTION chỉ ghi actor và appointmentId, TUYỆT ĐỐI không log nội dung đơn thuốc.
   */
  async getPrescriptionByAppointment(actor, appointmentId, query = {}, req = null) {
    if (!actor || (actor.role !== ROLES.PATIENT && actor.userType !== ROLES.PATIENT)) {
      throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền xem đơn thuốc cá nhân', 'FORBIDDEN_ROLE');
    }

    const numUserId = Number(actor.id || actor.userId);
    if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
      throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
    }

    const numApptId = Number(appointmentId);
    const appointmentIdentifierFilter = Number.isSafeInteger(numApptId) && numApptId > 0
      ? { id: numApptId }
      : { appointmentNo: String(appointmentId).trim() };

    // 1. Tìm danh sách ID hồ sơ phụ thuộc do user sở hữu (PatientProfile.ownerId === numUserId)
    const ownedProfiles = await PatientProfile.find({
      ownerId: numUserId,
      isArchived: false,
    }).select('id').lean();
    const ownedProfileIds = ownedProfiles.map((p) => p.id).filter(Boolean);

    // 2. Ownership query filter:
    // Appointment phải thỏa mãn:
    // (a) patientId === numUserId
    // HOẶC (b) patients.id nằm trong ownedProfileIds
    const ownershipOrConditions = [{ patientId: numUserId }];
    if (ownedProfileIds.length > 0) {
      ownershipOrConditions.push({ 'patients.id': { $in: ownedProfileIds } });
    }

    const appointmentFilter = {
      ...appointmentIdentifierFilter,
      $or: ownershipOrConditions,
    };

    const appointment = await Appointment.findOne(appointmentFilter).lean();
    if (!appointment) {
      // Không thuộc user hoặc không tồn tại -> Cùng một mã 404
      throw new ApiError(404, 'Không tìm thấy lịch hẹn hoặc lịch hẹn không thuộc về bạn', 'APPOINTMENT_NOT_FOUND');
    }

    // 3. Truy vấn đơn thuốc (Prescription) theo appointmentId
    // Hỗ trợ lọc theo version nếu có truyền query ?version=
    const prescriptionFilter = {
      appointmentId: appointment.id,
    };

    const requestedVersion = query?.version !== undefined && query?.version !== null && query?.version !== ''
      ? Number(query.version)
      : null;

    if (Number.isSafeInteger(requestedVersion) && requestedVersion > 0) {
      prescriptionFilter.version = requestedVersion;
    }

    // Lấy toàn bộ bản ghi đơn thuốc của appointment
    const prescriptions = await Prescription.find(prescriptionFilter)
      .sort({ version: -1, id: 1 })
      .lean();

    // Xác định version cao nhất hiện có (nếu không yêu cầu version cụ thể)
    let targetVersion = requestedVersion;
    if (!targetVersion && prescriptions.length > 0) {
      targetVersion = prescriptions[0].version || 1;
    }

    // Lọc các thuốc thuộc targetVersion (nếu có version)
    const matchedPrescriptions = targetVersion
      ? prescriptions.filter((p) => (p.version || 1) === targetVersion)
      : prescriptions;

    // 4. Lấy thông tin bác sĩ kê đơn (nếu có doctorId)
    let doctorInfo = null;
    if (appointment.doctorId) {
      const doctor = await User.findOne({ id: appointment.doctorId }).select('id fullName').lean();
      if (doctor) {
        doctorInfo = {
          id: doctor.id,
          fullName: doctor.fullName,
        };
      }
    }

    // 5. Chuẩn hóa danh sách thuốc (không rò rỉ ghi chú nội bộ hay PII khác)
    const medicines = matchedPrescriptions.map((p) => ({
      id: p.id,
      medicineName: p.medicineName,
      dosage: p.dosage || null,
      duration: p.duration || null,
      instructions: p.instructions || null,
      version: p.version || 1,
      createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      appointmentId: appointment.id,
    }));

    // 6. Ghi Audit Log VIEW_PRESCRIPTION (TUYỆT ĐỐI không log nội dung đơn thuốc)
    await auditService.log({
      actor: {
        userId: numUserId,
        role: actor.role || actor.userType,
        email: actor.email,
      },
      action: AUDIT_ACTIONS.VIEW_PRESCRIPTION,
      resource: {
        type: 'Appointment',
        id: appointment.id,
      },
      reason: `Bệnh nhân #${numUserId} xem đơn thuốc của lịch hẹn #${appointment.id}`,
      changes: {
        appointmentId: appointment.id,
        version: targetVersion || 1,
        count: medicines.length,
      },
      req,
    });

    // 7. Định dạng response:
    // Trả cả mảng medicines (tương thích web/src/api/prescription.ts mảng data[])
    // và metadata bổ sung (doctor, version, appointmentStatus)
    return {
      appointmentId: appointment.id,
      appointmentNo: appointment.appointmentNo,
      appointmentStatus: appointment.status,
      doctor: doctorInfo,
      version: targetVersion || 1,
      prescribedAt: medicines[0]?.createdAt || appointment.updatedAt || appointment.createdAt,
      medicines,
      // Array data root-compatible:
      data: medicines,
    };
  }
}

const patientPrescriptionService = new PatientPrescriptionService();
module.exports = {
  patientPrescriptionService,
  PatientPrescriptionService,
};
