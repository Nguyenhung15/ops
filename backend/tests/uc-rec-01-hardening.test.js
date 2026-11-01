const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_rec_01_hardening_test_secret_key';
process.env.RECEPTION_SEARCH_RATE_PER_MIN = '5';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_rec_01_hardening';

const app = require('../src/app');
const {
  User,
  Voucher,
  UserVoucher,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { maskEmail, maskPhone } = require('../src/utils/masking');

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

describe('UC-REC-01 Hardening: Tra cứu user, voucher & bảo vệ an toàn', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api`;
        resolve();
      });
    });

    const hashedPassword = await bcrypt.hash('Password@123', 8);

    receptionist1 = await User.create({
      id: 101,
      email: 'rec1_hard@clinic.com',
      password: hashedPassword,
      fullName: 'Lễ Tân Kiểm Tra',
      phoneNumber: '0901234567',
      userType: ROLES.RECEPTIONIST,
    });
    receptionist1Token = signAccessToken({
      userId: receptionist1.id,
      email: receptionist1.email,
      userType: receptionist1.userType,
    });

    admin1 = await User.create({
      id: 102,
      email: 'admin1_hard@clinic.com',
      password: hashedPassword,
      fullName: 'Quản Trị Viên An Toàn',
      phoneNumber: '0903333999',
      userType: ROLES.ADMIN,
    });
    admin1Token = signAccessToken({
      userId: admin1.id,
      email: admin1.email,
      userType: admin1.userType,
    });

    doctor1 = await User.create({
      id: 103,
      email: 'doc1_hard@clinic.com',
      password: hashedPassword,
      fullName: 'BS. Lê Trọng Tín',
      phoneNumber: '0907777888',
      userType: ROLES.DOCTOR,
    });
    doctor1Token = signAccessToken({
      userId: doctor1.id,
      email: doctor1.email,
      userType: doctor1.userType,
    });

    patient1 = await User.create({
      id: 104,
      email: 'patient1_hard@gmail.com',
      password: hashedPassword,
      fullName: 'Bệnh Nhân Thử Nghiệm',
      phoneNumber: '0918765432',
      userType: ROLES.PATIENT,
    });
    patient1Token = signAccessToken({
      userId: patient1.id,
      email: patient1.email,
      userType: patient1.userType,
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

  it('1. Wildcard và keyword không hợp lệ -> 400 (.*, *, %, _, khoảng trắng, ký tự đặc biệt)', async () => {
    const invalidKeywords = ['.*', '*', '%', '_', '   ', '.*.*', '%%%', '___', '***'];
    for (const kw of invalidKeywords) {
      const res = await apiRequest('GET', `/users/search?keyword=${encodeURIComponent(kw)}`, {
        token: receptionist1Token,
      });
      assert.equal(res.status, 400, `Keyword "${kw}" phải trả về 400`);
      assert.ok(
        ['INVALID_KEYWORD_LENGTH', 'INVALID_KEYWORD_FORMAT'].includes(res.body.error?.code),
        `Mã lỗi không khớp cho "${kw}"`,
      );
    }
  });

  it('2. Keyword ngắn hơn 3 ký tự -> 400 INVALID_KEYWORD_LENGTH', async () => {
    const shortKeywords = ['', 'a', 'ab', '  ab  '];
    for (const kw of shortKeywords) {
      const res = await apiRequest('GET', `/users/search?keyword=${encodeURIComponent(kw)}`, {
        token: receptionist1Token,
      });
      assert.equal(res.status, 400, `Keyword ngắn "${kw}" phải trả về 400`);
      assert.equal(res.body.error?.code, 'INVALID_KEYWORD_LENGTH');
    }
  });

  it('3. Limit vượt 20 bị cắt xuống tối đa 20', async () => {
    const testUsers = [];
    for (let i = 1; i <= 30; i++) {
      testUsers.push({
        id: 300 + i,
        email: `hard_user_${i}@example.com`,
        password: 'Password@123',
        fullName: `Bệnh Nhân Cắt Limit ${i}`,
        phoneNumber: `09811122${String(i).padStart(2, '0')}`,
        userType: ROLES.PATIENT,
      });
    }
    await User.insertMany(testUsers);

    const res = await apiRequest('GET', '/users/search?keyword=Cắt Limit&limit=50', {
      token: receptionist1Token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 20, 'Kết quả trả về không được vượt quá 20');
    assert.equal(res.body.pagination.limit, 20);
    assert.equal(res.body.pagination.total, 30);
  });

  it('4. Mask đúng định dạng cho email và phone', () => {
    assert.equal(maskEmail('patient1_hard@gmail.com'), 'p***@gmail.com');
    assert.equal(maskEmail('hello@domain.vn'), 'h***@domain.vn');
    assert.equal(maskPhone('0918765432'), '09****432');
    assert.equal(maskPhone('0901234567'), '09****567');
  });

  it('5. Response không bao giờ chứa trường nhạy cảm (password, passwordHash, oauth, hồ sơ y tế)', async () => {
    const res = await apiRequest('GET', '/users/search?keyword=Thử Nghiệm', {
      token: receptionist1Token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);

    const user = res.body.data[0];
    assert.equal(user.id, patient1.id);
    assert.equal(user.fullName, 'Bệnh Nhân Thử Nghiệm');
    assert.equal(user.email, 'p***@gmail.com');
    assert.equal(user.phoneNumber, '09****432');
    assert.equal(user.role, ROLES.PATIENT);
    assert.equal(user.isEnabled, true);

    // Không rò rỉ bất kỳ trường nhạy cảm nào
    assert.equal(user.password, undefined);
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.temporaryPassword, undefined);
    assert.equal(user.authProvider, undefined);
    assert.equal(user.medicalHistory, undefined);
    assert.equal(user.prescriptions, undefined);
  });

  it('6. Rate limit 429 trên cả search và view voucher theo userId', async () => {
    // 6.1 Test rate limit trên /users/search
    let hitRateLimitSearch = false;
    for (let i = 0; i < 7; i++) {
      const res = await apiRequest('GET', '/users/search?keyword=Thử Nghiệm', {
        token: receptionist1Token,
        headers: { 'x-test-rate-limit': '1' },
      });
      if (res.status === 429) {
        hitRateLimitSearch = true;
        assert.equal(res.body.error?.code, 'RATE_LIMIT_EXCEEDED');
        break;
      }
    }
    assert.ok(hitRateLimitSearch, 'Search phải kích hoạt 429 khi vượt ngưỡng');

    // 6.2 Test rate limit trên /vouchers/user/:userId
    let hitRateLimitVoucher = false;
    for (let i = 0; i < 7; i++) {
      const res = await apiRequest('GET', `/vouchers/user/${patient1.id}`, {
        token: receptionist1Token,
        headers: { 'x-test-rate-limit': '1' },
      });
      if (res.status === 429) {
        hitRateLimitVoucher = true;
        assert.equal(res.body.error?.code, 'RATE_LIMIT_EXCEEDED');
        break;
      }
    }
    assert.ok(hitRateLimitVoucher, 'Xem voucher phải kích hoạt 429 khi vượt ngưỡng');
  });

  it('7. Audit được ghi nhận đầy đủ cho SEARCH_USERS, VIEW_USER_VOUCHERS, USE_VOUCHER (không ghi PII)', async () => {
    // Thực hiện search
    await apiRequest('GET', '/users/search?keyword=Thử Nghiệm', {
      token: admin1Token,
    });

    // Thực hiện view vouchers
    await apiRequest('GET', `/vouchers/user/${patient1.id}`, {
      token: admin1Token,
    });

    // Tạo voucher để test use
    const uv = await UserVoucher.create({
      id: 701,
      voucherId: 88,
      userId: patient1.id,
      voucherCode: 'VC_AUDIT_TEST',
      voucherName: 'Voucher Kiểm Tra Audit',
      discountValue: 20000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: false,
    });

    // Thực hiện use voucher
    await apiRequest('POST', `/vouchers/${uv.id}/use?userId=${patient1.id}`, {
      token: admin1Token,
    });

    const searchLogs = await AuditLog.find({ action: AUDIT_ACTIONS.SEARCH_USERS }).lean();
    assert.equal(searchLogs.length, 1);
    assert.ok(searchLogs[0].changes?.keywordHash);
    assert.ok(!searchLogs[0].reason.includes('patient1_hard@gmail.com'));

    const viewLogs = await AuditLog.find({ action: AUDIT_ACTIONS.VIEW_USER_VOUCHERS }).lean();
    assert.equal(viewLogs.length, 1);
    assert.equal(viewLogs[0].targetId, patient1.id);

    const useLogs = await AuditLog.find({ action: AUDIT_ACTIONS.USE_VOUCHER }).lean();
    assert.equal(useLogs.length, 1);
    assert.equal(useLogs[0].targetId, uv.id);
  });

  it('8. Dùng voucher song song: chỉ 1 lần update thành công (conditional update used=false->true)', async () => {
    const concurrentUv = await UserVoucher.create({
      id: 702,
      voucherId: 89,
      userId: patient1.id,
      voucherCode: 'VC_RACE_CONCURRENT',
      voucherName: 'Voucher Đua Song Song',
      discountValue: 30000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: false,
    });

    // Gửi 5 request đồng thời
    const promises = Array.from({ length: 5 }).map(() =>
      apiRequest('POST', `/vouchers/${concurrentUv.id}/use?userId=${patient1.id}`, {
        token: receptionist1Token,
      }),
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.equal(res.body.used, true);
    }

    // Chỉ có đúng 1 audit log USE_VOUCHER cho việc chuyển used từ false sang true
    const useAuditLogs = await AuditLog.find({
      action: AUDIT_ACTIONS.USE_VOUCHER,
      targetId: concurrentUv.id,
    }).lean();
    assert.equal(useAuditLogs.length, 1, 'Chỉ được ghi đúng 1 audit USE_VOUCHER khi dùng voucher lần đầu');

    const inDb = await UserVoucher.findOne({ id: concurrentUv.id }).lean();
    assert.equal(inDb.used, true);
  });

  it('9. Voucher hết hạn hoặc bị disabled bị từ chối 400', async () => {
    // 9.1 Voucher của user đã hết hạn
    const expiredUv = await UserVoucher.create({
      id: 703,
      voucherId: 90,
      userId: patient1.id,
      voucherCode: 'VC_EXPIRED',
      voucherName: 'Voucher Quá Hạn',
      discountValue: 50000,
      type: 'DISCOUNT',
      expiryDate: new Date('2020-01-01T00:00:00Z'),
      used: false,
    });

    const resExpired = await apiRequest('POST', `/vouchers/${expiredUv.id}/use?userId=${patient1.id}`, {
      token: receptionist1Token,
    });
    assert.equal(resExpired.status, 400);
    assert.equal(resExpired.body.error?.code, 'VOUCHER_EXPIRED');

    // 9.2 Voucher cha bị disabled
    await Voucher.create({
      id: 91,
      code: 'PARENT_DISABLED',
      name: 'Voucher Gốc Bị Khóa',
      discountValue: 100000,
      enable: false,
      expiryDate: new Date('2026-12-31T23:59:59Z'),
    });

    const disabledUv = await UserVoucher.create({
      id: 704,
      voucherId: 91,
      userId: patient1.id,
      voucherCode: 'PARENT_DISABLED',
      voucherName: 'Voucher Thuộc Loại Bị Khóa',
      discountValue: 100000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: false,
    });

    const resDisabled = await apiRequest('POST', `/vouchers/${disabledUv.id}/use?userId=${patient1.id}`, {
      token: receptionist1Token,
    });
    assert.equal(resDisabled.status, 400);
    assert.equal(resDisabled.body.error?.code, 'VOUCHER_DISABLED');
  });

  it('10. Role Patient/Doctor gọi tất cả các route trên -> 403', async () => {
    const endpoints = [
      { method: 'GET', path: '/users/search?keyword=Thử Nghiệm' },
      { method: 'GET', path: `/vouchers/user/${patient1.id}` },
      { method: 'POST', path: `/vouchers/701/use?userId=${patient1.id}` },
    ];

    for (const ep of endpoints) {
      // Patient gọi
      const resPat = await apiRequest(ep.method, ep.path, { token: patient1Token });
      assert.equal(resPat.status, 403, `Patient gọi ${ep.method} ${ep.path} phải bị 403`);

      // Doctor gọi
      const resDoc = await apiRequest(ep.method, ep.path, { token: doctor1Token });
      assert.equal(resDoc.status, 403, `Doctor gọi ${ep.method} ${ep.path} phải bị 403`);
    }
  });
});
