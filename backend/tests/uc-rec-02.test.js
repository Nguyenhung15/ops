const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_rec_02_test_secret_key';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_rec_02';

const app = require('../src/app');
const {
  User,
  DoctorShift,
  Appointment,
  Specialty,
} = require('../src/models');
const { ROLES } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock, RealClock } = require('../src/services/clock.service');

let server;
let baseUrl;

let receptionist1;
let receptionist1Token;
let admin1;
let admin1Token;
let doctor1;
let doctor1Token;
let patient1;
let patient1Token;

let specialty1;

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

describe('UC-REC-02: Lễ tân xem lịch vận hành', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    // Ensure model indexes are created
    await Appointment.init();
    await DoctorShift.init();

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api`;
        resolve();
      });
    });

    const hashedPassword = await bcrypt.hash('Password@123', 8);

    // Specialty
    specialty1 = await Specialty.create({
      id: 1,
      name: 'Tim Mạch',
      description: 'Chuyên khoa tim mạch',
    });

    // Users
    receptionist1 = await User.create({
      id: 101,
      email: 'rec1@clinic.com',
      password: hashedPassword,
      fullName: 'Lễ Tân Nguyễn Thị Mai',
      phoneNumber: '0901111222',
      userType: ROLES.RECEPTIONIST,
    });
    receptionist1Token = signAccessToken({
      userId: receptionist1.id,
      email: receptionist1.email,
      userType: receptionist1.userType,
    });

    admin1 = await User.create({
      id: 102,
      email: 'admin1@clinic.com',
      password: hashedPassword,
      fullName: 'Quản Trị Viên Trần Văn An',
      phoneNumber: '0903333444',
      userType: ROLES.ADMIN,
    });
    admin1Token = signAccessToken({
      userId: admin1.id,
      email: admin1.email,
      userType: admin1.userType,
    });

    doctor1 = await User.create({
      id: 103,
      email: 'doctor1@clinic.com',
      password: hashedPassword,
      fullName: 'BS. Lê Minh Trí',
      phoneNumber: '0905555666',
      userType: ROLES.DOCTOR,
      specialtyId: specialty1.id,
    });
    doctor1Token = signAccessToken({
      userId: doctor1.id,
      email: doctor1.email,
      userType: doctor1.userType,
    });

    patient1 = await User.create({
      id: 104,
      email: 'patient1@gmail.com',
      password: hashedPassword,
      fullName: 'Bệnh Nhân Phạm Hoàng Nam',
      phoneNumber: '0912345678',
      userType: ROLES.PATIENT,
    });
    patient1Token = signAccessToken({
      userId: patient1.id,
      email: patient1.email,
      userType: patient1.userType,
    });
  });

  after(async () => {
    setClock(new RealClock());
    if (server) await new Promise((r) => server.close(r));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    setClock(createFakeClock('2026-11-01T08:00:00+07:00'));
    await Appointment.deleteMany({});
    await DoctorShift.deleteMany({});
  });

  it('1. Trả appointments và shifts của ngày đó, sắp xếp theo giờ tăng dần', async () => {
    // Tạo 1 ca làm việc
    await DoctorShift.create({
      id: 1,
      doctorId: doctor1.id,
      date: '2026-11-01',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [
        { id: 1, startTime: '08:00', endTime: '08:30', status: 'BOOKED', slotNumber: 1 },
        { id: 2, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE', slotNumber: 2 },
      ],
    });

    // Tạo 2 lịch hẹn với giờ khác nhau (để kiểm tra sắp xếp giờ tăng dần)
    await Appointment.create({
      id: 10,
      appointmentNo: 'APT-10',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: 1,
      slotIds: [2],
      appointmentDate: '2026-11-01',
      appointmentTime: '10:00',
      type: 'OFFLINE',
      status: 'CONFIRMED',
      reason: 'Khám kiểm tra sức khỏe tổng quát định kỳ',
    });

    await Appointment.create({
      id: 11,
      appointmentNo: 'APT-11',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: 1,
      slotIds: [1],
      appointmentDate: '2026-11-01',
      appointmentTime: '08:00',
      type: 'ONLINE',
      status: 'CHECKED_IN',
      reason: 'Đau tức ngực nhẹ khi vận động nhiều',
    });

    // Gọi endpoint vận hành GET /appointments/schedule?date=2026-11-01
    const res = await apiRequest('GET', '/appointments/schedule?date=2026-11-01', {
      token: receptionist1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.appointments.length, 2);
    assert.equal(data.shifts.length, 1);

    // Kiểm tra sắp xếp theo giờ: 08:00 trước 10:00
    assert.equal(data.appointments[0].appointmentTime, '08:00');
    assert.equal(data.appointments[0].id, 11);
    assert.equal(data.appointments[0].type, 'ONLINE');
    assert.equal(data.appointments[0].status, 'CHECKED_IN');
    assert.equal(data.appointments[0].patientName, 'Bệnh Nhân Phạm Hoàng Nam');
    assert.equal(data.appointments[0].doctorName, 'BS. Lê Minh Trí');

    assert.equal(data.appointments[1].appointmentTime, '10:00');
    assert.equal(data.appointments[1].id, 10);
    assert.equal(data.appointments[1].type, 'OFFLINE');

    // Kiểm tra ca làm việc
    assert.equal(data.shifts[0].id, 1);
    assert.equal(data.shifts[0].startTime, '08:00');
    assert.equal(data.shifts[0].availableSlots, 1);
  });

  it('2. Lọc theo khoảng ngày (startDate, endDate) kết hợp doctorId và status', async () => {
    // Tạo 3 appointment ở các ngày khác nhau
    await Appointment.create({
      id: 21,
      appointmentNo: 'APT-21',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: 1,
      appointmentDate: '2026-11-02',
      appointmentTime: '09:00',
      status: 'CONFIRMED',
      reason: 'Lý do 1',
    });
    await Appointment.create({
      id: 22,
      appointmentNo: 'APT-22',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: 1,
      appointmentDate: '2026-11-05',
      appointmentTime: '14:00',
      status: 'COMPLETED',
      reason: 'Lý do 2',
    });
    await Appointment.create({
      id: 23,
      appointmentNo: 'APT-23',
      patientId: patient1.id,
      doctorId: 999, // Bác sĩ khác
      specialtyId: specialty1.id,
      shiftId: 1,
      appointmentDate: '2026-11-05',
      appointmentTime: '15:00',
      status: 'CONFIRMED',
      reason: 'Lý do 3',
    });

    // Lọc theo khoảng ngày 2026-11-01 đến 2026-11-07, doctorId=doctor1.id, status=CONFIRMED
    const res = await apiRequest(
      'GET',
      `/appointments/schedule?startDate=2026-11-01&endDate=2026-11-07&doctorId=${doctor1.id}&status=CONFIRMED`,
      { token: receptionist1Token },
    );

    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.appointments.length, 1);
    assert.equal(data.appointments[0].id, 21);
    assert.equal(data.appointments[0].status, 'CONFIRMED');
    assert.equal(data.appointments[0].doctorId, doctor1.id);
  });

  it('3. Vượt khoảng ngày tối đa 31 ngày -> 400 DATE_RANGE_EXCEEDED', async () => {
    const res = await apiRequest(
      'GET',
      '/appointments/schedule?startDate=2026-11-01&endDate=2026-12-05', // 35 ngày
      { token: receptionist1Token },
    );

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, 'DATE_RANGE_EXCEEDED');
  });

  it('4. Phân trang: mặc định 20, tối đa 100', async () => {
    // Tạo 25 appointments trong ngày 2026-11-01
    const appts = [];
    for (let i = 1; i <= 25; i++) {
      const min = String(i).padStart(2, '0');
      appts.push({
        id: 100 + i,
        appointmentNo: `APT-100-${i}`,
        patientId: patient1.id,
        doctorId: doctor1.id,
        specialtyId: specialty1.id,
        shiftId: 1,
        appointmentDate: '2026-11-01',
        appointmentTime: `08:${min}`,
        status: 'CONFIRMED',
        reason: `Lịch khám số ${i}`,
      });
    }
    await Appointment.insertMany(appts);

    // Mặc định không truyền page, limit -> limit = 20
    const resDefault = await apiRequest('GET', '/appointments/schedule?date=2026-11-01', {
      token: receptionist1Token,
    });
    assert.equal(resDefault.status, 200);
    assert.equal(resDefault.body.data.appointments.length, 20);
    assert.equal(resDefault.body.data.pagination.page, 1);
    assert.equal(resDefault.body.data.pagination.limit, 20);
    assert.equal(resDefault.body.data.pagination.total, 25);
    assert.equal(resDefault.body.data.pagination.totalPages, 2);

    // Page 2 lấy 5 item còn lại
    const resPage2 = await apiRequest('GET', '/appointments/schedule?date=2026-11-01&page=2&limit=20', {
      token: receptionist1Token,
    });
    assert.equal(resPage2.status, 200);
    assert.equal(resPage2.body.data.appointments.length, 5);

    // Request limit vượt 100 -> ép về 100
    const resMax = await apiRequest('GET', '/appointments/schedule?date=2026-11-01&limit=500', {
      token: receptionist1Token,
    });
    assert.equal(resMax.status, 200);
    assert.equal(resMax.body.data.pagination.limit, 100);
  });

  it('5. Role không hợp lệ (PATIENT, DOCTOR) -> 403 FORBIDDEN_ROLE', async () => {
    const resPatient = await apiRequest('GET', '/appointments/schedule?date=2026-11-01', {
      token: patient1Token,
    });
    assert.equal(resPatient.status, 403);
    assert.equal(resPatient.body.error?.code, 'FORBIDDEN_ROLE');

    const resDoctor = await apiRequest('GET', '/appointments/schedule?date=2026-11-01', {
      token: doctor1Token,
    });
    assert.equal(resDoctor.status, 403);
    assert.equal(resDoctor.body.error?.code, 'FORBIDDEN_ROLE');

    // ADMIN được phép
    const resAdmin = await apiRequest('GET', '/appointments/schedule?date=2026-11-01', {
      token: admin1Token,
    });
    assert.equal(resAdmin.status, 200);
  });

  it('6. Bảo mật PII tối thiểu: không trả đơn thuốc, bệnh sử, passwordHash; lý do rút gọn', async () => {
    const longReason = 'A'.repeat(250); // Chuỗi 250 ký tự
    await Appointment.create({
      id: 301,
      appointmentNo: 'APT-301',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: 1,
      appointmentDate: '2026-11-01',
      appointmentTime: '08:30',
      type: 'OFFLINE',
      status: 'CONFIRMED',
      reason: longReason,
    });

    const res = await apiRequest('GET', '/appointments/schedule?date=2026-11-01', {
      token: receptionist1Token,
    });

    assert.equal(res.status, 200);
    const item = res.body.data.appointments[0];

    // Có các thông tin cho phép
    assert.equal(item.patientName, 'Bệnh Nhân Phạm Hoàng Nam');
    assert.equal(item.appointmentTime, '08:30');
    assert.equal(item.doctorName, 'BS. Lê Minh Trí');
    assert.equal(item.type, 'OFFLINE');
    assert.equal(item.status, 'CONFIRMED');

    // Lý do rút gọn tối đa 100 ký tự kèm dấu ...
    assert.ok(item.reason.length <= 104);
    assert.ok(item.reason.endsWith('...'));

    // Tuyệt đối KHÔNG chứa trường nhạy cảm
    assert.equal(item.password, undefined);
    assert.equal(item.passwordHash, undefined);
    assert.equal(item.prescription, undefined);
    assert.equal(item.prescriptions, undefined);
    assert.equal(item.medicalHistory, undefined);
    assert.equal(item.diagnosis, undefined);
  });

  it('7. Kiểm tra Index bằng explain(), đảm bảo dùng IXSCAN không bị COLLSCAN', async () => {
    // Tạo bản ghi mẫu
    await Appointment.create({
      id: 401,
      appointmentNo: 'APT-401',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: 1,
      appointmentDate: '2026-11-01',
      appointmentTime: '09:00',
      status: 'CONFIRMED',
      reason: 'Index verification',
    });

    // Giải thích truy vấn kết hợp doctorId + appointmentDate + status
    const explainResult = await Appointment.find({
      doctorId: doctor1.id,
      appointmentDate: '2026-11-01',
      status: 'CONFIRMED',
    })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .explain('executionStats');

    const winningPlan =
      explainResult.queryPlanner?.winningPlan ||
      explainResult.executionStats?.executionStages;

    const planString = JSON.stringify(winningPlan);
    // Phải chứa IXSCAN và tên index liên quan đến doctorId/appointmentDate/status
    assert.ok(
      planString.includes('IXSCAN'),
      `Kế hoạch truy vấn phải sử dụng index scan (IXSCAN): ${planString}`,
    );
    assert.ok(
      !planString.includes('"stage":"COLLSCAN"'),
      `Kế hoạch không được chứa toàn bộ collection scan (COLLSCAN)`,
    );
  });

  it('8. Frontend compatibility: GET /appointments/by-date và GET /shifts/by-date', async () => {
    await DoctorShift.create({
      id: 501,
      doctorId: doctor1.id,
      date: '2026-11-01',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
    });

    await Appointment.create({
      id: 502,
      appointmentNo: 'APT-502',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: 501,
      appointmentDate: '2026-11-01',
      appointmentTime: '08:15',
      status: 'CONFIRMED',
      reason: 'Compatibility check',
    });

    // Test GET /appointments/by-date
    const resAppts = await apiRequest('GET', '/appointments/by-date?date=2026-11-01', {
      token: receptionist1Token,
    });
    assert.equal(resAppts.status, 200);
    assert.ok(Array.isArray(resAppts.body));
    assert.equal(resAppts.body.length, 1);
    assert.equal(resAppts.body[0].id, 502);

    // Test GET /shifts/by-date
    const resShifts = await apiRequest('GET', '/shifts/by-date?date=2026-11-01', {
      token: receptionist1Token,
    });
    assert.equal(resShifts.status, 200);
    assert.ok(Array.isArray(resShifts.body));
    assert.equal(resShifts.body.length, 1);
    assert.equal(resShifts.body[0].id, 501);
  });
});
