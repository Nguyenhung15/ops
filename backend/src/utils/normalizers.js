const ApiError = require('./ApiError');
const { GENDERS, ROLE_VALUES } = require('../constants/enums');

/**
 * Normalize gender variants ('MALE' | 'Male' | 'Nam' | ...) -> 'Male' | 'Female' | 'Other'
 */
function normalizeGender(value) {
  if (typeof value !== 'string') return GENDERS.OTHER;
  const normalized = value.trim().toLowerCase();
  if (['male', 'nam', 'm'].includes(normalized)) return GENDERS.MALE;
  if (['female', 'nu', 'nữ', 'f'].includes(normalized)) return GENDERS.FEMALE;
  return GENDERS.OTHER;
}

/**
 * Normalize email to lowercase & trimmed string.
 */
function normalizeEmail(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'Email không hợp lệ');
  }
  const email = value.trim().toLowerCase();
  const emailRegex = /^[a-zA-Z0-9]+([._%+-][a-zA-Z0-9]+)*@[a-zA-Z0-9]+([.-][a-zA-Z0-9]+)*\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) {
    throw new ApiError(400, 'Định dạng email không hợp lệ');
  }
  return email;
}

/**
 * Normalize and validate Vietnamese/international phone number format.
 * Accepts: 10 digits starting with 0 (e.g. 0912345678) or international format (+84912345678).
 */
function normalizePhoneNumber(value, { required = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) {
      throw new ApiError(400, 'Số điện thoại không được để trống');
    }
    return null;
  }
  const phone = String(value).trim().replace(/[\s.-]+/g, '');
  const phoneRegex = /^(?:\+84|0)[1-9]\d{8}$/;
  if (!phoneRegex.test(phone)) {
    throw new ApiError(400, 'Số điện thoại không đúng định dạng (yêu cầu 10 chữ số, ví dụ 0945148484)');
  }
  return phone;
}

/**
 * Normalize user role case-insensitively to canonical 'Patient' | 'Doctor' | 'Receptionist' | 'Admin'.
 */
function normalizeRole(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'Vai trò người dùng (userType) không hợp lệ');
  }
  const lower = value.trim().toLowerCase();
  const matched = ROLE_VALUES.find((role) => role.toLowerCase() === lower);
  if (!matched) {
    throw new ApiError(
      400,
      `Vai trò '${value}' không hợp lệ. Chỉ chấp nhận: ${ROLE_VALUES.join(', ')}`,
    );
  }
  return matched;
}

/**
 * Parse and validate a positive integer ID from route params or query.
 */
function parsePositiveInt(value, fieldName = 'ID') {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ApiError(400, `${fieldName} không hợp lệ`);
  }
  return num;
}

/**
 * Escape special regex characters to prevent ReDoS on keyword search.
 */
function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  normalizeGender,
  normalizeEmail,
  normalizePhoneNumber,
  normalizeRole,
  parsePositiveInt,
  escapeRegex,
};

