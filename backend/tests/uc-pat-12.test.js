const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_pat_12_test_secret_key';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_pat_12';

const app = require('../src/app');
const {
  User,
  Specialty,
  DoctorShift,
  Appointment,
  Feedback,
  AuditLog,
} = require('../src/models');
const {
  ROLES,
  APPOINTMENT_STATUSES,
  FEEDBACK_STATUSES,
  AUDIT_ACTIONS,
} = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');
const { feedbackService } = require('../src/services/feedback.service');

let server;
let baseUrl;
let fakeClock;

let patient1;
let patient1Token;
let patient2;
let patient2Token;
let doctor1;
let doctor1Token;
let receptionist1;
let receptionist1Token;

let specialty1;
let doctorShift1;

let apptCompleted1;
let apptPending1;
let apptCompleted2;

async function apiRequest(method, path, { token, body, headers: customHeaders } = {}) {
  const headers = { ...customHeaders };
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

describe('UC-PAT-12: Patient gửi và xem feedback (/feedbacks)', () => {
  before(async () => {
    // Khởi tạo FakeClock bắt đầu tại mốc thời gian kiểm thử
    fakeClock = createFakeClock(new Date('2026-11-01T10:00:00.000Z'));
    setClock(fakeClock);

    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    const passwordHash = await bcrypt.hash('Secret@123', 10);

    // 1. Seed Specialty
    specialty1 = await Specialty.create({
      id: 1,
      name: 'Ngoại tổng quát',
    });

    // 2. Seed Users
    patient1 = await User.create({
      id: 1201,
      email: 'pat1_uc12@clinicbooking.com',
      password: passwordHash,
      fullName: 'Bệnh Nhân Feedback 1',
      userType: ROLES.PATIENT,
      gender: 'Male',
      phoneNumber: '0901234567',
      isEnable: true,
    });
    patient1Token = signAccessToken(patient1);

    patient2 = await User.create({
      id: 1202,
      email: 'pat2_uc12@clinicbooking.com',
      password: passwordHash,
      fullName: 'Bệnh Nhân Feedback 2',
      userType: ROLES.PATIENT,
      gender: 'Female',
      phoneNumber: '0907654321',
      isEnable: true,
    });
    patient2Token = signAccessToken(patient2);

    doctor1 = await User.create({
      id: 1203,
      email: 'doc1_uc12@clinicbooking.com',
      password: passwordHash,
      fullName: 'BS Lê Văn Bác Sĩ',
      userType: ROLES.DOCTOR,
      gender: 'Male',
      specialtyId: specialty1.id,
      phoneNumber: '0901112233',
      isEnable: true,
    });
    doctor1Token = signAccessToken(doctor1);

    receptionist1 = await User.create({
      id: 1204,
      email: 'rec1_uc12@clinicbooking.com',
      password: passwordHash,
      fullName: 'Lễ Tân Feedback',
      userType: ROLES.RECEPTIONIST,
      gender: 'Female',
      phoneNumber: '0904445566',
      isEnable: true,
    });
    receptionist1Token = signAccessToken(receptionist1);

    // 3. Seed Shift
    doctorShift1 = await DoctorShift.create({
      id: 601,
      doctorId: doctor1.id,
      date: '2026-11-01',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      maxPatients: 10,
      status: 'ACTIVE',
      slots: [
        { id: 301, slotNumber: 1, startTime: '08:00', endTime: '08:30', status: 'BOOKED' },
        { id: 302, slotNumber: 2, startTime: '08:30', endTime: '09:00', status: 'BOOKED' },
        { id: 303, slotNumber: 3, startTime: '09:00', endTime: '09:30', status: 'BOOKED' },
      ],
    });

    // 4. Seed Appointments
    // Appt 1: Của patient1, trạng thái COMPLETED
    apptCompleted1 = await Appointment.create({
      id: 5001,
      appointmentNo: 'OFF2611010001',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-01',
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.COMPLETED,
    });

    // Appt 2: Của patient1, trạng thái CONFIRMED (chưa COMPLETED)
    apptPending1 = await Appointment.create({
      id: 5002,
      appointmentNo: 'OFF2611010002',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-01',
      appointmentTime: '08:30',
      status: APPOINTMENT_STATUSES.CONFIRMED,
    });

    // Appt 3: Của patient2, trạng thái COMPLETED
    apptCompleted2 = await Appointment.create({
      id: 5003,
      appointmentNo: 'OFF2611010003',
      patientId: patient2.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: doctorShift1.id,
      appointmentDate: '2026-11-01',
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.COMPLETED,
    });

    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  it('1. Gửi feedback thành công: appointmentId thuộc user và COMPLETED, status PENDING, doctorId tự động gán từ appointment, ghi audit', async () => {
    const payload = {
      appointmentId: apptCompleted1.id,
      rating: 5,
      title: 'Dịch vụ rất tốt',
      comment: 'Bác sĩ tận tâm, thăm khám chu đáo.',
      category: 'Chất lượng khám chữa bệnh',
      isAnonymous: false,
    };

    const res = await apiRequest('POST', '/feedbacks', {
      token: patient1Token,
      body: payload,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.appointmentId, apptCompleted1.id);
    assert.equal(res.body.data.rating, 5);
    assert.equal(res.body.data.status, FEEDBACK_STATUSES.PENDING);
    assert.equal(res.body.data.doctorId, doctor1.id);
    assert.equal(res.body.data.comment, 'Bác sĩ tận tâm, thăm khám chu đáo.');

    // Kiểm tra DB
    const saved = await Feedback.findOne({ appointmentId: apptCompleted1.id, deletedAt: null }).lean();
    assert.ok(saved);
    assert.equal(saved.userId, patient1.id);
    assert.equal(saved.doctorId, doctor1.id);

    // Kiểm tra Audit Log
    const audit = await AuditLog.findOne({
      action: AUDIT_ACTIONS.CREATE_FEEDBACK,
      targetId: saved.id,
    }).lean();
    assert.ok(audit);
    assert.equal(Number(audit.actorId), patient1.id);
  });

  it('2. Lịch chưa COMPLETED: từ chối 409 APPOINTMENT_NOT_COMPLETED', async () => {
    const res = await apiRequest('POST', '/feedbacks', {
      token: patient1Token,
      body: {
        appointmentId: apptPending1.id,
        rating: 4,
        comment: 'Chưa khám xong đã gửi',
      },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error?.code, 'APPOINTMENT_NOT_COMPLETED');
  });

  it('3. Lịch của người khác: từ chối 404 (chống user enumeration)', async () => {
    // Patient 1 gửi feedback cho lịch của Patient 2 (apptCompleted2)
    const res = await apiRequest('POST', '/feedbacks', {
      token: patient1Token,
      body: {
        appointmentId: apptCompleted2.id,
        rating: 5,
        comment: 'Đánh giá lịch của người khác',
      },
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error?.code, 'APPOINTMENT_NOT_FOUND');
  });

  it('4. Gửi trùng feedback: Mỗi lịch chỉ một feedback active -> từ chối 409 FEEDBACK_EXISTS', async () => {
    const res = await apiRequest('POST', '/feedbacks', {
      token: patient1Token,
      body: {
        appointmentId: apptCompleted1.id,
        rating: 4,
        comment: 'Cố gắng gửi lần 2 cho cùng lịch hẹn',
      },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error?.code, 'FEEDBACK_EXISTS');
  });

  it('5. Rating sai: không phải số nguyên 1..5 -> từ chối 400 INVALID_RATING', async () => {
    const testRatings = [0, 6, 3.5, -1, 'five'];
    for (const invalidRating of testRatings) {
      const res = await apiRequest('POST', '/feedbacks', {
        token: patient2Token,
        body: {
          appointmentId: apptCompleted2.id,
          rating: invalidRating,
          comment: 'Thử rating không hợp lệ',
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error?.code, 'INVALID_RATING');
    }
  });

  it('6. Comment XSS bị loại bỏ an toàn (HTML tags bị strip)', async () => {
    const maliciousComment = '<script>alert("hack")</script><style>body{display:none;}</style>Phòng khám <b>rất tốt</b> & phục vụ chu đáo!';
    const res = await apiRequest('POST', '/feedbacks', {
      token: patient2Token,
      body: {
        appointmentId: apptCompleted2.id,
        rating: 4,
        comment: maliciousComment,
      },
    });

    assert.equal(res.status, 201);
    // Kiểm tra comment đã được làm sạch
    assert.ok(!res.body.data.comment.includes('<script>'));
    assert.ok(!res.body.data.comment.includes('<b>'));
    assert.ok(res.body.data.comment.includes('Phòng khám rất tốt & phục vụ chu đáo!'));
  });

  it('7. GET /feedbacks/my phân trang và data isolation (không lộ của người khác)', async () => {
    const res = await apiRequest('GET', '/feedbacks/my', {
      token: patient1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].appointmentId, apptCompleted1.id);
    // Tuyệt đối không chứa feedback của patient2
    assert.ok(res.body.data.every((f) => f.appointmentId !== apptCompleted2.id));
  });

  it('8. Sửa feedback của người khác -> 404 (chống enumeration)', async () => {
    // Lấy feedback của patient2
    const fb2 = await Feedback.findOne({ appointmentId: apptCompleted2.id }).lean();
    assert.ok(fb2);

    // Patient1 cố sửa fb2
    const res = await apiRequest('PUT', `/feedbacks/${fb2.id}`, {
      token: patient1Token,
      body: {
        comment: 'Cố sửa trộm của người khác',
      },
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.error?.code, 'FEEDBACK_NOT_FOUND');
  });

  it('9. Sửa feedback trong hạn: sửa bản PUBLISHED thì tự động quay về PENDING', async () => {
    const fb1 = await Feedback.findOne({ appointmentId: apptCompleted1.id });
    assert.ok(fb1);

    // Giả lập admin đã duyệt thành PUBLISHED
    fb1.status = FEEDBACK_STATUSES.PUBLISHED;
    await fb1.save();

    // Patient1 sửa feedback trong hạn (chưa quá 7 ngày)
    const res = await apiRequest('PUT', `/feedbacks/${fb1.id}`, {
      token: patient1Token,
      body: {
        rating: 4,
        comment: 'Cập nhật lại: Bác sĩ rất tốt nhưng chờ hơi lâu một chút.',
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.rating, 4);
    // Kiểm tra đã quay về PENDING
    assert.equal(res.body.data.status, FEEDBACK_STATUSES.PENDING);

    const updated = await Feedback.findOne({ id: fb1.id }).lean();
    assert.equal(updated.status, FEEDBACK_STATUSES.PENDING);
    assert.equal(updated.rating, 4);
  });

  it('10. Sửa/xóa ngoài hạn FEEDBACK_EDIT_DAYS (ví dụ sau 8 ngày) -> 409 FEEDBACK_EDIT_WINDOW_CLOSED', async () => {
    const fb1 = await Feedback.findOne({ appointmentId: apptCompleted1.id }).lean();
    assert.ok(fb1);

    // Tiến đồng hồ giả lập thêm 8 ngày (8 * 24 giờ)
    fakeClock.advanceByHours(8 * 24);

    // Thử sửa -> 409
    const resUpdate = await apiRequest('PUT', `/feedbacks/${fb1.id}`, {
      token: patient1Token,
      body: {
        comment: 'Sửa khi đã quá hạn 8 ngày',
      },
    });
    assert.equal(resUpdate.status, 409);
    assert.equal(resUpdate.body.error?.code, 'FEEDBACK_EDIT_WINDOW_CLOSED');

    // Thử xóa -> 409
    const resDelete = await apiRequest('DELETE', `/feedbacks/${fb1.id}`, {
      token: patient1Token,
    });
    assert.equal(resDelete.status, 409);
    assert.equal(resDelete.body.error?.code, 'FEEDBACK_EDIT_WINDOW_CLOSED');

    // Đặt lại thời gian về trong hạn (tiến thêm hoặc quay lại test tiếp)
    fakeClock.setNow(new Date('2026-11-02T10:00:00.000Z'));
  });

  it('11. Xóa mềm (deletedAt) và cho phép gửi lại feedback mới cho cùng lịch hẹn', async () => {
    const fb1 = await Feedback.findOne({ appointmentId: apptCompleted1.id, deletedAt: null });
    assert.ok(fb1);

    // Xóa mềm feedback
    const resDel = await apiRequest('DELETE', `/feedbacks/${fb1.id}`, {
      token: patient1Token,
    });
    assert.equal(resDel.status, 200);
    assert.equal(resDel.body.success, true);

    // Kiểm tra DB đã set deletedAt
    const softDeleted = await Feedback.findOne({ id: fb1.id }).lean();
    assert.ok(softDeleted.deletedAt !== null);

    // Gọi lại GET /feedbacks/my -> Không còn thấy bản ghi đã xóa
    const resMy = await apiRequest('GET', '/feedbacks/my', {
      token: patient1Token,
    });
    assert.equal(resMy.body.data.length, 0);

    // Gửi lại feedback mới cho apptCompleted1 -> Thành công (vì bản cũ đã xóa mềm)
    const resRecreate = await apiRequest('POST', '/feedbacks', {
      token: patient1Token,
      body: {
        appointmentId: apptCompleted1.id,
        rating: 5,
        comment: 'Gửi lại feedback mới sau khi đã xóa bản cũ.',
      },
    });
    assert.equal(resRecreate.status, 201);
    assert.equal(resRecreate.body.data.comment, 'Gửi lại feedback mới sau khi đã xóa bản cũ.');
  });

  it('12. Hàm query public (getPublishedAnonymous): chỉ lấy PUBLISHED, TUYỆT ĐỐI không trả userId, tên ẩn danh an toàn', async () => {
    // Tạo 1 feedback PUBLISHED có isAnonymous = true
    await Feedback.create({
      id: 9001,
      userId: patient1.id,
      appointmentId: 8881,
      doctorId: doctor1.id,
      rating: 5,
      comment: 'Bình luận ẩn danh',
      isAnonymous: true,
      status: FEEDBACK_STATUSES.PUBLISHED,
      deletedAt: null,
    });

    // Tạo 1 feedback PUBLISHED có isAnonymous = false
    await Feedback.create({
      id: 9002,
      userId: patient1.id,
      appointmentId: 8882,
      doctorId: doctor1.id,
      rating: 4,
      comment: 'Bình luận công khai có mask tên',
      isAnonymous: false,
      status: FEEDBACK_STATUSES.PUBLISHED,
      deletedAt: null,
    });

    // Tạo 1 feedback PENDING -> không được lọt vào public
    await Feedback.create({
      id: 9003,
      userId: patient2.id,
      appointmentId: 8883,
      rating: 1,
      comment: 'Bình luận đang chờ duyệt',
      status: FEEDBACK_STATUSES.PENDING,
      deletedAt: null,
    });

    const publicList = await feedbackService.getPublishedAnonymous();
    assert.ok(Array.isArray(publicList));
    assert.ok(publicList.length >= 2);

    // Kiểm tra không chứa userId trong bất kỳ bản ghi nào
    for (const item of publicList) {
      assert.equal(item.userId, undefined);
      assert.equal(item.patientEmail, undefined);
      assert.ok(item.patientName);
    }

    const anonItem = publicList.find((i) => i.id === 9001);
    assert.ok(anonItem);
    assert.equal(anonItem.patientName, 'Ẩn danh');

    const namedItem = publicList.find((i) => i.id === 9002);
    assert.ok(namedItem);
    // Tên gốc 'Bệnh Nhân Feedback 1' -> Được mask thành 'B. Nhân Feedback 1'
    assert.ok(namedItem.patientName.startsWith('B. '));

    // Không chứa bản ghi PENDING
    assert.ok(publicList.every((i) => i.id !== 9003));
  });

  it('13. Rate limit: gửi vượt ngưỡng FEEDBACK_RATE_PER_HOUR -> 429 RATE_LIMIT_EXCEEDED', async () => {
    // Tạo 15 appointment COMPLETED cho patient2 để gửi
    const appts = [];
    for (let i = 1; i <= 12; i += 1) {
      const a = await Appointment.create({
        id: 7000 + i,
        appointmentNo: `TEST_RATE_${i}`,
        patientId: patient2.id,
        doctorId: doctor1.id,
        specialtyId: specialty1.id,
        shiftId: doctorShift1.id,
        appointmentDate: '2026-11-01',
        appointmentTime: '10:00',
        status: APPOINTMENT_STATUSES.COMPLETED,
      });
      appts.push(a);
    }

    let hit429 = false;
    // Header x-test-rate-limit để kích hoạt rate limiter trong môi trường test
    for (let i = 0; i < appts.length; i += 1) {
      const res = await apiRequest('POST', '/feedbacks', {
        token: patient2Token,
        headers: { 'x-test-rate-limit': '1' },
        body: {
          appointmentId: appts[i].id,
          rating: 5,
          comment: `Feedback thứ ${i + 1}`,
        },
      });

      if (res.status === 429) {
        hit429 = true;
        assert.equal(res.body.error?.code, 'RATE_LIMIT_EXCEEDED');
        break;
      }
    }

    assert.equal(hit429, true, 'Phải kích hoạt mã 429 khi gửi quá rate limit');
  });

  it('14. Phân quyền: Doctor và Receptionist gọi POST /feedbacks hoặc GET /feedbacks/my bị 403 FORBIDDEN_ROLE', async () => {
    const resDoctor = await apiRequest('GET', '/feedbacks/my', {
      token: doctor1Token,
    });
    assert.equal(resDoctor.status, 403);
    assert.equal(resDoctor.body.success, false);

    const resReceptionist = await apiRequest('POST', '/feedbacks', {
      token: receptionist1Token,
      body: { appointmentId: 9999, rating: 5, comment: 'Lễ tân gửi feedback' },
    });
    assert.equal(resReceptionist.status, 403);
    assert.equal(resReceptionist.body.success, false);
  });
});
