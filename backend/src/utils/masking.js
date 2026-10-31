/**
 * Mask an email address:
 * e.g. "nguyenhung@gmail.com" -> "n***@gmail.com"
 * or "a@gmail.com" -> "a***@gmail.com"
 * or "ab@gmail.com" -> "a***@gmail.com"
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const parts = email.trim().split('@');
  if (parts.length !== 2) return '***';

  const [username, domain] = parts;
  if (!username) return `***@${domain}`;

  const firstChar = username[0];
  return `${firstChar}***@${domain}`;
}

/**
 * Mask a phone number:
 * e.g. "0912345678" -> "09****678" (or "09****123")
 * Standard pattern: Keep first 2 digits, mask middle, keep last 3 digits
 * If length <= 5: Keep first char, mask rest
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const clean = phone.trim();
  if (clean.length < 5) return '***';

  const prefix = clean.slice(0, 2);
  const suffix = clean.slice(-3);
  return `${prefix}****${suffix}`;
}

module.exports = {
  maskEmail,
  maskPhone,
};
