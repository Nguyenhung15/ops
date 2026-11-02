const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_pat_07_test_jwt_secret_key';
process.env.JOIN_TOKEN_SECRET = 'uc_pat_07_test_join_token_secret_32chars_long';
process.env.ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN = 'true';
process.env.JOIN_EARLY_MINUTES = '15';
process.env.JOIN_LATE_GRACE_MINUTES = '15';

const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_pat_07';

const app = require('../src/app');
const {
  User,
  DoctorShift,
  Appointment,
  PaymentTransaction,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS, APPOINTMENT_STATUSES, PAYMENT_STATUSES } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');
const { onlineConsultationService } = require('../src/services/onlineConsultation.service');
const { configService } = require('../src/config/config.service');

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

let fakeClock;

async function apiRequest(method, path, { token, body, headers: customHeaders } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (customHeaders) Object.assign(headers, customHeaders);

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, body: json };
}

describe('UC-PAT-07: Patient vào khám online (POST /appointments/:id/join-online)', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    fakeClock = createFakeClock(new Date('2026-11-05T08:20:00.000Z')); // 15:20 GMT+7
    setClock(fakeClock);

    const passwordHash = await bcrypt.hash('Secret123!', 6);

    patient1 = await User.create({
      email: 'patient1_pat07@test.local',
      password: passwordHash,
      fullName: 'Patient One',
      userType: ROLES.PATIENT,
      isActive: true,
      phoneNumber: '0901000001',
    });
    patient1Token = signAccessToken({
      userId: patient1.id,
      id: patient1.id,
      role: ROLES.PATIENT,
      email: patient1.email,
    });

    patient2 = await User.create({
      email: 'patient2_pat07@test.local',
      password: passwordHash,
      fullName: 'Patient Two',
      userType: ROLES.PATIENT,
      isActive: true,
      phoneNumber: '0901000002',
    });
    patient2Token = signAccessToken({
      userId: patient2.id,
      id: patient2.id,
      role: ROLES.PATIENT,
      email: patient2.email,
    });

    doctor1 = await User.create({
      email: 'doctor1_pat07@test.local',
      password: passwordHash,
      fullName: 'Doctor One',
      userType: ROLES.DOCTOR,
      isActive: true,
      phoneNumber: '0901000003',
      consultationFee: 300000,
    });
    doctor1Token = signAccessToken({
      userId: doctor1.id,
      id: doctor1.id,
      role: ROLES.DOCTOR,
      email: doctor1.email,
    });

    receptionist1 = await User.create({
      email: 'receptionist1_pat07@test.local',
      password: passwordHash,
      fullName: 'Receptionist One',
      userType: ROLES.RECEPTIONIST,
      isActive: true,
      phoneNumber: '0901000004',
    });
    receptionist1Token = signAccessToken({
      userId: receptionist1.id,
      id: receptionist1.id,
      role: ROLES.RECEPTIONIST,
      email: receptionist1.email,
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
    setClock(null);
  });

  beforeEach(async () => {
    await Appointment.deleteMany({});
    await DoctorShift.deleteMany({});
    await PaymentTransaction.deleteMany({});
    await AuditLog.deleteMany({});
    patient1Token = signAccessToken(patient1);
    patient2Token = signAccessToken(patient2);
    doctor1Token = signAccessToken(doctor1);
    receptionist1Token = signAccessToken(receptionist1);
    fakeClock.setNow(new Date('2026-11-05T01:50:00.000Z')); // 08:50 GMT+7
    process.env.ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN = 'true';
    process.env.JOIN_TOKEN_SECRET = 'uc_pat_07_test_join_token_secret_32chars_long';
  });

  it('1. Đúng chủ sở hữu + ONLINE + CONFIRMED + đã thanh toán + đúng khung giờ -> Trả meetingUrl và joinToken hợp lệ', async () => {
    // Ca khám lúc 09:00 - 09:45 ngày 2026-11-05 (GMT+7) => 02:00 - 02:45 UTC
    // fakeClock đặt lúc 08:50 GMT+7 (01:50 UTC) -> trước ca 10 phút, nằm trong window [08:45, 10:00]
    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slotDurationMinutes: 45,
      slots: [
        {
          id: 1,
          slotNumber: 1,
          startTime: '09:00',
          endTime: '09:45',
          status: 'BOOKED',
          bookingRef: 'ONL70001',
        },
      ],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70001',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [1],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN70001',
      amount: 300000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data.meetingUrl);
    assert.ok(res.body.data.joinToken);
    assert.ok(res.body.data.meetingCode);
    assert.equal(res.body.data.appointmentId, appt.id);

    // Xác thực joinToken bằng JOIN_TOKEN_SECRET (chứ không phải JWT_SECRET)
    const decoded = jwt.verify(res.body.data.joinToken, process.env.JOIN_TOKEN_SECRET);
    assert.equal(decoded.appointmentId, appt.id);
    assert.equal(decoded.userId, patient1.id);
    assert.equal(decoded.role, ROLES.PATIENT);

    // Ghi audit log JOIN_ONLINE không rò rỉ token
    const audit = await AuditLog.findOne({ action: AUDIT_ACTIONS.JOIN_ONLINE });
    assert.ok(audit);
    assert.equal(audit.actorId, patient1.id);
  });

  it('2. Lịch người khác hoặc không tồn tại -> Đều trả về 404 (chống enumeration)', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL70002',
      patientId: patient2.id, // Thuộc patient 2
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [2],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    // Patient 1 gọi lịch của patient 2 -> 404
    const resForbiddenAppt = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(resForbiddenAppt.status, 404);

    // Lịch không tồn tại -> 404
    const resNotFound = await apiRequest('POST', `/api/appointments/999999/join-online`, {
      token: patient1Token,
    });
    assert.equal(resNotFound.status, 404);
  });

  it('3. Lịch OFFLINE -> 409 NOT_ONLINE_APPOINTMENT', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'OFF70003',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [3],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'OFFLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'NOT_ONLINE_APPOINTMENT');
  });

  it('4. Trạng thái không hợp lệ (PENDING_PAYMENT, CANCELLED, COMPLETED) -> 409', async () => {
    // 4a. PENDING_PAYMENT trả về 409 PAYMENT_REQUIRED
    const pendingPaymentAppt = await Appointment.create({
      appointmentNo: 'ONL70004_PENDING_PAYMENT',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [4],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });
    const resPendingPayment = await apiRequest('POST', `/api/appointments/${pendingPaymentAppt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(resPendingPayment.status, 409);
    assert.equal(resPendingPayment.body.error?.code, 'PAYMENT_REQUIRED');

    // 4b. Các trạng thái khác trả về INVALID_APPOINTMENT_STATUS
    const invalidStatuses = [
      APPOINTMENT_STATUSES.PENDING_CONFIRMATION,
      APPOINTMENT_STATUSES.CANCELLED,
      APPOINTMENT_STATUSES.COMPLETED,
      APPOINTMENT_STATUSES.EXPIRED,
      APPOINTMENT_STATUSES.NO_SHOW,
    ];

    for (const st of invalidStatuses) {
      const appt = await Appointment.create({
        appointmentNo: `ONL70004_${st}`,
        patientId: patient1.id,
        doctorId: doctor1.id,
        specialtyId: 1,
        shiftId: 1,
        slotIds: [4],
        appointmentDate: '2026-11-05',
        appointmentTime: '09:00',
        type: 'ONLINE',
        status: st,
      });

      const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
        token: patient1Token,
      });
      assert.equal(res.status, 409, `Expected 409 for status ${st}`);
      assert.equal(res.body.error?.code, 'INVALID_APPOINTMENT_STATUS');
    }
  });

  it('5. Cho phép vào lại khi lịch ở trạng thái CHECKED_IN hoặc IN_PROGRESS', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slotDurationMinutes: 45,
      slots: [{ id: 5, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    for (const inProgressStatus of [APPOINTMENT_STATUSES.CHECKED_IN, APPOINTMENT_STATUSES.IN_PROGRESS]) {
      const appt = await Appointment.create({
        appointmentNo: `ONL70005_${inProgressStatus}`,
        patientId: patient1.id,
        doctorId: doctor1.id,
        specialtyId: 1,
        shiftId: shift.id,
        slotIds: [5],
        appointmentDate: '2026-11-05',
        appointmentTime: '09:00',
        type: 'ONLINE',
        status: inProgressStatus,
      });

      await PaymentTransaction.create({
        appointmentId: appt.id,
        userId: patient1.id,
        transactionNo: `TXN70005_${inProgressStatus}`,
        amount: 300000,
        status: PAYMENT_STATUSES.SUCCESS,
      });

      const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
        token: patient1Token,
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.data.joinToken);
    }
  });

  it('6. Cờ ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN bật: Chưa thanh toán -> 409 PAYMENT_REQUIRED', async () => {
    process.env.ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN = 'true';

    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 6, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70006',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [6],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      paymentStatus: 'PENDING',
    });

    // Không tạo PaymentTransaction SUCCESS
    const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'PAYMENT_REQUIRED');
  });

  it('7. Cờ ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN tắt: Cho phép vào mà không cần giao dịch thanh toán', async () => {
    process.env.ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN = 'false';

    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 7, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70007',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [7],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.joinToken);
  });

  it('8. Kiểm tra khung giờ: Sớm hơn slotStart - 15 phút -> 409 JOIN_TOO_EARLY kèm availableFrom', async () => {
    // Slot 09:00 - 09:45 GMT+7 => window mở từ 08:45 GMT+7 (01:45 UTC)
    // Đặt fakeClock lúc 08:30 GMT+7 (01:30 UTC) -> Quá sớm 15 phút
    fakeClock.setNow(new Date('2026-11-05T01:30:00.000Z'));

    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 8, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70008',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [8],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN70008',
      amount: 300000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'JOIN_TOO_EARLY');
    assert.ok(
      res.body.error?.details?.[0]?.availableFrom ||
      res.body.details?.availableFrom ||
      res.body.availableFrom,
    );
  });

  it('9. Kiểm tra khung giờ: Muộn hơn slotEnd + 15 phút -> 409 JOIN_WINDOW_CLOSED', async () => {
    // Slot 09:00 - 09:45 GMT+7 => window đóng lúc 10:00 GMT+7 (03:00 UTC)
    // Đặt fakeClock lúc 10:01 GMT+7 (03:01 UTC) -> Quá muộn
    fakeClock.setNow(new Date('2026-11-05T03:01:00.000Z'));

    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 9, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70009',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [9],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN70009',
      amount: 300000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'JOIN_WINDOW_CLOSED');
  });

  it('10. Biên hai đầu: Đúng 08:45 (đầu biên) và đúng 10:00 (cuối biên) đều được phép tham gia', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 10, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70010',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [10],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN70010',
      amount: 300000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    // 1. Đúng 08:45 GMT+7 (01:45 UTC)
    fakeClock.setNow(new Date('2026-11-05T01:45:00.000Z'));
    const resStart = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(resStart.status, 200);

    // 2. Đúng 10:00 GMT+7 (03:00 UTC)
    fakeClock.setNow(new Date('2026-11-05T03:00:00.000Z'));
    const resEnd = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(resEnd.status, 200);
  });

  it('11. Meeting code ổn định & Xử lý song song: 2 request đồng thời nhận cùng một meetingCode', async () => {
    fakeClock.setNow(new Date('2026-11-05T02:00:00.000Z')); // 09:00 GMT+7

    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 11, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70011',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [11],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN70011',
      amount: 300000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    // Gọi song song 2 request
    const [resA, resB] = await Promise.all([
      apiRequest('POST', `/api/appointments/${appt.id}/join-online`, { token: patient1Token }),
      apiRequest('POST', `/api/appointments/${appt.id}/join-online`, { token: patient1Token }),
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(resA.body.data.meetingCode, resB.body.data.meetingCode);
    assert.equal(resA.body.data.meetingUrl, resB.body.data.meetingUrl);
  });

  it('12. Phân quyền: Doctor hoặc Receptionist gọi endpoint bị 403', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 12, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70012',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [12],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    const resDoctor = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: doctor1Token,
    });
    assert.equal(resDoctor.status, 403);

    const resReceptionist = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: receptionist1Token,
    });
    assert.equal(resReceptionist.status, 403);
  });

  it('13. Thiếu cấu hình JOIN_TOKEN_SECRET -> Trả về lỗi cấu hình máy chủ 500 rõ ràng', async () => {
    delete process.env.JOIN_TOKEN_SECRET;

    fakeClock.setNow(new Date('2026-11-05T02:00:00.000Z'));

    const shift = await DoctorShift.create({
      doctorId: doctor1.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      slots: [{ id: 13, slotNumber: 1, startTime: '09:00', endTime: '09:45', status: 'BOOKED' }],
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL70013',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: shift.id,
      slotIds: [13],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN70013',
      amount: 300000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    const res = await apiRequest('POST', `/api/appointments/${appt.id}/join-online`, {
      token: patient1Token,
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.error?.code, 'MISSING_JOIN_TOKEN_SECRET');
  });
});
