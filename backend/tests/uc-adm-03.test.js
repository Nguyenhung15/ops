const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Isolate test database BEFORE loading app & models
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_adm_03_test_secret';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI_ADM03 ||
  'mongodb://127.0.0.1:27017/clinic_booking_test_uc_adm_03';

const app = require('../src/app');
const {
  User,
  Specialty,
  Image,
  Appointment,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS } = require('../constants/enums');

let server;
let baseUrl;
let adminToken;
let patientToken;

async function apiRequest(method, path, { token, body, isFormData = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let requestBody;
  if (isFormData) {
    // Let fetch calculate Content-Type with multipart boundary
    requestBody = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: requestBody,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

describe('UC-ADM-03: Quản lý specialty và ảnh (Admin Specialty & Image Management)', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    // 1. Seed Initial Admin & Patient
    const passwordHash = await bcrypt.hash('Admin@123', 10);
    await User.create({
      email: 'admin.spec@clinic.com',
      password: passwordHash,
      fullName: 'Specialty Admin',
      userType: ROLES.ADMIN,
      gender: 'Male',
      isEnable: true,
    });

    await User.create({
      email: 'patient.spec@clinic.com',
      password: passwordHash,
      fullName: 'Patient Viewer',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });

    // 2. Start ephemeral test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    // 3. Login
    const adminLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'admin.spec@clinic.com', password: 'Admin@123' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.data.token;

    const patientLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'patient.spec@clinic.com', password: 'Admin@123' },
    });
    assert.equal(patientLogin.status, 200);
    patientToken = patientLogin.body.data.token;
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

  let createdSpecId;
  let targetMigrationSpecId;
  let testDoctorId;

  // -------------------------------------------------------------------------
  // 1. Luồng chính: Tạo và sửa Specialty
  // -------------------------------------------------------------------------
  it('Admin tạo chuyên khoa mới hợp lệ', async () => {
    const res = await apiRequest('POST', '/specialties/create', {
      token: adminToken,
      body: {
        name: 'Tai Mũi Họng',
        description: 'Chẩn đoán và điều trị bệnh lý tai mũi họng',
        isEnabled: true,
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(typeof res.body.data.id === 'number');
    assert.equal(res.body.data.name, 'Tai Mũi Họng');
    assert.equal(res.body.data.isEnable, true);
    assert.equal(res.body.data.isEnabled, true);

    createdSpecId = res.body.data.id;
  });

  it('Admin sửa thông tin chuyên khoa', async () => {
    const res = await apiRequest('PUT', `/specialties/update/${createdSpecId}`, {
      token: adminToken,
      body: {
        name: 'Tai Mũi Họng (Cập nhật)',
        description: 'Điều trị chuyên sâu tai mũi họng và thanh quản',
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Tai Mũi Họng (Cập nhật)');
    assert.equal(res.body.data.description, 'Điều trị chuyên sâu tai mũi họng và thanh quản');
  });

  it('Lấy danh sách chuyên khoa (Public) và chi tiết theo ID', async () => {
    const listRes = await apiRequest('GET', '/specialties/all');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.data));
    assert.ok(listRes.body.data.some((s) => s.id === createdSpecId));

    const detailRes = await apiRequest('GET', `/specialties/${createdSpecId}`);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.data.id, createdSpecId);
  });

  // -------------------------------------------------------------------------
  // 2. Vô hiệu hóa (Disable) & Kích hoạt lại (Enable) Specialty
  // -------------------------------------------------------------------------
  it('Admin vô hiệu hóa (disable) và kích hoạt lại (enable) chuyên khoa', async () => {
    // 1. Disable
    const disableRes = await apiRequest('PATCH', `/specialties/${createdSpecId}/status`, {
      token: adminToken,
      body: { isEnable: false },
    });
    assert.equal(disableRes.status, 200);
    assert.equal(disableRes.body.data.isEnable, false);
    assert.equal(disableRes.body.data.isEnabled, false);

    // 2. Enable lại
    const enableRes = await apiRequest('PATCH', `/specialties/${createdSpecId}/status`, {
      token: adminToken,
      body: { isEnable: true },
    });
    assert.equal(enableRes.status, 200);
    assert.equal(enableRes.body.data.isEnable, true);
    assert.equal(enableRes.body.data.isEnabled, true);
  });

  // -------------------------------------------------------------------------
  // 3. Gắn bác sĩ vào Specialty
  // -------------------------------------------------------------------------
  it('Admin gắn bác sĩ vào chuyên khoa', async () => {
    // Tạo 1 bác sĩ thử nghiệm
    const docRes = await apiRequest('POST', '/admin/create-user', {
      token: adminToken,
      body: {
        fullName: 'BS. Lê Quang Định',
        email: 'lequangdinh@clinic.com',
        password: 'Doctor@123',
        userType: 'Doctor',
        specialtyId: createdSpecId,
        gender: 'Male',
      },
    });
    assert.equal(docRes.status, 201);
    testDoctorId = docRes.body.data.id;

    // Gắn thêm qua endpoint /specialties/:id/doctors
    const assignRes = await apiRequest('POST', `/specialties/${createdSpecId}/doctors`, {
      token: adminToken,
      body: { doctorIds: [testDoctorId] },
    });
    assert.equal(assignRes.status, 200);
    assert.ok(assignRes.body.data.assignedDoctorIds.includes(testDoctorId));
  });

  // -------------------------------------------------------------------------
  // 4. Ngoại lệ: Không xóa specialty đang được reference nếu không migration
  // -------------------------------------------------------------------------
  it('Không thể xóa chuyên khoa đang có bác sĩ nếu không có migration (409 Conflict)', async () => {
    // Chuyên khoa createdSpecId đang có bác sĩ testDoctorId
    const deleteRes = await apiRequest('DELETE', `/specialties/${createdSpecId}`, {
      token: adminToken,
    });

    assert.equal(
      deleteRes.status,
      409,
      'Phải trả về 409 Conflict khi cố xóa chuyên khoa đang được tham chiếu',
    );
    assert.match(
      deleteRes.body.message,
      /Không thể xóa chuyên khoa.*đang được tham chiếu.*migration/i,
    );

    // Kiểm tra chuyên khoa vẫn còn nguyên trong DB
    const specInDb = await Specialty.findOne({ id: createdSpecId });
    assert.ok(specInDb);
  });

  // -------------------------------------------------------------------------
  // 5. Luồng di chuyển (Migration) khi xóa Specialty
  // -------------------------------------------------------------------------
  it('Xóa chuyên khoa thành công khi cung cấp migrateToSpecialtyId hợp lệ', async () => {
    // Tạo 1 chuyên khoa đích để tiếp nhận migration
    const targetRes = await apiRequest('POST', '/specialties/create', {
      token: adminToken,
      body: {
        name: 'Đa khoa tổng hợp',
        description: 'Khoa tiếp nhận bệnh nhân tổng quát',
      },
    });
    assert.equal(targetRes.status, 201);
    targetMigrationSpecId = targetRes.body.data.id;

    // Tiến hành xóa createdSpecId kèm migration sang targetMigrationSpecId
    const migrateDeleteRes = await apiRequest('DELETE', `/specialties/${createdSpecId}`, {
      token: adminToken,
      body: {
        migrateToSpecialtyId: targetMigrationSpecId,
      },
    });

    assert.equal(migrateDeleteRes.status, 200);
    assert.equal(migrateDeleteRes.body.success, true);
    assert.equal(migrateDeleteRes.body.data.migratedTo, targetMigrationSpecId);

    // Xác minh bác sĩ testDoctorId đã được tự động di chuyển sang chuyên khoa mới
    const docAfterMigration = await User.findOne({ id: testDoctorId });
    assert.equal(docAfterMigration.specialtyId, targetMigrationSpecId);

    // Xác minh chuyên khoa cũ đã bị xóa khỏi DB
    const oldSpec = await Specialty.findOne({ id: createdSpecId });
    assert.equal(oldSpec, null);
  });

  // -------------------------------------------------------------------------
  // 6. Xóa chuyên khoa không có liên kết tham chiếu
  // -------------------------------------------------------------------------
  it('Có thể xóa chuyên khoa độc lập không có bác sĩ hay lịch hẹn nào', async () => {
    // Tạo chuyên khoa độc lập
    const unusedRes = await apiRequest('POST', '/specialties/create', {
      token: adminToken,
      body: { name: 'Chuyên khoa tạm thời', description: 'Tạm' },
    });
    assert.equal(unusedRes.status, 201);
    const unusedId = unusedRes.body.data.id;

    // Xóa không cần migration
    const delRes = await apiRequest('DELETE', `/specialties/${unusedId}`, {
      token: adminToken,
    });
    assert.equal(delRes.status, 200);

    const check = await Specialty.findOne({ id: unusedId });
    assert.equal(check, null);
  });

  // -------------------------------------------------------------------------
  // 7. Validation dữ liệu Specialty
  // -------------------------------------------------------------------------
  it('Bắt lỗi tên chuyên khoa trống hoặc trùng lặp', async () => {
    // 1. Tên rỗng
    const emptyName = await apiRequest('POST', '/specialties/create', {
      token: adminToken,
      body: { name: '   ', description: 'Trống' },
    });
    assert.equal(emptyName.status, 400);

    // 2. Trùng tên
    const dupName = await apiRequest('POST', '/specialties/create', {
      token: adminToken,
      body: { name: 'Đa khoa tổng hợp', description: 'Trùng' },
    });
    assert.equal(dupName.status, 409);
  });

  // -------------------------------------------------------------------------
  // 8. Quản lý Ảnh Bác sĩ: Upload, Thay thế, Xóa ảnh
  // -------------------------------------------------------------------------
  it('Admin upload, cập nhật và xóa ảnh bác sĩ hợp lệ', async () => {
    // 1. Upload ảnh bác sĩ (file hợp lệ)
    const formData = new FormData();
    const fakeImageBuffer = Buffer.from('fake-jpeg-image-content-data');
    formData.append('file', new Blob([fakeImageBuffer], { type: 'image/jpeg' }), 'avatar.jpg');

    const uploadRes = await apiRequest('POST', `/images/doctor/${testDoctorId}`, {
      token: adminToken,
      body: formData,
      isFormData: true,
    });

    assert.equal(uploadRes.status, 201);
    assert.ok(uploadRes.body.imageUrl.startsWith('/uploads/doctors/'));
    assert.equal(uploadRes.body.doctorId, testDoctorId);

    // Kiểm tra doctor.avatarUrl đã được đồng bộ trong DB
    const doctorInDb = await User.findOne({ id: testDoctorId });
    assert.equal(doctorInDb.avatarUrl, uploadRes.body.imageUrl);

    // 2. Lấy thông tin ảnh bác sĩ (Public GET)
    const getRes = await apiRequest('GET', `/images/doctor/${testDoctorId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.imageUrl, uploadRes.body.imageUrl);

    // 3. Thay thế (cập nhật) ảnh bác sĩ (PUT)
    const newFormData = new FormData();
    newFormData.append('file', new Blob([Buffer.from('new-image-content')], { type: 'image/png' }), 'new.png');

    const updateRes = await apiRequest('PUT', `/images/doctor/${testDoctorId}`, {
      token: adminToken,
      body: newFormData,
      isFormData: true,
    });

    assert.equal(updateRes.status, 200);
    assert.ok(updateRes.body.imageUrl.startsWith('/uploads/doctors/'));

    // 4. Xóa ảnh bác sĩ (DELETE)
    const deleteRes = await apiRequest('DELETE', `/images/doctor/${testDoctorId}`, {
      token: adminToken,
    });
    assert.equal(deleteRes.status, 200);

    // Kiểm tra DB: avatarUrl đã về null
    const docAfterDel = await User.findOne({ id: testDoctorId });
    assert.equal(docAfterDel.avatarUrl, null);

    // Gọi lại GET -> 404 Not Found
    const afterGet = await apiRequest('GET', `/images/doctor/${testDoctorId}`);
    assert.equal(afterGet.status, 404);
  });

  // -------------------------------------------------------------------------
  // 9. Quản lý Ảnh Chuyên khoa
  // -------------------------------------------------------------------------
  it('Admin upload và xóa ảnh chuyên khoa hợp lệ', async () => {
    const formData = new FormData();
    formData.append('file', new Blob([Buffer.from('specialty-image-data')], { type: 'image/png' }), 'spec.png');

    const uploadRes = await apiRequest('POST', `/images/specialty/${targetMigrationSpecId}`, {
      token: adminToken,
      body: formData,
      isFormData: true,
    });

    assert.equal(uploadRes.status, 201);
    assert.ok(uploadRes.body.imageUrl.startsWith('/uploads/specialties/'));

    // Kiểm tra chuyên khoa có imageUrl
    const specInDb = await Specialty.findOne({ id: targetMigrationSpecId });
    assert.equal(specInDb.imageUrl, uploadRes.body.imageUrl);

    // Xóa ảnh chuyên khoa
    const delRes = await apiRequest('DELETE', `/images/specialty/${targetMigrationSpecId}`, {
      token: adminToken,
    });
    assert.equal(delRes.status, 200);

    const specAfterDel = await Specialty.findOne({ id: targetMigrationSpecId });
    assert.equal(specAfterDel.imageUrl, null);
  });

  // -------------------------------------------------------------------------
  // 10. Ngoại lệ Validate File: MIME & Kích thước file
  // -------------------------------------------------------------------------
  it('Bắt lỗi khi upload file không đúng định dạng ảnh (MIME validate) -> 400', async () => {
    const invalidForm = new FormData();
    invalidForm.append('file', new Blob(['text-content'], { type: 'text/plain' }), 'document.txt');

    const res = await apiRequest('POST', `/images/doctor/${testDoctorId}`, {
      token: adminToken,
      body: invalidForm,
      isFormData: true,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /file ảnh định dạng/i);
  });

  it('Bắt lỗi khi upload file ảnh rỗng (0 bytes) -> 400', async () => {
    const emptyForm = new FormData();
    emptyForm.append('file', new Blob([], { type: 'image/jpeg' }), 'empty.jpg');

    const res = await apiRequest('POST', `/images/doctor/${testDoctorId}`, {
      token: adminToken,
      body: emptyForm,
      isFormData: true,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /không được rỗng/i);
  });

  // -------------------------------------------------------------------------
  // 11. Phân quyền: Chỉ Admin mới có quyền quản trị specialty và ảnh
  // -------------------------------------------------------------------------
  it('Chặn người dùng không có quyền quản lý chuyên khoa hoặc upload ảnh', async () => {
    // 1. Khách vãng lai cố tạo chuyên khoa
    const unauth = await apiRequest('POST', '/specialties/create', {
      body: { name: 'Chuyên khoa lậu' },
    });
    assert.equal(unauth.status, 401);

    // 2. Bệnh nhân cố xóa chuyên khoa
    const patientForbidden = await apiRequest('DELETE', `/specialties/${targetMigrationSpecId}`, {
      token: patientToken,
    });
    assert.equal(patientForbidden.status, 403);
  });
});
