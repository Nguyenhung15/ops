const ApiError = require('./ApiError');

/**
 * Flexible date parser that supports:
 * 1. "DD/MM/YYYY HH:mm" or "DD/MM/YYYY" (sent by AdminEvents.tsx and AdminVouchers.tsx)
 * 2. ISO-8601 strings (e.g. "2026-10-30T14:30:00.000Z", "2026-10-30")
 * 3. Native Date objects or epoch timestamps
 *
 * @param {string|Date|number|null|undefined} input
 * @param {string} [fieldName='Date']
 * @param {boolean} [required=false]
 * @returns {Date|null}
 */
function parseFlexibleDate(input, fieldName = 'Ngày tháng', required = false) {
  if (input === null || input === undefined || input === '') {
    if (required) {
      throw new ApiError(400, `${fieldName} không được để trống`);
    }
    return null;
  }

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new ApiError(400, `${fieldName} không hợp lệ`);
    }
    return input;
  }

  if (typeof input === 'number') {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) {
      throw new ApiError(400, `${fieldName} không hợp lệ`);
    }
    return d;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      if (required) {
        throw new ApiError(400, `${fieldName} không được để trống`);
      }
      return null;
    }

    // Match DD/MM/YYYY HH:mm or DD/MM/YYYY
    const ddmmyyyyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2}))?$/);
    if (ddmmyyyyMatch) {
      const day = parseInt(ddmmyyyyMatch[1], 10);
      const month = parseInt(ddmmyyyyMatch[2], 10);
      const year = parseInt(ddmmyyyyMatch[3], 10);
      const hour = ddmmyyyyMatch[4] !== undefined ? parseInt(ddmmyyyyMatch[4], 10) : 0;
      const minute = ddmmyyyyMatch[5] !== undefined ? parseInt(ddmmyyyyMatch[5], 10) : 0;

      if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new ApiError(400, `${fieldName} chứa giá trị ngày/giờ không hợp lệ`);
      }

      const d = new Date(year, month - 1, day, hour, minute);
      if (Number.isNaN(d.getTime())) {
        throw new ApiError(400, `${fieldName} không hợp lệ`);
      }
      return d;
    }

    // Try standard Date parsing (ISO-8601, RFC2822, etc.)
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  throw new ApiError(400, `${fieldName} không đúng định dạng (hỗ trợ DD/MM/YYYY HH:mm hoặc ISO-8601)`);
}

module.exports = {
  parseFlexibleDate,
};
