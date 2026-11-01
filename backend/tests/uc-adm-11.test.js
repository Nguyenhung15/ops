const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Isolate test database BEFORE loading app & models
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_adm_11_test_secret';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI_ADM11 ||
  'mongodb://127.0.0.1:27017/clinic_booking_test_uc_adm_11';

const app = require('../src/app');
const {
  User,
  Feedback,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS, FEEDBACK_STATUSES } = require('../constants/enums');

let server;
let baseUrl;
let adminToken;
let doctorToken;
let patient1Token;
let patient2Token;

let testPatient1Id;
let testPatient2Id;
let createdFeedbackId;
let anonymousFeedbackId;

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

describe('UC-ADM-11: Quản lý feedback (Admin/Moderator Feedback Management)', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    const passwordHash = await bcrypt.hash('Secret@123', 10);

    // 1. Seed Admin User
    await User.create({
      email: 'admin.feedback@clinic.com',
      password: passwordHash,
      fullName: 'Quản trị viên Kiểm duyệt',
      userType: ROLES.ADMIN,
      gender: 'Male',
      isEnable: true,
    });

    // 2. Seed Doctor User
    await User.create({
      email: 'doctor.feedback@clinic.com',
      password: passwordHash,
      fullName: 'BS. Lê Thị Đánh Giá',
      userType: ROLES.DOCTOR,
      gender: 'Female',
      isEnable: true,
    });

    // 3. Seed Patient 1 User
    const p1 = await User.create({
      email: 'patient1.feedback@clinic.com',
      password: passwordHash,
      fullName: 'Nguyễn Văn Bệnh Nhân 1',
      userType: ROLES.PATIENT,
      gender: 'Male',
      isEnable: true,
    });
    testPatient1Id = p1.id;

    // 4. Seed Patient 2 User
    const p2 = await User.create({
      email: 'patient2.feedback@clinic.com',
      password: passwordHash,
      fullName: 'Trần Thị Bệnh Nhân 2',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });
    testPatient2Id = p2.id;

    // 5. Start test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    // 6. Login all personas
    const adminLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'admin.feedback@clinic.com', password: 'Secret@123' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.data.token;

    const doctorLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'doctor.feedback@clinic.com', password: 'Secret@123' },
    });
    assert.equal(doctorLogin.status, 200);
    doctorToken = doctorLogin.body.data.token;

    const p1Login = await apiRequest('POST', '/auth/login', {
      body: { email: 'patient1.feedback@clinic.com', password: 'Secret@123' },
    });
    assert.equal(p1Login.status, 200);
    patient1Token = p1Login.body.data.token;

    const p2Login = await apiRequest('POST', '/auth/login', {
      body: { email: 'patient2.feedback@clinic.com', password: 'Secret@123' },
    });
    assert.equal(p2Login.status, 200);
    patient2Token = p2Login.body.data.token;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  describe('1. Phân quyền truy cập (Authorization)', () => {
    it('Bệnh nhân không có quyền truy cập endpoint Admin Feedback (403 Forbidden)', async () => {
      const res = await apiRequest('GET', '/feedbacks/admin/all', {
        token: patient1Token,
      });
      assert.equal(res.status, 403);
    });

    it('Bác sĩ không có quyền gọi endpoint phản hồi của Admin (403 Forbidden)', async () => {
      const res = await apiRequest('POST', '/feedbacks/admin/1/respond', {
        token: doctorToken,
        body: { adminResponse: 'Cảm ơn bạn' },
      });
      assert.equal(res.status, 403);
    });

    it('Bác sĩ không có quyền ẩn/công bố feedback của Admin (403 Forbidden)', async () => {
      const res = await apiRequest('PUT', '/feedbacks/admin/1/status', {
        token: doctorToken,
        body: { status: 'HIDDEN' },
      });
      assert.equal(res.status, 403);
    });
  });

  describe('2. Bệnh nhân gửi đánh giá (Patient Feedback Submission)', () => {
    it('Báo lỗi 400 nếu rating không nằm trong khoảng 1 đến 5 hoặc comment rỗng', async () => {
      const res1 = await apiRequest('POST', '/feedbacks', {
        token: patient1Token,
        body: { rating: 6, comment: 'Dịch vụ tốt' },
      });
      assert.equal(res1.status, 400);

      const res2 = await apiRequest('POST', '/feedbacks', {
        token: patient1Token,
        body: { rating: 5, comment: '   ' },
      });
      assert.equal(res2.status, 400);
    });

    it('Bệnh nhân 1 gửi đánh giá công khai danh tính thành công', async () => {
      const res = await apiRequest('POST', '/feedbacks', {
        token: patient1Token,
        body: {
          rating: 5,
          title: 'Phòng khám rất chu đáo',
          comment: 'Bác sĩ và điều dưỡng nhiệt tình, thiết bị rất hiện đại.',
          category: 'Chất lượng khám chữa bệnh',
          isAnonymous: false,
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.rating, 5);
      assert.equal(res.body.data.comment, 'Bác sĩ và điều dưỡng nhiệt tình, thiết bị rất hiện đại.');
      assert.equal(res.body.data.patientName, 'Nguyễn Văn Bệnh Nhân 1');
      assert.equal(res.body.data.isOwner, true);

      createdFeedbackId = res.body.data.id;
    });

    it('Bệnh nhân 2 gửi đánh giá ẩn danh (isAnonymous: true) thành công', async () => {
      const res = await apiRequest('POST', '/feedbacks', {
        token: patient2Token,
        body: {
          rating: 3,
          title: 'Thời gian chờ hơi lâu',
          comment: 'Đợi vào phòng khám mất khoảng 30 phút, cần cải thiện khâu tiếp nhận.',
          category: 'Thời gian chờ đợi',
          isAnonymous: true,
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.rating, 3);
      assert.equal(res.body.data.isAnonymous, true);

      anonymousFeedbackId = res.body.data.id;
    });

    it('Công chúng xem danh sách đánh giá: Ẩn danh sẽ hiển thị "Bệnh nhân ẩn danh" và ẩn email', async () => {
      const res = await apiRequest('GET', '/feedbacks/public');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));

      const anon = res.body.data.find((f) => f.id === anonymousFeedbackId);
      assert.ok(anon);
      assert.equal(anon.patientName, 'Bệnh nhân ẩn danh');
      assert.equal(anon.patientEmail, undefined);
      assert.equal(anon.userId, undefined);

      const pub = res.body.data.find((f) => f.id === createdFeedbackId);
      assert.ok(pub);
      assert.equal(pub.patientName, 'Nguyễn Văn Bệnh Nhân 1');
    });

    it('Công chúng xem thống kê sao (GET /feedbacks/stats)', async () => {
      const res = await apiRequest('GET', '/feedbacks/stats');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.totalFeedbacks, 2);
      assert.equal(res.body.data.starCounts[5], 1);
      assert.equal(res.body.data.starCounts[3], 1);
      assert.equal(res.body.data.averageRating, 4.0); // (5 + 3) / 2 = 4.0
    });
  });

  describe('3. Admin xem và kiểm duyệt đánh giá (Admin View & Moderator Inspection)', () => {
    it('Admin xem danh sách toàn bộ đánh giá kèm thông tin tác giả thật dù là ẩn danh', async () => {
      const res = await apiRequest('GET', '/feedbacks/admin/all', {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.equal(res.body.data.length, 2);

      const anonAdminView = res.body.data.find((f) => f.id === anonymousFeedbackId);
      assert.ok(anonAdminView);
      // Admin luôn thấy được tác giả thật và email
      assert.equal(anonAdminView.patientName, 'Trần Thị Bệnh Nhân 2');
      assert.equal(anonAdminView.patientEmail, 'patient2.feedback@clinic.com');
      assert.equal(anonAdminView.userId, testPatient2Id);
      assert.equal(anonAdminView.isAnonymous, true);
    });

    it('Admin lọc danh sách đánh giá theo rating và category', async () => {
      const res = await apiRequest('GET', '/feedbacks/admin/all?rating=5', {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].id, createdFeedbackId);
    });

    it('Admin xem chi tiết đánh giá theo ID', async () => {
      const res = await apiRequest('GET', `/feedbacks/admin/${createdFeedbackId}`, {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, createdFeedbackId);
      assert.equal(res.body.data.status, 'APPROVED');
    });
  });

  describe('4. Admin phản hồi đánh giá & Không sửa nội dung gốc (Admin Response & Integrity)', () => {
    it('Báo lỗi 400 nếu nội dung phản hồi của Admin bị để trống', async () => {
      const res = await apiRequest('POST', `/feedbacks/admin/${createdFeedbackId}/respond`, {
        token: adminToken,
        body: { adminResponse: '   ' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /không được để trống/i);
    });

    it('Admin phản hồi đánh giá: ghi nhận actor và thời gian phản hồi', async () => {
      const res = await apiRequest('POST', `/feedbacks/admin/${createdFeedbackId}/respond`, {
        token: adminToken,
        body: {
          adminResponse: 'Phòng khám xin cảm ơn đánh giá của bạn. Chúng tôi sẽ tiếp tục duy trì chất lượng phục vụ.',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(
        res.body.data.adminResponse,
        'Phòng khám xin cảm ơn đánh giá của bạn. Chúng tôi sẽ tiếp tục duy trì chất lượng phục vụ.',
      );
      assert.ok(res.body.data.adminRespondedAt);
      assert.equal(res.body.data.adminRespondedBy, 1); // Admin ID

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'Feedback',
        targetId: createdFeedbackId,
        action: AUDIT_ACTIONS.FEEDBACK_RESPONSE,
      }).lean();
      assert.ok(audit, 'Phải có AuditLog FEEDBACK_RESPONSE');
      assert.equal(audit.actor.id, 1);
    });

    it('RÀNG BUỘC TOÀN VẸN: Phản hồi của Admin tuyệt đối không sửa đổi nội dung gốc của người gửi', async () => {
      // Đọc lại từ database
      const fb = await Feedback.findOne({ id: createdFeedbackId }).lean();
      assert.equal(fb.rating, 5, 'Rating gốc của bệnh nhân không được thay đổi');
      assert.equal(fb.title, 'Phòng khám rất chu đáo', 'Title gốc không được thay đổi');
      assert.equal(
        fb.comment,
        'Bác sĩ và điều dưỡng nhiệt tình, thiết bị rất hiện đại.',
        'Comment gốc của bệnh nhân không được thay đổi',
      );
      assert.equal(fb.userId, testPatient1Id, 'Tác giả gốc không được thay đổi');
      assert.equal(fb.category, 'Chất lượng khám chữa bệnh');
      assert.equal(fb.isAnonymous, false);
      assert.ok(fb.adminResponse);
    });

    it('Bệnh nhân xem đánh giá công khai có hiển thị lời phản hồi của Admin', async () => {
      const res = await apiRequest('GET', '/feedbacks/public');
      assert.equal(res.status, 200);
      const found = res.body.data.find((f) => f.id === createdFeedbackId);
      assert.ok(found);
      assert.equal(
        found.adminResponse,
        'Phòng khám xin cảm ơn đánh giá của bạn. Chúng tôi sẽ tiếp tục duy trì chất lượng phục vụ.',
      );
      assert.ok(found.adminRespondedAt);
    });
  });

  describe('5. Admin Ẩn / Công bố đánh giá (Moderation - Hide / Publish)', () => {
    it('Admin ẩn đánh giá (status: HIDDEN) ghi nhận actor/time và AuditLog', async () => {
      const res = await apiRequest('PUT', `/feedbacks/admin/${anonymousFeedbackId}/status`, {
        token: adminToken,
        body: {
          status: 'HIDDEN',
          reason: 'Nội dung phản ánh cần xác minh nội bộ thêm với bộ phận tiếp tân',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'HIDDEN');
      assert.ok(res.body.data.moderatedAt);
      assert.equal(res.body.data.moderatedBy, 1);

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'Feedback',
        targetId: anonymousFeedbackId,
        action: AUDIT_ACTIONS.FEEDBACK_HIDE,
      }).lean();
      assert.ok(audit, 'Phải có AuditLog FEEDBACK_HIDE');
    });

    it('Đánh giá bị ẩn (HIDDEN) không hiển thị trên Public và không tính vào Stats', async () => {
      // 1. Kiểm tra Public API
      const publicRes = await apiRequest('GET', '/feedbacks/public');
      assert.equal(publicRes.status, 200);
      const hiddenFound = publicRes.body.data.find((f) => f.id === anonymousFeedbackId);
      assert.equal(hiddenFound, undefined, 'Đánh giá bị ẩn không được xuất hiện trên Public');
      assert.equal(publicRes.body.data.length, 1);

      // 2. Kiểm tra Stats
      const statsRes = await apiRequest('GET', '/feedbacks/stats');
      assert.equal(statsRes.status, 200);
      assert.equal(statsRes.body.data.totalFeedbacks, 1, 'Chỉ tính đánh giá APPROVED');
      assert.equal(statsRes.body.data.starCounts[3], 0);
      assert.equal(statsRes.body.data.averageRating, 5.0);
    });

    it('Admin công bố lại đánh giá (status: APPROVED)', async () => {
      const res = await apiRequest('PUT', `/feedbacks/admin/${anonymousFeedbackId}/status`, {
        token: adminToken,
        body: { status: 'APPROVED' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'APPROVED');

      // Đánh giá xuất hiện lại trên Public
      const publicRes = await apiRequest('GET', '/feedbacks/public');
      assert.equal(publicRes.body.data.length, 2);
    });
  });

  describe('6. Bệnh nhân chỉnh sửa / xóa đánh giá & Admin xóa vi phạm', () => {
    it('Bệnh nhân 2 không có quyền sửa đánh giá của Bệnh nhân 1 (403 Forbidden)', async () => {
      const res = await apiRequest('PUT', `/feedbacks/${createdFeedbackId}`, {
        token: patient2Token,
        body: { comment: 'Hack sửa comment' },
      });
      assert.equal(res.status, 403);
    });

    it('Bệnh nhân 1 cập nhật thành công đánh giá của chính mình', async () => {
      const res = await apiRequest('PUT', `/feedbacks/${createdFeedbackId}`, {
        token: patient1Token,
        body: {
          rating: 4,
          comment: 'Bác sĩ và điều dưỡng nhiệt tình, thiết bị rất hiện đại. (Đã bổ sung ý kiến)',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.rating, 4);
      assert.equal(
        res.body.data.comment,
        'Bác sĩ và điều dưỡng nhiệt tình, thiết bị rất hiện đại. (Đã bổ sung ý kiến)',
      );

      // Phản hồi của admin trước đó vẫn được giữ nguyên
      assert.ok(res.body.data.adminResponse);
    });

    it('Admin có quyền xóa feedback vi phạm kèm AuditLog', async () => {
      const res = await apiRequest('DELETE', `/feedbacks/admin/${anonymousFeedbackId}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.deleted, true);

      // Verify DB removal
      const found = await Feedback.findOne({ id: anonymousFeedbackId }).lean();
      assert.equal(found, null);

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'Feedback',
        targetId: anonymousFeedbackId,
        action: AUDIT_ACTIONS.FEEDBACK_DELETE,
      }).lean();
      assert.ok(audit);
    });
  });
});
