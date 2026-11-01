const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { parsePositiveInt } = require('../utils/normalizers');
const { ROLES, AUDIT_ACTIONS } = require('../constants/enums');
const { Image, User, Specialty } = require('../models');
const { recordAudit } = require('./audit.service');

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function validateImageFile(file) {
  if (!file) {
    throw new ApiError(400, 'Vui lòng chọn file ảnh để tải lên');
  }
  if (!file.mimetype || !ALLOWED_IMAGE_MIMES.has(file.mimetype.toLowerCase())) {
    throw new ApiError(400, 'Chỉ chấp nhận file ảnh định dạng JPEG, PNG, WEBP, GIF');
  }
  if (file.size === 0) {
    throw new ApiError(400, 'File ảnh không được rỗng (0 bytes)');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new ApiError(400, 'Kích thước file ảnh vượt quá giới hạn 5MB');
  }
}

function removeUploadedFileSafely(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('/uploads/')) return;
  const relPath = imageUrl.replace(/^\/uploads\/+/, '');
  const fullPath = path.join(env.uploadsDir, relPath);
  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch {
      // Ignore file unlink errors so DB update does not fail
    }
  }
}

async function ensureDoctorExists(doctorId) {
  const id = parsePositiveInt(doctorId, 'doctorId');
  const doctor = await User.findOne({ id, userType: ROLES.DOCTOR });
  if (!doctor) {
    throw new ApiError(404, `Không tìm thấy bác sĩ với ID #${id}`);
  }
  return doctor;
}

async function ensureSpecialtyExists(specialtyId) {
  const id = parsePositiveInt(specialtyId, 'specialtyId');
  const spec = await Specialty.findOne({ id });
  if (!spec) {
    throw new ApiError(404, `Không tìm thấy chuyên khoa với ID #${id}`);
  }
  return spec;
}

async function getDoctorImage(doctorId) {
  const id = parsePositiveInt(doctorId, 'doctorId');
  const image = await Image.findOne({ doctorId: id });
  if (!image) {
    throw new ApiError(404, `Doctor #${id} does not have an image`);
  }
  return image.toJSON();
}

async function saveDoctorImage(actor, doctorId, file, req) {
  validateImageFile(file);

  const doctor = await ensureDoctorExists(doctorId);
  const imageUrl = `/uploads/doctors/${file.filename}`;

  let image = await Image.findOne({ doctorId: doctor.id });
  const isUpdate = Boolean(image);

  if (image) {
    removeUploadedFileSafely(image.imageUrl);
    image.imageUrl = imageUrl;
    await image.save();
  } else {
    image = await Image.create({
      doctorId: doctor.id,
      imageUrl,
    });
  }

  doctor.avatarUrl = imageUrl;
  await doctor.save();

  if (actor) {
    await recordAudit({
      actor,
      action: isUpdate ? AUDIT_ACTIONS.DOCTOR_IMAGE_UPDATE : AUDIT_ACTIONS.DOCTOR_IMAGE_UPLOAD,
      targetType: 'User',
      targetId: doctor.id,
      reason: isUpdate ? 'Cập nhật ảnh đại diện bác sĩ' : 'Tải lên ảnh đại diện bác sĩ',
      changes: { after: { avatarUrl: imageUrl } },
      req,
    });
  }

  return image.toJSON();
}

async function deleteDoctorImage(actor, doctorId, req) {
  const doctor = await ensureDoctorExists(doctorId);
  const image = await Image.findOne({ doctorId: doctor.id });
  if (!image) {
    throw new ApiError(404, `Doctor #${doctor.id} does not have an image`);
  }

  const oldUrl = image.imageUrl;
  removeUploadedFileSafely(oldUrl);
  await Image.deleteOne({ id: image.id });

  doctor.avatarUrl = null;
  await doctor.save();

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.DOCTOR_IMAGE_DELETE,
      targetType: 'User',
      targetId: doctor.id,
      reason: 'Xóa ảnh đại diện bác sĩ',
      changes: { before: { avatarUrl: oldUrl }, after: { avatarUrl: null } },
      req,
    });
  }
}

async function getSpecialtyImage(specialtyId) {
  const id = parsePositiveInt(specialtyId, 'specialtyId');
  const image = await Image.findOne({ specialtyId: id });
  if (!image) {
    throw new ApiError(404, `Specialty #${id} does not have an image`);
  }
  return image.toJSON();
}

async function saveSpecialtyImage(actor, specialtyId, file, req) {
  validateImageFile(file);

  const spec = await ensureSpecialtyExists(specialtyId);
  const imageUrl = `/uploads/specialties/${file.filename}`;

  let image = await Image.findOne({ specialtyId: spec.id });
  const isUpdate = Boolean(image);

  if (image) {
    removeUploadedFileSafely(image.imageUrl);
    image.imageUrl = imageUrl;
    await image.save();
  } else {
    image = await Image.create({
      specialtyId: spec.id,
      imageUrl,
    });
  }

  spec.imageUrl = imageUrl;
  await spec.save();

  if (actor) {
    await recordAudit({
      actor,
      action: isUpdate ? AUDIT_ACTIONS.SPECIALTY_IMAGE_UPDATE : AUDIT_ACTIONS.SPECIALTY_IMAGE_UPLOAD,
      targetType: 'Specialty',
      targetId: spec.id,
      reason: isUpdate ? 'Cập nhật ảnh chuyên khoa' : 'Tải lên ảnh chuyên khoa',
      changes: { after: { imageUrl } },
      req,
    });
  }

  return image.toJSON();
}

async function deleteSpecialtyImage(actor, specialtyId, req) {
  const spec = await ensureSpecialtyExists(specialtyId);
  const image = await Image.findOne({ specialtyId: spec.id });
  if (!image) {
    throw new ApiError(404, `Specialty #${spec.id} does not have an image`);
  }

  const oldUrl = image.imageUrl;
  removeUploadedFileSafely(oldUrl);
  await Image.deleteOne({ id: image.id });

  spec.imageUrl = null;
  await spec.save();

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.SPECIALTY_IMAGE_DELETE,
      targetType: 'Specialty',
      targetId: spec.id,
      reason: 'Xóa ảnh chuyên khoa',
      changes: { before: { imageUrl: oldUrl }, after: { imageUrl: null } },
      req,
    });
  }
}

module.exports = {
  validateImageFile,
  getDoctorImage,
  saveDoctorImage,
  deleteDoctorImage,
  getSpecialtyImage,
  saveSpecialtyImage,
  deleteSpecialtyImage,
};

