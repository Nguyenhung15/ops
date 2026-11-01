const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { User, BootstrapState } = require('../models');
const { ROLES, AUTH_PROVIDERS, AUDIT_ACTIONS } = require('../constants/enums');
const { normalizeEmail, normalizePhoneNumber, normalizeGender } = require('../utils/normalizers');
const { recordAudit } = require('./audit.service');
const ApiError = require('../utils/ApiError');

const BOOTSTRAP_LOCK_ID = 'ADMIN_BOOTSTRAP';
const CLAIM_TTL_MS = 15 * 1000;
const BCRYPT_ROUNDS = 10;

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function sha256Hex(value) {
  return sha256Buffer(value).toString('hex');
}

/**
 * Constant-time secret comparison using fixed-length SHA-256 digests
 * so neither secret content nor secret length leaks via timing side-channels.
 */
function verifySecretConstantTime(providedSecret, configuredSecret) {
  if (
    typeof configuredSecret !== 'string' ||
    !configuredSecret.trim() ||
    typeof providedSecret !== 'string' ||
    !providedSecret
  ) {
    return false;
  }
  const digestA = sha256Buffer(providedSecret);
  const digestB = sha256Buffer(configuredSecret.trim());
  return crypto.timingSafeEqual(digestA, digestB);
}

function resolveRuntimeBootstrapConfig() {
  const secretRaw =
    process.env.ADMIN_BOOTSTRAP_SECRET !== undefined
      ? process.env.ADMIN_BOOTSTRAP_SECRET
      : env.adminBootstrapSecret;
  const requireSecretRaw =
    process.env.ADMIN_BOOTSTRAP_REQUIRE_SECRET !== undefined
      ? process.env.ADMIN_BOOTSTRAP_REQUIRE_SECRET === 'true'
      : Boolean(env.adminBootstrapRequireSecret);

  const secret = typeof secretRaw === 'string' ? secretRaw.trim() : '';
  return {
    secret,
    hasConfiguredSecret: secret.length > 0,
    requireSecret: requireSecretRaw,
  };
}

function extractBootstrapSecret(req, payload = {}) {
  const headerSecret =
    req?.headers?.['x-bootstrap-secret'] ??
    req?.headers?.['x-admin-bootstrap-secret'];

  if (typeof headerSecret === 'string' && headerSecret.length > 0) {
    return headerSecret;
  }
  if (
    typeof payload?.bootstrapSecret === 'string' &&
    payload.bootstrapSecret.length > 0
  ) {
    return payload.bootstrapSecret;
  }
  return null;
}

async function ensureBootstrapStateInitialized() {
  try {
    await BootstrapState.updateOne(
      { _id: BOOTSTRAP_LOCK_ID },
      {
        $setOnInsert: {
          status: 'IDLE',
          locked: false,
          consumedSecretHashes: [],
        },
      },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

async function syncLockIfAdminAlreadyExists() {
  await ensureBootstrapStateInitialized();
  const existingAdminCount = await User.countDocuments({ userType: ROLES.ADMIN });
  if (existingAdminCount > 0) {
    await BootstrapState.updateOne(
      { _id: BOOTSTRAP_LOCK_ID, locked: false, status: 'IDLE' },
      {
        $set: {
          status: 'LOCKED',
          locked: true,
          lockedAt: new Date(),
        },
      },
    );
  }
  const state = await BootstrapState.findById(BOOTSTRAP_LOCK_ID).lean();
  return { existingAdminCount, state };
}

/**
 * Inspect safe, non-sensitive bootstrap readiness without leaking Admin identities or secrets.
 */
async function getBootstrapStatus() {
  const config = resolveRuntimeBootstrapConfig();
  const { existingAdminCount, state } = await syncLockIfAdminAlreadyExists();

  const publicZeroAdminOpen =
    !config.requireSecret && existingAdminCount === 0 && !state?.locked;

  let secretBootstrapOpen = false;
  if (config.hasConfiguredSecret) {
    const currentSecretHash = sha256Hex(config.secret);
    const consumed = (state?.consumedSecretHashes || []).includes(currentSecretHash);
    secretBootstrapOpen = !consumed;
  }

  const bootstrapAvailable = publicZeroAdminOpen || secretBootstrapOpen;

  return {
    bootstrapAvailable,
    locked: Boolean(state?.locked) || existingAdminCount > 0,
    requiresSecret: !publicZeroAdminOpen && secretBootstrapOpen,
  };
}

async function acquireBootstrapClaim(providedSecret) {
  const config = resolveRuntimeBootstrapConfig();
  await ensureBootstrapStateInitialized();

  const now = new Date();
  const claimToken = crypto.randomUUID();
  const currentState = await BootstrapState.findById(BOOTSTRAP_LOCK_ID).lean();
  const previousLocked = Boolean(currentState?.locked);

  // If caller explicitly supplied a bootstrap secret, validate it strictly in constant time
  if (providedSecret !== null) {
    if (!config.hasConfiguredSecret) {
      throw new ApiError(
        403,
        'Hệ thống chưa kích hoạt chế độ Bootstrap Secret',
      );
    }

    if (!verifySecretConstantTime(providedSecret, config.secret)) {
      throw new ApiError(403, 'Bootstrap secret không hợp lệ');
    }

    const secretHash = sha256Hex(config.secret);
    const claimed = await BootstrapState.findOneAndUpdate(
      {
        _id: BOOTSTRAP_LOCK_ID,
        consumedSecretHashes: { $ne: secretHash },
        $or: [
          { status: { $ne: 'CLAIMING' } },
          { claimExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'CLAIMING',
          claimToken,
          claimExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
        },
      },
      { returnDocument: 'after' },
    ).lean();

    if (!claimed) {
      throw new ApiError(
        403,
        'Bootstrap secret này đã được sử dụng và cơ chế bootstrap đã bị khóa',
      );
    }

    return {
      claimToken,
      mode: 'BOOTSTRAP_SECRET',
      secretHash,
      previousLocked,
    };
  }

  // No secret supplied -> only allowed if requireSecret is false AND zero Admins exist AND lock is open
  if (config.requireSecret) {
    throw new ApiError(
      403,
      'Hệ thống yêu cầu cung cấp Bootstrap Secret hợp lệ để khởi tạo Admin đầu tiên',
    );
  }

  const existingAdminCount = await User.countDocuments({ userType: ROLES.ADMIN });
  if (existingAdminCount > 0) {
    await BootstrapState.updateOne(
      { _id: BOOTSTRAP_LOCK_ID, locked: false },
      { $set: { status: 'LOCKED', locked: true, lockedAt: now } },
    );
    throw new ApiError(
      403,
      'Hệ thống đã có quản trị viên. Cơ chế khởi tạo Admin công khai đã bị khóa',
    );
  }

  const claimed = await BootstrapState.findOneAndUpdate(
    {
      _id: BOOTSTRAP_LOCK_ID,
      locked: false,
      $or: [
        { status: 'IDLE' },
        { status: 'CLAIMING', claimExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'CLAIMING',
        claimToken,
        claimExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
      },
    },
    { returnDocument: 'after' },
  ).lean();

  if (!claimed) {
    throw new ApiError(
      403,
      'Cơ chế khởi tạo Admin đầu tiên đã bị khóa hoặc đang được xử lý',
    );
  }

  // Double-check Admin count AFTER acquiring atomic claim to close any pre-lock race window
  const recheckAdminCount = await User.countDocuments({ userType: ROLES.ADMIN });
  if (recheckAdminCount > 0) {
    await BootstrapState.updateOne(
      { _id: BOOTSTRAP_LOCK_ID, claimToken },
      {
        $set: {
          status: 'LOCKED',
          locked: true,
          lockedAt: new Date(),
          claimToken: null,
          claimExpiresAt: null,
        },
      },
    );
    throw new ApiError(
      403,
      'Hệ thống đã có quản trị viên. Cơ chế khởi tạo Admin công khai đã bị khóa',
    );
  }

  return {
    claimToken,
    mode: 'INITIAL_ZERO_ADMIN',
    secretHash: null,
    previousLocked: false,
  };
}

async function releaseBootstrapClaim({ claimToken, previousLocked }) {
  await BootstrapState.updateOne(
    { _id: BOOTSTRAP_LOCK_ID, claimToken },
    {
      $set: {
        status: previousLocked ? 'LOCKED' : 'IDLE',
        locked: previousLocked,
        claimToken: null,
        claimExpiresAt: null,
      },
    },
  );
}

async function finalizeBootstrapLock({ claimToken, adminId, mode, secretHash }) {
  const updateOps = {
    $set: {
      status: 'LOCKED',
      locked: true,
      lockedAt: new Date(),
      bootstrappedAdminId: adminId,
      bootstrapMode: mode,
      claimToken: null,
      claimExpiresAt: null,
    },
  };

  if (secretHash) {
    updateOps.$addToSet = { consumedSecretHashes: secretHash };
  }

  await BootstrapState.updateOne(
    { _id: BOOTSTRAP_LOCK_ID, claimToken },
    updateOps,
  );
}

function validateAdminRegistrationInput(payload = {}) {
  const fullName =
    typeof payload?.fullName === 'string' ? payload.fullName.trim() : '';
  if (!fullName) {
    throw new ApiError(400, 'Họ và tên không được để trống');
  }

  const email = normalizeEmail(payload?.email);
  const password = payload?.password;
  if (typeof password !== 'string' || password.length < 6) {
    throw new ApiError(400, 'Mật khẩu phải có ít nhất 6 ký tự');
  }

  const phoneNumber = normalizePhoneNumber(payload?.phoneNumber);
  const gender = normalizeGender(payload?.gender);

  return { fullName, email, password, phoneNumber, gender };
}

/**
 * UC-ADM-10 — Bootstrap First Admin Safely.
 * - Precondition: Only runs when zero Admins exist (unless requireSecret=true) OR with a valid unconsumed Bootstrap Secret.
 * - Atomically claims bootstrap lock, creates Admin account, permanently locks public bootstrap, and records AuditLog.
 */
async function bootstrapFirstAdmin(payload = {}, req = null) {
  const providedSecret = extractBootstrapSecret(req, payload);
  const claim = await acquireBootstrapClaim(providedSecret);

  let createdAdmin;
  try {
    const validated = validateAdminRegistrationInput(payload);

    const existingEmailUser = await User.findOne({ email: validated.email }).lean();
    if (existingEmailUser) {
      throw new ApiError(409, 'Email đã tồn tại trong hệ thống');
    }

    const hashedPassword = await bcrypt.hash(validated.password, BCRYPT_ROUNDS);
    try {
      createdAdmin = await User.create({
        fullName: validated.fullName,
        email: validated.email,
        phoneNumber: validated.phoneNumber,
        password: hashedPassword,
        gender: validated.gender,
        userType: ROLES.ADMIN,
        isEnable: true,
        authProvider: AUTH_PROVIDERS.LOCAL,
      });
    } catch (dbErr) {
      if (dbErr?.code === 11000) {
        throw new ApiError(409, 'Email đã tồn tại trong hệ thống');
      }
      throw dbErr;
    }
  } catch (error) {
    await releaseBootstrapClaim(claim);
    throw error;
  }

  await finalizeBootstrapLock({
    claimToken: claim.claimToken,
    adminId: createdAdmin.id,
    mode: claim.mode,
    secretHash: claim.secretHash,
  });

  await recordAudit({
    actor: createdAdmin,
    action: AUDIT_ACTIONS.ADMIN_BOOTSTRAP,
    targetType: 'User',
    targetId: createdAdmin.id,
    reason:
      claim.mode === 'BOOTSTRAP_SECRET'
        ? 'Khởi tạo tài khoản Admin qua cơ chế Bootstrap Secret và khóa secret'
        : 'Khởi tạo tài khoản Admin đầu tiên của hệ thống và khóa cơ chế bootstrap công khai',
    changes: {
      after: {
        id: createdAdmin.id,
        email: createdAdmin.email,
        userType: ROLES.ADMIN,
        bootstrapMode: claim.mode,
        bootstrapLocked: true,
      },
    },
    req,
  });

  return {
    id: createdAdmin.id,
    email: createdAdmin.email,
    role: ROLES.ADMIN,
    bootstrapLocked: true,
  };
}

module.exports = {
  BOOTSTRAP_LOCK_ID,
  verifySecretConstantTime,
  getBootstrapStatus,
  bootstrapFirstAdmin,
};

