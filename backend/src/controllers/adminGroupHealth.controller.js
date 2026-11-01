const adminGroupHealthService = require('../services/adminGroupHealth.service');
const { streamFileToResponse } = require('../utils/groupHealthStorage');
const { sendSuccess } = require('../utils/response');

function resolveDisposition(query = {}) {
  if (
    query.disposition === 'inline' ||
    query.inline === 'true' ||
    query.inline === '1' ||
    query.mode === 'open'
  ) {
    return 'inline';
  }
  return 'attachment';
}

async function listRequests(req, res) {
  const data = await adminGroupHealthService.listRequests({
    status: req.query.status,
  });
  return sendSuccess(res, {
    message: 'Lấy danh sách yêu cầu khám nhóm thành công',
    data,
  });
}

async function getRequestDetail(req, res) {
  const data = await adminGroupHealthService.getRequestDetail(
    req.params.requestId,
  );
  return sendSuccess(res, {
    message: 'Lấy chi tiết yêu cầu khám nhóm thành công',
    data,
  });
}

async function openRequestSourceFile(req, res, next) {
  const file = await adminGroupHealthService.getRequestSourceFileForAdmin(
    req.params.requestId,
  );
  return streamFileToResponse(
    res,
    { ...file, disposition: resolveDisposition(req.query) },
    next,
  );
}

async function listAssignments(req, res) {
  const data = await adminGroupHealthService.listAssignments({
    resultStatus: req.query.resultStatus,
    requestId: req.query.requestId,
    doctorId: req.query.doctorId,
  });
  return sendSuccess(res, {
    message: 'Lấy danh sách phân công kết quả khám nhóm thành công',
    data,
  });
}

async function getAssignmentDetail(req, res) {
  const data = await adminGroupHealthService.getAssignmentDetail(
    req.params.assignmentId,
  );
  return sendSuccess(res, {
    message: 'Lấy chi tiết phân công khám nhóm thành công',
    data,
  });
}

async function openAssignmentSourceFile(req, res, next) {
  const file = await adminGroupHealthService.getAssignmentFileForAdmin(
    req.params.assignmentId,
    { kind: 'source' },
  );
  return streamFileToResponse(
    res,
    { ...file, disposition: resolveDisposition(req.query) },
    next,
  );
}

async function openAssignmentResultFile(req, res, next) {
  const version = req.params.version ?? req.query.version ?? 'latest';
  const file = await adminGroupHealthService.getAssignmentFileForAdmin(
    req.params.assignmentId,
    { kind: 'result', version },
  );
  return streamFileToResponse(
    res,
    { ...file, disposition: resolveDisposition(req.query) },
    next,
  );
}

async function approveAssignmentResult(req, res) {
  const result = await adminGroupHealthService.approveAssignmentResult(
    req.user,
    req.params.assignmentId,
    req.body || {},
    req,
  );
  return sendSuccess(res, {
    message: result.idempotent
      ? 'Kết quả phân công đã được duyệt trước đó (idempotent)'
      : 'Duyệt kết quả khám nhóm thành công',
    data: result,
  });
}

async function rejectAssignmentResult(req, res) {
  const result = await adminGroupHealthService.rejectAssignmentResult(
    req.user,
    req.params.assignmentId,
    req.body || {},
    req,
  );
  return sendSuccess(res, {
    message: 'Đã từ chối kết quả khám nhóm',
    data: result,
  });
}

async function reviewAssignmentResult(req, res) {
  const result = await adminGroupHealthService.reviewAssignmentResult(
    req.user,
    req.params.assignmentId,
    req.body || {},
    req,
  );
  return sendSuccess(res, {
    message: 'Xử lý duyệt kết quả khám nhóm thành công',
    data: result,
  });
}

async function approveRequest(req, res) {
  const data = await adminGroupHealthService.approveRequest(
    req.user,
    req.params.requestId,
    req.body || {},
    req,
  );
  return sendSuccess(res, {
    message: 'Duyệt yêu cầu khám nhóm thành công',
    data,
  });
}

async function rejectRequest(req, res) {
  const data = await adminGroupHealthService.rejectRequest(
    req.user,
    req.params.requestId,
    req.body || {},
    req,
  );
  return sendSuccess(res, {
    message: 'Từ chối yêu cầu khám nhóm thành công',
    data,
  });
}

async function assignRequest(req, res) {
  const data = await adminGroupHealthService.assignRequest(
    req.user,
    req.params.requestId,
    req.body || {},
    req,
  );
  return sendSuccess(res, {
    statusCode: 201,
    message: 'Phân công khám nhóm thành công',
    data,
  });
}

async function updateAssignment(req, res) {
  const data = await adminGroupHealthService.updateAssignment(
    req.user,
    req.params.assignmentId,
    req.body || {},
    req,
  );
  return sendSuccess(res, {
    message: 'Cập nhật phân công khám nhóm thành công',
    data,
  });
}

async function deleteAssignment(req, res) {
  const data = await adminGroupHealthService.deleteAssignment(
    req.user,
    req.params.assignmentId,
    req,
  );
  return sendSuccess(res, {
    message: data.message,
    data,
  });
}

module.exports = {
  listRequests,
  getRequestDetail,
  openRequestSourceFile,
  listAssignments,
  getAssignmentDetail,
  openAssignmentSourceFile,
  openAssignmentResultFile,
  approveAssignmentResult,
  rejectAssignmentResult,
  reviewAssignmentResult,
  approveRequest,
  rejectRequest,
  assignRequest,
  updateAssignment,
  deleteAssignment,
};


