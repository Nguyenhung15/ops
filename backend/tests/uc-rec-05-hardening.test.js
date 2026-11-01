const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_rec_05_hardening_test_secret_key';
process.env.ENABLE_MONGO_TRANSACTIONS = 'false'; // Verify ENABLE_MONGO_TRANSACTIONS=false operates correctly with compensation

const TEST_DB_URI =
  process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/clinic_booking_test_uc_rec_05_hardening';

const app = require('../src/app');
const {
  User,
  DoctorShift,
  Appointment,
  PaymentTransaction,
  AuditLog,
  OutboxEvent,
  Specialty,
} = require('../src/models');
const { ROLES, APPOINTMENT_STATUSES, AUDIT_ACTIONS } = require('../src/constants/enums');
const { signAccessToken } = require('../src/utils/jwt');
const { setClock, createFakeClock, RealClock } = require('../src/services/clock.service');
const { appointmentStateService } = require('../src/services/appointmentState.service');
const appointmentSlotService = require('../src/services/appointmentSlot.service');

let server;
let baseUrl;

let patientUser;
let patientToken;
let doctorUser;
let doctorToken;
let receptionistUser;
let receptionistToken;
let adminUser;
let adminToken;

let activeShiftA;
let activeShiftB;

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

describe('UC-REC-05 Hardening: Củng cố Hủy và Đổi lịch hẹn', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }
    await mongoose.connection.dropDatabase();

    const hashedPassword = await bcrypt.hash('Test@123456', 10);

    // Create Specialty
    await Specialty.create({
      id: 10,
      name: 'Nhi Khoa',
      description: 'Chuyên khoa nhi',
    });

    // Create Patient
    patientUser = await User.create({
      id: 101,
      userType: ROLES.PATIENT,
      email: 'patient_rec05_h@clinic.test',
      fullName: 'Bệnh Nhân Hardening 05',
      password: hashedPassword,
      phoneNumber: '0988111222',
      isEnable: true,
      cancelledCount: 0,
      isBookingLocked: false,
    });
    patientToken = signAccessToken({
      userId: patientUser.id,
      userType: patientUser.userType,
      email: patientUser.email,
    });

    // Create Doctor
    doctorUser = await User.create({
      id: 201,
      userType: ROLES.DOCTOR,
      email: 'doctor_rec05_h@clinic.test',
      fullName: 'Bác Sĩ Hardening 05',
      password: hashedPassword,
      specialtyId: 10,
      isEnable: true,
    });
    doctorToken = signAccessToken({
      userId: doctorUser.id,
      userType: doctorUser.userType,
      email: doctorUser.email,
    });

    // Create Receptionist
    receptionistUser = await User.create({
      id: 301,
      userType: ROLES.RECEPTIONIST,
      email: 'receptionist_rec05_h@clinic.test',
      fullName: 'Lễ Tân Hardening 05',
      password: hashedPassword,
      isEnable: true,
    });
    receptionistToken = signAccessToken({
      userId: receptionistUser.id,
      userType: receptionistUser.userType,
      email: receptionistUser.email,
    });

    // Create Admin
    adminUser = await User.create({
      id: 401,
      userType: ROLES.ADMIN,
      email: 'admin_rec05_h@clinic.test',
      fullName: 'Admin Hardening 05',
      password: hashedPassword,
      isEnable: true,
    });
    adminToken = signAccessToken({
      userId: adminUser.id,
      userType: adminUser.userType,
      email: adminUser.email,
    });

    // Start HTTP server on random port
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
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
    setClock(createFakeClock(new Date('2026-11-15T08:00:00Z')));

    await Appointment.deleteMany({});
    await DoctorShift.deleteMany({});
    await PaymentTransaction.deleteMany({});
    await AuditLog.deleteMany({});
    await OutboxEvent.deleteMany({});

    // Shift A: Old shift
    activeShiftA = await DoctorShift.create({
      id: 501,
      doctorId: doctorUser.id,
      date: '2026-11-20',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      status: 'ACTIVE',
      slots: [
        {
          id: 5011,
          slotNumber: 1,
          startTime: '08:00',
          endTime: '08:45',
          status: 'AVAILABLE',
          bookingRef: null,
          bookedAt: null,
        },
        {
          id: 5012,
          slotNumber: 2,
          startTime: '09:00',
          endTime: '09:45',
          status: 'AVAILABLE',
          bookingRef: null,
          bookedAt: null,
        },
      ],
    });

    // Shift B: Target shift for reschedule
    activeShiftB = await DoctorShift.create({
      id: 502,
      doctorId: doctorUser.id,
      date: '2026-11-21',
      shift: 'AFTERNOON',
      startTime: '13:00',
      endTime: '17:00',
      status: 'ACTIVE',
      slots: [
        {
          id: 5021,
          slotNumber: 1,
          startTime: '13:00',
          endTime: '13:45',
          status: 'AVAILABLE',
          bookingRef: null,
          bookedAt: null,
        },
        {
          id: 5022,
          slotNumber: 2,
          startTime: '14:00',
          endTime: '14:45',
          status: 'AVAILABLE',
          bookingRef: null,
          bookedAt: null,
        },
      ],
    });
  });

  it('1. Đổi lịch concurrency: 2 request đổi cùng vào 1 slot -> 1 thành công (200), 1 bị 409, slot không bị lệch dữ liệu', async () => {
    // Tạo 2 appointment cũ
    const appt1 = await Appointment.create({
      id: 1001,
      appointmentNo: 'OFFCONC01',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5011],
      appointmentDate: activeShiftA.date,
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Đau đầu',
    });
    const appt2 = await Appointment.create({
      id: 1002,
      appointmentNo: 'OFFCONC02',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5012],
      appointmentDate: activeShiftA.date,
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Sốt nhẹ',
    });

    // Gửi 2 request đổi lịch cùng nhắm vào slot 5021 của shift 502
    const [res1, res2] = await Promise.all([
      apiRequest('PUT', `/appointments/reschedule/${appt1.id}`, {
        token: receptionistToken,
        body: {
          newShiftId: activeShiftB.id,
          newSlotId: 5021,
          reason: 'Bận việc gia đình - đổi lịch 1',
        },
      }),
      apiRequest('PUT', `/appointments/reschedule/${appt2.id}`, {
        token: receptionistToken,
        body: {
          newShiftId: activeShiftB.id,
          newSlotId: 5021,
          reason: 'Bận việc gia đình - đổi lịch 2',
        },
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 409], 'Chính xác 1 request thành công 200 và 1 request thất bại 409');

    // Kiểm tra slot 5021 trong DB: phải là BOOKED và gắn đúng appointmentNo mới
    const updatedShiftB = await DoctorShift.findOne({ id: activeShiftB.id });
    const slot5021 = updatedShiftB.slots.find((s) => s.id === 5021);
    assert.equal(slot5021.status, 'BOOKED');
    assert.ok(slot5021.bookingRef, 'Slot 5021 phải có bookingRef');
    assert.notEqual(slot5021.bookingRef, 'OFFCONC01');
    assert.notEqual(slot5021.bookingRef, 'OFFCONC02');
  });

  it('2. Mock lỗi sau khi giữ slot mới -> cơ chế bồi hoàn (compensation) tự động trả slot về AVAILABLE', async () => {
    const appt = await Appointment.create({
      id: 1003,
      appointmentNo: 'OFFMOCK01',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5011],
      appointmentDate: activeShiftA.date,
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Khám kiểm tra',
    });

    // Mock transition của appointmentStateService ném lỗi giữa chừng
    const originalTransition = appointmentStateService.transition;
    appointmentStateService.transition = async () => {
      throw new Error('MOCK_DATABASE_NETWORK_PARTITION_FAILURE');
    };

    try {
      const res = await apiRequest('PUT', `/appointments/reschedule/${appt.id}`, {
        token: receptionistToken,
        body: {
          newShiftId: activeShiftB.id,
          newSlotId: 5022,
          reason: 'Dời sang ca chiều',
        },
      });

      assert.equal(res.status, 500);

      // Kiểm tra slot 5022 phải được trả về AVAILABLE
      const refreshedShiftB = await DoctorShift.findOne({ id: activeShiftB.id });
      const slot5022 = refreshedShiftB.slots.find((s) => s.id === 5022);
      assert.equal(slot5022.status, 'AVAILABLE', 'Slot 5022 phải được rollback về AVAILABLE');
      assert.equal(slot5022.bookingRef, null, 'bookingRef phải được xóa sạch về null');

      // Lịch hẹn cũ vẫn giữ nguyên CONFIRMED
      const checkAppt = await Appointment.findOne({ id: appt.id });
      assert.equal(checkAppt.status, APPOINTMENT_STATUSES.CONFIRMED);
    } finally {
      appointmentStateService.transition = originalTransition;
    }
  });

  it('3. Hủy lịch không giải phóng slot của lịch khác (guard bookingRef mismatch)', async () => {
    // Slot 5011 đang do lịch khác APPT_OTHER_123 giữ
    await DoctorShift.updateOne(
      { id: activeShiftA.id, 'slots.id': 5011 },
      {
        $set: {
          'slots.$.status': 'BOOKED',
          'slots.$.bookingRef': 'APPT_OTHER_123',
          'slots.$.bookedAt': new Date(),
        },
      },
    );

    // Appointment đang có slotIds chứa 5011 nhưng appointmentNo là MY_OWN_999
    const myAppt = await Appointment.create({
      id: 1004,
      appointmentNo: 'MY_OWN_999',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5011],
      appointmentDate: activeShiftA.date,
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Khám định kỳ',
    });

    const res = await apiRequest('PUT', `/appointments/cancel/${myAppt.id}`, {
      token: receptionistToken,
      body: {
        reason: 'Lễ tân hủy lịch cho bệnh nhân',
      },
    });

    assert.equal(res.status, 200);

    // Slot 5011 TUYỆT ĐỐI không bị giải phóng vì bookingRef của nó không khớp MY_OWN_999
    const refreshedShiftA = await DoctorShift.findOne({ id: activeShiftA.id });
    const slot5011 = refreshedShiftA.slots.find((s) => s.id === 5011);
    assert.equal(slot5011.status, 'BOOKED');
    assert.equal(slot5011.bookingRef, 'APPT_OTHER_123');
  });

  it('4. Hủy lịch COMPLETED bị từ chối 409 INVALID_STATE', async () => {
    const completedAppt = await Appointment.create({
      id: 1005,
      appointmentNo: 'OFFCOMP01',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5012],
      appointmentDate: activeShiftA.date,
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.COMPLETED,
      reason: 'Đã hoàn tất',
    });

    const res = await apiRequest('PUT', `/appointments/cancel/${completedAppt.id}`, {
      token: receptionistToken,
      body: {
        reason: 'Hủy lịch đã khám',
      },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error?.code, 'INVALID_STATE');
  });

  it('5. Thiếu reason khi hủy bị từ chối 400 REASON_REQUIRED', async () => {
    const appt = await Appointment.create({
      id: 1006,
      appointmentNo: 'OFFNOREAS01',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5012],
      appointmentDate: activeShiftA.date,
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Cần hủy',
    });

    const resEmpty = await apiRequest('PUT', `/appointments/cancel/${appt.id}`, {
      token: receptionistToken,
      body: {
        reason: '   ',
      },
    });
    assert.equal(resEmpty.status, 400);
    assert.equal(resEmpty.body.error?.code, 'REASON_REQUIRED');

    const resMissing = await apiRequest('PUT', `/appointments/cancel/${appt.id}`, {
      token: receptionistToken,
      body: {},
    });
    assert.equal(resMissing.status, 400);
    assert.equal(resMissing.body.error?.code, 'REASON_REQUIRED');
  });

  it('6. Role Doctor gọi endpoint hủy/đổi của staff bị từ chối 403 FORBIDDEN_ROLE', async () => {
    const appt = await Appointment.create({
      id: 1007,
      appointmentNo: 'OFFROLETEST',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5011],
      appointmentDate: activeShiftA.date,
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Test role guard',
    });

    // Doctor gọi /appointments/cancel/:id (endpoint của staff) -> 403
    const resDocCancel = await apiRequest('PUT', `/appointments/cancel/${appt.id}`, {
      token: doctorToken,
      body: {
        reason: 'Bác sĩ tự ý gọi staff cancel',
      },
    });
    assert.equal(resDocCancel.status, 403);

    // Doctor gọi /appointments/reschedule/:id (endpoint của staff) -> 403
    const resDocResched = await apiRequest('PUT', `/appointments/reschedule/${appt.id}`, {
      token: doctorToken,
      body: {
        newShiftId: activeShiftB.id,
        reason: 'Bác sĩ tự gọi endpoint lễ tân',
      },
    });
    assert.equal(resDocResched.status, 403);
  });

  it('7. Hủy lặp lại (idempotent): lịch đã CANCELLED gọi lại trả HTTP 200 idempotent mà không giải phóng slot 2 lần', async () => {
    // Đặt trước slot 5012 cho appt
    await DoctorShift.updateOne(
      { id: activeShiftA.id, 'slots.id': 5012 },
      {
        $set: {
          'slots.$.status': 'BOOKED',
          'slots.$.bookingRef': 'OFFIDEMP01',
          'slots.$.bookedAt': new Date(),
        },
      },
    );

    const appt = await Appointment.create({
      id: 1008,
      appointmentNo: 'OFFIDEMP01',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5012],
      appointmentDate: activeShiftA.date,
      appointmentTime: '09:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      reason: 'Hủy kiểm tra idempotent',
    });

    // Lần 1: Hủy thành công
    const res1 = await apiRequest('PUT', `/appointments/cancel/${appt.id}`, {
      token: receptionistToken,
      body: {
        reason: 'Lễ tân hủy lần 1',
      },
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.data?.status, APPOINTMENT_STATUSES.CANCELLED);

    // Sau lần 1, slot 5012 có người khác vào đặt ngay
    await DoctorShift.updateOne(
      { id: activeShiftA.id, 'slots.id': 5012 },
      {
        $set: {
          'slots.$.status': 'BOOKED',
          'slots.$.bookingRef': 'SOMEONE_ELSE_NEW_APPT',
          'slots.$.bookedAt': new Date(),
        },
      },
    );

    // Lần 2: Gọi hủy lặp lại (idempotent: HTTP 200, status CANCELLED, message báo đã hủy trước đó)
    const res2 = await apiRequest('PUT', `/appointments/cancel/${appt.id}`, {
      token: receptionistToken,
      body: {
        reason: 'Lễ tân bấm nhầm lần 2',
      },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.data?.status, APPOINTMENT_STATUSES.CANCELLED);
    assert.equal(res2.body.message, 'Lịch hẹn đã được hủy trước đó');

    // Slot của người khác TUYỆT ĐỐI không bị ảnh hưởng
    const shiftAfter = await DoctorShift.findOne({ id: activeShiftA.id });
    const slot5012 = shiftAfter.slots.find((s) => s.id === 5012);
    assert.equal(slot5012.status, 'BOOKED');
    assert.equal(slot5012.bookingRef, 'SOMEONE_ELSE_NEW_APPT');
  });

  it('8. Tự động đánh dấu refundRequired = true khi đã có PaymentTransaction thành công', async () => {
    const paidAppt = await Appointment.create({
      id: 1009,
      appointmentNo: 'OFFPAID01',
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      specialtyId: 10,
      shiftId: activeShiftA.id,
      slotIds: [5011],
      appointmentDate: activeShiftA.date,
      appointmentTime: '08:00',
      status: APPOINTMENT_STATUSES.CONFIRMED,
      refundRequired: false,
      reason: 'Khám đã thanh toán online',
    });

    // Tạo bản ghi PaymentTransaction với status = SUCCESS
    await PaymentTransaction.create({
      id: 9901,
      appointmentId: paidAppt.id,
      amount: 250000,
      status: 'SUCCESS',
      transactionNo: 'VNPay_9901',
      responseCode: '00',
    });

    const res = await apiRequest('PUT', `/appointments/cancel/${paidAppt.id}`, {
      token: receptionistToken,
      body: {
        reason: 'Bệnh nhân bận việc đột xuất cần hoàn tiền',
      },
    });

    assert.equal(res.status, 200);
    const updatedAppt = await Appointment.findOne({ id: paidAppt.id });
    assert.equal(updatedAppt.status, APPOINTMENT_STATUSES.CANCELLED);
    assert.equal(updatedAppt.refundRequired, true, 'Lịch hẹn phải được đánh dấu refundRequired = true');
  });

  it('9. Trích logic giữ/giải phóng slot vào appointmentSlotService: unit test holdSlot & releaseSlot', async () => {
    // 9.1 holdSlot thành công vào shift A slot 5011
    const holdRes = await appointmentSlotService.holdSlot({
      shiftId: activeShiftA.id,
      slotId: 5011,
      bookingRef: 'UNIT_HOLD_REF_123',
    });
    assert.equal(holdRes.success, true);

    const shiftACheck = await DoctorShift.findOne({ id: activeShiftA.id });
    const slot5011 = shiftACheck.slots.find((s) => s.id === 5011);
    assert.equal(slot5011.status, 'BOOKED');
    assert.equal(slot5011.bookingRef, 'UNIT_HOLD_REF_123');

    // 9.2 holdSlot lặp lại vào cùng slot đã bị đặt -> 409 SLOT_ALREADY_BOOKED
    await assert.rejects(
      async () => {
        await appointmentSlotService.holdSlot({
          shiftId: activeShiftA.id,
          slotId: 5011,
          bookingRef: 'UNIT_HOLD_REF_ANOTHER',
        });
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'SLOT_ALREADY_BOOKED');
        return true;
      },
    );

    // 9.3 releaseSlot không đúng bookingRef -> modifiedCount = 0, slot vẫn BOOKED
    const wrongRelease = await appointmentSlotService.releaseSlot({
      shiftId: activeShiftA.id,
      slotIds: [5011],
      bookingRef: 'WRONG_REF',
    });
    assert.equal(wrongRelease.modifiedCount, 0);

    // 9.4 releaseSlot đúng bookingRef -> trả về AVAILABLE
    const correctRelease = await appointmentSlotService.releaseSlot({
      shiftId: activeShiftA.id,
      slotIds: [5011],
      bookingRef: 'UNIT_HOLD_REF_123',
    });
    assert.equal(correctRelease.modifiedCount, 1);

    const shiftAReleased = await DoctorShift.findOne({ id: activeShiftA.id });
    const slot5011Released = shiftAReleased.slots.find((s) => s.id === 5011);
    assert.equal(slot5011Released.status, 'AVAILABLE');
    assert.equal(slot5011Released.bookingRef, null);
  });
});
