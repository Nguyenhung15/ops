const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Isolate test database BEFORE loading app & models
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_adm_04_test_secret';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI_ADM04 ||
  'mongodb://127.0.0.1:27017/clinic_booking_test_uc_adm_04';

const app = require('../src/app');
const {
  User,
  Specialty,
  DoctorShift,
  Appointment,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS } = require('../src/constants/enums');

let server;
let baseUrl;
let adminToken;
let doctorToken;
let patientToken;
let receptionistToken;

let testDoctorId;
let disabledDoctorId;
let testSpecialtyId;
let testSpecialtyName;
let createdShiftId;

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

// Compute future date helper (e.g. +7 days, +8 days) in YYYY-MM-DD
function getFutureDate(offsetDays = 7) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('UC-ADM-04: Quản lý ca / lịch tuần (Admin Shift & Weekly Schedule Management)', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    const passwordHash = await bcrypt.hash('Secret@123', 10);

    // 1. Seed Specialty
    const spec = await Specialty.create({
      name: 'Nội tiết & Tiểu đường',
      description: 'Khám và điều trị nội tiết',
      isEnable: true,
    });
    testSpecialtyId = spec.id;
    testSpecialtyName = spec.name;

    // 2. Seed Admin User
    await User.create({
      email: 'admin.shift@clinic.com',
      password: passwordHash,
      fullName: 'Quản trị viên Lịch trực',
      userType: ROLES.ADMIN,
      gender: 'Male',
      isEnable: true,
    });

    // 3. Seed Active Doctor User
    const doctor = await User.create({
      email: 'doctor.shift@clinic.com',
      password: passwordHash,
      fullName: 'BS. Nguyễn Văn A',
      userType: ROLES.DOCTOR,
      specialtyId: testSpecialtyId,
      gender: 'Male',
      isEnable: true,
    });
    testDoctorId = doctor.id;

    // 4. Seed Disabled Doctor User
    const disabledDoc = await User.create({
      email: 'doctor.disabled@clinic.com',
      password: passwordHash,
      fullName: 'BS. Bị Khóa',
      userType: ROLES.DOCTOR,
      specialtyId: testSpecialtyId,
      gender: 'Female',
      isEnable: false,
    });
    disabledDoctorId = disabledDoc.id;

    // 5. Seed Receptionist User
    await User.create({
      email: 'receptionist.shift@clinic.com',
      password: passwordHash,
      fullName: 'Lễ tân Bàn trực',
      userType: ROLES.RECEPTIONIST,
      gender: 'Female',
      isEnable: true,
    });

    // 6. Seed Patient User
    await User.create({
      email: 'patient.shift@clinic.com',
      password: passwordHash,
      fullName: 'Bệnh nhân B',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });

    // 7. Start test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    // 8. Login all personas
    const adminLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'admin.shift@clinic.com', password: 'Secret@123' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.data.token;

    const doctorLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'doctor.shift@clinic.com', password: 'Secret@123' },
    });
    assert.equal(doctorLogin.status, 200);
    doctorToken = doctorLogin.body.data.token;

    const receptionistLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'receptionist.shift@clinic.com', password: 'Secret@123' },
    });
    assert.equal(receptionistLogin.status, 200);
    receptionistToken = receptionistLogin.body.data.token;

    const patientLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'patient.shift@clinic.com', password: 'Secret@123' },
    });
    assert.equal(patientLogin.status, 200);
    patientToken = patientLogin.body.data.token;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  describe('1. Quyền truy cập & Phân quyền (Authorization)', () => {
    it('Bệnh nhân không có quyền xem lịch tuần Admin (GET /shifts/admin/week -> 403)', async () => {
      const res = await apiRequest('GET', '/shifts/admin/week?start=2026-11-01&end=2026-11-07', {
        token: patientToken,
      });
      assert.equal(res.status, 403);
    });

    it('Bệnh nhân không có quyền tạo ca trực (POST /shifts/admin/create -> 403)', async () => {
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: patientToken,
        body: {
          doctorId: testDoctorId,
          date: getFutureDate(10),
          shift: 'MORNING',
        },
      });
      assert.equal(res.status, 403);
    });

    it('Lễ tân không có quyền tạo ca trực admin (POST /shifts/admin/create -> 403)', async () => {
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: receptionistToken,
        body: {
          doctorId: testDoctorId,
          date: getFutureDate(10),
          shift: 'MORNING',
        },
      });
      assert.equal(res.status, 403);
    });
  });

  describe('2. Tạo ca trực (Create Shift Flow & Validation)', () => {
    it('Báo lỗi 400 nếu ngày trực trong quá khứ', async () => {
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          date: '2020-01-01',
          shift: 'MORNING',
          maxPatients: 5,
        },
      });
      assert.equal(res.status, 400);
    });

    it('Báo lỗi 400 nếu bác sĩ bị khóa tài khoản', async () => {
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: disabledDoctorId,
          date: getFutureDate(14),
          shift: 'MORNING',
          maxPatients: 5,
        },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /bị khóa tài khoản/i);
    });

    it('Báo lỗi 400 nếu loại ca trực không hợp lệ (không phải MORNING/AFTERNOON/EVENING)', async () => {
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          date: getFutureDate(14),
          shift: 'MIDNIGHT',
          maxPatients: 5,
        },
      });
      assert.equal(res.status, 400);
    });

    it('Admin tạo ca trực thành công với đầy đủ slot tự động sinh và audit log', async () => {
      const shiftDate = getFutureDate(14);
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          date: shiftDate,
          shift: 'MORNING',
          maxPatients: 4,
          note: 'Ca sáng khám tổng quát',
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.ok(res.body.data);
      assert.equal(res.body.data.doctorId, testDoctorId);
      assert.equal(res.body.data.shift, 'MORNING');
      assert.equal(res.body.data.date, shiftDate);
      assert.equal(res.body.data.maxPatients, 4);
      assert.ok(Array.isArray(res.body.data.slots));
      assert.equal(res.body.data.slots.length, 4);

      createdShiftId = res.body.data.id;

      // Check Audit Log
      const audit = await AuditLog.findOne({
        targetType: 'DoctorShift',
        targetId: createdShiftId,
        action: AUDIT_ACTIONS.SHIFT_CREATE,
      }).lean();
      assert.ok(audit, 'AuditLog must be recorded for SHIFT_CREATE');
      assert.equal(audit.actor.id, 1); // Admin ID
    });

    it('Phát hiện xung đột (Conflict): Báo lỗi 409 nếu bác sĩ đã có ca trực cùng ngày và loại ca', async () => {
      const shiftDate = getFutureDate(14);
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          date: shiftDate,
          shift: 'MORNING',
          maxPatients: 4,
        },
      });

      assert.equal(res.status, 409);
      assert.match(res.body.message, /đã có ca trực/i);
    });

    it('Bác sĩ có thể trực khác ca (AFTERNOON) trong cùng ngày', async () => {
      const shiftDate = getFutureDate(14);
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          date: shiftDate,
          shift: 'AFTERNOON',
          maxPatients: 4,
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.shift, 'AFTERNOON');
    });

    it('Hỗ trợ đăng ký lặp tuần (repeatWeekly) tự động bỏ qua tuần trùng lịch', async () => {
      const shiftDate = getFutureDate(21);
      // Tạo trước 1 ca ở tuần thứ 2 (shiftDate + 7 ngày)
      const futureDate7 = getFutureDate(28);
      await DoctorShift.create({
        doctorId: testDoctorId,
        date: futureDate7,
        shift: 'EVENING',
        startTime: '18:00',
        endTime: '21:00',
        maxPatients: 2,
        slots: [{ id: 99991, slotNumber: 1, startTime: '18:00', endTime: '18:45', status: 'AVAILABLE' }],
      });

      // Tạo lặp 2 tuần: tuần 0 (ngày 21), tuần 1 (ngày 28 - đã có ca nên sẽ bỏ qua), tuần 2 (ngày 35 - tạo mới)
      const res = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          date: shiftDate,
          shift: 'EVENING',
          maxPatients: 3,
          repeatWeekly: true,
          repeatCount: 2,
        },
      });

      assert.equal(res.status, 201);
      // occurrences trả về 2 ca (tuần 0 và tuần 2, tuần 1 bị trùng đã được bỏ qua)
      assert.ok(Array.isArray(res.body.occurrences));
      assert.equal(res.body.occurrences.length, 2);
    });
  });

  describe('3. Xem lịch tuần & Tìm kiếm theo ngày (Weekly & Daily Schedule View)', () => {
    it('Admin xem lịch tuần khớp khoảng ngày và có tên bác sĩ, tên chuyên khoa', async () => {
      const startISO = getFutureDate(12);
      const endISO = getFutureDate(18);

      const res = await apiRequest('GET', `/shifts/admin/week?start=${startISO}&end=${endISO}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length >= 2);

      const found = res.body.data.find((s) => s.id === createdShiftId);
      assert.ok(found);
      assert.equal(found.doctorName, 'BS. Nguyễn Văn A');
      assert.equal(found.specialtyName, testSpecialtyName);
      assert.equal(found.shiftType, 'MORNING');
      assert.equal(found.availableSlots, 4);
      assert.equal(found.bookedSlots, 0);
    });

    it('Lọc theo specialtyId trong lịch tuần', async () => {
      const startISO = getFutureDate(12);
      const endISO = getFutureDate(18);

      const res = await apiRequest(
        'GET',
        `/shifts/admin/week?start=${startISO}&end=${endISO}&specialtyId=${testSpecialtyId}`,
        { token: adminToken },
      );

      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 2);
      assert.ok(res.body.data.every((s) => s.specialtyId === testSpecialtyId));
    });

    it('Admin xem lịch tuần mặc định khi không truyền tham số start và end', async () => {
      const res = await apiRequest('GET', '/shifts/admin/week', {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
    });

    it('Lễ tân và Admin xem danh sách ca trực theo ngày (GET /shifts/by-date)', async () => {
      const shiftDate = getFutureDate(14);
      const res = await apiRequest('GET', `/shifts/by-date?date=${shiftDate}`, {
        token: receptionistToken,
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length >= 2);
      assert.ok(res.body.data[0].doctorName);
      assert.ok(res.body.data[0].specialtyName);
    });

    it('Xem chi tiết ca trực kèm danh sách slot và cuộc hẹn (GET /shifts/admin/:id)', async () => {
      const res = await apiRequest('GET', `/shifts/admin/${createdShiftId}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, createdShiftId);
      assert.ok(Array.isArray(res.body.data.slots));
      assert.ok(Array.isArray(res.body.data.appointments));
      assert.equal(res.body.data.appointments.length, 0);
    });
  });

  describe('4. Điều chỉnh ca trực (Adjust Shift & Capacity Constraints)', () => {
    it('Điều chỉnh ghi chú (note) và tăng số lượng bệnh nhân (maxPatients) thành công', async () => {
      const res = await apiRequest('PUT', `/shifts/admin/${createdShiftId}`, {
        token: adminToken,
        body: {
          note: 'Đã cập nhật: thêm 1 slot',
          maxPatients: 5,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.note, 'Đã cập nhật: thêm 1 slot');
      assert.equal(res.body.data.maxPatients, 5);

      // Verify Audit Log
      const audit = await AuditLog.findOne({
        targetType: 'DoctorShift',
        targetId: createdShiftId,
        action: AUDIT_ACTIONS.SHIFT_UPDATE,
      }).sort({ createdAt: -1 }).lean();
      assert.ok(audit);
      assert.ok(audit.changes.after);
    });

    it('Không cho phép giảm maxPatients xuống dưới số lượng slot đã được bệnh nhân đặt khám (409 Conflict)', async () => {
      // Giả lập 2 cuộc hẹn đã đặt vào 2 slots của ca trực này
      const shift = await DoctorShift.findOne({ id: createdShiftId });
      const slot1 = shift.slots[0];
      const slot2 = shift.slots[1];
      slot1.status = 'BOOKED';
      slot2.status = 'BOOKED';
      await shift.save();

      // Thêm record Appointment tham chiếu
      await Appointment.create({
        patientId: 4, // Patient user
        doctorId: testDoctorId,
        specialtyId: testSpecialtyId,
        shiftId: createdShiftId,
        appointmentDate: shift.date,
        appointmentTime: slot1.startTime,
        slotIds: [slot1.id],
        appointmentNo: 'APPT-TEST-001',
        type: 'OFFLINE',
        status: 'CONFIRMED',
      });

      await Appointment.create({
        patientId: 4,
        doctorId: testDoctorId,
        specialtyId: testSpecialtyId,
        shiftId: createdShiftId,
        appointmentDate: shift.date,
        appointmentTime: slot2.startTime,
        slotIds: [slot2.id],
        appointmentNo: 'APPT-TEST-002',
        type: 'OFFLINE',
        status: 'CONFIRMED',
      });

      // Cố gắng giảm capacity xuống 1 (trong khi đã có 2 slots được đặt)
      const res = await apiRequest('PUT', `/shifts/admin/${createdShiftId}`, {
        token: adminToken,
        body: {
          maxPatients: 1,
        },
      });

      assert.equal(res.status, 409);
      assert.match(res.body.message, /Không thể giảm số lượng bệnh nhân xuống 1/i);
    });

    it('Không cho phép đổi trạng thái sang GROUP_BLOCKED nếu ca đã có lịch hẹn cá nhân (409 Conflict)', async () => {
      const res = await apiRequest('PUT', `/shifts/admin/${createdShiftId}`, {
        token: adminToken,
        body: {
          status: 'GROUP_BLOCKED',
        },
      });

      assert.equal(res.status, 409);
      assert.match(res.body.message, /khám đoàn/i);
    });

    it('Giảm capacity hợp lệ (ví dụ từ 5 xuống 3) bảo toàn toàn bộ slot đã đặt', async () => {
      const res = await apiRequest('PUT', `/shifts/admin/${createdShiftId}`, {
        token: adminToken,
        body: {
          maxPatients: 3,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.maxPatients, 3);

      // Verify DB slots
      const updatedShift = await DoctorShift.findOne({ id: createdShiftId }).lean();
      const bookedSlots = updatedShift.slots.filter((s) => s.status === 'BOOKED');
      assert.equal(bookedSlots.length, 2, 'Cả 2 slots đã đặt phải được bảo toàn nguyên vẹn');
      assert.equal(updatedShift.slots.length, 3);
    });
  });

  describe('5. Xóa ca trực & Ràng buộc toàn vẹn (Delete Shift Constraints)', () => {
    it('Không cho phép xóa ca trực đang có lịch khám của bệnh nhân (409 Conflict)', async () => {
      const res = await apiRequest('DELETE', `/shifts/admin/${createdShiftId}`, {
        token: adminToken,
      });

      assert.equal(res.status, 409);
      assert.match(res.body.message, /Không thể xóa ca trực/i);

      // Verify shift still exists
      const shift = await DoctorShift.findOne({ id: createdShiftId }).lean();
      assert.ok(shift, 'Ca trực không được bị xóa khỏi DB');
    });

    it('Xóa thành công ca trực khi không có cuộc hẹn nào (200 OK & AuditLog)', async () => {
      // Tạo một ca trực mới không có appointment
      const emptyShiftRes = await apiRequest('POST', '/shifts/admin/create', {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          date: getFutureDate(20),
          shift: 'EVENING',
          maxPatients: 2,
        },
      });
      assert.equal(emptyShiftRes.status, 201);
      const emptyShiftId = emptyShiftRes.body.data.id;

      // Thực hiện xóa
      const deleteRes = await apiRequest('DELETE', `/shifts/admin/${emptyShiftId}`, {
        token: adminToken,
      });

      assert.equal(deleteRes.status, 200);
      assert.match(deleteRes.body.message, /thành công/i);

      // Verify shift is deleted
      const found = await DoctorShift.findOne({ id: emptyShiftId }).lean();
      assert.equal(found, null);

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'DoctorShift',
        targetId: emptyShiftId,
        action: AUDIT_ACTIONS.SHIFT_CANCEL,
      }).lean();
      assert.ok(audit, 'Audit log must record deletion');
    });
  });
});
