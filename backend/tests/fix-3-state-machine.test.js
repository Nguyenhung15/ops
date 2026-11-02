const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'fix_3_test_jwt_secret_key_sdn302';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_fix_3';

const app = require('../src/app');
const {
  User,
  DoctorShift,
  Specialty,
  Appointment,
  Prescription,
  AuditLog,
  OutboxEvent,
} = require('../src/models');
const { ROLES, APPOINTMENT_STATUSES } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock } = require('../src/services/clock.service');
const doctorAppointmentService = require('../src/services/doctorAppointment.service');

let server;
let baseUrl;
let fakeClock;

let doctor1;
let doctor1Token;
let doctor2;
let doctor2Token;
let patient1;
let patient1Token;
let specialty1;
let shift1;

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

describe('FIX-3: State Machine Integration for Doctor Appointment Service', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    // Thiết lập clock cố định
    fakeClock = createFakeClock(new Date('2026-11-02T08:30:00.000Z'));
    setClock(fakeClock);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    const hash = await bcrypt.hash('Secret@123', 8);

    doctor1 = await User.create({
      id: 7001,
      email: 'fix3.doctor1@test.com',
      password: hash,
      fullName: 'Bác Sĩ Fix3 Một',
      userType: ROLES.DOCTOR,
      gender: 'Male',
      isEnable: true,
    });
    doctor1Token = signAccessToken(doctor1);

    doctor2 = await User.create({
      id: 7002,
      email: 'fix3.doctor2@test.com',
      password: hash,
      fullName: 'Bác Sĩ Fix3 Hai',
      userType: ROLES.DOCTOR,
      gender: 'Female',
      isEnable: true,
    });
    doctor2Token = signAccessToken(doctor2);

    patient1 = await User.create({
      id: 7003,
      email: 'fix3.patient1@test.com',
      password: hash,
      fullName: 'Bệnh Nhân Fix3',
      userType: ROLES.PATIENT,
      gender: 'Male',
      isEnable: true,
    });
    patient1Token = signAccessToken(patient1);

    specialty1 = await Specialty.create({
      id: 701,
      name: 'Chuyên khoa Nội',
      description: 'Khám nội tổng quát',
    });

    shift1 = await DoctorShift.create({
      id: 7001,
      doctorId: doctor1.id,
      date: '2026-11-02',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [
        { id: 1, slotNumber: 1, startTime: '08:00', endTime: '08:30', status: 'BOOKED', bookingRef: 'FIX3-APPT-1' },
      ],
    });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({});
    await OutboxEvent.deleteMany({});
  });

  it('1. Doctor start lịch từ CHECKED_IN thành công (CHECKED_IN -> IN_PROGRESS), lưu actualStartTime ISO, ghi audit và outbox', async () => {
    const appt = await Appointment.create({
      id: 8001,
      appointmentNo: 'FIX3-APPT-8001',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: shift1.id,
      appointmentDate: '2026-11-02',
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.CHECKED_IN,
      patients: [{ fullName: 'Bệnh Nhân Fix3' }],
    });

    const res = await apiRequest('PUT', `/appointments/start/${appt.id}`, {
      token: doctor1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, APPOINTMENT_STATUSES.IN_PROGRESS);
    assert.equal(res.body.data.id, appt.id);
    assert.equal(res.body.data.doctorName, doctor1.fullName);

    // Kiểm tra DB
    const fresh = await Appointment.findOne({ id: appt.id }).lean();
    assert.equal(fresh.status, APPOINTMENT_STATUSES.IN_PROGRESS);
    assert.equal(fresh.actualStartTime, '2026-11-02T08:30:00.000Z');

    // Kiểm tra AuditLog được ghi nhận
    const audit = await AuditLog.findOne({
      targetType: 'Appointment',
      targetId: String(appt.id),
    }).lean();
    assert.ok(audit, 'AuditLog phải được ghi');
    assert.equal(audit.changes?.after?.status, APPOINTMENT_STATUSES.IN_PROGRESS);

    // Kiểm tra OutboxEvent được ghi nhận
    const outbox = await OutboxEvent.findOne({
      eventType: 'APPOINTMENT_IN_PROGRESS',
    }).lean();
    assert.ok(outbox, 'OutboxEvent phải được ghi');
    assert.equal(outbox.payload?.appointmentNo, appt.appointmentNo);
  });

  it('2. Start từ trạng thái sai (ví dụ: CONFIRMED hoặc PENDING_CONFIRMATION) bị từ chối 409', async () => {
    const apptWrong = await Appointment.create({
      id: 8002,
      appointmentNo: 'FIX3-APPT-8002',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: shift1.id,
      appointmentDate: '2026-11-02',
      appointmentTime: '08:30',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      patients: [{ fullName: 'Bệnh Nhân Fix3' }],
    });

    const res = await apiRequest('PUT', `/appointments/start/${apptWrong.id}`, {
      token: doctor1Token,
    });

    assert.equal(res.status, 409);
    assert.match(res.body.message, /Only a checked-in appointment can be started/i);

    const fresh = await Appointment.findOne({ id: apptWrong.id }).lean();
    assert.equal(fresh.status, APPOINTMENT_STATUSES.CONFIRMED);
  });

  it('3. Start lịch của bác sĩ khác bị từ chối 404 (bảo vệ quyền sở hữu lịch)', async () => {
    const apptOtherDoctor = await Appointment.create({
      id: 8003,
      appointmentNo: 'FIX3-APPT-8003',
      patientId: patient1.id,
      doctorId: doctor2.id,
      specialtyId: specialty1.id,
      shiftId: shift1.id,
      appointmentDate: '2026-11-02',
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.CHECKED_IN,
      patients: [{ fullName: 'Bệnh Nhân Fix3' }],
    });

    // Doctor 1 cố gọi start lịch của Doctor 2
    const res = await apiRequest('PUT', `/appointments/start/${apptOtherDoctor.id}`, {
      token: doctor1Token,
    });

    assert.equal(res.status, 404);
    assert.match(res.body.message, /Appointment not found/i);
  });

  it('4. Complete lịch đúng: yêu cầu prescription tồn tại, chuyển IN_PROGRESS -> COMPLETED, lưu actualEndTime ISO', async () => {
    const apptComplete = await Appointment.create({
      id: 8004,
      appointmentNo: 'FIX3-APPT-8004',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: shift1.id,
      appointmentDate: '2026-11-02',
      appointmentTime: '09:30',
      status: APPOINTMENT_STATUSES.IN_PROGRESS,
      actualStartTime: '2026-11-02T08:30:00.000Z',
      patients: [{ fullName: 'Bệnh Nhân Fix3' }],
    });

    // Cố hoàn thành khi chưa có đơn thuốc -> 409
    const resNoPrescription = await apiRequest('PUT', `/appointments/complete/${apptComplete.id}`, {
      token: doctor1Token,
    });
    assert.equal(resNoPrescription.status, 409);
    assert.match(resNoPrescription.body.message, /prescription/i);

    // Tạo đơn thuốc hợp lệ cho lịch hẹn
    await Prescription.create({
      id: 9001,
      appointmentId: apptComplete.id,
      medicineName: 'Paracetamol 500mg',
      dosage: '1 viên',
      duration: '5 ngày',
      instructions: 'Uống sau ăn',
    });

    // Chỉnh đồng hồ tới thời điểm kết thúc khám
    fakeClock.setNow(new Date('2026-11-02T09:00:00.000Z'));

    const res = await apiRequest('PUT', `/appointments/complete/${apptComplete.id}`, {
      token: doctor1Token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, APPOINTMENT_STATUSES.COMPLETED);

    const fresh = await Appointment.findOne({ id: apptComplete.id }).lean();
    assert.equal(fresh.status, APPOINTMENT_STATUSES.COMPLETED);
    assert.equal(fresh.actualEndTime, '2026-11-02T09:00:00.000Z');

    // Kiểm tra AuditLog
    const audit = await AuditLog.findOne({
      targetType: 'Appointment',
      targetId: String(apptComplete.id),
      'changes.after.status': APPOINTMENT_STATUSES.COMPLETED,
    }).lean();
    assert.ok(audit, 'AuditLog COMPLETED phải được ghi');

    // Kiểm tra OutboxEvent
    const outbox = await OutboxEvent.findOne({
      eventType: 'APPOINTMENT_COMPLETED',
    }).lean();
    assert.ok(outbox, 'OutboxEvent COMPLETED phải được ghi');
  });

  it('5. Tính Idempotent: Gọi lặp completeAppointment khi đã COMPLETED trả về state hiện tại, không lỗi 500', async () => {
    const resRepeat = await apiRequest('PUT', '/appointments/complete/8004', {
      token: doctor1Token,
    });

    assert.equal(resRepeat.status, 200);
    assert.equal(resRepeat.body.success, true);
    assert.equal(resRepeat.body.data.status, APPOINTMENT_STATUSES.COMPLETED);
  });

  it('6. Concurrency: 2 request start song song cùng 1 lịch chỉ chuyển trạng thái 1 lần, cả 2 trả về 200', async () => {
    const apptConcurrent = await Appointment.create({
      id: 8005,
      appointmentNo: 'FIX3-APPT-8005',
      patientId: patient1.id,
      doctorId: doctor1.id,
      specialtyId: specialty1.id,
      shiftId: shift1.id,
      appointmentDate: '2026-11-02',
      appointmentTime: '10:00',
      status: APPOINTMENT_STATUSES.CHECKED_IN,
      patients: [{ fullName: 'Bệnh Nhân Fix3' }],
    });

    const [resA, resB] = await Promise.all([
      apiRequest('PUT', `/appointments/start/${apptConcurrent.id}`, { token: doctor1Token }),
      apiRequest('PUT', `/appointments/start/${apptConcurrent.id}`, { token: doctor1Token }),
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(resA.body.data.status, APPOINTMENT_STATUSES.IN_PROGRESS);
    assert.equal(resB.body.data.status, APPOINTMENT_STATUSES.IN_PROGRESS);

    const fresh = await Appointment.findOne({ id: apptConcurrent.id }).lean();
    assert.equal(fresh.status, APPOINTMENT_STATUSES.IN_PROGRESS);
  });
});
