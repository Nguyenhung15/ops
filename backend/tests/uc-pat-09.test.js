const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_pat_09_test_jwt_secret_key';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_pat_09';

const app = require('../src/app');
const {
  User,
  Voucher,
  UserVoucher,
  Appointment,
  PaymentTransaction,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS, APPOINTMENT_STATUSES, PAYMENT_STATUSES } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');
const { release, calculateDiscount } = require('../src/services/voucherRedemption.service');

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

describe('UC-PAT-09: Patient xem và dùng voucher (/vouchers/my)', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    await UserVoucher.init();
    await Voucher.init();
    await Appointment.init();
    await PaymentTransaction.init();

    // Fake clock tại 2026-11-01T10:00:00Z
    fakeClock = createFakeClock(new Date('2026-11-01T10:00:00Z'));
    setClock(fakeClock);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api`;
        resolve();
      });
    });

    const hashedPassword = await bcrypt.hash('Password@123', 8);

    patient1 = await User.create({
      id: 901,
      email: 'patient1_pat09@gmail.com',
      password: hashedPassword,
      fullName: 'Bệnh Nhân Nguyễn An',
      phoneNumber: '0912345678',
      userType: ROLES.PATIENT,
    });
    patient1Token = signAccessToken({
      userId: patient1.id,
      email: patient1.email,
      userType: patient1.userType,
    });

    patient2 = await User.create({
      id: 902,
      email: 'patient2_pat09@gmail.com',
      password: hashedPassword,
      fullName: 'Bệnh Nhân Trần Bình',
      phoneNumber: '0987654321',
      userType: ROLES.PATIENT,
    });
    patient2Token = signAccessToken({
      userId: patient2.id,
      email: patient2.email,
      userType: patient2.userType,
    });

    doctor1 = await User.create({
      id: 903,
      email: 'doc1_pat09@clinic.com',
      password: hashedPassword,
      fullName: 'BS. Lê Minh',
      phoneNumber: '0901111222',
      userType: ROLES.DOCTOR,
    });
    doctor1Token = signAccessToken({
      userId: doctor1.id,
      email: doctor1.email,
      userType: doctor1.userType,
    });

    receptionist1 = await User.create({
      id: 904,
      email: 'rec1_pat09@clinic.com',
      password: hashedPassword,
      fullName: 'Lễ Tân Mai',
      phoneNumber: '0903333444',
      userType: ROLES.RECEPTIONIST,
    });
    receptionist1Token = signAccessToken({
      userId: receptionist1.id,
      email: receptionist1.email,
      userType: receptionist1.userType,
    });
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({});
  });

  it('1. GET /vouchers/my: Xem voucher của mình, không lẫn voucher người khác, trạng thái dẫn xuất đúng (AVAILABLE, USED, EXPIRED)', async () => {
    // Voucher 1: còn hạn, chưa dùng -> AVAILABLE
    await UserVoucher.create({
      id: 101,
      voucherId: 1,
      userId: patient1.id,
      voucherCode: 'VC_ACTIVE_50K',
      voucherName: 'Giảm 50k Khám Tổng Quát',
      discountValue: 50000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: false,
    });

    // Voucher 2: đã dùng -> USED
    await UserVoucher.create({
      id: 102,
      voucherId: 2,
      userId: patient1.id,
      voucherCode: 'VC_USED',
      voucherName: 'Voucher Đã Dùng',
      discountValue: 20000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: true,
      usedAt: new Date('2026-10-20T10:00:00Z'),
    });

    // Voucher 3: quá hạn so với fakeClock (2026-11-01) -> EXPIRED
    await UserVoucher.create({
      id: 103,
      voucherId: 3,
      userId: patient1.id,
      voucherCode: 'VC_EXPIRED',
      voucherName: 'Voucher Quá Hạn',
      discountValue: 30000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-10-15T00:00:00Z'),
      used: false,
    });

    // Voucher của patient 2 (không được xuất hiện trong /vouchers/my của patient 1)
    await UserVoucher.create({
      id: 104,
      voucherId: 4,
      userId: patient2.id,
      voucherCode: 'VC_PATIENT2',
      voucherName: 'Voucher Người Khác',
      discountValue: 100000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: false,
    });

    const res = await apiRequest('GET', '/vouchers/my', { token: patient1Token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 3);

    const v1 = res.body.data.find((v) => v.id === 101);
    assert.ok(v1);
    assert.equal(v1.derivedStatus, 'AVAILABLE');

    const v2 = res.body.data.find((v) => v.id === 102);
    assert.ok(v2);
    assert.equal(v2.derivedStatus, 'USED');

    const v3 = res.body.data.find((v) => v.id === 103);
    assert.ok(v3);
    assert.equal(v3.derivedStatus, 'EXPIRED');

    // Không chứa voucher 104 của patient2
    const hasOther = res.body.data.some((v) => v.id === 104);
    assert.equal(hasOther, false, 'Không được trả voucher của người khác');
  });

  it('2. POST /vouchers/my/:userVoucherId/redeem: Dùng voucher thành công kèm tính giảm tiền AMOUNT, ghi audit REDEEM_VOUCHER', async () => {
    // Tạo parent voucher AMOUNT
    await Voucher.create({
      id: 10,
      code: 'VC_AMOUNT_100K',
      name: 'Giảm 100k Trực Tiếp',
      discountValue: 100000,
      discountType: 'AMOUNT',
      type: 'DISCOUNT',
      enable: true,
      expiryDate: new Date('2026-12-31T23:59:59Z'),
    });

    const uv = await UserVoucher.create({
      id: 201,
      voucherId: 10,
      userId: patient1.id,
      voucherCode: 'VC_AMOUNT_100K',
      voucherName: 'Giảm 100k Trực Tiếp',
      discountValue: 100000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: false,
    });

    const appt = await Appointment.create({
      id: 501,
      appointmentNo: 'APPT-501',
      patientId: patient1.id,
      doctorId: 903,
      specialtyId: 1,
      shiftId: 1,
      appointmentDate: '2026-11-05',
      appointmentTime: '08:30',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    const res = await apiRequest('POST', `/vouchers/my/${uv.id}/redeem`, {
      token: patient1Token,
      body: {
        appointmentId: appt.id,
        totalAmount: 300000, // Tổng tiền 300.000đ
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.discountAmount, 100000);
    assert.equal(res.body.data.totalAmount, 300000);
    assert.equal(res.body.data.used, true);

    // Kiểm tra DB
    const updatedUv = await UserVoucher.findOne({ id: uv.id }).lean();
    assert.equal(updatedUv.used, true);
    assert.equal(updatedUv.appointmentId, appt.id);
    assert.ok(updatedUv.usedAt);

    // Kiểm tra Audit Log
    const audit = await AuditLog.findOne({ action: AUDIT_ACTIONS.REDEEM_VOUCHER, targetId: uv.id }).lean();
    assert.ok(audit);
    assert.equal(audit.actorId, patient1.id);
    assert.equal(audit.changes?.discountAmount, 100000);
  });

  it('3. Dùng voucher đã được sử dụng -> 409 VOUCHER_ALREADY_USED', async () => {
    // uv 201 đã dùng ở test 2
    const res = await apiRequest('POST', '/vouchers/my/201/redeem', {
      token: patient1Token,
      body: { totalAmount: 200000 },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'VOUCHER_ALREADY_USED');
  });

  it('4. Dùng voucher của người khác -> 404 VOUCHER_NOT_FOUND', async () => {
    // uv 104 thuộc về patient2
    const res = await apiRequest('POST', '/vouchers/my/104/redeem', {
      token: patient1Token,
      body: { totalAmount: 200000 },
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.error?.code, 'VOUCHER_NOT_FOUND');
  });

  it('5. Dùng voucher hết hạn -> 409 VOUCHER_EXPIRED', async () => {
    // uv 103 đã quá hạn
    const res = await apiRequest('POST', '/vouchers/my/103/redeem', {
      token: patient1Token,
      body: { totalAmount: 200000 },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'VOUCHER_EXPIRED');
  });

  it('6. Dùng voucher bị disabled (Voucher gốc enable: false) -> 409 VOUCHER_DISABLED', async () => {
    await Voucher.create({
      id: 20,
      code: 'VC_DISABLED',
      name: 'Voucher Khóa',
      discountValue: 50000,
      enable: false,
      expiryDate: new Date('2026-12-31T23:59:59Z'),
    });

    const uvDisabled = await UserVoucher.create({
      id: 202,
      voucherId: 20,
      userId: patient1.id,
      voucherCode: 'VC_DISABLED',
      used: false,
      expiryDate: new Date('2026-12-31T23:59:59Z'),
    });

    const res = await apiRequest('POST', `/vouchers/my/${uvDisabled.id}/redeem`, {
      token: patient1Token,
      body: { totalAmount: 200000 },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'VOUCHER_DISABLED');
  });

  it('7. 2 request song song cùng redeem 1 voucher: đúng 1 thành công (200), 1 bị từ chối 409', async () => {
    const uvRace = await UserVoucher.create({
      id: 203,
      voucherId: 10,
      userId: patient1.id,
      voucherCode: 'VC_RACE',
      used: false,
      expiryDate: new Date('2026-12-31T23:59:59Z'),
    });

    const [resA, resB] = await Promise.all([
      apiRequest('POST', `/vouchers/my/${uvRace.id}/redeem`, {
        token: patient1Token,
        body: { totalAmount: 150000 },
      }),
      apiRequest('POST', `/vouchers/my/${uvRace.id}/redeem`, {
        token: patient1Token,
        body: { totalAmount: 150000 },
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409], 'Một request phải 200 và một request phải 409');

    // Audit REDEEM_VOUCHER chỉ ghi đúng 1 lần cho uvRace
    const audits = await AuditLog.find({ action: AUDIT_ACTIONS.REDEEM_VOUCHER, targetId: uvRace.id }).lean();
    assert.equal(audits.length, 1);
  });

  it('8. Tính toán giảm giá: PERCENT, AMOUNT và giới hạn không vượt tổng tiền', () => {
    // 8.1 Giảm PERCENT 20% trên 500.000đ = 100.000đ
    const percentVoucher = { discountType: 'PERCENT', discountValue: 20, type: 'DISCOUNT' };
    assert.equal(calculateDiscount(percentVoucher, 500000), 100000);

    // 8.2 Giảm AMOUNT 70.000đ trên 200.000đ = 70.000đ
    const amountVoucher = { discountType: 'AMOUNT', discountValue: 70000, type: 'DISCOUNT' };
    assert.equal(calculateDiscount(amountVoucher, 200000), 70000);

    // 8.3 Giảm AMOUNT 300.000đ nhưng tổng tiền chỉ có 150.000đ -> Giảm tối đa 150.000đ (không vượt tổng tiền)
    assert.equal(calculateDiscount(amountVoucher, 50000), 50000);

    // 8.4 SERVICE_TICKET -> 0đ
    const ticketVoucher = { discountType: 'AMOUNT', discountValue: 100000, type: 'SERVICE_TICKET' };
    assert.equal(calculateDiscount(ticketVoucher, 500000), 0);
  });

  it('9. release(): Hoàn voucher thành công khi đúng appointment, chặn khi sai appointment hoặc đã thanh toán thành công', async () => {
    const uvRelease = await UserVoucher.create({
      id: 204,
      voucherId: 10,
      userId: patient1.id,
      voucherCode: 'VC_RELEASE',
      appointmentId: 501,
      used: true,
      usedAt: new Date(),
    });

    // 9.1 Sai appointmentId -> Lỗi 400
    await assert.rejects(
      async () => {
        await release(uvRelease.id, 999);
      },
      (err) => err.statusCode === 400 && err.code === 'VOUCHER_APPOINTMENT_MISMATCH',
    );

    // 9.2 Lịch hẹn đã thanh toán SUCCESS -> Lỗi 409
    await PaymentTransaction.create({
      appointmentId: 501,
      amount: 200000,
      status: PAYMENT_STATUSES.SUCCESS,
    });

    await assert.rejects(
      async () => {
        await release(uvRelease.id, 501);
      },
      (err) => err.statusCode === 409 && err.code === 'PAYMENT_ALREADY_SUCCESS',
    );

    // Dọn dẹp payment để test release hợp lệ cho lịch hẹn 502
    await PaymentTransaction.deleteMany({});

    const appt2 = await Appointment.create({
      id: 502,
      appointmentNo: 'APPT-502',
      patientId: patient1.id,
      doctorId: 903,
      specialtyId: 1,
      shiftId: 1,
      appointmentDate: '2026-11-06',
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
    });

    const uvReleaseOk = await UserVoucher.create({
      id: 205,
      voucherId: 10,
      userId: patient1.id,
      voucherCode: 'VC_RELEASE_OK',
      appointmentId: 502,
      used: true,
      usedAt: new Date(),
    });

    // 9.3 Hoàn lại thành công
    const releaseRes = await release(uvReleaseOk.id, 502, { id: patient1.id, role: ROLES.PATIENT });
    assert.equal(releaseRes.success, true);

    const inDb = await UserVoucher.findOne({ id: uvReleaseOk.id }).lean();
    assert.equal(inDb.used, false);
    assert.equal(inDb.appointmentId, null);
    assert.equal(inDb.usedAt, null);

    // Kiểm tra Audit Log RELEASE_VOUCHER
    const releaseAudit = await AuditLog.findOne({ action: AUDIT_ACTIONS.RELEASE_VOUCHER, targetId: uvReleaseOk.id }).lean();
    assert.ok(releaseAudit);
  });

  it('10. Phân quyền: Role Doctor/Receptionist hoặc chưa đăng nhập bị từ chối 403 / 401', async () => {
    // 10.1 Chưa đăng nhập -> 401
    const resNoAuth = await apiRequest('GET', '/vouchers/my');
    assert.equal(resNoAuth.status, 401);

    const resNoAuthRedeem = await apiRequest('POST', '/vouchers/my/101/redeem');
    assert.equal(resNoAuthRedeem.status, 401);

    // 10.2 Doctor gọi -> 403
    const resDoc = await apiRequest('GET', '/vouchers/my', { token: doctor1Token });
    assert.equal(resDoc.status, 403);

    // 10.3 Receptionist gọi -> 403
    const resRec = await apiRequest('GET', '/vouchers/my', { token: receptionist1Token });
    assert.equal(resRec.status, 403);
  });
});
