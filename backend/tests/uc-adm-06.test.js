const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Isolate test database BEFORE loading app & models
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'uc_adm_06_test_secret';
const TEST_DB_URI =
  process.env.MONGO_TEST_URI_ADM06 ||
  'mongodb://127.0.0.1:27017/clinic_booking_test_uc_adm_06';

const app = require('../src/app');
const {
  User,
  Specialty,
  DoctorShift,
  GroupHealthRequest,
  GroupHealthAssignment,
  AuditLog,
} = require('../src/models');
const { ROLES, AUDIT_ACTIONS, GROUP_HEALTH_REQUEST_STATUSES } = require('../constants/enums');

let server;
let baseUrl;
let adminToken;
let doctorToken;
let patientToken;

let testDoctorId;
let otherDoctorId;
let disabledDoctorId;
let testSpecialtyId;
let disabledSpecialtyId;
let testShiftId;
let cancelledShiftId;
let pendingRequestId;
let createdAssignmentId;

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

describe('UC-ADM-06: Duyệt và chia yêu cầu khám nhóm (Group Health Request Approval & Splitting)', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();

    const passwordHash = await bcrypt.hash('Secret@123', 10);

    // 1. Seed Specialties
    const spec = await Specialty.create({
      name: 'Nội tổng quát',
      description: 'Khám nội khoa tổng quát',
      isEnable: true,
    });
    testSpecialtyId = spec.id;

    const disabledSpec = await Specialty.create({
      name: 'Khoa Tạm đóng',
      description: 'Chuyên khoa đang bảo trì',
      isEnable: false,
    });
    disabledSpecialtyId = disabledSpec.id;

    // 2. Seed Admin User
    await User.create({
      email: 'admin.group@clinic.com',
      password: passwordHash,
      fullName: 'Quản trị viên Khám đoàn',
      userType: ROLES.ADMIN,
      gender: 'Male',
      isEnable: true,
    });

    // 3. Seed Doctor Users
    const doc1 = await User.create({
      email: 'doctor.group1@clinic.com',
      password: passwordHash,
      fullName: 'BS. Trần Văn Khám',
      userType: ROLES.DOCTOR,
      specialtyId: testSpecialtyId,
      gender: 'Male',
      isEnable: true,
    });
    testDoctorId = doc1.id;

    const doc2 = await User.create({
      email: 'doctor.group2@clinic.com',
      password: passwordHash,
      fullName: 'BS. Lê Thị Trưởng',
      userType: ROLES.DOCTOR,
      specialtyId: testSpecialtyId,
      gender: 'Female',
      isEnable: true,
    });
    otherDoctorId = doc2.id;

    const disabledDoc = await User.create({
      email: 'doctor.disabled@clinic.com',
      password: passwordHash,
      fullName: 'BS. Bị Khóa',
      userType: ROLES.DOCTOR,
      specialtyId: testSpecialtyId,
      gender: 'Female',
      isEnable: false,
    });
    disabledDoctorId = disabledDoc.id;

    // 4. Seed Patient User
    await User.create({
      email: 'patient.group@clinic.com',
      password: passwordHash,
      fullName: 'Bệnh nhân Đoàn',
      userType: ROLES.PATIENT,
      gender: 'Female',
      isEnable: true,
    });

    // 5. Seed Doctor Shifts
    const shift1 = await DoctorShift.create({
      doctorId: testDoctorId,
      date: '2026-11-20',
      shift: 'MORNING',
      startTime: '08:00',
      endTime: '12:00',
      maxPatients: 30,
      status: 'ACTIVE',
      slots: [],
    });
    testShiftId = shift1.id;

    const shift2 = await DoctorShift.create({
      doctorId: testDoctorId,
      date: '2026-11-21',
      shift: 'AFTERNOON',
      startTime: '13:00',
      endTime: '17:00',
      maxPatients: 20,
      status: 'CANCELLED',
      slots: [],
    });
    cancelledShiftId = shift2.id;

    // 6. Seed Pending Group Health Request
    const request = await GroupHealthRequest.create({
      groupName: 'Công ty Cổ phần Công nghệ ABC',
      departments: 'Phòng Kỹ thuật & Phòng Kinh doanh (80 nhân viên)',
      phoneNumber: '0905123456',
      preferredDate: '2026-11-20',
      status: 'PENDING',
      sourceFileName: 'danh-sach-kham-suc-khoe-abc.xlsx',
      sourceFileSize: 24500,
      sourceFileMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    pendingRequestId = request.id;

    // 7. Start test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });

    // 8. Login all personas
    const adminLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'admin.group@clinic.com', password: 'Secret@123' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.data.token;

    const doctorLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'doctor.group1@clinic.com', password: 'Secret@123' },
    });
    assert.equal(doctorLogin.status, 200);
    doctorToken = doctorLogin.body.data.token;

    const patientLogin = await apiRequest('POST', '/auth/login', {
      body: { email: 'patient.group@clinic.com', password: 'Secret@123' },
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
    it('Bệnh nhân không có quyền truy cập duyệt yêu cầu khám nhóm (403 Forbidden)', async () => {
      const res = await apiRequest('GET', '/admin/group-health/requests', {
        token: patientToken,
      });
      assert.equal(res.status, 403);
    });

    it('Bác sĩ không có quyền gọi endpoint duyệt hoặc phân công của Admin (403 Forbidden)', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/approve`, {
        token: doctorToken,
      });
      assert.equal(res.status, 403);
    });
  });

  describe('2. Xem thông tin & phân tích yêu cầu khám nhóm', () => {
    it('Admin xem danh sách yêu cầu khám nhóm', async () => {
      const res = await apiRequest('GET', '/admin/group-health/requests', {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.some((r) => r.id === pendingRequestId));
    });

    it('Admin xem chi tiết yêu cầu khám nhóm kèm tiến độ', async () => {
      const res = await apiRequest('GET', `/admin/group-health/requests/${pendingRequestId}`, {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, pendingRequestId);
      assert.equal(res.body.data.groupName, 'Công ty Cổ phần Công nghệ ABC');
      assert.equal(res.body.data.status, 'PENDING');
      assert.equal(res.body.data.sourceFileName, 'danh-sach-kham-suc-khoe-abc.xlsx');
      assert.ok(res.body.data.progress);
      assert.equal(res.body.data.progress.totalAssignments, 0);
    });
  });

  describe('3. Duyệt và Từ chối yêu cầu (Approve / Reject Flow)', () => {
    it('Ngoại lệ: Từ chối yêu cầu bắt buộc phải có lý do (reason) không được để trống (400 Bad Request)', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/reject`, {
        token: adminToken,
        body: { reason: '   ' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /Lý do từ chối/i);
    });

    it('Admin từ chối yêu cầu thành công có ghi nhận lý do và AuditLog', async () => {
      // Tạo một request phụ để thử nghiệm từ chối
      const tempReq = await GroupHealthRequest.create({
        groupName: 'Công ty TNHH Thử Nghiệm Từ Chối',
        status: 'PENDING',
      });

      const res = await apiRequest('POST', `/admin/group-health/requests/${tempReq.id}/reject`, {
        token: adminToken,
        body: { reason: 'Không đủ nhân sự đáp ứng vào ngày công ty yêu cầu' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'REJECTED');
      assert.equal(res.body.data.rejectReason, 'Không đủ nhân sự đáp ứng vào ngày công ty yêu cầu');

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'GroupHealthRequest',
        targetId: tempReq.id,
        action: AUDIT_ACTIONS.GROUP_HEALTH_REQUEST_REJECT,
      }).lean();
      assert.ok(audit);
      assert.equal(audit.reason, 'Không đủ nhân sự đáp ứng vào ngày công ty yêu cầu');

      // Không thể phân công cho request đã bị REJECTED
      const assignRes = await apiRequest('POST', `/admin/group-health/requests/${tempReq.id}/assign`, {
        token: adminToken,
        body: { doctorId: testDoctorId, shiftId: testShiftId },
      });
      assert.equal(assignRes.status, 409);
      assert.match(assignRes.body.message, /đã bị từ chối/i);
    });

    it('Admin duyệt yêu cầu khám nhóm (Approve request) chuyển trạng thái sang APPROVED', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/approve`, {
        token: adminToken,
        body: { note: 'Đã duyệt yêu cầu, chuẩn bị phân công bác sĩ' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'APPROVED');
      assert.ok(res.body.data.approvedAt);

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'GroupHealthRequest',
        targetId: pendingRequestId,
        action: AUDIT_ACTIONS.GROUP_HEALTH_REQUEST_APPROVE,
      }).lean();
      assert.ok(audit);
    });
  });

  describe('4. Phân chia và gán phần theo Specialty / Doctor / Shift (Split & Assign)', () => {
    it('Báo lỗi 400 nếu bác sĩ bị khóa tài khoản', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/assign`, {
        token: adminToken,
        body: {
          doctorId: disabledDoctorId,
          specialtyId: testSpecialtyId,
        },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /bị khóa tài khoản/i);
    });

    it('Báo lỗi 400 nếu chuyên khoa bị vô hiệu hóa', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/assign`, {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          specialtyId: disabledSpecialtyId,
        },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /bị vô hiệu hóa/i);
    });

    it('Báo lỗi 400 nếu ca trực không thuộc về bác sĩ được phân công', async () => {
      // testShiftId thuộc về testDoctorId, nhưng phân công cho otherDoctorId
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/assign`, {
        token: adminToken,
        body: {
          doctorId: otherDoctorId,
          shiftId: testShiftId,
          specialtyId: testSpecialtyId,
        },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /không khớp với bác sĩ/i);
    });

    it('Báo lỗi 400 nếu ca trực đã bị hủy', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/assign`, {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          shiftId: cancelledShiftId,
        },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /đã bị hủy/i);
    });

    it('Báo lỗi 400 nếu số lượng phân bổ (capacityAllocated) vượt quá sức chứa của ca', async () => {
      // testShiftId maxPatients là 30
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/assign`, {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          shiftId: testShiftId,
          capacityAllocated: 50,
        },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /vượt quá sức chứa tối đa/i);
    });

    it('Admin phân công hợp lệ thành công (Split và gán phần theo chuyên khoa, bác sĩ, ca trực)', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/assign`, {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          shiftId: testShiftId,
          specialtyId: testSpecialtyId,
          capacityAllocated: 25,
          note: 'Phụ trách khám nội tổng quát cho khối Kỹ thuật',
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.id, pendingRequestId);
      assert.ok(Array.isArray(res.body.data.assignments));
      assert.equal(res.body.data.assignments.length, 1);

      const assigned = res.body.data.assignments[0];
      assert.equal(assigned.doctorId, testDoctorId);
      assert.equal(assigned.shiftId, testShiftId);
      assert.equal(assigned.specialtyId, testSpecialtyId);
      assert.equal(assigned.capacityAllocated, 25);
      assert.equal(assigned.resultStatus, 'NONE');

      createdAssignmentId = assigned.id;

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'GroupHealthAssignment',
        targetId: createdAssignmentId,
        action: AUDIT_ACTIONS.GROUP_HEALTH_ASSIGNMENT_CREATE,
      }).lean();
      assert.ok(audit);
    });

    it('Ràng buộc: Không gán trùng bác sĩ và ca trực trong cùng một yêu cầu (409 Conflict)', async () => {
      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/assign`, {
        token: adminToken,
        body: {
          doctorId: testDoctorId,
          shiftId: testShiftId,
          specialtyId: testSpecialtyId,
          capacityAllocated: 20,
        },
      });

      assert.equal(res.status, 409);
      assert.match(res.body.message, /đã được phân công|danh sách phân công/i);
    });

    it('Hỗ trợ phân công hàng loạt (Batch Split) nhiều bác sĩ cho cùng yêu cầu', async () => {
      // Tạo thêm 1 ca trực cho otherDoctorId
      const otherShift = await DoctorShift.create({
        doctorId: otherDoctorId,
        date: '2026-11-20',
        shift: 'AFTERNOON',
        startTime: '13:00',
        endTime: '17:00',
        maxPatients: 30,
        status: 'ACTIVE',
        slots: [],
      });

      const res = await apiRequest('POST', `/admin/group-health/requests/${pendingRequestId}/split`, {
        token: adminToken,
        body: {
          assignments: [
            {
              doctorId: otherDoctorId,
              shiftId: otherShift.id,
              specialtyId: testSpecialtyId,
              capacityAllocated: 20,
              note: 'Phụ trách khối Kinh doanh ca chiều',
            },
          ],
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.assignments.length, 2);
    });
  });

  describe('5. Điều chỉnh và Xóa phân công (Update & Delete Assignment)', () => {
    it('Admin điều chỉnh số lượng phân bổ và ghi chú của phân công', async () => {
      const res = await apiRequest('PUT', `/admin/group-health/assignments/${createdAssignmentId}`, {
        token: adminToken,
        body: {
          capacityAllocated: 28,
          note: 'Đã cập nhật số lượng thành 28 nhân viên',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.capacityAllocated, 28);
      assert.equal(res.body.data.note, 'Đã cập nhật số lượng thành 28 nhân viên');

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'GroupHealthAssignment',
        targetId: createdAssignmentId,
        action: AUDIT_ACTIONS.GROUP_HEALTH_ASSIGNMENT_UPDATE,
      }).sort({ createdAt: -1 }).lean();
      assert.ok(audit);
    });

    it('Xóa phân công chưa có kết quả thành công kèm AuditLog', async () => {
      const res = await apiRequest('DELETE', `/admin/group-health/assignments/${createdAssignmentId}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.match(res.body.message, /thành công/i);

      // Verify DB removal
      const found = await GroupHealthAssignment.findOne({ id: createdAssignmentId }).lean();
      assert.equal(found, null);

      // Verify AuditLog
      const audit = await AuditLog.findOne({
        targetType: 'GroupHealthAssignment',
        targetId: createdAssignmentId,
        action: AUDIT_ACTIONS.GROUP_HEALTH_ASSIGNMENT_DELETE,
      }).lean();
      assert.ok(audit);
    });
  });
});
