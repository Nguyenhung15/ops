const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_rec_06_hardening_test_secret_key';

const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_rec_06_hardening';

const app = require('../src/app');
const {
  User,
  DoctorShift,
  Appointment,
  ShiftCancellationRequest,
  PaymentTransaction,
  AuditLog,
  OutboxEvent,
  Specialty,
} = require('../src/models');
const {
  ROLES,
  APPOINTMENT_STATUSES,
  AUDIT_ACTIONS,
  SHIFT_STATUSES,
} = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock, RealClock } = require('../src/services/clock.service');

let server;
let baseUrl;

let doctorUser1;
let doctorToken1;
let doctorUser2;
let doctorToken2;
let receptionistUser1;
let receptionistToken1;
let receptionistUser2;
let receptionistToken2;
let adminUser;
let adminToken;
let patientUser;
let patientToken;

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

describe('UC-REC-06 Hardening: Củng cố Duyệt/Từ chối yêu cầu hủy ca của Bác sĩ', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    const hashedPassword = await bcrypt.hash('Hardening@123', 10);

    // Specialty
    await Specialty.create({
      id: 20,
      name: 'Ngoại Khoa',
      description: 'Chuyên khoa ngoại tổng quát',
    });

    // Doctors
    doctorUser1 = await User.create({
      id: 201,
      email: 'dr1_h@clinic.test',
      password: hashedPassword,
      fullName: 'BS Nguyễn Văn Một',
      userType: ROLES.DOCTOR,
      specialtyId: 20,
      isEnable: true,
    });
    doctorToken1 = signAccessToken(doctorUser1);

    doctorUser2 = await User.create({
      id: 202,
      email: 'dr2_h@clinic.test',
      password: hashedPassword,
      fullName: 'BS Trần Văn Hai',
      userType: ROLES.DOCTOR,
      specialtyId: 20,
      isEnable: true,
    });
    doctorToken2 = signAccessToken(doctorUser2);

    // Receptionists
    receptionistUser1 = await User.create({
      id: 301,
      email: 'recep1_h@clinic.test',
      password: hashedPassword,
      fullName: 'Lễ Tân Một',
      userType: ROLES.RECEPTIONIST,
      isEnable: true,
    });
    receptionistToken1 = signAccessToken(receptionistUser1);

    receptionistUser2 = await User.create({
      id: 302,
      email: 'recep2_h@clinic.test',
      password: hashedPassword,
      fullName: 'Lễ Tân Hai',
      userType: ROLES.RECEPTIONIST,
      isEnable: true,
    });
    receptionistToken2 = signAccessToken(receptionistUser2);

    // Admin
    adminUser = await User.create({
      id: 401,
      email: 'admin_h@clinic.test',
      password: hashedPassword,
      fullName: 'Quản Trị Viên H',
      userType: ROLES.ADMIN,
      isEnable: true,
    });
    adminToken = signAccessToken(adminUser);

    // Patient
    patientUser = await User.create({
      id: 101,
      email: 'patient_h@clinic.test',
      password: hashedPassword,
      fullName: 'Bệnh Nhân H',
      userType: ROLES.PATIENT,
      isEnable: true,
    });
    patientToken = signAccessToken(patientUser);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api`;
        resolve();
      });
    });
  });

  after(async () => {
    setClock(new RealClock());
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    setClock(createFakeClock(new Date('2026-11-01T08:00:00.000Z')));
    await Appointment.deleteMany({});
    await DoctorShift.deleteMany({});
    await ShiftCancellationRequest.deleteMany({});
    await PaymentTransaction.deleteMany({});
    await AuditLog.deleteMany({});
    await OutboxEvent.deleteMany({});
  });

  // 1. Policy BLOCK_UNTIL_RESOLVED khi CÓ booking: 409 SHIFT_HAS_ACTIVE_BOOKINGS và TUYỆT ĐỐI KHÔNG đổi trạng thái request hay ca trực
  it('1. BLOCK_UNTIL_RESOLVED: có lịch hẹn hoạt động -> trả 409 và bảo toàn trạng thái PENDING của request & ACTIVE của ca trực', async () => {
    const shift = await DoctorShift.create({
      id: 5001,
      doctorId: doctorUser1.id,
      date: '2026-11-20',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [
        { id: 1, slotNumber: 1, startTime: '08:00', endTime: '08:45', status: 'BOOKED', bookingRef: 'OFF_ACTIVE_1' },
        { id: 2, slotNumber: 2, startTime: '08:45', endTime: '09:30', status: 'AVAILABLE', bookingRef: null },
      ],
    });

    await Appointment.create({
      id: 8001,
      appointmentNo: 'OFF_ACTIVE_1',
      patientId: patientUser.id,
      doctorId: doctorUser1.id,
      specialtyId: 20,
      shiftId: shift.id,
      slotIds: [1],
      appointmentDate: '2026-11-20',
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Khám định kỳ',
    });

    const reqDoc = await ShiftCancellationRequest.create({
      id: 9001,
      shiftId: shift.id,
      doctorId: doctorUser1.id,
      shiftDate: shift.date,
      shiftType: shift.shift,
      reason: 'Bác sĩ bận việc gia đình đột xuất',
      affectedAppointmentCount: 1,
      status: 'PENDING',
    });

    const resApprove = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
      token: receptionistToken1,
      body: { policy: 'BLOCK_UNTIL_RESOLVED' },
    });

    assert.equal(resApprove.status, 409);
    assert.equal(resApprove.body.error?.code, 'SHIFT_HAS_ACTIVE_BOOKINGS');

    // Kiểm tra request KHÔNG bị đổi trạng thái (vẫn là PENDING)
    const checkReq = await ShiftCancellationRequest.findOne({ id: reqDoc.id });
    assert.equal(checkReq.status, 'PENDING');
    assert.equal(checkReq.approvedBy, null);
    assert.equal(checkReq.approvedAt, null);

    // Kiểm tra ca trực và các slot KHÔNG bị đổi trạng thái
    const checkShift = await DoctorShift.findOne({ id: shift.id });
    assert.equal(checkShift.status, 'ACTIVE');
    const slot1 = checkShift.slots.find((s) => s.id === 1);
    const slot2 = checkShift.slots.find((s) => s.id === 2);
    assert.equal(slot1.status, 'BOOKED');
    assert.equal(slot2.status, 'AVAILABLE');

    // Lịch hẹn vẫn CONFIRMED
    const checkAppt = await Appointment.findOne({ id: 8001 });
    assert.equal(checkAppt.status, APPOINTMENT_STATUSES.CONFIRMED);
  });

  // 2. Policy AUTO_CANCEL_AFFECTED: tự động hủy từng lịch hẹn (qua logic REC-05, cập nhật refundRequired nếu đã trả), shift -> CANCELLED, slot chưa đặt -> CANCELLED
  it('2. AUTO_CANCEL_AFFECTED: tự động hủy lịch (transition CANCELLED + refundRequired), ca -> CANCELLED, slot trống -> CANCELLED, slot đã đặt giữ bookingRef', async () => {
    const shift = await DoctorShift.create({
      id: 5002,
      doctorId: doctorUser1.id,
      date: '2026-11-21',
      shift: 'AFTERNOON',
      startTime: '13:00',
      endTime: '17:00',
      status: 'ACTIVE',
      slots: [
        { id: 11, slotNumber: 1, startTime: '13:00', endTime: '13:45', status: 'BOOKED', bookingRef: 'OFF_PAID_AUTO_1' },
        { id: 12, slotNumber: 2, startTime: '14:00', endTime: '14:45', status: 'AVAILABLE', bookingRef: null },
      ],
    });

    const appt = await Appointment.create({
      id: 8002,
      appointmentNo: 'OFF_PAID_AUTO_1',
      patientId: patientUser.id,
      doctorId: doctorUser1.id,
      specialtyId: 20,
      shiftId: shift.id,
      slotIds: [11],
      appointmentDate: '2026-11-21',
      appointmentTime: '13:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      refundRequired: false,
      reason: 'Đau khớp gối',
    });

    // Tạo giao dịch thanh toán thành công
    await PaymentTransaction.create({
      id: 7001,
      appointmentId: appt.id,
      amount: 300000,
      status: 'SUCCESS',
      transactionStatus: '00',
      responseCode: '00',
    });

    const reqDoc = await ShiftCancellationRequest.create({
      id: 9002,
      shiftId: shift.id,
      doctorId: doctorUser1.id,
      shiftDate: shift.date,
      shiftType: shift.shift,
      reason: 'Tham gia ca phẫu thuật khẩn cấp',
      affectedAppointmentCount: 1,
      status: 'PENDING',
    });

    const resApprove = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
      token: receptionistToken1,
      body: { policy: 'AUTO_CANCEL_AFFECTED', note: 'Duyệt và tự động hủy ca' },
    });

    assert.equal(resApprove.status, 200);
    assert.equal(resApprove.body.data.status, 'APPROVED');

    // Lịch hẹn tự động chuyển sang CANCELLED và được đánh dấu refundRequired = true
    const updatedAppt = await Appointment.findOne({ id: appt.id });
    assert.equal(updatedAppt.status, APPOINTMENT_STATUSES.CANCELLED);
    assert.equal(updatedAppt.refundRequired, true);
    assert.equal(String(updatedAppt.cancelledBy), String(receptionistUser1.id));
    assert.ok(updatedAppt.cancelledAt);

    // Ca trực chuyển sang CANCELLED
    const updatedShift = await DoctorShift.findOne({ id: shift.id });
    assert.equal(updatedShift.status, 'CANCELLED');

    // Toàn bộ các slot chưa đặt hoặc vừa được giải phóng đều trở thành CANCELLED theo ca trực bị hủy
    const slot11 = updatedShift.slots.find((s) => s.id === 11);
    assert.equal(slot11.status, 'CANCELLED');

    // Outbox notification cho bệnh nhân và bác sĩ
    const outboxDoctor = await OutboxEvent.findOne({
      eventType: 'SHIFT_CANCELLATION_APPROVED',
      'payload.shiftId': shift.id,
    });
    assert.ok(outboxDoctor, 'Outbox SHIFT_CANCELLATION_APPROVED phải tồn tại');

    const outboxPatient = await OutboxEvent.findOne({
      eventType: 'PATIENT_APPOINTMENT_CANCELLED_DUE_TO_SHIFT',
      'payload.appointmentId': appt.id,
    });
    assert.ok(outboxPatient, 'Outbox PATIENT_APPOINTMENT_CANCELLED_DUE_TO_SHIFT phải tồn tại');
  });

  // 3. Từ chối yêu cầu (Reject): BẮT BUỘC có note, nếu thiếu trả 400 REJECTION_NOTE_REQUIRED
  it('3. Từ chối yêu cầu hủy ca: bắt buộc có note, thiếu note trả 400 REJECTION_NOTE_REQUIRED', async () => {
    const shift = await DoctorShift.create({
      id: 5003,
      doctorId: doctorUser1.id,
      date: '2026-11-22',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [],
    });

    const reqDoc = await ShiftCancellationRequest.create({
      id: 9003,
      shiftId: shift.id,
      doctorId: doctorUser1.id,
      shiftDate: shift.date,
      shiftType: shift.shift,
      reason: 'Xin nghỉ phép cá nhân',
      affectedAppointmentCount: 0,
      status: 'PENDING',
    });

    // Gọi reject không truyền note hoặc note chuỗi rỗng
    const resNoNote = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/reject`, {
      token: receptionistToken1,
      body: { note: '   ' },
    });
    assert.equal(resNoNote.status, 400);
    assert.equal(resNoNote.body.error?.code, 'REJECTION_NOTE_REQUIRED');

    // Request vẫn ở PENDING
    const checkReq = await ShiftCancellationRequest.findOne({ id: reqDoc.id });
    assert.equal(checkReq.status, 'PENDING');

    // Gọi reject có note hợp lệ -> 200 REJECTED
    const resReject = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/reject`, {
      token: receptionistToken1,
      body: { note: 'Không đủ bác sĩ thay thế trong ngày này' },
    });
    assert.equal(resReject.status, 200);
    assert.equal(resReject.body.data.status, 'REJECTED');
    assert.equal(resReject.body.data.decisionNote, 'Không đủ bác sĩ thay thế trong ngày này');
  });

  // 4. Duyệt song song (Concurrency): 2 lễ tân cùng duyệt 1 request -> 1 thắng cập nhật DB, 1 nhận kết quả idempotent, không duplicate outbox/audit
  it('4. Duyệt song song: 2 lễ tân cùng duyệt 1 request -> DB cập nhật nhất quán và an toàn', async () => {
    const shift = await DoctorShift.create({
      id: 5004,
      doctorId: doctorUser1.id,
      date: '2026-11-23',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [
        { id: 21, slotNumber: 1, startTime: '08:00', endTime: '08:45', status: 'AVAILABLE', bookingRef: null },
      ],
    });

    const reqDoc = await ShiftCancellationRequest.create({
      id: 9004,
      shiftId: shift.id,
      doctorId: doctorUser1.id,
      shiftDate: shift.date,
      shiftType: shift.shift,
      reason: 'Lịch giảng dạy đột xuất',
      affectedAppointmentCount: 0,
      status: 'PENDING',
    });

    const [res1, res2] = await Promise.all([
      apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
        token: receptionistToken1,
        body: { note: 'Lễ tân 1 duyệt' },
      }),
      apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
        token: receptionistToken2,
        body: { note: 'Lễ tân 2 duyệt' },
      }),
    ]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    const statuses = [res1.body.data?.status, res2.body.data?.status];
    assert.deepEqual(statuses, ['APPROVED', 'APPROVED']);

    // Chỉ đúng 1 lần ghi APPROVED vào DB
    const finalReq = await ShiftCancellationRequest.findOne({ id: reqDoc.id });
    assert.equal(finalReq.status, 'APPROVED');
    assert.ok([receptionistUser1.id, receptionistUser2.id].includes(Number(finalReq.approvedBy)));

    // Ca trực chuyển sang CANCELLED
    const finalShift = await DoctorShift.findOne({ id: shift.id });
    assert.equal(finalShift.status, 'CANCELLED');
  });

  // 5. Duyệt lặp hoặc từ chối lặp (Idempotent): đã APPROVED gọi lại approve trả HTTP 200 idempotent kèm state hiện tại
  it('5. Duyệt lặp (idempotent): request đã APPROVED gọi lại approve trả HTTP 200 và giữ nguyên approvedBy/approvedAt ban đầu', async () => {
    const shift = await DoctorShift.create({
      id: 5005,
      doctorId: doctorUser1.id,
      date: '2026-11-24',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [],
    });

    const reqDoc = await ShiftCancellationRequest.create({
      id: 9005,
      shiftId: shift.id,
      doctorId: doctorUser1.id,
      shiftDate: shift.date,
      shiftType: shift.shift,
      reason: 'Khám sức khỏe tổng quát',
      affectedAppointmentCount: 0,
      status: 'PENDING',
    });

    // Duyệt lần 1
    const res1 = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
      token: receptionistToken1,
      body: { note: 'Duyệt lần đầu' },
    });
    assert.equal(res1.status, 200);
    const firstApprovedAt = res1.body.data?.approvedAt;
    const firstApprovedBy = res1.body.data?.approvedBy;

    // Tua đồng hồ giả lập
    setClock(createFakeClock(new Date('2026-11-01T10:00:00.000Z')));

    // Duyệt lần 2 (bởi Admin)
    const res2 = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
      token: adminToken,
      body: { note: 'Admin duyệt lại lần nữa' },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.idempotent, true);
    assert.equal(res2.body.data?.status, 'APPROVED');
    assert.equal(res2.body.data?.approvedBy, firstApprovedBy);
    assert.equal(res2.body.data?.approvedAt, firstApprovedAt);
  });

  // 6. Doctor tạo yêu cầu cho ca của bác sĩ khác bị từ chối 403 DOCTOR_MISMATCH
  it('6. Bác sĩ tạo yêu cầu cho ca trực của bác sĩ khác bị từ chối 403 DOCTOR_MISMATCH, doctorId lấy từ JWT', async () => {
    const shiftOfDoctor1 = await DoctorShift.create({
      id: 5006,
      doctorId: doctorUser1.id,
      date: '2026-11-25',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [],
    });

    // Doctor 2 gửi request kèm giả mạo doctorId: 201 trong body -> vẫn lấy doctorId từ JWT (202) -> 403 DOCTOR_MISMATCH
    const resForbidden = await apiRequest('POST', `/shifts/${shiftOfDoctor1.id}/cancellation-requests`, {
      token: doctorToken2,
      body: {
        doctorId: doctorUser1.id,
        reason: 'Tôi muốn hủy ca hộ bác sĩ 1',
      },
    });
    assert.equal(resForbidden.status, 403);
    assert.equal(resForbidden.body.error?.code, 'DOCTOR_MISMATCH');

    // Không có request nào được tạo trong DB
    const count = await ShiftCancellationRequest.countDocuments({ shiftId: shiftOfDoctor1.id });
    assert.equal(count, 0);
  });

  // 7. Role sai: Patient gọi endpoint duyệt hoặc từ chối bị từ chối 403
  it('7. Patient gọi endpoint approve / reject hoặc doctor gọi approve bị từ chối 403', async () => {
    const shift = await DoctorShift.create({
      id: 5007,
      doctorId: doctorUser1.id,
      date: '2026-11-26',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [],
    });

    const reqDoc = await ShiftCancellationRequest.create({
      id: 9007,
      shiftId: shift.id,
      doctorId: doctorUser1.id,
      shiftDate: shift.date,
      shiftType: shift.shift,
      reason: 'Bận việc riêng',
      affectedAppointmentCount: 0,
      status: 'PENDING',
    });

    // Patient gọi approve -> 403
    const resPatApprove = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
      token: patientToken,
      body: {},
    });
    assert.equal(resPatApprove.status, 403);

    // Patient gọi reject -> 403
    const resPatReject = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/reject`, {
      token: patientToken,
      body: { note: 'Bệnh nhân từ chối' },
    });
    assert.equal(resPatReject.status, 403);

    // Doctor gọi approve -> 403
    const resDocApprove = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
      token: doctorToken1,
      body: {},
    });
    assert.equal(resDocApprove.status, 403);
  });

  // 8. Khi hủy ca không có booking: slot AVAILABLE chuyển thành CANCELLED, slot đã BOOKED không bị hủy nhầm
  it('8. Duyệt ca: slot AVAILABLE chuyển sang CANCELLED, slot đã BOOKED tuyệt đối không bị ghi đè', async () => {
    const shift = await DoctorShift.create({
      id: 5008,
      doctorId: doctorUser1.id,
      date: '2026-11-27',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [
        { id: 31, slotNumber: 1, startTime: '08:00', endTime: '08:45', status: 'AVAILABLE', bookingRef: null },
        { id: 32, slotNumber: 2, startTime: '08:45', endTime: '09:30', status: 'BOOKED', bookingRef: 'SPECIAL_BOOKING_REF' },
      ],
    });

    const reqDoc = await ShiftCancellationRequest.create({
      id: 9008,
      shiftId: shift.id,
      doctorId: doctorUser1.id,
      shiftDate: shift.date,
      shiftType: shift.shift,
      reason: 'Nghỉ dưỡng',
      affectedAppointmentCount: 0,
      status: 'PENDING',
    });

    // Duyệt yêu cầu
    const resApprove = await apiRequest('PUT', `/shifts/cancellation-requests/${reqDoc.id}/approve`, {
      token: receptionistToken1,
      body: { note: 'Duyệt ca nghỉ' },
    });
    assert.equal(resApprove.status, 200);

    const updatedShift = await DoctorShift.findOne({ id: shift.id });
    assert.equal(updatedShift.status, 'CANCELLED');

    // Slot 31 AVAILABLE -> CANCELLED
    const slot31 = updatedShift.slots.find((s) => s.id === 31);
    assert.equal(slot31.status, 'CANCELLED');

    // Slot 32 BOOKED -> vẫn giữ nguyên BOOKED và bookingRef
    const slot32 = updatedShift.slots.find((s) => s.id === 32);
    assert.equal(slot32.status, 'BOOKED');
    assert.equal(slot32.bookingRef, 'SPECIAL_BOOKING_REF');
  });
});
