const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_rec_01_test_secret_key';
process.env.RECEPTION_SEARCH_RATE_PER_MIN = '5';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_rec_01';

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

describe('UC-REC-01: Lễ tân tra cứu user và voucher', () => {
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
    if (server) await new Promise((r) => server.close(r));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({});
  });

  it('1. Mask email và số điện thoại chính xác', () => {
    assert.equal(maskEmail('nguyenhung@gmail.com'), 'n***@gmail.com');
    assert.equal(maskEmail('a@gmail.com'), 'a***@gmail.com');
    assert.equal(maskPhone('0912345678'), '09****678');
    assert.equal(maskPhone('0901111222'), '09****222');
  });

  it('2. Search thành công theo keyword: chỉ trả trường tối thiểu, email & phone đã mask, không rò rỉ password/passwordHash/oauth', async () => {
    const res = await apiRequest('GET', '/users/search?keyword=Hoàng Nam', {
      token: receptionist1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 1);

    const user = res.body.data[0];
    assert.equal(user.id, patient1.id);
    assert.equal(user.fullName, 'Bệnh Nhân Phạm Hoàng Nam');
    // Đã che PII
    assert.equal(user.email, 'p***@gmail.com');
    assert.equal(user.phoneNumber, '09****678');
    assert.equal(user.role, ROLES.PATIENT);
    assert.equal(user.isEnabled, true);

    // Tuyệt đối không rò rỉ trường nhạy cảm
    assert.equal(user.password, undefined);
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.authProvider, undefined);
    assert.equal(user.googleId, undefined);
    assert.equal(user.medicalHistory, undefined);

    // Kiểm tra Audit Log: ghi nhận search mà không lưu keyword thô
    const logs = await AuditLog.find({ action: AUDIT_ACTIONS.SEARCH_USERS }).lean();
    assert.equal(logs.length, 1);
    assert.ok(logs[0].changes?.keywordHash);
    assert.equal(logs[0].changes?.resultCount, 1);
  });

  it('3. Keyword ngắn hơn 3 ký tự hoặc rỗng -> 400 INVALID_KEYWORD_LENGTH', async () => {
    const resEmpty = await apiRequest('GET', '/users/search?keyword=', {
      token: receptionist1Token,
    });
    assert.equal(resEmpty.status, 400);
    assert.equal(resEmpty.body.error?.code, 'INVALID_KEYWORD_LENGTH');

    const resShort = await apiRequest('GET', '/users/search?keyword=ab', {
      token: receptionist1Token,
    });
    assert.equal(resShort.status, 400);
    assert.equal(resShort.body.error?.code, 'INVALID_KEYWORD_LENGTH');
  });

  it('4. Keyword là wildcard toàn bộ (ví dụ ".*" hoặc "*") -> 400 INVALID_KEYWORD_FORMAT', async () => {
    const resWildcard = await apiRequest('GET', '/users/search?keyword=.*.*', {
      token: receptionist1Token,
    });
    assert.equal(resWildcard.status, 400);
    assert.equal(resWildcard.body.error?.code, 'INVALID_KEYWORD_FORMAT');
  });

  it('5. Phân trang và giới hạn limit tối đa 20', async () => {
    // Tạo thêm 25 users để test paging
    const bulkUsers = [];
    for (let i = 1; i <= 25; i++) {
      bulkUsers.push({
        id: 200 + i,
        email: `searchuser${i}@test.com`,
        password: 'hashedpassword',
        fullName: `Tìm Kiếm Bệnh Nhân ${i}`,
        phoneNumber: `09876543${String(i).padStart(2, '0')}`,
        userType: ROLES.PATIENT,
      });
    }
    await User.insertMany(bulkUsers);

    // Request limit = 100 -> backend phải ép tối đa 20
    const resMaxLimit = await apiRequest('GET', '/users/search?keyword=Tìm Kiếm&limit=100', {
      token: receptionist1Token,
    });
    assert.equal(resMaxLimit.status, 200);
    assert.equal(resMaxLimit.body.data.length, 20);
    assert.equal(resMaxLimit.body.pagination.limit, 20);
    assert.equal(resMaxLimit.body.pagination.total, 25);
    assert.equal(resMaxLimit.body.pagination.totalPages, 2);

    // Page 2 lấy 5 item còn lại
    const resPage2 = await apiRequest('GET', '/users/search?keyword=Tìm Kiếm&page=2&limit=20', {
      token: receptionist1Token,
    });
    assert.equal(resPage2.status, 200);
    assert.equal(resPage2.body.data.length, 5);
  });

  it('6. Role sai (PATIENT, DOCTOR) gọi /users/search bị từ chối 403', async () => {
    const resPatient = await apiRequest('GET', '/users/search?keyword=Hoàng Nam', {
      token: patient1Token,
    });
    assert.equal(resPatient.status, 403);

    const resDoctor = await apiRequest('GET', '/users/search?keyword=Hoàng Nam', {
      token: doctor1Token,
    });
    assert.equal(resDoctor.status, 403);
  });

  it('7. Xem danh sách voucher của user (GET /vouchers/user/:userId)', async () => {
    // Tạo 2 voucher cho patient1
    await UserVoucher.create({
      id: 501,
      voucherId: 10,
      userId: patient1.id,
      voucherCode: 'VC_TET_2026',
      voucherName: 'Giảm 50k Khám Tổng Quát',
      discountValue: 50000,
      type: 'DISCOUNT',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: false,
    });

    await UserVoucher.create({
      id: 502,
      voucherId: 11,
      userId: patient1.id,
      voucherCode: 'VC_FREE_TEST',
      voucherName: 'Miễn phí xét nghiệm đường huyết',
      discountValue: 100000,
      type: 'SERVICE_TICKET',
      expiryDate: new Date('2026-12-31T23:59:59Z'),
      used: true,
      usedAt: new Date('2026-10-31T10:00:00Z'),
    });

    const res = await apiRequest('GET', `/vouchers/user/${patient1.id}`, {
      token: receptionist1Token,
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);

    const v1 = res.body.find((v) => v.code === 'VC_TET_2026');
    assert.ok(v1);
    assert.equal(v1.name, 'Giảm 50k Khám Tổng Quát');
    assert.equal(v1.discountValue, 50000);
    assert.equal(v1.type, 'DISCOUNT');
    assert.equal(v1.used, false);
    assert.equal(v1.usedAt, null);

    const v2 = res.body.find((v) => v.code === 'VC_FREE_TEST');
    assert.ok(v2);
    assert.equal(v2.used, true);
    assert.ok(v2.usedAt);

    // Kiểm tra Audit Log xem voucher
    const logs = await AuditLog.find({ action: AUDIT_ACTIONS.VIEW_USER_VOUCHERS }).lean();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].targetId, patient1.id);
  });

  it('8. Đánh dấu sử dụng voucher tại quầy (POST /vouchers/:voucherId/use?userId=...) idempotent', async () => {
    const resUse = await apiRequest('POST', `/vouchers/501/use?userId=${patient1.id}`, {
      token: receptionist1Token,
    });

    assert.equal(resUse.status, 200);
    assert.equal(resUse.body.used, true);
    assert.ok(resUse.body.usedAt);

    // DB đã cập nhật
    const updatedInDb = await UserVoucher.findOne({ id: 501 }).lean();
    assert.equal(updatedInDb.used, true);
    assert.ok(updatedInDb.usedAt);

    // Gọi lại lần 2 (idempotent)
    const resUseAgain = await apiRequest('POST', `/vouchers/501/use?userId=${patient1.id}`, {
      token: receptionist1Token,
    });
    assert.equal(resUseAgain.status, 200);
    assert.equal(resUseAgain.body.used, true);
  });

  it('9. Rate limit: gửi liên tiếp quá giới hạn cho phép -> 429 RATE_LIMIT_EXCEEDED', async () => {
    // Kích hoạt test rate limit bằng header 'x-test-rate-limit': '1'
    // Giới hạn cấu hình RECEPTION_SEARCH_RATE_PER_MIN = 5
    let lastStatus = 200;
    for (let i = 0; i < 7; i++) {
      const res = await apiRequest('GET', '/users/search?keyword=Hoàng Nam', {
        token: receptionist1Token,
        headers: { 'x-test-rate-limit': '1' },
      });
      lastStatus = res.status;
      if (res.status === 429) {
        assert.equal(res.body.error?.code, 'RATE_LIMIT_EXCEEDED');
        assert.ok(res.headers.get('retry-after'));
        break;
      }
    }
    assert.equal(lastStatus, 429);
  });
});
