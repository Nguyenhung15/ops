const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'fix_1_test_jwt_secret_key_12345';
process.env.JOIN_TOKEN_SECRET = 'fix_1_test_join_token_secret_32chars_long';
process.env.VNP_TMN_CODE = 'TEST_TMN_CODE';
process.env.VNP_HASH_SECRET = 'TEST_HASH_SECRET_1234567890';
process.env.ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN = 'true';
process.env.PAYMENT_APPOINTMENT_HOLD_MINUTES = '30';
process.env.PAYMENT_PENDING_TTL_MINUTES = '15';

const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_fix_1';

const app = require('../src/app');
const {
  User,
  Specialty,
  DoctorShift,
  Appointment,
  PaymentTransaction,
  Voucher,
  UserVoucher,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS, APPOINTMENT_STATUSES, PAYMENT_STATUSES } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');
const voucherRedemptionService = require('../src/services/voucherRedemption.service');
const paymentMaintenanceJob = require('../src/jobs/paymentMaintenance.job');

let server;
let baseUrl;

let patient1;
let patient1Token;
let patient2;
let doctorWithFee;
let doctorZeroFee;
let receptionist;
let receptionistToken;
let specialty1;

let fakeClock;

function generateVNPaySignature(params, secret = process.env.VNP_HASH_SECRET) {
  const filtered = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType' && v !== undefined && v !== null && String(v).trim() !== '') {
      filtered[k] = v;
    }
  }
  const sortedKeys = Object.keys(filtered).sort();
  const signParts = [];
  for (const k of sortedKeys) {
    signParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(filtered[k]))}`);
  }
  const signData = signParts.join('&');
  return crypto.createHmac('sha512', secret).update(Buffer.from(signData, 'utf-8')).digest('hex');
}

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

describe('FIX-1: Payment flow overhaul & reconciliation tests', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    // 01:00 UTC = 08:00 GMT+7 (Asia/Ho_Chi_Minh)
    fakeClock = createFakeClock(new Date('2026-11-05T01:00:00.000Z'));
    setClock(fakeClock);

    const passwordHash = await bcrypt.hash('Secret123!', 6);

    specialty1 = await Specialty.create({
      id: 1,
      name: 'Tim mạch',
      description: 'Chuyên khoa tim mạch',
    });

    doctorWithFee = await User.create({
      email: 'doctor_fee@fix1.test',
      password: passwordHash,
      fullName: 'BS Nguyễn Phí',
      userType: ROLES.DOCTOR,
      specialtyId: specialty1.id,
      consultationFee: 300000,
      isActive: true,
      isEnable: true,
    });

    doctorZeroFee = await User.create({
      email: 'doctor_zero@fix1.test',
      password: passwordHash,
      fullName: 'BS Miễn Phí',
      userType: ROLES.DOCTOR,
      specialtyId: specialty1.id,
      consultationFee: 0,
      isActive: true,
      isEnable: true,
    });

    patient1 = await User.create({
      email: 'patient1@fix1.test',
      password: passwordHash,
      fullName: 'Patient Fix One',
      userType: ROLES.PATIENT,
      isActive: true,
      isEnable: true,
    });
    patient1Token = signAccessToken({
      userId: patient1.id,
      id: patient1.id,
      role: ROLES.PATIENT,
      email: patient1.email,
    });

    patient2 = await User.create({
      email: 'patient2@fix1.test',
      password: passwordHash,
      fullName: 'Patient Fix Two',
      userType: ROLES.PATIENT,
      isActive: true,
      isEnable: true,
    });

    receptionist = await User.create({
      email: 'rec@fix1.test',
      password: passwordHash,
      fullName: 'Receptionist Fix',
      userType: ROLES.RECEPTIONIST,
      isActive: true,
      isEnable: true,
    });
    receptionistToken = signAccessToken({
      userId: receptionist.id,
      id: receptionist.id,
      role: ROLES.RECEPTIONIST,
      email: receptionist.email,
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
    await Voucher.deleteMany({});
    await UserVoucher.deleteMany({});
    await AuditLog.deleteMany({});
    // 01:00 UTC = 08:00 GMT+7
    fakeClock.setNow(new Date('2026-11-05T01:00:00.000Z'));
  });

  it('1. Đặt lịch ONLINE có phí -> PENDING_PAYMENT, requiresPayment = true, paymentDueAt, slot BOOKED', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '11:30',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 101, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const res = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Nguyen A', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham tim' }],
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.status, APPOINTMENT_STATUSES.PENDING_PAYMENT);
    assert.equal(data.paymentStatus, 'PENDING');
    assert.equal(data.requiresPayment, true);
    assert.ok(data.paymentDueAt);

    // Slot phải ở trạng thái BOOKED với bookingRef
    const updatedShift = await DoctorShift.findOne({ id: shift.id });
    const slot = updatedShift.slots.find((s) => s.id === 101);
    assert.equal(slot.status, 'BOOKED');
    assert.equal(slot.bookingRef, data.appointmentNo);
  });

  it('2. Đặt lịch ONLINE phí 0 -> PENDING_CONFIRMATION, requiresPayment = false', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorZeroFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '11:30',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 102, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const res = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorZeroFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Nguyen Free', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham mien phi' }],
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, APPOINTMENT_STATUSES.PENDING_CONFIRMATION);
    assert.equal(res.body.data.requiresPayment, false);
  });

  it('3. Đặt lịch OFFLINE -> PENDING_CONFIRMATION', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '11:30',
      type: 'OFFLINE',
      status: 'ACTIVE',
      slots: [
        { id: 103, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const res = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'OFFLINE' },
        patients: [{ fullName: 'Nguyen Offline', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham offline' }],
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, APPOINTMENT_STATUSES.PENDING_CONFIRMATION);
    assert.equal(res.body.data.requiresPayment, false);
  });

  it('4. Luồng đầy đủ: Đặt -> Tạo thanh toán -> IPN hợp lệ -> CONFIRMED -> join-online thành công', async () => {
    // 4.1 Đặt lịch
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 104, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Flow Test', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham online' }],
      },
    });
    assert.equal(createRes.status, 201);
    const apptId = createRes.body.data.id;
    const apptNo = createRes.body.data.appointmentNo;

    // 4.2 Tạo thanh toán VNPay
    const payRes = await apiRequest('POST', '/payment/create', {
      token: patient1Token,
      body: { appointmentId: apptId },
    });
    assert.equal(payRes.status, 200);
    assert.ok(payRes.body.data.paymentUrl);
    const transactionNo = payRes.body.data.transactionNo;

    // 4.3 Giả lập VNPay IPN gọi về thành công
    const ipnParams = {
      vnp_TmnCode: process.env.VNP_TMN_CODE,
      vnp_Amount: String(300000 * 100),
      vnp_BankCode: 'NCB',
      vnp_CardType: 'ATM',
      vnp_OrderInfo: `Thanh toan lich hen ${apptNo}`,
      vnp_PayDate: '20261105081000',
      vnp_ResponseCode: '00',
      vnp_TransactionNo: '14000001',
      vnp_TxnRef: transactionNo,
    };
    ipnParams.vnp_SecureHash = generateVNPaySignature(ipnParams);

    const queryString = new URLSearchParams(ipnParams).toString();
    const ipnRes = await apiRequest('GET', `/payments/vnpay-ipn?${queryString}`);
    assert.equal(ipnRes.status, 200);
    assert.equal(ipnRes.body.RspCode, '00');

    // 4.4 Kiểm tra lịch đã thành CONFIRMED và paymentStatus = PAID
    const verifiedAppt = await Appointment.findOne({ id: apptId });
    assert.equal(verifiedAppt.status, APPOINTMENT_STATUSES.CONFIRMED);
    assert.equal(verifiedAppt.paymentStatus, 'PAID');

    // 4.5 Patient vào phòng khám trong cửa sổ khám: 08:35 GMT+7 = 01:35 UTC
    fakeClock.setNow(new Date('2026-11-05T01:35:00.000Z'));
    const joinRes = await apiRequest('POST', `/appointments/${apptId}/join-online`, {
      token: patient1Token,
    });
    assert.equal(joinRes.status, 200);
    assert.equal(joinRes.body.ok, true);
    assert.ok(joinRes.body.meetingUrl);
  });

  it('5. Chưa thanh toán: join-online bị từ chối 409 PAYMENT_REQUIRED kèm paymentUrl', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 105, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Unpaid Flow', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham' }],
      },
    });
    const apptId = createRes.body.data.id;

    // Đặt lịch lúc 01:00 UTC. Đến 01:10 UTC (sau 10 phút, còn trong hold 30 phút và trong window khám)
    fakeClock.setNow(new Date('2026-11-05T01:10:00.000Z'));
    const joinRes = await apiRequest('POST', `/appointments/${apptId}/join-online`, {
      token: patient1Token,
    });

    assert.equal(joinRes.status, 409);
    assert.equal(joinRes.body.error?.code, 'PAYMENT_REQUIRED');
    // Check paymentUrl from details or body
    const details = joinRes.body.error?.details || [];
    const hasPaymentUrl = details.some((d) => d.paymentUrl) || joinRes.body.paymentUrl;
    assert.ok(hasPaymentUrl);
  });

  it('6. Lịch ONLINE cũ không có paymentStatus vẫn join được (backward compatibility)', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 106, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'BOOKED' },
      ],
    });

    // Lịch legacy: CONFIRMED, không có paymentStatus
    const legacyAppt = await Appointment.create({
      appointmentNo: 'ONLLEGACY1',
      patientId: patient1.id,
      doctorId: doctorWithFee.id,
      specialtyId: specialty1.id,
      shiftId: shift.id,
      slotIds: [106],
      appointmentDate: '2026-11-05',
      appointmentTime: '08:30',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      patients: [{ fullName: 'Legacy Patient' }],
    });

    // 08:35 GMT+7 = 01:35 UTC
    fakeClock.setNow(new Date('2026-11-05T01:35:00.000Z'));
    const joinRes = await apiRequest('POST', `/appointments/${legacyAppt.id}/join-online`, {
      token: patient1Token,
    });

    assert.equal(joinRes.status, 200);
    assert.equal(joinRes.body.ok, true);
    assert.ok(joinRes.body.meetingUrl);
  });

  it('7. Patient hủy lịch PENDING_PAYMENT -> giải phóng slot (AVAILABLE) và release voucher', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 107, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Cancel Me', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham' }],
      },
    });
    const apptId = createRes.body.data.id;

    // Tạo voucher và giữ cho appointment này
    const voucher = await Voucher.create({
      code: 'VOUCHER10K',
      discountType: 'AMOUNT',
      discountValue: 10000,
      enable: true,
      expiryDate: new Date('2026-11-30'),
    });
    const userVoucher = await UserVoucher.create({
      userId: patient1.id,
      voucherId: voucher.id,
      used: true,
      usedAt: new Date(),
      appointmentId: apptId,
    });

    // Patient bấm hủy: PUT /appointments/cancel/:id
    const cancelRes = await apiRequest('PUT', `/appointments/cancel/${apptId}`, {
      token: patient1Token,
      body: { cancellationReason: 'Doi y dinh' },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.success, true);

    // Slot phải trở về AVAILABLE
    const updatedShift = await DoctorShift.findOne({ id: shift.id });
    const slot = updatedShift.slots.find((s) => s.id === 107);
    assert.equal(slot.status, 'AVAILABLE');
    assert.equal(slot.bookingRef, null);

    // Voucher phải được trả về used = false
    const updatedUserVoucher = await UserVoucher.findOne({ id: userVoucher.id });
    assert.equal(updatedUserVoucher.used, false);
    assert.equal(updatedUserVoucher.appointmentId, null);
  });

  it('8. Lễ tân confirm lịch PENDING_PAYMENT -> 409 INVALID_STATE "Không thể xác nhận lịch hẹn: lịch đang chờ thanh toán"', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 108, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Pending Rec', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham' }],
      },
    });
    const apptId = createRes.body.data.id;

    // Lễ tân xác nhận: PUT /appointments/confirm/:id
    const confirmRes = await apiRequest('PUT', `/appointments/confirm/${apptId}`, {
      token: receptionistToken,
    });

    assert.equal(confirmRes.status, 409);
    assert.equal(confirmRes.body.error?.code, 'INVALID_STATE');
    assert.ok(confirmRes.body.message.includes('lịch đang chờ thanh toán'));
  });

  it('9. Voucher được release khi tạo transaction gặp lỗi (mock)', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 109, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Voucher Fail', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham' }],
      },
    });
    const apptId = createRes.body.data.id;

    const voucher = await Voucher.create({
      code: 'VOUCHERROLLBACK',
      discountType: 'AMOUNT',
      discountValue: 15000,
      enable: true,
      expiryDate: new Date('2026-11-30'),
    });
    const userVoucher = await UserVoucher.create({
      userId: patient1.id,
      voucherId: voucher.id,
      used: false,
    });

    // Mock PaymentTransaction.create ném lỗi
    const origCreate = PaymentTransaction.create;
    PaymentTransaction.create = async () => {
      throw new Error('Database crash during transaction creation');
    };

    try {
      const res = await apiRequest('POST', '/payment/create', {
        token: patient1Token,
        body: {
          appointmentId: apptId,
          userVoucherId: userVoucher.id,
        },
      });

      assert.equal(res.status, 500);

      // Voucher phải được trả về used = false và appointmentId = null sau rollback release
      const checkedUV = await UserVoucher.findOne({ id: userVoucher.id });
      assert.equal(checkedUV.used, false);
      assert.equal(checkedUV.appointmentId, null);

      // Thử nghiệm trực tiếp: Redeem gắn appointmentId và release() kiểm tra đúng appointmentId
      const redeemResult = await voucherRedemptionService.redeem(
        { id: patient1.id, role: ROLES.PATIENT },
        userVoucher.id,
        { appointmentId: apptId, totalAmount: 150000 }
      );
      assert.equal(redeemResult.success, true);
      const afterRedeemUV = await UserVoucher.findOne({ id: userVoucher.id });
      assert.equal(afterRedeemUV.used, true);
      assert.equal(afterRedeemUV.appointmentId, apptId);

      // Release với appointmentId sai -> thất bại
      await assert.rejects(
        async () => {
          await voucherRedemptionService.release(userVoucher.id, 999999, { id: patient1.id, role: ROLES.PATIENT });
        },
        { code: 'VOUCHER_APPOINTMENT_MISMATCH' }
      );

      // Release với appointmentId đúng -> thành công
      const releaseResult = await voucherRedemptionService.release(
        userVoucher.id,
        apptId,
        { id: patient1.id, role: ROLES.PATIENT }
      );
      assert.equal(releaseResult.success, true);
      const afterReleaseUV = await UserVoucher.findOne({ id: userVoucher.id });
      assert.equal(afterReleaseUV.used, false);
      assert.equal(afterReleaseUV.appointmentId, null);
    } finally {
      PaymentTransaction.create = origCreate;
    }
  });

  it('10. Transition lỗi sau thanh toán -> needsReconcile + audit, job runOnce sửa được', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 110, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Transition Fail', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham' }],
      },
    });
    const apptId = createRes.body.data.id;
    const apptNo = createRes.body.data.appointmentNo;

    const payRes = await apiRequest('POST', '/payment/create', {
      token: patient1Token,
      body: { appointmentId: apptId },
    });
    const transactionNo = payRes.body.data.transactionNo;

    // Giả lập transition lúc IPN bị lỗi 1 lần
    const { appointmentStateService } = require('../src/services/appointmentState.service');
    const origTransition = appointmentStateService.transition.bind(appointmentStateService);
    let transitionFailedOnce = false;
    appointmentStateService.transition = async (params) => {
      if (!transitionFailedOnce) {
        transitionFailedOnce = true;
        throw new Error('Lock acquisition failed during IPN');
      }
      return origTransition(params);
    };

    try {
      const ipnParams = {
        vnp_TmnCode: process.env.VNP_TMN_CODE,
        vnp_Amount: String(300000 * 100),
        vnp_BankCode: 'NCB',
        vnp_CardType: 'ATM',
        vnp_OrderInfo: `Thanh toan lich hen ${apptNo}`,
        vnp_PayDate: '20261105081000',
        vnp_ResponseCode: '00',
        vnp_TransactionNo: '14000002',
        vnp_TxnRef: transactionNo,
      };
      ipnParams.vnp_SecureHash = generateVNPaySignature(ipnParams);

      const queryString = new URLSearchParams(ipnParams).toString();
      const ipnRes = await apiRequest('GET', `/payments/vnpay-ipn?${queryString}`);
      assert.equal(ipnRes.status, 200);
      assert.equal(ipnRes.body.RspCode, '00'); // IPN vẫn trả 00 cho VNPay

      // Transaction phải có needsReconcile = true
      const tx = await PaymentTransaction.findOne({ transactionNo });
      assert.equal(tx.status, PAYMENT_STATUSES.SUCCESS);
      assert.equal(tx.needsReconcile, true);

      // Audit PAYMENT_STATE_SYNC_FAILED phải được ghi
      const auditFailed = await AuditLog.findOne({ action: AUDIT_ACTIONS.PAYMENT_STATE_SYNC_FAILED });
      assert.ok(auditFailed);

      // Bây giờ chạy job.runOnce() để reconcile
      await paymentMaintenanceJob.runOnce();

      // Kiểm tra lại transaction và appointment
      const reconciledTx = await PaymentTransaction.findOne({ transactionNo });
      assert.equal(reconciledTx.needsReconcile, false);

      const reconciledAppt = await Appointment.findOne({ id: apptId });
      assert.equal(reconciledAppt.status, APPOINTMENT_STATUSES.CONFIRMED);

      // Audit PAYMENT_RECONCILED phải được ghi
      const auditReconciled = await AuditLog.findOne({ action: AUDIT_ACTIONS.PAYMENT_RECONCILED });
      assert.ok(auditReconciled);
    } finally {
      appointmentStateService.transition = origTransition;
    }
  });

  it('11. Tiền về khi lịch đã EXPIRED -> refundRequired = true và needsReconcile = true', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 111, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Late Money', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham' }],
      },
    });
    const apptId = createRes.body.data.id;
    const apptNo = createRes.body.data.appointmentNo;

    const payRes = await apiRequest('POST', '/payment/create', {
      token: patient1Token,
      body: { appointmentId: apptId },
    });
    const transactionNo = payRes.body.data.transactionNo;

    // Lịch bị chuyển sang EXPIRED
    const appt = await Appointment.findOne({ id: apptId });
    appt.status = APPOINTMENT_STATUSES.EXPIRED;
    await appt.save();

    const ipnParams = {
      vnp_TmnCode: process.env.VNP_TMN_CODE,
      vnp_Amount: String(300000 * 100),
      vnp_BankCode: 'NCB',
      vnp_CardType: 'ATM',
      vnp_OrderInfo: `Thanh toan lich hen ${apptNo}`,
      vnp_PayDate: '20261105081000',
      vnp_ResponseCode: '00',
      vnp_TransactionNo: '14000003',
      vnp_TxnRef: transactionNo,
    };
    ipnParams.vnp_SecureHash = generateVNPaySignature(ipnParams);

    const queryString = new URLSearchParams(ipnParams).toString();
    const ipnRes = await apiRequest('GET', `/payments/vnpay-ipn?${queryString}`);
    assert.equal(ipnRes.status, 200);

    const updatedAppt = await Appointment.findOne({ id: apptId });
    assert.equal(updatedAppt.refundRequired, true);
    assert.equal(updatedAppt.status, APPOINTMENT_STATUSES.EXPIRED); // Không bị ép sang CONFIRMED

    const tx = await PaymentTransaction.findOne({ transactionNo });
    assert.equal(tx.status, PAYMENT_STATUSES.SUCCESS);
    assert.equal(tx.needsReconcile, true);
  });

  it('12. Job: Transaction quá hạn -> EXPIRED; Lịch quá hạn giữ -> EXPIRED + slot AVAILABLE + voucher về', async () => {
    const shift = await DoctorShift.create({
      doctorId: doctorWithFee.id,
      date: '2026-11-05',
      shift: 'MORNING',
      startTime: '08:30',
      endTime: '09:00',
      type: 'ONLINE',
      status: 'ACTIVE',
      slots: [
        { id: 112, slotNumber: 1, startTime: '08:30', endTime: '09:00', status: 'AVAILABLE' },
      ],
    });

    const createRes = await apiRequest('POST', `/appointments/create?specialtyId=${specialty1.id}&doctorId=${doctorWithFee.id}`, {
      token: patient1Token,
      body: {
        shiftId: shift.id,
        appointment: { type: 'ONLINE' },
        patients: [{ fullName: 'Auto Expire', dateOfBirth: '1990-01-01', gender: 'Male', reason: 'Kham' }],
      },
    });
    const apptId = createRes.body.data.id;

    const voucher = await Voucher.create({
      code: 'VOUCHEREXPIRE',
      discountType: 'AMOUNT',
      discountValue: 20000,
      enable: true,
      expiryDate: new Date('2026-11-30'),
    });
    const userVoucher = await UserVoucher.create({
      userId: patient1.id,
      voucherId: voucher.id,
      used: false,
    });

    const payRes = await apiRequest('POST', '/payment/create', {
      token: patient1Token,
      body: {
        appointmentId: apptId,
        userVoucherId: userVoucher.id,
      },
    });
    assert.equal(payRes.status, 200);
    const transactionNo = payRes.body.data.transactionNo;

    // Tua đồng hồ qua 35 phút (quá hạn transaction 15m và hold 30m)
    // 01:00 UTC + 36 phút = 01:36 UTC
    fakeClock.setNow(new Date('2026-11-05T01:36:00.000Z'));

    // Chạy job bảo trì
    await paymentMaintenanceJob.runOnce();

    // 12.1 Transaction phải thành EXPIRED
    const expiredTx = await PaymentTransaction.findOne({ transactionNo });
    assert.equal(expiredTx.status, PAYMENT_STATUSES.EXPIRED);

    // 12.2 Lịch phải thành EXPIRED
    const expiredAppt = await Appointment.findOne({ id: apptId });
    assert.equal(expiredAppt.status, APPOINTMENT_STATUSES.EXPIRED);

    // 12.3 Slot phải trở về AVAILABLE
    const updatedShift = await DoctorShift.findOne({ id: shift.id });
    const slot = updatedShift.slots.find((s) => s.id === 112);
    assert.equal(slot.status, 'AVAILABLE');

    // 12.4 Voucher phải được release về used = false
    const releasedVoucher = await UserVoucher.findOne({ id: userVoucher.id });
    assert.equal(releasedVoucher.used, false);

    // 12.5 Chạy lặp lại: idempotent, không thay đổi thêm
    await paymentMaintenanceJob.runOnce();
    const idempotentAppt = await Appointment.findOne({ id: apptId });
    assert.equal(idempotentAppt.status, APPOINTMENT_STATUSES.EXPIRED);
  });
});
