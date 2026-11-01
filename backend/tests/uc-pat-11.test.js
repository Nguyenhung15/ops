const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_pat_11_test_secret_key';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_pat_11';

const app = require('../src/app');
const {
  User,
  Specialty,
  DoctorShift,
  Appointment,
  Prescription,
  PatientProfile,
  AuditLog,
} = require('../src/models');
const { ROLES, APPOINTMENT_STATUSES, AUDIT_ACTIONS } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');

let server;
let baseUrl;

let patient1;
let patient1Token;
let patient2;
let patient2Token;
let doctor1;
let doctor1Token;
let receptionist1;
let receptionist1Token;

let specialty1;
let doctorShift1;

let patient1DependentProfile;
let patient2DependentProfile;

async function apiRequest(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

describe('UC-PAT-11: Patient xem đơn thuốc và lịch sử khám (/prescriptions & /appointments)', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    const passwordHash = await bcrypt.hash('Secret@123', 10);

    // 1. Seed Specialty
    specialty1 = await Specialty.create({
      id: 1,
      name: 'Nội tiết - Tim mạch',
      description: 'Chuyên khoa Nội',
    });

    // 2. Seed Users
    patient1 = await User.create({
      id: 1101,
      email: 'pat1_uc11@clinicbooking.com',
      password: passwordHash,
      fullName: 'Bệnh Nhân Chính Một',
      userType: ROLES.PATIENT,
      gender: 'Male',
      phoneNumber: '0901111111',
      isEnable: true,
    });
    patient1Token = signAccessToken(patient1);

    patient2 = await User.create({
      id: 1102,
      email: 'pat2_uc11@clinicbooking.com',
      password: passwordHash,
      fullName: 'Bệnh Nhân Khác Hai',
      userType: ROLES.PATIENT,
      gender: 'Female',
      phoneNumber: '0902222222',
      isEnable: true,
    });
    patient2Token = signAccessToken(patient2);

    doctor1 = await User.create({
      id: 1103,
      email: 'doc1_uc11@clinicbooking.com',
      password: passwordHash,
      fullName: 'BS CKII Trần Văn Bác Sĩ',
      userType: ROLES.DOCTOR,
      gender: 'Male',
      specialtyId: specialty1.id,
      phoneNumber: '0903333333',
      isEnable: true,
    });
    doctor1Token = signAccessToken(doctor1);

    receptionist1 = await User.create({
      id: 1104,
      email: 'rec1_uc11@clinicbooking.com',
      password: passwordHash,
      fullName: 'Lễ Tân Tiếp Đón',
      userType: ROLES.RECEPTIONIST,
      gender: 'Female',
      phoneNumber: '0904444444',
      isEnable: true,
    });
    receptionist1Token = signAccessToken(receptionist1);

    // 3. Seed Patient Profiles (Dependent)
    patient1DependentProfile = await PatientProfile.create({
      id: 101,
      ownerId: patient1.id,
      fullName: 'Con Gái Bệnh Nhân 1',
      gender: 'Female',
      dateOfBirth: '2020-05-15',
      relationship: 'CHILD',
      phoneNumber: '0901111111',
      isArchived: false,
    });

    patient2DependentProfile = await PatientProfile.create({
      id: 102,
      ownerId: patient2.id,
      fullName: 'Mẹ Bệnh Nhân 2',
      gender: 'Female',
      dateOfBirth: '1960-01-01',
      relationship: 'PARENT',
      phoneNumber: '0902222222',
      isArchived: false,
    });

    // 4. Seed DoctorShift
    doctorShift1 = await DoctorShift.create({
      id: 501,
      doctorId: doctor1.id,
      date: '2026-11-10',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      maxPatients: 10,
      status: 'ACTIVE',
      slots: [
        { id: 201, slotNumber: 1, startTime: '08:00', endTime: '08:30', status: 'BOOKED' },
        { id: 202, slotNumber: 2, startTime: '08:30', endTime: '09:00', status: 'BOOKED' },
        { id: 203, slotNumber: 3, startTime: '09:00', endTime: '09:30', status: 'BOOKED' },
        { id: 204, slotNumber: 4, startTime: '09:30', endTime: '10:00', status: 'BOOKED' },
      ],
    });

    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  it('1. Đơn thuốc của chính mình: xem thành công, đầy đủ thông tin thuốc, bác sĩ, ngày kê', async () => {
    // Tạo lịch hẹn COMPLETED của patient1
    const appt = await Appointment.create({
      id: 4001,
      appointmentNo: 'OFF2611010001',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-01',
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.COMPLETED,
      actualStartTime: '2026-11-01T08:05:00.000Z',
      actualEndTime: '2026-11-01T08:25:00.000Z',
      patients: [{ fullName: patient1.fullName, gender: 'Male', relationship: 'SELF' }],
    });

    // Tạo đơn thuốc cho appointment 4001
    await Prescription.create([
      {
        id: 7001,
        appointmentId: appt.id,
        medicineName: 'Amoxicillin 500mg',
        dosage: '1 viên x 3 lần/ngày',
        duration: '7 ngày',
        instructions: 'Uống sau ăn no',
        version: 1,
      },
      {
        id: 7002,
        appointmentId: appt.id,
        medicineName: 'Paracetamol 500mg',
        dosage: '1 viên khi sốt > 38.5 độ',
        duration: '3 ngày',
        instructions: 'Cách ít nhất 4-6 tiếng mỗi lần',
        version: 1,
      },
    ]);

    const res = await apiRequest('GET', `/prescriptions/by-appointment/${appt.id}`, {
      token: patient1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.appointmentId, appt.id);
    assert.equal(res.body.appointmentNo, 'OFF2611010001');
    assert.equal(res.body.doctor?.fullName, doctor1.fullName);
    assert.equal(res.body.version, 1);

    // Kiểm tra danh sách medicines và cấu trúc data
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.data[0].medicineName, 'Amoxicillin 500mg');
    assert.equal(res.body.data[0].dosage, '1 viên x 3 lần/ngày');
    assert.equal(res.body.data[0].duration, '7 ngày');
    assert.equal(res.body.data[0].instructions, 'Uống sau ăn no');
    assert.equal(res.body.data[1].medicineName, 'Paracetamol 500mg');
  });

  it('2. Lịch người khác: Bệnh nhân cố xem đơn thuốc của người khác -> 404 (chống user enumeration)', async () => {
    // Tạo lịch của patient2
    const apptPatient2 = await Appointment.create({
      id: 4002,
      appointmentNo: 'OFF2611010002',
      patientId: patient2.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-01',
      appointmentTime: '08:30',
      status: APPOINTMENT_STATUSES.COMPLETED,
      patients: [{ fullName: patient2.fullName }],
    });

    await Prescription.create({
      id: 7003,
      appointmentId: apptPatient2.id,
      medicineName: 'Vitamin C 500mg',
      dosage: '1 viên/ngày',
      duration: '10 ngày',
      instructions: 'Uống buổi sáng',
      version: 1,
    });

    // Patient1 gọi xem đơn của appointment 4002 -> Phải trả về 404
    const res = await apiRequest('GET', `/prescriptions/by-appointment/${apptPatient2.id}`, {
      token: patient1Token,
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error?.code, 'APPOINTMENT_NOT_FOUND');
  });

  it('3. Hồ sơ phụ thuộc: Hồ sơ phụ thuộc thuộc sở hữu của mình -> xem được; hồ sơ của người khác -> 404', async () => {
    // 3a. Lịch đặt cho con gái của patient1 (patient1DependentProfile.id = 101)
    const apptDependent1 = await Appointment.create({
      id: 4003,
      appointmentNo: 'OFF2611010003',
      patientId: 0, // hoặc null khi đặt cho người thân
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-01',
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.COMPLETED,
      patients: [
        {
          id: patient1DependentProfile.id,
          fullName: patient1DependentProfile.fullName,
          gender: patient1DependentProfile.gender,
          relationship: patient1DependentProfile.relationship,
        },
      ],
    });

    await Prescription.create({
      id: 7004,
      appointmentId: apptDependent1.id,
      medicineName: 'Siro Ho Prospan',
      dosage: '5ml x 3 lần/ngày',
      duration: '5 ngày',
      instructions: 'Uống trực tiếp',
      version: 1,
    });

    // Patient 1 xem đơn của con gái mình -> thành công 200
    const resOwnDependent = await apiRequest('GET', `/prescriptions/by-appointment/${apptDependent1.id}`, {
      token: patient1Token,
    });
    assert.equal(resOwnDependent.status, 200);
    assert.equal(resOwnDependent.body.data.length, 1);
    assert.equal(resOwnDependent.body.data[0].medicineName, 'Siro Ho Prospan');

    // 3b. Lịch đặt cho hồ sơ phụ thuộc của patient2 (patient2DependentProfile.id = 102)
    const apptDependent2 = await Appointment.create({
      id: 4004,
      appointmentNo: 'OFF2611010004',
      patientId: 0,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-01',
      appointmentTime: '09:30',
      status: APPOINTMENT_STATUSES.COMPLETED,
      patients: [
        {
          id: patient2DependentProfile.id,
          fullName: patient2DependentProfile.fullName,
          gender: patient2DependentProfile.gender,
          relationship: patient2DependentProfile.relationship,
        },
      ],
    });

    // Patient 1 cố xem đơn của hồ sơ phụ thuộc thuộc Patient 2 -> 404
    const resOtherDependent = await apiRequest('GET', `/prescriptions/by-appointment/${apptDependent2.id}`, {
      token: patient1Token,
    });
    assert.equal(resOtherDependent.status, 404);
    assert.equal(resOtherDependent.body.error?.code, 'APPOINTMENT_NOT_FOUND');
  });

  it('4. Lịch chưa có đơn hoặc chưa COMPLETED: trả danh sách rỗng [], không gây lỗi 500', async () => {
    // Tạo lịch CONFIRMED chưa có đơn
    const apptNoPrescription = await Appointment.create({
      id: 4005,
      appointmentNo: 'OFF2611010005',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-05',
      appointmentTime: '10:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      patients: [{ fullName: patient1.fullName }],
    });

    const res = await apiRequest('GET', `/prescriptions/by-appointment/${apptNoPrescription.id}`, {
      token: patient1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 0);
  });

  it('5. Quản lý phiên bản (version): mặc định lấy bản mới nhất, xem bản cũ qua ?version=', async () => {
    const apptMultiVersion = await Appointment.create({
      id: 4006,
      appointmentNo: 'OFF2611010006',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-02',
      appointmentTime: '14:00',
      status: APPOINTMENT_STATUSES.COMPLETED,
      patients: [{ fullName: patient1.fullName }],
    });

    // Phiên bản 1: Thuốc A
    await Prescription.create({
      id: 7010,
      appointmentId: apptMultiVersion.id,
      medicineName: 'Thuốc Bản Cũ V1',
      dosage: '1 viên/ngày',
      duration: '3 ngày',
      version: 1,
    });

    // Phiên bản 2: Thuốc B (bản cập nhật mới nhất)
    await Prescription.create({
      id: 7011,
      appointmentId: apptMultiVersion.id,
      medicineName: 'Thuốc Bản Mới V2',
      dosage: '2 viên/ngày',
      duration: '5 ngày',
      version: 2,
    });

    // Gọi không truyền ?version -> Mặc định lấy version 2
    const resLatest = await apiRequest('GET', `/prescriptions/by-appointment/${apptMultiVersion.id}`, {
      token: patient1Token,
    });
    assert.equal(resLatest.status, 200);
    assert.equal(resLatest.body.version, 2);
    assert.equal(resLatest.body.data.length, 1);
    assert.equal(resLatest.body.data[0].medicineName, 'Thuốc Bản Mới V2');

    // Gọi có ?version=1 -> Lấy đúng version 1
    const resV1 = await apiRequest('GET', `/prescriptions/by-appointment/${apptMultiVersion.id}?version=1`, {
      token: patient1Token,
    });
    assert.equal(resV1.status, 200);
    assert.equal(resV1.body.version, 1);
    assert.equal(resV1.body.data.length, 1);
    assert.equal(resV1.body.data[0].medicineName, 'Thuốc Bản Cũ V1');
  });

  it('6. Bảo mật và Audit Log: ghi nhận VIEW_PRESCRIPTION chỉ với actor và appointmentId, TUYỆT ĐỐI không log nội dung đơn thuốc', async () => {
    // Đếm audit log trước khi gọi
    const countBefore = await AuditLog.countDocuments({ action: AUDIT_ACTIONS.VIEW_PRESCRIPTION });

    const res = await apiRequest('GET', '/prescriptions/by-appointment/4001', {
      token: patient1Token,
    });
    assert.equal(res.status, 200);

    const countAfter = await AuditLog.countDocuments({ action: AUDIT_ACTIONS.VIEW_PRESCRIPTION });
    assert.equal(countAfter, countBefore + 1);

    const latestLog = await AuditLog.findOne({ action: AUDIT_ACTIONS.VIEW_PRESCRIPTION }).sort({ createdAt: -1 }).lean();
    assert.ok(latestLog);
    assert.equal(Number(latestLog.actorId), patient1.id);
    assert.equal(Number(latestLog.targetId), 4001);

    // Xác nhận không rò rỉ tên thuốc hay chỉ định trong changes/reason/metadata
    const logStr = JSON.stringify(latestLog);
    assert.ok(!logStr.includes('Amoxicillin'));
    assert.ok(!logStr.includes('Paracetamol'));
    assert.ok(!logStr.includes('Uống sau ăn no'));
  });

  it('7. Phân quyền: Doctor và Receptionist gọi route bệnh nhân bị 403 FORBIDDEN_ROLE', async () => {
    // Route riêng cho Patient: /prescriptions/my-prescriptions/by-appointment/:appointmentId
    const resDoctor = await apiRequest('GET', '/prescriptions/my-prescriptions/by-appointment/4001', {
      token: doctor1Token,
    });
    assert.equal(resDoctor.status, 403);
    assert.equal(resDoctor.body.success, false);

    const resReceptionist = await apiRequest('GET', '/prescriptions/my-prescriptions/by-appointment/4001', {
      token: receptionist1Token,
    });
    assert.equal(resReceptionist.status, 403);
    assert.equal(resReceptionist.body.success, false);
  });

  it('8. Khả năng tương thích lịch sử khám (PAT-05): GET /appointments/my-completed trả actualStartTime, actualEndTime và lọc theo khoảng ngày', async () => {
    // Seed thêm một cuộc hẹn đã hoàn tất có khoảng ngày cụ thể
    await Appointment.create({
      id: 4007,
      appointmentNo: 'OFF2611010007',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-10-15',
      appointmentTime: '10:00',
      status: APPOINTMENT_STATUSES.COMPLETED,
      actualStartTime: '2026-10-15T10:02:00.000Z',
      actualEndTime: '2026-10-15T10:20:00.000Z',
      patients: [{ fullName: patient1.fullName }],
    });

    const resAll = await apiRequest('GET', '/appointments/my-completed', {
      token: patient1Token,
    });
    assert.equal(resAll.status, 200);
    assert.ok(Array.isArray(resAll.body.data));
    assert.ok(resAll.body.data.length >= 2);

    // Kiểm tra có actualStartTime / actualEndTime
    const appt4001InHistory = resAll.body.data.find((a) => a.id === 4001);
    assert.ok(appt4001InHistory);
    assert.equal(appt4001InHistory.actualStartTime, '2026-11-01T08:05:00.000Z');
    assert.equal(appt4001InHistory.actualEndTime, '2026-11-01T08:25:00.000Z');

    // Thử lọc theo khoảng ngày: từ 2026-10-01 đến 2026-10-31 (chỉ khớp 4007, loại bỏ 4001 và 4006 ở tháng 11)
    const resFiltered = await apiRequest('GET', '/appointments/my-completed?fromDate=2026-10-01&toDate=2026-10-31', {
      token: patient1Token,
    });
    assert.equal(resFiltered.status, 200);
    const filteredIds = resFiltered.body.data.map((a) => a.id);
    assert.ok(filteredIds.includes(4007));
    assert.ok(!filteredIds.includes(4001));
    assert.ok(!filteredIds.includes(4006));
  });

  it('9. Route fallback tương thích cho Bác sĩ trên GET /prescriptions/by-appointment/:appointmentId', async () => {
    // Bác sĩ gọi endpoint chung /prescriptions/by-appointment/:appointmentId
    // Nhờ middleware kiểm tra nếu không phải PATIENT thì rơi xuống doctorPrescriptionRoutes,
    // bác sĩ vẫn lấy được dữ liệu đơn thuốc của ca khám do mình phụ trách!
    const resDoctorCommon = await apiRequest('GET', '/prescriptions/by-appointment/4001', {
      token: doctor1Token,
    });
    assert.equal(resDoctorCommon.status, 200);
    assert.equal(resDoctorCommon.body.success, true);
    assert.ok(Array.isArray(resDoctorCommon.body.data));
  });
});
