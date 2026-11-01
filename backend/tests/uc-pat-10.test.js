const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_pat_10_test_jwt_secret_key';
process.env.VNP_TMN_CODE = 'TEST_TMN_CODE';
process.env.VNP_HASH_SECRET = 'TEST_HASH_SECRET_1234567890';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_pat_10';

const app = require('../src/app');
const {
  User,
  Voucher,
  UserVoucher,
  Appointment,
  PaymentTransaction,
  AuditLog,
  OutboxEvent,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS, APPOINTMENT_STATUSES, PAYMENT_STATUSES } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');
const { paymentService, verifyVNPayHash, formatVNPayDate } = require('../src/services/payment.service');

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

describe('UC-PAT-10 & UC-SYS-03: VNPay Payment & Cleanup Job', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    fakeClock = createFakeClock(new Date('2026-11-01T08:00:00.000Z'));
    setClock(fakeClock);

    const passwordHash = await bcrypt.hash('Secret123!', 6);

    patient1 = await User.create({
      email: 'patient1_pat10@test.local',
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
      email: 'patient2_pat10@test.local',
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
      email: 'doctor1_pat10@test.local',
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
      email: 'receptionist1_pat10@test.local',
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
    await PaymentTransaction.deleteMany({});
    await Voucher.deleteMany({});
    await UserVoucher.deleteMany({});
    await AuditLog.deleteMany({});
    await OutboxEvent.deleteMany({});
    fakeClock.setNow(new Date('2026-11-01T08:00:00.000Z'));
  });

  it('1. Tạo thanh toán: Phí do server tính từ doctor.consultationFee, bỏ qua amount từ client', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL10001',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [101],
      appointmentDate: '2026-11-05',
      appointmentTime: '08:30',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
      patients: [{ fullName: 'Patient A' }],
    });

    // Client cố tình gửi amount: 1000 (gian lận giá)
    const res = await apiRequest('POST', '/api/payment/create', {
      token: patient1Token,
      body: {
        appointmentId: appt.id,
        amount: 1000,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.amount, 300000); // 300k do server tính
    assert.ok(res.body.data.paymentUrl.includes('vnp_Amount=30000000')); // nhân 100 theo VNPay
    assert.ok(res.body.data.paymentUrl.includes('vnp_SecureHash='));

    const txn = await PaymentTransaction.findOne({ appointmentId: appt.id });
    assert.ok(txn);
    assert.equal(txn.amount, 300000);
    assert.equal(txn.status, PAYMENT_STATUSES.PENDING);
  });

  it('2. Lịch người khác -> trả về 404 (quyền sở hữu lịch khám)', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL10002',
      patientId: patient2.id, // Thuộc về patient2
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [102],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const res = await apiRequest('POST', '/api/payment/create', {
      token: patient1Token, // Patient 1 cố tình tạo thanh toán
      body: { appointmentId: appt.id },
    });

    assert.equal(res.status, 404);
  });

  it('3. Vai trò sai (Bác sĩ / Lễ tân) tạo thanh toán -> 403', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL10003',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [103],
      appointmentDate: '2026-11-05',
      appointmentTime: '09:30',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const res = await apiRequest('POST', '/api/payment/create', {
      token: doctor1Token,
      body: { appointmentId: appt.id },
    });

    assert.equal(res.status, 403);
  });

  it('4. Tạo thanh toán hỗ trợ voucher qua voucherRedemptionService và tính đúng amount', async () => {
    const parentVoucher = await Voucher.create({
      code: 'GIAM50K',
      name: 'Giảm 50.000đ',
      discountValue: 50000,
      discountType: 'AMOUNT',
      type: 'DISCOUNT',
      enable: true,
      expiryDate: new Date('2026-12-31T23:59:59.000Z'),
    });

    const userVoucher = await UserVoucher.create({
      userId: patient1.id,
      voucherId: parentVoucher.id,
      voucherCode: 'GIAM50K',
      discountValue: 50000,
      type: 'DISCOUNT',
      used: false,
      expiryDate: new Date('2026-12-31T23:59:59.000Z'),
    });

    const appt = await Appointment.create({
      appointmentNo: 'ONL10004',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [104],
      appointmentDate: '2026-11-05',
      appointmentTime: '10:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
      patients: [{ fullName: 'Patient B' }],
    });

    const res = await apiRequest('POST', '/api/payment/create', {
      token: patient1Token,
      body: {
        appointmentId: appt.id,
        userVoucherId: userVoucher.id,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.amount, 250000); // 300k - 50k = 250k
    assert.equal(res.body.data.discountAmount, 50000);
    assert.ok(res.body.data.paymentUrl.includes('vnp_Amount=25000000'));

    const updatedUv = await UserVoucher.findOne({ id: userVoucher.id });
    assert.equal(updatedUv.used, true);
    assert.equal(updatedUv.appointmentId, appt.id);
  });

  it('5. Callback IPN: Sai chữ ký -> Không đổi state, IPN trả RspCode 97', async () => {
    const txn = await PaymentTransaction.create({
      appointmentId: 5001,
      userId: patient1.id,
      transactionNo: 'TXN_TEST_SIG_FAIL',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '30000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_SecureHash: 'INVALID_SIGNATURE_HEX',
    };
    const qs = new URLSearchParams(params).toString();

    const res = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.RspCode, '97');

    const unchangedTxn = await PaymentTransaction.findOne({ id: txn.id });
    assert.equal(unchangedTxn.status, PAYMENT_STATUSES.PENDING);
  });

  it('6. Callback IPN: Sai số tiền -> Không đổi state, IPN trả RspCode 04', async () => {
    const txn = await PaymentTransaction.create({
      appointmentId: 5002,
      userId: patient1.id,
      transactionNo: 'TXN_TEST_AMOUNT_MISMATCH',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '10000000', // Khác 30000000
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
    };
    params.vnp_SecureHash = generateVNPaySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.RspCode, '04');

    const unchangedTxn = await PaymentTransaction.findOne({ id: txn.id });
    assert.equal(unchangedTxn.status, PAYMENT_STATUSES.PENDING);
  });

  it('7. Callback IPN Thành công: Chuyển đúng state ONLINE sang CONFIRMED, ghi nhận outbox và audit', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL10007',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [107],
      appointmentDate: '2026-11-05',
      appointmentTime: '11:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const txn = await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN_TEST_ONLINE_SUCCESS',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '30000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_BankCode: 'NCB',
      vnp_PayDate: '20261101083000',
    };
    params.vnp_SecureHash = generateVNPaySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.RspCode, '00');

    // Kiểm tra state của lịch hẹn ONLINE -> CONFIRMED
    const updatedAppt = await Appointment.findOne({ id: appt.id });
    assert.equal(updatedAppt.status, APPOINTMENT_STATUSES.CONFIRMED);

    // Kiểm tra Transaction status
    const updatedTxn = await PaymentTransaction.findOne({ id: txn.id });
    assert.equal(updatedTxn.status, PAYMENT_STATUSES.SUCCESS);
    assert.equal(updatedTxn.bankCode, 'NCB');

    // Kiểm tra Outbox event
    const outbox = await OutboxEvent.findOne({ eventType: 'PAYMENT_SUCCESS' });
    assert.ok(outbox);
    assert.equal(outbox.payload.transactionNo, txn.transactionNo);

    // Kiểm tra Audit log
    const audit = await AuditLog.findOne({ action: AUDIT_ACTIONS.PAYMENT_SUCCESS });
    assert.ok(audit);
  });

  it('8. Callback IPN Thành công: Chuyển đúng state OFFLINE sang PENDING_CONFIRMATION', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'OFF10008',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [108],
      appointmentDate: '2026-11-05',
      appointmentTime: '14:00',
      type: 'OFFLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const txn = await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN_TEST_OFFLINE_SUCCESS',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '30000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_BankCode: 'VCB',
      vnp_PayDate: '20261101083000',
    };
    params.vnp_SecureHash = generateVNPaySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.RspCode, '00');

    const updatedAppt = await Appointment.findOne({ id: appt.id });
    assert.equal(updatedAppt.status, APPOINTMENT_STATUSES.PENDING_CONFIRMATION);
  });

  it('9. Idempotency: Callback lặp 3 lần chỉ xử lý 1 lần, các lần sau trả RspCode 02', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL10009',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [109],
      appointmentDate: '2026-11-05',
      appointmentTime: '15:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const txn = await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN_TEST_IDEMPOTENT_LOOP',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '30000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_BankCode: 'MB',
      vnp_PayDate: '20261101083000',
    };
    params.vnp_SecureHash = generateVNPaySignature(params);
    const qs = new URLSearchParams(params).toString();

    // Lần 1: Thành công
    const res1 = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res1.body.RspCode, '00');

    // Lần 2 & 3: Idempotent trả về RspCode 02 (Order already confirmed)
    const res2 = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res2.body.RspCode, '02');

    const res3 = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res3.body.RspCode, '02');

    const outboxList = await OutboxEvent.find({ eventType: 'PAYMENT_SUCCESS' });
    assert.equal(outboxList.length, 1); // Chỉ ghi 1 outbox event
  });

  it('10. Concurrency: 2 callback IPN chạy song song -> chỉ 1 bên thành công, không xung đột', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL10010',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [110],
      appointmentDate: '2026-11-05',
      appointmentTime: '16:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const txn = await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN_TEST_PARALLEL',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '30000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_BankCode: 'NCB',
      vnp_PayDate: '20261101083000',
    };
    params.vnp_SecureHash = generateVNPaySignature(params);
    const qs = new URLSearchParams(params).toString();

    const [resA, resB] = await Promise.all([
      apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`),
      apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`),
    ]);

    const codes = [resA.body.RspCode, resB.body.RspCode].sort();
    assert.deepEqual(codes, ['00', '02']); // Một bên '00', một bên '02'
  });

  it('11. Thanh toán thất bại: Transaction FAILED, release voucher, giữ nguyên trạng thái PENDING_PAYMENT của lịch', async () => {
    const parentVoucher = await Voucher.create({
      code: 'RELEASEME',
      discountValue: 50000,
      discountType: 'AMOUNT',
      enable: true,
      expiryDate: new Date('2026-12-31T23:59:59.000Z'),
    });

    const userVoucher = await UserVoucher.create({
      userId: patient1.id,
      voucherId: parentVoucher.id,
      used: true,
      appointmentId: 5011,
      expiryDate: new Date('2026-12-31T23:59:59.000Z'),
    });

    const appt = await Appointment.create({
      id: 5011,
      appointmentNo: 'ONL10011',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [111],
      appointmentDate: '2026-11-05',
      appointmentTime: '17:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const txn = await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      userVoucherId: userVoucher.id,
      transactionNo: 'TXN_TEST_FAILED_TXN',
      amount: 250000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '25000000',
      vnp_ResponseCode: '24', // Người dùng hủy giao dịch
      vnp_TransactionStatus: '02',
    };
    params.vnp_SecureHash = generateVNPaySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await apiRequest('GET', `/api/payment/vnpay-ipn?${qs}`);
    assert.equal(res.status, 200);

    const updatedTxn = await PaymentTransaction.findOne({ id: txn.id });
    assert.equal(updatedTxn.status, PAYMENT_STATUSES.FAILED);

    // Voucher được giải phóng
    const updatedUv = await UserVoucher.findOne({ id: userVoucher.id });
    assert.equal(updatedUv.used, false);
    assert.equal(updatedUv.appointmentId, null);

    // Lịch hẹn giữ nguyên trạng thái PENDING_PAYMENT
    const updatedAppt = await Appointment.findOne({ id: appt.id });
    assert.equal(updatedAppt.status, APPOINTMENT_STATUSES.PENDING_PAYMENT);
  });

  it('12. UC-SYS-03: Cleanup Job dọn giao dịch PENDING quá hạn -> EXPIRED và release voucher', async () => {
    const parentVoucher = await Voucher.create({
      code: 'EXPIRE_CLEANUP',
      discountValue: 40000,
      discountType: 'AMOUNT',
      enable: true,
      expiryDate: new Date('2026-12-31T23:59:59.000Z'),
    });

    const userVoucher = await UserVoucher.create({
      userId: patient1.id,
      voucherId: parentVoucher.id,
      used: true,
      appointmentId: 5012,
      expiryDate: new Date('2026-12-31T23:59:59.000Z'),
    });

    // Tạo giao dịch PENDING đã quá hạn (expiresAt lúc 07:50, hiện tại là 08:00)
    const expiredTxn = await PaymentTransaction.create({
      appointmentId: 5012,
      userId: patient1.id,
      userVoucherId: userVoucher.id,
      transactionNo: 'TXN_EXPIRED_TO_CLEANUP',
      amount: 260000,
      status: PAYMENT_STATUSES.PENDING,
      expiresAt: new Date('2026-11-01T07:50:00.000Z'),
    });

    // Tạo giao dịch PENDING còn hạn (expiresAt lúc 08:15)
    const activeTxn = await PaymentTransaction.create({
      appointmentId: 5013,
      userId: patient1.id,
      transactionNo: 'TXN_STILL_ACTIVE',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
      expiresAt: new Date('2026-11-01T08:15:00.000Z'),
    });

    const cleanupResult = await paymentService.cleanupExpiredTransactions();
    assert.equal(cleanupResult.cleanedCount, 1);

    const checkedExpiredTxn = await PaymentTransaction.findOne({ id: expiredTxn.id });
    assert.equal(checkedExpiredTxn.status, PAYMENT_STATUSES.EXPIRED);

    const checkedActiveTxn = await PaymentTransaction.findOne({ id: activeTxn.id });
    assert.equal(checkedActiveTxn.status, PAYMENT_STATUSES.PENDING);

    // Voucher của giao dịch hết hạn được giải phóng
    const checkedUv = await UserVoucher.findOne({ id: userVoucher.id });
    assert.equal(checkedUv.used, false);
    assert.equal(checkedUv.appointmentId, null);
  });

  it('13. GET /payments: Chỉ trả danh sách giao dịch của user trong JWT, không lộ người khác', async () => {
    // Tạo 2 giao dịch cho patient1 và 1 giao dịch cho patient2
    await PaymentTransaction.create({
      appointmentId: 6001,
      userId: patient1.id,
      transactionNo: 'TXN_PAT1_A',
      amount: 150000,
      status: PAYMENT_STATUSES.SUCCESS,
    });
    await PaymentTransaction.create({
      appointmentId: 6002,
      userId: patient1.id,
      transactionNo: 'TXN_PAT1_B',
      amount: 200000,
      status: PAYMENT_STATUSES.PENDING,
    });
    await PaymentTransaction.create({
      appointmentId: 6003,
      userId: patient2.id,
      transactionNo: 'TXN_PAT2_SECRET',
      amount: 500000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    const res = await apiRequest('GET', '/api/payments', {
      token: patient1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.length, 2);
    const txnNos = res.body.data.map((item) => item.transactionNo);
    assert.ok(txnNos.includes('TXN_PAT1_A'));
    assert.ok(txnNos.includes('TXN_PAT1_B'));
    assert.ok(!txnNos.includes('TXN_PAT2_SECRET')); // Không thấy của patient 2
  });

  it('14. Return URL: /payment/vnpay-return trả kết quả giao dịch và xử lý idempotent', async () => {
    const appt = await Appointment.create({
      appointmentNo: 'ONL10014',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: 1,
      shiftId: 1,
      slotIds: [114],
      appointmentDate: '2026-11-05',
      appointmentTime: '18:00',
      type: 'ONLINE',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const txn = await PaymentTransaction.create({
      appointmentId: appt.id,
      userId: patient1.id,
      transactionNo: 'TXN_TEST_RETURN_URL',
      amount: 300000,
      status: PAYMENT_STATUSES.PENDING,
    });

    const params = {
      vnp_TxnRef: txn.transactionNo,
      vnp_Amount: '30000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_BankCode: 'NCB',
      vnp_PayDate: '20261101083000',
    };
    params.vnp_SecureHash = generateVNPaySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await apiRequest('GET', `/api/payment/vnpay-return?${qs}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.success, true);
    assert.equal(res.body.data.status, PAYMENT_STATUSES.SUCCESS);

    const updatedAppt = await Appointment.findOne({ id: appt.id });
    assert.equal(updatedAppt.status, APPOINTMENT_STATUSES.CONFIRMED);
  });
});
