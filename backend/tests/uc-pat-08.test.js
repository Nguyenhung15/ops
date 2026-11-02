const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_pat_08_test_jwt_secret_key';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_pat_08';

const app = require('../src/app');
const {
  User,
  Event,
  EventRegistration,
  Voucher,
  AuditLog,
  OutboxEvent,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');

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

describe('UC-PAT-08: Patient đăng ký sự kiện (/events)', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    // Ensure model indexes are created (especially unique index eventId+userId)
    await EventRegistration.init();
    await Event.init();

    // Thiết lập fake clock cố định tại 2026-11-01T10:00:00Z
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
      id: 801,
      email: 'patient1_pat08@gmail.com',
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
      id: 802,
      email: 'patient2_pat08@gmail.com',
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
      id: 803,
      email: 'doctor1_pat08@clinic.com',
      password: hashedPassword,
      fullName: 'BS. Lê Trọng',
      phoneNumber: '0901111222',
      userType: ROLES.DOCTOR,
    });
    doctor1Token = signAccessToken({
      userId: doctor1.id,
      email: doctor1.email,
      userType: doctor1.userType,
    });

    receptionist1 = await User.create({
      id: 804,
      email: 'rec1_pat08@clinic.com',
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
    await OutboxEvent.deleteMany({});
  });

  it('1. Đăng ký sự kiện thành công: tạo registration PENDING, ghi outbox và audit REGISTER_EVENT', async () => {
    // Tạo voucher liên kết
    await Voucher.create({
      id: 50,
      code: 'VC_EVENT_50',
      name: 'Voucher Khám Miễn Phí 50k',
      discountValue: 50000,
      enable: true,
      expiryDate: new Date('2026-12-31T23:59:59Z'),
    });

    // Tạo event đang mở
    const ev = await Event.create({
      id: 901,
      title: 'Hội Thảo Sức Khỏe Cộng Đồng 2026',
      description: 'Khám và tư vấn miễn phí',
      location: 'Hội trường Tầng 3',
      startDate: new Date('2026-11-01T08:00:00Z'),
      endDate: new Date('2026-11-01T18:00:00Z'),
      isEnabled: true,
      voucherId: 50,
      capacity: 100,
      registeredCount: 0,
    });

    const res = await apiRequest('POST', `/events/${ev.id}/register`, {
      token: patient1Token,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.eventId, ev.id);
    assert.equal(res.body.data.userId, patient1.id);
    assert.equal(res.body.data.status, 'PENDING');
    assert.ok(res.body.data.registeredAt);

    // Kiểm tra DB registration
    const regInDb = await EventRegistration.findOne({ eventId: ev.id, userId: patient1.id }).lean();
    assert.ok(regInDb);
    assert.equal(regInDb.status, 'PENDING');

    // Kiểm tra registeredCount tăng lên 1
    const eventInDb = await Event.findOne({ id: ev.id }).lean();
    assert.equal(eventInDb.registeredCount, 1);

    // Kiểm tra Audit Log
    const auditLogs = await AuditLog.find({ action: AUDIT_ACTIONS.REGISTER_EVENT }).lean();
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].actorId, patient1.id);
    assert.equal(auditLogs[0].targetType, 'EventRegistration');

    // Kiểm tra Outbox Event
    const outboxEvents = await OutboxEvent.find({ eventType: 'EVENT_REGISTRATION_CREATED' }).lean();
    assert.equal(outboxEvents.length, 1);
    assert.equal(outboxEvents[0].payload.eventId, ev.id);
    assert.equal(outboxEvents[0].payload.userId, patient1.id);
  });

  it('2. Đăng ký trùng sự kiện -> 409 ALREADY_REGISTERED', async () => {
    // patient1 đã đăng ký event 901 ở test 1
    const res = await apiRequest('POST', '/events/901/register', {
      token: patient1Token,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'ALREADY_REGISTERED');
  });

  it('3. Sự kiện không tồn tại -> 404 EVENT_NOT_FOUND', async () => {
    const res = await apiRequest('POST', '/events/99999/register', {
      token: patient1Token,
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.error?.code, 'EVENT_NOT_FOUND');
  });

  it('4. Sự kiện bị đóng hoặc quá hạn -> 409 EVENT_CLOSED', async () => {
    // 4.1 Sự kiện có isEnabled = false
    const disabledEv = await Event.create({
      id: 902,
      title: 'Sự Kiện Đã Khóa',
      startDate: new Date('2026-11-01T08:00:00Z'),
      endDate: new Date('2026-11-01T18:00:00Z'),
      isEnabled: false,
    });

    const resDisabled = await apiRequest('POST', `/events/${disabledEv.id}/register`, {
      token: patient2Token,
    });
    assert.equal(resDisabled.status, 409);
    assert.equal(resDisabled.body.error?.code, 'EVENT_CLOSED');

    // 4.2 Sự kiện đã quá hạn (endDate < now)
    const expiredEv = await Event.create({
      id: 903,
      title: 'Sự Kiện Quá Hạn',
      startDate: new Date('2026-10-01T08:00:00Z'),
      endDate: new Date('2026-10-01T18:00:00Z'),
      isEnabled: true,
    });

    const resExpired = await apiRequest('POST', `/events/${expiredEv.id}/register`, {
      token: patient2Token,
    });
    assert.equal(resExpired.status, 409);
    assert.equal(resExpired.body.error?.code, 'EVENT_CLOSED');

    // 4.3 Sự kiện chưa bắt đầu (startDate > now, now <= endDate) -> Cho phép đăng ký trước (chính sách FIX-2)
    const futureEv = await Event.create({
      id: 904,
      title: 'Sự Kiện Chưa Bắt Đầu',
      startDate: new Date('2026-12-01T08:00:00Z'),
      endDate: new Date('2026-12-01T18:00:00Z'),
      isEnabled: true,
    });

    const resFuture = await apiRequest('POST', `/events/${futureEv.id}/register`, {
      token: patient2Token,
    });
    assert.equal(resFuture.status, 201);
    assert.equal(resFuture.body.data.eventId, futureEv.id);
  });

  it('5. Sự kiện hết chỗ -> 409 EVENT_FULL', async () => {
    const fullEv = await Event.create({
      id: 905,
      title: 'Sự Kiện Đã Kín Chỗ',
      startDate: new Date('2026-11-01T08:00:00Z'),
      endDate: new Date('2026-11-01T18:00:00Z'),
      isEnabled: true,
      capacity: 1,
      registeredCount: 1,
    });

    const resFull = await apiRequest('POST', `/events/${fullEv.id}/register`, {
      token: patient2Token,
    });
    assert.equal(resFull.status, 409);
    assert.equal(resFull.body.error?.code, 'EVENT_FULL');
  });

  it('6. 2 request song song từ cùng 1 user: đúng 1 request thành công, 1 request trả 409', async () => {
    const evRace = await Event.create({
      id: 906,
      title: 'Sự Kiện Đua Trùng User',
      startDate: new Date('2026-11-01T08:00:00Z'),
      endDate: new Date('2026-11-01T18:00:00Z'),
      isEnabled: true,
      capacity: 50,
      registeredCount: 0,
    });

    const [resA, resB] = await Promise.all([
      apiRequest('POST', `/events/${evRace.id}/register`, { token: patient2Token }),
      apiRequest('POST', `/events/${evRace.id}/register`, { token: patient2Token }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [201, 409], 'Một request phải 201, một request phải 409');

    // Chỉ có duy nhất 1 bản ghi trong DB
    const count = await EventRegistration.countDocuments({ eventId: evRace.id, userId: patient2.id });
    assert.equal(count, 1);

    // registeredCount chỉ tăng đúng 1
    const inDb = await Event.findOne({ id: evRace.id }).lean();
    assert.equal(inDb.registeredCount, 1);
  });

  it('7. N request song song vào event chỉ còn đúng 1 chỗ: đúng 1 thành công, N-1 bị 409 EVENT_FULL', async () => {
    // Tạo event capacity = 5, registeredCount = 4 (còn đúng 1 chỗ)
    const limitedEv = await Event.create({
      id: 907,
      title: 'Sự Kiện Còn 1 Chỗ',
      startDate: new Date('2026-11-01T08:00:00Z'),
      endDate: new Date('2026-11-01T18:00:00Z'),
      isEnabled: true,
      capacity: 5,
      registeredCount: 4,
    });

    // Tạo 5 patients khác nhau
    const candidates = [];
    for (let i = 1; i <= 5; i++) {
      const u = await User.create({
        id: 850 + i,
        email: `candidate${i}@pat08.com`,
        password: 'Password@123',
        fullName: `Ứng Viên ${i}`,
        phoneNumber: `093333333${i}`,
        userType: ROLES.PATIENT,
      });
      const t = signAccessToken({ userId: u.id, email: u.email, userType: u.userType });
      candidates.push({ user: u, token: t });
    }

    // Gửi 5 request đồng thời
    const results = await Promise.all(
      candidates.map((c) => apiRequest('POST', `/events/${limitedEv.id}/register`, { token: c.token })),
    );

    const successList = results.filter((r) => r.status === 201);
    const fullList = results.filter((r) => r.status === 409 && r.body.error?.code === 'EVENT_FULL');

    assert.equal(successList.length, 1, 'Chỉ duy nhất 1 request chiếm được chỗ cuối');
    assert.equal(fullList.length, 4, '4 request còn lại phải nhận 409 EVENT_FULL');

    // registeredCount đúng bằng capacity = 5
    const finalEv = await Event.findOne({ id: limitedEv.id }).lean();
    assert.equal(finalEv.registeredCount, 5);
  });

  it('8. GET /events/my: chỉ trả đăng ký của user trong JWT, không lộ của người khác, kèm status và event info', async () => {
    const res = await apiRequest('GET', '/events/my', {
      token: patient1Token,
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);

    // Tất cả items thuộc về event mà patient1 đã đăng ký (901)
    for (const item of res.body.data) {
      assert.equal(item.eventId, 901);
      assert.equal(item.title, 'Hội Thảo Sức Khỏe Cộng Đồng 2026');
      assert.equal(item.status, 'PENDING');
      assert.ok(item.userEventId);
      assert.ok(item.registeredAt);
    }

    // Không chứa đăng ký của patient2 (event 906)
    const hasOtherEvent = res.body.data.some((item) => item.eventId === 906);
    assert.equal(hasOtherEvent, false, 'Không được lộ đăng ký sự kiện của người khác');
  });

  it('9. GET /events: danh sách sự kiện mở, kèm registrationStatus nếu user đã đăng nhập', async () => {
    const res = await apiRequest('GET', '/events', {
      token: patient1Token,
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));

    const ev901 = res.body.data.find((e) => e.id === 901);
    assert.ok(ev901);
    assert.equal(ev901.registrationStatus, 'PENDING');
    assert.equal(ev901.voucherCode, 'VC_EVENT_50');
  });

  it('10. Phân quyền: Role sai (Doctor, Receptionist) hoặc chưa đăng nhập bị từ chối 403 / 401', async () => {
    // 10.1 Chưa đăng nhập -> 401
    const resNoAuth = await apiRequest('POST', '/events/901/register');
    assert.equal(resNoAuth.status, 401);

    const resNoAuthMy = await apiRequest('GET', '/events/my');
    assert.equal(resNoAuthMy.status, 401);

    // 10.2 Doctor gọi -> 403
    const resDocReg = await apiRequest('POST', '/events/901/register', { token: doctor1Token });
    assert.equal(resDocReg.status, 403);

    const resDocMy = await apiRequest('GET', '/events/my', { token: doctor1Token });
    assert.equal(resDocMy.status, 403);

    // 10.3 Receptionist gọi -> 403
    const resRecReg = await apiRequest('POST', '/events/901/register', { token: receptionist1Token });
    assert.equal(resRecReg.status, 403);

    const resRecMy = await apiRequest('GET', '/events/my', { token: receptionist1Token });
    assert.equal(resRecMy.status, 403);
  });
});
