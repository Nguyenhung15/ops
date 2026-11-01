const bcrypt = require('bcryptjs');
const ApiError = require('../utils/ApiError');
const { normalizeEmail, normalizePhoneNumber, normalizeGender } = require('../utils/normalizers');
const { signAccessToken } = require('../utils/jwt');
const { ROLES, AUTH_PROVIDERS, AUDIT_ACTIONS } = require('../constants/enums');
const { User } = require('../models');
const { recordAudit } = require('./audit.service');
const bootstrapAdminService = require('./bootstrapAdmin.service');

const BCRYPT_ROUNDS = 10;
const OAUTH_PASSWORD_SENTINEL = '{noop}GOOGLE_LOGIN';

function validatePasswordStrength(password, fieldLabel = 'Mật khẩu') {
  if (typeof password !== 'string' || password.length < 6) {
    throw new ApiError(400, `${fieldLabel} phải có ít nhất 6 ký tự`);
  }
}

async function login({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  if (typeof password !== 'string' || !password) {
    throw new ApiError(400, 'Vui lòng nhập mật khẩu');
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    throw new ApiError(401, 'Email hoặc mật khẩu không chính xác');
  }

  if (!user.isEnable) {
    throw new ApiError(403, 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ quản trị viên');
  }

  if (user.password === OAUTH_PASSWORD_SENTINEL) {
    throw new ApiError(400, 'Tài khoản này sử dụng đăng nhập Google, vui lòng chọn đăng nhập bằng Google');
  }

  const passwordValid = await bcrypt.compare(password, user.password);
  if (!passwordValid) {
    throw new ApiError(401, 'Email hoặc mật khẩu không chính xác');
  }

  const token = signAccessToken(user);

  // Exact structure expected by web/src/api/auth.ts BackendLoginResponse
  return {
    message: 'Đăng nhập thành công',
    success: true,
    id: user.id,
    fullName: user.fullName,
    role: user.userType,
    token,
  };
}

async function registerPatient(payload) {
  const fullName = typeof payload?.fullName === 'string' ? payload.fullName.trim() : '';
  if (!fullName) {
    throw new ApiError(400, 'Họ và tên không được để trống');
  }

  const email = normalizeEmail(payload?.email);
  validatePasswordStrength(payload?.password);

  const existing = await User.findOne({ email });
  if (existing) {
    throw new ApiError(409, 'Email đã tồn tại trong hệ thống');
  }

  const hashedPassword = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);
  // Strictly force `userType: ROLES.PATIENT` — never trust role fields from public registration payloads
  const created = await User.create({
    fullName,
    email,
    phoneNumber: normalizePhoneNumber(payload?.phoneNumber),
    password: hashedPassword,
    gender: normalizeGender(payload?.gender),
    userType: ROLES.PATIENT,
    isEnable: true,
    authProvider: AUTH_PROVIDERS.LOCAL,
  });

  return {
    id: created.id,
    email: created.email,
  };
}

async function registerAdmin(payload, req = null) {
  return bootstrapAdminService.bootstrapFirstAdmin(payload, req);
}

async function getBootstrapStatus() {
  return bootstrapAdminService.getBootstrapStatus();
}

async function changePassword(actor, payload, req) {
  const { oldPassword, newPassword, confirmPassword } = payload || {};
  if (!oldPassword || !newPassword) {
    throw new ApiError(400, 'Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới');
  }
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    throw new ApiError(400, 'Mật khẩu xác nhận không khớp');
  }
  validatePasswordStrength(newPassword, 'Mật khẩu mới');

  const user = await User.findOne({ id: actor.id });
  if (!user) {
    throw new ApiError(404, 'Không tìm thấy tài khoản');
  }
  if (user.password === OAUTH_PASSWORD_SENTINEL) {
    throw new ApiError(400, 'Tài khoản đăng nhập qua Google không hỗ trợ đổi mật khẩu trực tiếp');
  }

  const matches = await bcrypt.compare(oldPassword, user.password);
  if (!matches) {
    throw new ApiError(400, 'Mật khẩu hiện tại không chính xác');
  }

  user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await user.save();

  await recordAudit({
    actor: user,
    action: AUDIT_ACTIONS.USER_PASSWORD_CHANGE,
    targetType: 'User',
    targetId: user.id,
    reason: 'Người dùng tự đổi mật khẩu',
    req,
  });

  return { message: 'Đổi mật khẩu thành công' };
}

module.exports = {
  BCRYPT_ROUNDS,
  OAUTH_PASSWORD_SENTINEL,
  validatePasswordStrength,
  login,
  registerPatient,
  registerAdmin,
  getBootstrapStatus,
  changePassword,
};

