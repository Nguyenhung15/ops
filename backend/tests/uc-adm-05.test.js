const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Isolate test database BEFORE loading app & models
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_adm_05_test_secret';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI_ADM05 ||
  'mongodb://127.0.0.1:27017/clinic_booking_test_uc_adm_05';

const app = require('../src/app');
const {
  User,
  Voucher,
  UserVoucher,
  Event,
  UserEvent,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS, VOUCHER_TYPES } = require('../src/constants/enums');

let server;
let baseUrl;
let adminToken;
let receptionistToken;
let patientToken;

let testPatientId;
let createdVoucherId;
let createdEventId;

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

describe('UC-ADM-05: Quản lý event/voucher (Admin Event & Voucher Management)', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    const passwordHash = await bcrypt.hash('Secret@123', 10);

    // 1. Seed Admin User
    await User.create({
      email: 'admin.event@clinic.com',
      password: passwordHash,
      fullName: 'Quản trị viên Chiến dịch',
      userType: ROLES.ADMIN,
      gender: 'Male',
      isEnable: true,
    });

    // 2. Seed Receptionist User
    await User.create({
      email: 'reception.event@clinic.com',
      password: passwordHash,
      fullName: 'Lễ tân Tiếp đón',
      userType: ROLES.RECEPTIONIST,
      gender: 'Female',
      isEnable: true,
    });

    // 3. Seed Patient User
    const patient = await User.create({
      email: 'patient.event@clinic.com',
      password: passwordHash,
      fullName: 'Bệnh nhân Thử nghiệm',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });
    testPatientId = patient.id;

    // 4. Start test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    // 5. Login all personas
    const adminLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'admin.event@clinic.com', password: 'Secret@123' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.data.token;

    const receptionLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'reception.event@clinic.com', password: 'Secret@123' },
    });
    assert.equal(receptionLogin.status, 200);
    receptionistToken = receptionLogin.body.data.token;

    const patientLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'patient.event@clinic.com', password: 'Secret@123' },
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

  describe('1. Phân quyền (Authorization)', () => {
    it('Bệnh nhân không có quyền tạo voucher (POST /vouchers/create -> 403)', async () => {
      const res = await apiRequest('POST', '/vouchers/create', {
        token: patientToken,
        body: { code: 'TEST_FORBIDDEN', type: 'DISCOUNT', discountValue: 10 },
      });
      assert.equal(res.status, 403);
    });

    it('Bệnh nhân không có quyền tạo event (POST /events/create -> 403)', async () => {
      const res = await apiRequest('POST', '/events/create', {
        token: patientToken,
        body: { title: 'Test Forbidden', startDate: '2026-11-01', endDate: '2026-11-02' },
      });
      assert.equal(res.status, 403);
    });

    it('Lễ tân không có quyền xóa voucher (DELETE /vouchers/delete/1 -> 403)', async () => {
      const res = await apiRequest('DELETE', '/vouchers/delete/1', {
        token: receptionistToken,
      });
      assert.equal(res.status, 403);
    });
  });

  describe('2. Quản lý Voucher (Voucher CRUD & Unique Constraint)', () => {
    it('Báo lỗi 400 nếu thiếu mã voucher (code) hoặc discountValue không hợp lệ', async () => {
      const res1 = await apiRequest('POST', '/vouchers/create', {
        token: adminToken,
        body: { code: '', type: 'DISCOUNT', discountValue: 10 },
      });
      assert.equal(res1.status, 400);

      // DISCOUNT vượt quá 100%
      const res2 = await apiRequest('POST', '/vouchers/create', {
        token: adminToken,
        body: { code: 'INVALID_DISCOUNT', type: 'DISCOUNT', discountValue: 150 },
      });
      assert.equal(res2.status, 400);
    });

    it('Admin tạo voucher thành công hỗ trợ định dạng ngày dd/MM/yyyy HH:mm', async () => {
      const res = await apiRequest('POST', '/vouchers/create', {
        token: adminToken,
        body: {
          code: 'TRIAN2026',
          name: 'Tri ân khách hàng tháng 11',
          discountValue: 20,
          type: 'DISCOUNT',
          enable: true,
          expiryDate: '30/11/2026 23:59',
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.code, 'TRIAN2026');
      assert.equal(res.body.data.discountValue, 20);
      assert.equal(res.body.data.type, 'DISCOUNT');
      assert.equal(res.body.data.enable, true);
      assert.ok(res.body.data.expiryDate);

      createdVoucherId = res.body.data.id;

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'Voucher',
        targetId: createdVoucherId,
        action: AUDIT_ACTIONS.VOUCHER_CREATE,
      }).lean();
      assert.ok(audit);
    });

    it('Ràng buộc Unique Code: Báo lỗi 409 nếu tạo voucher trùng mã đã tồn tại', async () => {
      const res = await apiRequest('POST', '/vouchers/create', {
        token: adminToken,
        body: {
          code: 'trian2026', // lowercase vẫn bị chuẩn hóa và trùng
          name: 'Voucher trùng',
          discountValue: 15,
          type: 'DISCOUNT',
        },
      });

      assert.equal(res.status, 409);
      assert.match(res.body.message, /đã tồn tại/i);
    });

    it('Admin cập nhật thông tin và vô hiệu hóa voucher (enable: false)', async () => {
      const res = await apiRequest('PUT', `/vouchers/update/${createdVoucherId}`, {
        token: adminToken,
        body: {
          name: 'Tri ân khách hàng (Đã cập nhật)',
          enable: false,
          discountValue: 25,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.name, 'Tri ân khách hàng (Đã cập nhật)');
      assert.equal(res.body.data.enable, false);
      assert.equal(res.body.data.discountValue, 25);

      // Verify AuditLog record disable
      const audit = await AuditLog.findOne({
        targetType: 'Voucher',
        targetId: createdVoucherId,
        action: AUDIT_ACTIONS.VOUCHER_DISABLE,
      }).sort({ createdAt: -1 }).lean();
      assert.ok(audit);

      // Mở lại voucher
      await apiRequest('PUT', `/vouchers/update/${createdVoucherId}`, {
        token: adminToken,
        body: { enable: true },
      });
    });

    it('Admin xem danh sách toàn bộ voucher và xem chi tiết theo ID', async () => {
      const listRes = await apiRequest('GET', '/vouchers/all', {
        token: adminToken,
      });
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.body.data));
      assert.ok(listRes.body.data.some((v) => v.id === createdVoucherId));

      const detailRes = await apiRequest('GET', `/vouchers/${createdVoucherId}`, {
        token: adminToken,
      });
      assert.equal(detailRes.status, 200);
      assert.equal(detailRes.body.data.id, createdVoucherId);
    });
  });

  describe('3. Quản lý Sự kiện (Event CRUD & Voucher Association)', () => {
    it('Báo lỗi 400 nếu thời gian kết thúc trước thời gian bắt đầu', async () => {
      const res = await apiRequest('POST', '/events/create', {
        token: adminToken,
        body: {
          title: 'Sự kiện sai ngày',
          startDate: '20/11/2026 10:00',
          endDate: '19/11/2026 10:00',
        },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /kết thúc phải sau/i);
    });

    it('Admin tạo sự kiện thành công có gắn voucher khuyến mãi', async () => {
      const res = await apiRequest('POST', '/events/create', {
        token: adminToken,
        body: {
          title: 'Ngày hội Sức khỏe Gia đình 2026',
          description: 'Khám tầm soát miễn phí và tặng voucher giảm giá',
          location: 'Tầng 1 - Sảnh chính Phòng khám',
          startDate: '15/11/2026 08:00',
          endDate: '15/11/2026 17:00',
          isEnabled: true,
          voucherId: createdVoucherId,
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.title, 'Ngày hội Sức khỏe Gia đình 2026');
      assert.equal(res.body.data.voucherId, createdVoucherId);
      assert.equal(res.body.data.voucherCode, 'TRIAN2026');
      assert.ok(res.body.data.startDate);
      assert.ok(res.body.data.endDate);

      createdEventId = res.body.data.id;

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'Event',
        targetId: createdEventId,
        action: AUDIT_ACTIONS.EVENT_CREATE,
      }).lean();
      assert.ok(audit);
    });

    it('Admin cập nhật thông tin sự kiện', async () => {
      const res = await apiRequest('PUT', `/events/update/${createdEventId}`, {
        token: adminToken,
        body: {
          location: 'Tầng 2 - Hội trường Phòng khám',
          description: 'Nội dung mô tả đã cập nhật',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.location, 'Tầng 2 - Hội trường Phòng khám');
    });

    it('Public / Bệnh nhân xem danh sách sự kiện mở và Admin xem toàn bộ', async () => {
      const publicRes = await apiRequest('GET', '/events');
      assert.equal(publicRes.status, 200);
      assert.ok(Array.isArray(publicRes.body.data));
      assert.ok(publicRes.body.data.some((e) => e.id === createdEventId));

      const adminRes = await apiRequest('GET', '/events/all', {
        token: adminToken,
      });
      assert.equal(adminRes.status, 200);
      assert.ok(adminRes.body.data.some((e) => e.id === createdEventId));
    });
  });

  describe('4. Đăng ký sự kiện, Check-in & Tự động phát hành Voucher', () => {
    it('Bệnh nhân đăng ký tham gia sự kiện thành công', async () => {
      const res = await apiRequest('POST', `/events/${createdEventId}/register`, {
        token: patientToken,
      });

      assert.equal(res.status, 200);
      assert.match(res.body.message, /thành công/i);

      // Verify patient personal event list
      const myEvents = await apiRequest('GET', '/events/my', {
        token: patientToken,
      });
      assert.equal(myEvents.status, 200);
      assert.ok(myEvents.body.data.some((e) => e.eventId === createdEventId && e.status === 'PENDING'));
    });

    it('Báo lỗi 400 nếu bệnh nhân đăng ký lại sự kiện đã đăng ký', async () => {
      const res = await apiRequest('POST', `/events/${createdEventId}/register`, {
        token: patientToken,
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /đã đăng ký/i);
    });

    it('Lễ tân và Admin theo dõi danh sách người đăng ký sự kiện (GET /reception/events)', async () => {
      const res = await apiRequest('GET', '/reception/events', {
        token: receptionistToken,
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      const targetEvent = res.body.data.find((e) => e.id === createdEventId);
      assert.ok(targetEvent);
      assert.ok(Array.isArray(targetEvent.registrations));
      assert.equal(targetEvent.registrations.length, 1);
      assert.equal(targetEvent.registrations[0].userId, testPatientId);
      assert.equal(targetEvent.registrations[0].status, 'PENDING');
    });

    it('Lễ tân check-in cho bệnh nhân: UserEvent sang CONFIRMED và tự động tặng voucher', async () => {
      const res = await apiRequest('POST', `/reception/events/${createdEventId}/confirm/${testPatientId}`, {
        token: receptionistToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'CONFIRMED');
      assert.ok(res.body.data.grantedVoucherId);

      // Kiểm tra bệnh nhân nhận được UserVoucher
      const patientVouchers = await apiRequest('GET', '/vouchers/my', {
        token: patientToken,
      });
      assert.equal(patientVouchers.status, 200);
      const granted = patientVouchers.body.data.find((uv) => uv.voucherId === createdVoucherId);
      assert.ok(granted, 'Bệnh nhân phải nhận được voucher tự động từ sự kiện');
      assert.equal(granted.voucherCode, 'TRIAN2026');
      assert.equal(granted.used, false);
    });

    it('Admin/Lễ tân theo dõi danh sách người sở hữu voucher và voucher của bệnh nhân', async () => {
      const ownersRes = await apiRequest('GET', `/vouchers/${createdVoucherId}/owners`, {
        token: adminToken,
      });
      assert.equal(ownersRes.status, 200);
      assert.ok(ownersRes.body.data.some((uv) => uv.userId === testPatientId));

      const userVoucherRes = await apiRequest('GET', `/vouchers/user/${testPatientId}`, {
        token: receptionistToken,
      });
      assert.equal(userVoucherRes.status, 200);
      assert.ok(userVoucherRes.body.data.some((uv) => uv.voucherId === createdVoucherId));
    });

    it('Lễ tân/Admin sử dụng voucher cho bệnh nhân (Redeem voucher)', async () => {
      const res = await apiRequest('POST', `/vouchers/${createdVoucherId}/use?userId=${testPatientId}`, {
        token: receptionistToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.used, true);

      // Verify AuditLog for redemption
      const audit = await AuditLog.findOne({
        targetType: 'UserVoucher',
        action: AUDIT_ACTIONS.VOUCHER_REDEEM,
      }).lean();
      assert.ok(audit, 'Phải có audit log VOUCHER_REDEEM');

      // Cố gắng sử dụng lại voucher đã dùng -> 400
      const retryRes = await apiRequest('POST', `/vouchers/${createdVoucherId}/use?userId=${testPatientId}`, {
        token: receptionistToken,
      });
      assert.equal(retryRes.status, 400);
    });
  });

  describe('5. Ràng buộc bảo toàn lịch sử (No Hard Delete on Redemption / Participants)', () => {
    it('Xóa voucher đã phát sinh lịch sử sở hữu/redemption: Tự động vô hiệu hóa (Soft Disable), không xóa cứng', async () => {
      const res = await apiRequest('DELETE', `/vouchers/delete/${createdVoucherId}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.softDeleted, true);
      assert.match(res.body.message, /bảo toàn lịch sử/i);

      // Verify voucher still exists in database with enable = false
      const v = await Voucher.findOne({ id: createdVoucherId }).lean();
      assert.ok(v, 'Voucher không được bị xóa khỏi DB');
      assert.equal(v.enable, false);

      // Lịch sử UserVoucher và redemption vẫn nguyên vẹn
      const uv = await UserVoucher.findOne({ voucherId: createdVoucherId }).lean();
      assert.ok(uv);
      assert.equal(uv.used, true);
    });

    it('Xóa sự kiện đã có người đăng ký: Tự động vô hiệu hóa (Soft Disable), không làm mất danh sách tham gia', async () => {
      const res = await apiRequest('DELETE', `/events/delete/${createdEventId}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.softDeleted, true);
      assert.match(res.body.message, /bảo toàn lịch sử/i);

      // Verify event still exists in DB with isEnabled = false
      const e = await Event.findOne({ id: createdEventId }).lean();
      assert.ok(e);
      assert.equal(e.isEnabled, false);

      // Danh sách người đăng ký vẫn còn nguyên vẹn
      const ue = await UserEvent.findOne({ eventId: createdEventId }).lean();
      assert.ok(ue);
      assert.equal(ue.status, 'CONFIRMED');
    });

    it('Xóa cứng thành công voucher rỗng (chưa từng cấp và chưa gắn sự kiện)', async () => {
      const newVoucher = await apiRequest('POST', '/vouchers/create', {
        token: adminToken,
        body: { code: 'EMPTY_VOUCHER', type: 'SERVICE_TICKET', discountValue: 50 },
      });
      assert.equal(newVoucher.status, 201);
      const emptyId = newVoucher.body.data.id;

      const deleteRes = await apiRequest('DELETE', `/vouchers/delete/${emptyId}`, {
        token: adminToken,
      });
      assert.equal(deleteRes.status, 200);
      assert.equal(deleteRes.body.data.deleted, true);

      const found = await Voucher.findOne({ id: emptyId }).lean();
      assert.equal(found, null);
    });

    it('Xóa cứng thành công sự kiện rỗng (chưa có người đăng ký)', async () => {
      const newEvent = await apiRequest('POST', '/events/create', {
        token: adminToken,
        body: {
          title: 'Sự kiện rỗng',
          startDate: '25/11/2026 09:00',
          endDate: '25/11/2026 12:00',
        },
      });
      assert.equal(newEvent.status, 201);
      const emptyEventId = newEvent.body.data.id;

      const deleteRes = await apiRequest('DELETE', `/events/delete/${emptyEventId}`, {
        token: adminToken,
      });
      assert.equal(deleteRes.status, 200);
      assert.equal(deleteRes.body.data.deleted, true);

      const found = await Event.findOne({ id: emptyEventId }).lean();
      assert.equal(found, null);
    });
  });
});
