const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'fix_2_test_secret_key';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_fix_2';

const app = require('../src/app');
const {
  User,
  Event,
  EventRegistration,
  Feedback,
  Appointment,
} = require('../src/models');
const { ROLES, FEEDBACK_STATUSES, APPOINTMENT_STATUSES } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');
const patientEventService = require('../src/services/patientEvent.service');
const feedbackService = require('../src/services/feedback.service');

let server;
let baseUrl;
let fakeClock;

let patient1;
let patient1Token;
let patient2;
let patient2Token;
let patient3;
let patient3Token;
let doctor1;

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
  return { status: res.status, headers: res.headers, body: json };
}

describe('FIX-2: Regression & Concurrency Tests for Events (PAT-08) and Feedbacks (PAT-12)', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    // Đồng hồ giả lập cố định lúc 2026-11-02T10:00:00Z
    fakeClock = createFakeClock(new Date('2026-11-02T10:00:00.000Z'));
    setClock(fakeClock);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    const hash = await bcrypt.hash('Secret@123', 8);

    patient1 = await User.create({
      email: 'fix2.patient1@test.com',
      password: hash,
      fullName: 'Bệnh Nhân Fix2 Một',
      userType: ROLES.PATIENT,
      gender: 'Male',
      isEnable: true,
    });
    patient1Token = signAccessToken(patient1);

    patient2 = await User.create({
      email: 'fix2.patient2@test.com',
      password: hash,
      fullName: 'Bệnh Nhân Fix2 Hai',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });
    patient2Token = signAccessToken(patient2);

    patient3 = await User.create({
      email: 'fix2.patient3@test.com',
      password: hash,
      fullName: 'Bệnh Nhân Fix2 Ba',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });
    patient3Token = signAccessToken(patient3);

    doctor1 = await User.create({
      email: 'fix2.doctor1@test.com',
      password: hash,
      fullName: 'Bác Sĩ Fix2',
      userType: ROLES.DOCTOR,
      gender: 'Male',
      isEnable: true,
    });

    await EventRegistration.init();
    await Event.init();
    await Feedback.init();
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  describe('PAT-08: Patient Event Service & Concurrency Tests', () => {
    it('1. Lỗi Mongo giả lập (không phải 11000) không bị map thành ALREADY_REGISTERED và registeredCount được hoàn tác', async () => {
      const ev = await Event.create({
        id: 1001,
        title: 'Sự kiện kiểm tra lỗi Mongo khác',
        startDate: new Date('2026-11-02T08:00:00Z'),
        endDate: new Date('2026-11-02T18:00:00Z'),
        isEnabled: true,
        capacity: 10,
        registeredCount: 0,
      });

      // Mock EventRegistration.create ném lỗi Mongo thông thường (ví dụ: WriteConflict hoặc Connection error)
      const originalCreate = EventRegistration.create;
      EventRegistration.create = async () => {
        const mongoErr = new Error('Simulated write conflict');
        mongoErr.code = 112; // Không phải 11000
        throw mongoErr;
      };

      try {
        await assert.rejects(
          async () => {
            await patientEventService.registerEvent(patient1, ev.id);
          },
          (err) => {
            assert.equal(err.code, 112);
            assert.notEqual(err.errorCode, 'ALREADY_REGISTERED');
            return true;
          },
        );

        // Kiểm tra registeredCount đã được hoàn lại 0 (không bị tăng vĩnh viễn)
        const checkEv = await Event.findOne({ id: ev.id }).lean();
        assert.equal(checkEv.registeredCount, 0);
      } finally {
        EventRegistration.create = originalCreate;
      }
    });

    it('2. Đăng ký event chưa bắt đầu (startDate > now, now <= endDate) thành công (chính sách FIX-2)', async () => {
      const futureEv = await Event.create({
        id: 1002,
        title: 'Sự kiện tương lai cho phép đăng ký trước',
        startDate: new Date('2026-11-10T08:00:00Z'),
        endDate: new Date('2026-11-15T18:00:00Z'),
        isEnabled: true,
        capacity: 5,
        registeredCount: 0,
      });

      const res = await apiRequest('POST', `/events/${futureEv.id}/register`, {
        token: patient1Token,
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.eventId, futureEv.id);

      const updated = await Event.findOne({ id: futureEv.id }).lean();
      assert.equal(updated.registeredCount, 1);
    });

    it('3. Event đã quá hạn (now > endDate) bị từ chối 409 EVENT_CLOSED', async () => {
      const expiredEv = await Event.create({
        id: 1003,
        title: 'Sự kiện đã kết thúc',
        startDate: new Date('2026-10-01T08:00:00Z'),
        endDate: new Date('2026-10-10T18:00:00Z'),
        isEnabled: true,
        capacity: 10,
        registeredCount: 0,
      });

      const res = await apiRequest('POST', `/events/${expiredEv.id}/register`, {
        token: patient1Token,
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error?.code, 'EVENT_CLOSED');
    });

    it('4. N request song song vào event chỉ còn 1 chỗ: đúng 1 thành công, count đúng bằng capacity', async () => {
      const singleSlotEv = await Event.create({
        id: 1004,
        title: 'Sự kiện chỉ còn 1 chỗ',
        startDate: new Date('2026-11-01T08:00:00Z'),
        endDate: new Date('2026-11-10T18:00:00Z'),
        isEnabled: true,
        capacity: 1,
        registeredCount: 0,
      });

      // 3 user khác nhau đăng ký song song cùng một thời điểm
      const results = await Promise.all([
        apiRequest('POST', `/events/${singleSlotEv.id}/register`, { token: patient1Token }),
        apiRequest('POST', `/events/${singleSlotEv.id}/register`, { token: patient2Token }),
        apiRequest('POST', `/events/${singleSlotEv.id}/register`, { token: patient3Token }),
      ]);

      const successResults = results.filter((r) => r.status === 201);
      const fullResults = results.filter((r) => r.status === 409 && r.body.error?.code === 'EVENT_FULL');

      assert.equal(successResults.length, 1, 'Đúng 1 request được ghi nhận thành công');
      assert.equal(fullResults.length, 2, '2 request còn lại phải bị từ chối EVENT_FULL');

      const afterEv = await Event.findOne({ id: singleSlotEv.id }).lean();
      assert.equal(afterEv.registeredCount, 1, 'registeredCount không vượt quá capacity 1');
    });

    it('5. 2 request song song từ cùng 1 user vào cùng event: đúng 1 thành công, count đúng bằng 1', async () => {
      const multiSlotEv = await Event.create({
        id: 1005,
        title: 'Sự kiện rộng chỗ kiểm tra duplicate cùng user',
        startDate: new Date('2026-11-01T08:00:00Z'),
        endDate: new Date('2026-11-10T18:00:00Z'),
        isEnabled: true,
        capacity: 100,
        registeredCount: 0,
      });

      const results = await Promise.all([
        apiRequest('POST', `/events/${multiSlotEv.id}/register`, { token: patient1Token }),
        apiRequest('POST', `/events/${multiSlotEv.id}/register`, { token: patient1Token }),
      ]);

      const successResults = results.filter((r) => r.status === 201);
      const duplicateResults = results.filter(
        (r) => r.status === 409 && r.body.error?.code === 'ALREADY_REGISTERED',
      );

      assert.equal(successResults.length, 1);
      assert.equal(duplicateResults.length, 1);

      const afterEv = await Event.findOne({ id: multiSlotEv.id }).lean();
      assert.equal(afterEv.registeredCount, 1, 'registeredCount được rollback về 1 sau khi một nhánh trùng bị chặn');
    });

    it('6. Event không giới hạn capacity (capacity = null): khi lỗi registration vẫn hoàn lại registeredCount', async () => {
      const unlimitedEv = await Event.create({
        id: 1006,
        title: 'Sự kiện unlimited capacity',
        startDate: new Date('2026-11-01T08:00:00Z'),
        endDate: new Date('2026-11-10T18:00:00Z'),
        isEnabled: true,
        capacity: null,
        registeredCount: 0,
      });

      // Tạo sẵn 1 registration trong DB để làm nổ lỗi 11000
      await EventRegistration.create({
        eventId: unlimitedEv.id,
        userId: patient2.id,
        status: 'PENDING',
        registeredAt: new Date(),
      });
      await Event.updateOne({ id: unlimitedEv.id }, { registeredCount: 1 });

      // Gọi registerEvent lại cho user2 -> sẽ bị lỗi duplicate key 11000
      await assert.rejects(
        async () => {
          await patientEventService.registerEvent(patient2, unlimitedEv.id);
        },
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'ALREADY_REGISTERED');
          return true;
        },
      );

      const checkEv = await Event.findOne({ id: unlimitedEv.id }).lean();
      assert.equal(checkEv.registeredCount, 1, 'registeredCount không bị tăng thêm khi lỗi xảy ra');
    });
  });

  describe('PAT-12: Feedback Service, Partial Index & Concurrency Tests', () => {
    let apptCompleted1;
    let apptCompleted2;

    before(async () => {
      apptCompleted1 = await Appointment.create({
        id: 5001,
        appointmentNo: 'APPT-FIX2-5001',
        patientId: patient1.id,
        doctorId: doctor1.id,
        specialtyId: 1,
        shiftId: 1,
        status: APPOINTMENT_STATUSES.COMPLETED,
        type: 'OFFLINE',
        appointmentDate: '2026-11-01',
        appointmentTime: '08:00',
      });

      apptCompleted2 = await Appointment.create({
        id: 5002,
        appointmentNo: 'APPT-FIX2-5002',
        patientId: patient2.id,
        doctorId: doctor1.id,
        specialtyId: 1,
        shiftId: 1,
        status: APPOINTMENT_STATUSES.COMPLETED,
        type: 'OFFLINE',
        appointmentDate: '2026-11-01',
        appointmentTime: '09:00',
      });
    });

    it('1. Kiểm tra Partial Unique Index trên collection feedbacks tồn tại và bảo vệ', async () => {
      // Đảm bảo index được sync trên database
      await Feedback.syncIndexes();
      const indexes = await Feedback.collection.indexes();

      const partialIdx = indexes.find(
        (idx) =>
          idx.key &&
          idx.key.appointmentId === 1 &&
          idx.key.userId === 1 &&
          idx.unique === true,
      );

      assert.ok(partialIdx, 'Partial unique index { appointmentId: 1, userId: 1 } phải tồn tại');
      assert.ok(
        partialIdx.partialFilterExpression &&
          (partialIdx.partialFilterExpression.deletedAt === null ||
            partialIdx.partialFilterExpression.deletedAt?.$type === 'null'),
        'partialFilterExpression phải lọc deletedAt null',
      );
    });

    it('2. 2 request gửi feedback song song cho cùng lịch hẹn: 1 thành công (201), 1 trả 409 FEEDBACK_EXISTS (không 500)', async () => {
      const payload = {
        appointmentId: apptCompleted1.id,
        rating: 5,
        title: 'Dịch vụ rất tốt',
        comment: 'Bác sĩ tận tình',
      };

      const results = await Promise.all([
        apiRequest('POST', '/feedbacks', { token: patient1Token, body: payload }),
        apiRequest('POST', '/feedbacks', { token: patient1Token, body: payload }),
      ]);

      const successResults = results.filter((r) => r.status === 201);
      const conflictResults = results.filter(
        (r) => r.status === 409 && r.body.error?.code === 'FEEDBACK_EXISTS',
      );

      assert.equal(successResults.length, 1, 'Đúng 1 request tạo thành công');
      assert.equal(conflictResults.length, 1, 'Request trùng trả về 409 FEEDBACK_EXISTS');
      assert.ok(results.every((r) => r.status !== 500), 'Tuyệt đối không có mã lỗi 500');
    });

    it('3. Xóa mềm (soft delete) rồi gửi lại feedback mới cho cùng lịch hẹn thành công', async () => {
      const activeFb = await Feedback.findOne({
        appointmentId: apptCompleted1.id,
        deletedAt: null,
      });
      assert.ok(activeFb);

      // Xóa mềm feedback hiện tại
      const delRes = await apiRequest('DELETE', `/feedbacks/${activeFb.id}`, {
        token: patient1Token,
      });
      assert.equal(delRes.status, 200);

      const checkSoftDel = await Feedback.findOne({ id: activeFb.id }).lean();
      assert.ok(checkSoftDel.deletedAt !== null);

      // Gửi lại feedback mới cho apptCompleted1
      const resendRes = await apiRequest('POST', '/feedbacks', {
        token: patient1Token,
        body: {
          appointmentId: apptCompleted1.id,
          rating: 4,
          title: 'Gửi lại sau xóa mềm',
          comment: 'Chỉnh sửa ý kiến sau khi trải nghiệm lần 2',
        },
      });

      assert.equal(resendRes.status, 201);
      assert.equal(resendRes.body.data.appointmentId, apptCompleted1.id);
      assert.equal(resendRes.body.data.comment, 'Chỉnh sửa ý kiến sau khi trải nghiệm lần 2');
    });

    it('4. Sửa feedback khi comment chứa HTML: comment bị sanitize', async () => {
      const fb = await Feedback.create({
        userId: patient2.id,
        appointmentId: apptCompleted2.id,
        doctorId: doctor1.id,
        rating: 4,
        title: 'Title ban đầu',
        comment: 'Comment sạch',
        isAnonymous: false,
        status: FEEDBACK_STATUSES.PUBLISHED,
        deletedAt: null,
      });

      const res = await apiRequest('PUT', `/feedbacks/${fb.id}`, {
        token: patient2Token,
        body: {
          title: '<b>Title mới có tag</b>',
          comment: '<script>alert(1)</script>Đánh giá sau khi <i>cập nhật</i>',
          rating: 5,
        },
      });

      assert.equal(res.status, 200);
      assert.ok(!res.body.data.comment.includes('<script>'));
      assert.ok(!res.body.data.comment.includes('<i>'));
      assert.ok(res.body.data.comment.includes('Đánh giá sau khi cập nhật'));
      assert.ok(!res.body.data.title.includes('<b>'));
      assert.ok(res.body.data.title.includes('Title mới có tag'));
      // Vì sửa từ PUBLISHED nên status phải quay về PENDING
      assert.equal(res.body.data.status, FEEDBACK_STATUSES.PENDING);
    });

    it('5. getPublishedAnonymous tôn trọng isAnonymous và tuyệt đối không bao giờ trả userId hay patientEmail', async () => {
      // 1 feedback PUBLISHED anonymous
      await Feedback.create({
        userId: patient1.id,
        rating: 5,
        title: 'Ẩn danh',
        comment: 'Nội dung ẩn danh',
        isAnonymous: true,
        status: FEEDBACK_STATUSES.PUBLISHED,
        deletedAt: null,
      });

      // 1 feedback PUBLISHED công khai danh tính (sẽ được mask)
      await Feedback.create({
        userId: patient2.id,
        rating: 5,
        title: 'Công khai',
        comment: 'Nội dung công khai',
        isAnonymous: false,
        status: FEEDBACK_STATUSES.PUBLISHED,
        deletedAt: null,
      });

      const published = await feedbackService.getPublishedAnonymous();
      assert.ok(Array.isArray(published));
      assert.ok(published.length >= 2);

      for (const item of published) {
        assert.equal(item.userId, undefined, 'userId tuyệt đối không được trả ra');
        assert.equal(item.patientEmail, undefined, 'patientEmail tuyệt đối không được trả ra');
        if (item.isAnonymous) {
          assert.equal(item.patientName, 'Ẩn danh');
        } else {
          // patient2 có họ tên "Bệnh Nhân Fix2 Hai" -> mask thành "B. Nhân Fix2 Hai"
          assert.ok(item.patientName.startsWith('B. '));
        }
      }
    });
  });
});
