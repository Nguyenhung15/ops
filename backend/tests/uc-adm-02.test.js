const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Isolate test database BEFORE loading app & models
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_adm_02_test_secret';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI_ADM02 ||
  'mongodb://127.0.0.1:27017/clinic_booking_test_uc_adm_02';

const app = require('../src/app');
const {
  User,
  Specialty,
  AuditLog,
  DoctorShift,
  Appointment,
  Prescription,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS } = require('../src/constants/enums');

let server;
let baseUrl;
let adminToken;
let patientToken;
let receptionistToken;

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

describe('UC-ADM-02: Quản lý bác sĩ và lễ tân (Admin Staff Management)', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    // 1. Seed Specialties
    await Specialty.create([
      { id: 1, name: 'Nội tổng quát', description: 'Khám nội khoa tổng quát' },
      { id: 2, name: 'Nhi khoa', description: 'Chăm sóc sức khỏe trẻ em' },
      { id: 5, name: 'Tim mạch', description: 'Khám chuyên sâu tim mạch' },
    ]);

    // 2. Seed Admin, Patient, Receptionist
    const passwordHash = await bcrypt.hash('Staff@123', 10);
    await User.create({
      email: 'admin.staff@clinic.com',
      password: passwordHash,
      fullName: 'Head Administrator',
      userType: ROLES.ADMIN,
      gender: 'Male',
      isEnable: true,
    });

    await User.create({
      email: 'patient.test@clinic.com',
      password: passwordHash,
      fullName: 'Test Patient',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });

    await User.create({
      email: 'recep.test@clinic.com',
      password: passwordHash,
      fullName: 'Test Receptionist',
      userType: ROLES.RECEPTIONIST,
      gender: 'Female',
      isEnable: true,
    });

    // 3. Start ephemeral test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    // 4. Authenticate tokens
    const adminLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'admin.staff@clinic.com', password: 'Staff@123' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.data.token;

    const patLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'patient.test@clinic.com', password: 'Staff@123' },
    });
    assert.equal(patLogin.status, 200);
    patientToken = patLogin.body.data.token;

    const recepLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'recep.test@clinic.com', password: 'Staff@123' },
    });
    assert.equal(recepLogin.status, 200);
    receptionistToken = recepLogin.body.data.token;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
  });

  let createdDoctorId;
  let createdReceptionistId;

  // -------------------------------------------------------------------------
  // 1. Luồng chính: Tạo hồ sơ Bác sĩ (Doctor)
  // -------------------------------------------------------------------------
  it('Admin tạo bác sĩ với chuyên khoa (tên), bằng cấp, kinh nghiệm, phí khám và trạng thái', async () => {
    const payload = {
      fullName: 'BS. Nguyễn Văn A',
      email: 'doctor.nguyenvana@clinic.com',
      password: 'Doctor@123',
      phoneNumber: '0901234567',
      gender: 'Male',
      userType: 'Doctor',
      specialization: 'Tim mạch', // Gửi tên chuyên khoa theo chuẩn Frontend AdminCreateUser
      degree: 'Tiến sĩ Y khoa',
      experience: '15 năm',
      description: 'Chuyên gia tim mạch hàng đầu',
      consultationFee: 350000,
      isVip: true,
      isEnabled: true,
    };

    const res = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: payload,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(typeof res.body.data.id === 'number');
    assert.equal(res.body.data.userType, 'Doctor');
    assert.equal(res.body.data.specialtyId, 5);
    assert.equal(res.body.data.specialtyName, 'Tim mạch');
    assert.equal(res.body.data.degree, 'Tiến sĩ Y khoa');
    assert.equal(res.body.data.experience, '15 năm');
    assert.equal(res.body.data.consultationFee, 350000);
    assert.equal(res.body.data.isVip, true);
    assert.equal(res.body.data.isEnable, true);
    assert.equal(res.body.data.isEnabled, true);

    createdDoctorId = res.body.data.id;

    // Check DB
    const doctorInDb = await User.findOne({ id: createdDoctorId }).lean();
    assert.ok(doctorInDb);
    assert.equal(doctorInDb.specialtyId, 5);
    assert.equal(doctorInDb.consultationFee, 350000);
  });

  // -------------------------------------------------------------------------
  // 2. Luồng chính: Tạo hồ sơ Lễ tân (Receptionist)
  // -------------------------------------------------------------------------
  it('Admin tạo lễ tân với thông tin đầy đủ', async () => {
    const payload = {
      fullName: 'Lê Thị Thu Thảo',
      email: 'thuthao.recep@clinic.com',
      password: 'Recep@123',
      phoneNumber: '0988776655',
      gender: 'Female',
      userType: 'Receptionist',
      isEnabled: true,
    };

    const res = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: payload,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(typeof res.body.data.id === 'number');
    assert.equal(res.body.data.userType, 'Receptionist');
    assert.equal(res.body.data.fullName, 'Lê Thị Thu Thảo');
    assert.equal(res.body.data.isEnable, true);

    createdReceptionistId = res.body.data.id;
  });

  // -------------------------------------------------------------------------
  // 3. Luồng chính: Sửa hồ sơ Bác sĩ
  // -------------------------------------------------------------------------
  it('Admin sửa hồ sơ bác sĩ: cập nhật bằng cấp, kinh nghiệm, phí khám và thông tin cá nhân', async () => {
    const updatePayload = {
      fullName: 'PGS. TS. Nguyễn Văn A (Đã cập nhật)',
      phoneNumber: '0909999888',
      gender: 'Male',
      degree: 'Phó Giáo Sư - Tiến Sĩ',
      experience: '20 năm',
      description: 'Trưởng khoa tim mạch can thiệp',
      consultationFee: 500000,
      isVip: true,
    };

    const res = await apiRequest('PUT', `/admin/update-doctor/${createdDoctorId}`, {
      token: adminToken,
      body: updatePayload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.fullName, 'PGS. TS. Nguyễn Văn A (Đã cập nhật)');
    assert.equal(res.body.data.degree, 'Phó Giáo Sư - Tiến Sĩ');
    assert.equal(res.body.data.experience, '20 năm');
    assert.equal(res.body.data.consultationFee, 500000);
    assert.equal(res.body.data.specialtyName, 'Tim mạch');
  });

  // -------------------------------------------------------------------------
  // 4. Luồng chính: Sửa hồ sơ Lễ tân
  // -------------------------------------------------------------------------
  it('Admin sửa hồ sơ lễ tân: cập nhật tên, số điện thoại, giới tính', async () => {
    const updatePayload = {
      fullName: 'Lê Thị Thu Thảo (Trưởng Lễ Tân)',
      phoneNumber: '0911223344',
      gender: 'Female',
    };

    const res = await apiRequest('PUT', `/receptionists/update/${createdReceptionistId}`, {
      token: adminToken,
      body: updatePayload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.fullName, 'Lê Thị Thu Thảo (Trưởng Lễ Tân)');
    assert.equal(res.body.data.phoneNumber, '0911223344');
  });

  // -------------------------------------------------------------------------
  // 5. Luồng chính: Cập nhật trạng thái enabled / disabled (Khóa & Mở khóa)
  // -------------------------------------------------------------------------
  it('Admin có thể khóa (disable) và kích hoạt lại (enable) bác sĩ', async () => {
    // 1. Khóa bác sĩ qua update payload { isEnabled: false }
    const disableRes = await apiRequest('PUT', `/admin/update-doctor/${createdDoctorId}`, {
      token: adminToken,
      body: { isEnabled: false, reason: 'Nghỉ phép dài hạn' },
    });
    assert.equal(disableRes.status, 200);
    assert.equal(disableRes.body.data.isEnable, false);
    assert.equal(disableRes.body.data.isEnabled, false);

    // 2. Mở khóa lại bằng API activate
    const activateRes = await apiRequest('POST', `/admin/activate/${createdDoctorId}`, {
      token: adminToken,
      body: { reason: 'Quay lại công tác' },
    });
    assert.equal(activateRes.status, 200);
    assert.equal(activateRes.body.data.isEnable, true);
    assert.equal(activateRes.body.data.isEnabled, true);
  });

  // -------------------------------------------------------------------------
  // 6. Ngoại lệ: Thay đổi chuyên khoa KHÔNG làm hỏng lịch cũ
  // -------------------------------------------------------------------------
  it('Thay đổi chuyên khoa bác sĩ: cuộc hẹn cũ vẫn giữ nguyên specialtyId ban đầu', async () => {
    // Tạo 1 bác sĩ mới thuộc chuyên khoa 1 ('Nội tổng quát')
    const docRes = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: {
        fullName: 'BS. Chuyên Khoa Test',
        email: 'doc.spec.test@clinic.com',
        password: 'Doctor@123',
        userType: 'Doctor',
        specialtyId: 1, // Nội tổng quát
        gender: 'Male',
      },
    });
    assert.equal(docRes.status, 201);
    const docId = docRes.body.data.id;
    assert.equal(docRes.body.data.specialtyId, 1);

    // Giả lập 1 cuộc hẹn cũ đã khám thuộc chuyên khoa 1 ('Nội tổng quát')
    const oldAppointment = await Appointment.create({
      appointmentNo: 'TEST_HISTORICAL_001',
      patientId: 2,
      doctorId: docId,
      specialtyId: 1, // 'Nội tổng quát'
      shiftId: 101,
      slotIds: [1],
      appointmentDate: '2026-01-15',
      appointmentTime: '08:00',
      type: 'OFFLINE',
      status: 'COMPLETED',
      patients: [{ fullName: 'Bệnh nhân lịch sử', gender: 'Female' }],
    });

    // Admin chuyển bác sĩ sang chuyên khoa 2 ('Nhi khoa')
    const changeSpecRes = await apiRequest('PUT', `/admin/update-doctor/${docId}`, {
      token: adminToken,
      body: {
        specialtyId: 2, // Đổi sang Nhi khoa
      },
    });
    assert.equal(changeSpecRes.status, 200);
    assert.equal(changeSpecRes.body.data.specialtyId, 2);
    assert.equal(changeSpecRes.body.data.specialtyName, 'Nhi khoa');

    // Kiểm tra cuộc hẹn cũ: specialtyId PHẢI VẪN LÀ 1 (KHÔNG BỊ THAY ĐỔI)
    const checkedApt = await Appointment.findOne({ id: oldAppointment.id }).lean();
    assert.ok(checkedApt);
    assert.equal(
      checkedApt.specialtyId,
      1,
      'Cuộc hẹn cũ phải giữ nguyên specialtyId ban đầu (1 - Nội tổng quát)',
    );
  });

  // -------------------------------------------------------------------------
  // 7. Ngoại lệ: KHÔNG ĐƯỢC XÓA nhân sự đã có lịch sử hoạt động
  // -------------------------------------------------------------------------
  it('Không thể xóa bác sĩ đã có lịch hẹn/ca trực trong hệ thống (phải báo lỗi 409)', async () => {
    // Bác sĩ doc.spec.test@clinic.com ở test trên đã gắn với cuộc hẹn TEST_HISTORICAL_001
    const docWithHistory = await User.findOne({ email: 'doc.spec.test@clinic.com' });
    assert.ok(docWithHistory);

    // Cố gắng xóa bác sĩ
    const deleteRes = await apiRequest('DELETE', `/admin/doctors/${docWithHistory.id}`, {
      token: adminToken,
    });

    assert.equal(
      deleteRes.status,
      409,
      'Bắt buộc trả về 409 Conflict khi cố xóa nhân sự đã có lịch sử',
    );
    assert.match(
      deleteRes.body.message,
      /Không thể xóa nhân sự.*lịch sử hoạt động.*khóa tài khoản/i,
    );

    // Kiểm tra bác sĩ vẫn tồn tại an toàn trong DB
    const stillExists = await User.findOne({ id: docWithHistory.id });
    assert.ok(stillExists, 'Bác sĩ không được bị xóa khỏi cơ sở dữ liệu');
  });

  it('Không thể xóa lễ tân đã từng xác nhận lịch hẹn (phải báo lỗi 409)', async () => {
    // Tạo 1 lễ tân có lịch sử xác nhận
    const recepRes = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: {
        fullName: 'Lễ tân bận rộn',
        email: 'busy.recep@clinic.com',
        password: 'Recep@123',
        userType: 'Receptionist',
      },
    });
    assert.equal(recepRes.status, 201);
    const busyRecepId = recepRes.body.data.id;

    // Gắn lễ tân này vào trường confirmedBy của 1 cuộc hẹn
    await Appointment.create({
      appointmentNo: 'TEST_RECEP_CONFIRMED_01',
      patientId: 2,
      doctorId: createdDoctorId,
      specialtyId: 5,
      shiftId: 102,
      slotIds: [2],
      appointmentDate: '2026-02-10',
      appointmentTime: '09:00',
      type: 'OFFLINE',
      status: 'CONFIRMED',
      confirmedBy: busyRecepId,
      patients: [{ fullName: 'Bệnh nhân được xác nhận' }],
    });

    // Cố gắng xóa lễ tân đã có lịch sử xác nhận
    const deleteRes = await apiRequest('DELETE', `/admin/receptionists/${busyRecepId}`, {
      token: adminToken,
    });

    assert.equal(deleteRes.status, 409);
    assert.match(deleteRes.body.message, /Không thể xóa nhân sự.*đã xác nhận/i);

    const recepStillExists = await User.findOne({ id: busyRecepId });
    assert.ok(recepStillExists);
  });

  // -------------------------------------------------------------------------
  // 8. Nhánh thành công: Có thể xóa nhân sự CHƯA có lịch sử hoạt động
  // -------------------------------------------------------------------------
  it('Có thể xóa an toàn nhân sự mới tạo nhầm chưa từng có lịch sử nào', async () => {
    // Tạo 1 bác sĩ mới tạo nhầm, 0 ca trực, 0 cuộc hẹn
    const tempDoctor = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: {
        fullName: 'Bác Sĩ Nhầm Lẫn',
        email: 'mistake.doc@clinic.com',
        password: 'Doctor@123',
        userType: 'Doctor',
        specialtyId: 1,
      },
    });
    assert.equal(tempDoctor.status, 201);
    const tempDocId = tempDoctor.body.data.id;

    // Xóa bác sĩ này
    const deleteRes = await apiRequest('DELETE', `/admin/doctors/${tempDocId}`, {
      token: adminToken,
    });

    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.body.success, true);

    // Kiểm tra DB: đã được xóa hoàn toàn
    const docCheck = await User.findOne({ id: tempDocId });
    assert.equal(docCheck, null);

    // Kiểm tra AuditLog ghi nhận hành động USER_DELETE
    const audit = await AuditLog.findOne({
      action: AUDIT_ACTIONS.USER_DELETE,
      targetId: tempDocId,
    });
    assert.ok(audit, 'AuditLog phải ghi nhận USER_DELETE');
  });

  // -------------------------------------------------------------------------
  // 9. Điều kiện trước & Phân quyền: Chỉ JWT Admin mới được thực hiện
  // -------------------------------------------------------------------------
  it('Chặn truy cập khi không có token (401) hoặc token không phải Admin (403)', async () => {
    // 1. Không có token
    const unauth = await apiRequest('POST', '/admin/create-user', {
      body: { fullName: 'Hacker', email: 'hacker@clinic.com' },
    });
    assert.equal(unauth.status, 401);

    // 2. Token Patient cố tạo bác sĩ
    const forbidden = await apiRequest('POST', '/admin/create-user', {
      token: patientToken,
      body: { fullName: 'Fake Doctor', email: 'fake@clinic.com' },
    });
    assert.equal(forbidden.status, 403);

    // 3. Token Receptionist cố xóa bác sĩ
    const recepForbidden = await apiRequest('DELETE', `/admin/doctors/${createdDoctorId}`, {
      token: receptionistToken,
    });
    assert.equal(recepForbidden.status, 403);
  });

  // -------------------------------------------------------------------------
  // 10. Ràng buộc dữ liệu & Input validation
  // -------------------------------------------------------------------------
  it('Bắt lỗi phí khám âm (consultationFee < 0) trả về 400', async () => {
    const invalidFee = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: {
        fullName: 'BS. Phí Âm',
        email: 'negative.fee@clinic.com',
        password: 'Doctor@123',
        userType: 'Doctor',
        specialtyId: 1,
        consultationFee: -100000,
      },
    });
    assert.equal(invalidFee.status, 400);
    assert.match(invalidFee.body.message, /consultationFee.*không âm/i);
  });

  it('Bắt lỗi trùng email trả về 409', async () => {
    const dupEmail = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: {
        fullName: 'BS. Trùng Email',
        email: 'doctor.nguyenvana@clinic.com', // Đã tồn tại ở test 1
        password: 'Doctor@123',
        userType: 'Doctor',
        specialtyId: 1,
      },
    });
    assert.equal(dupEmail.status, 409);
    assert.match(dupEmail.body.message, /Email đã tồn tại/i);
  });
});
