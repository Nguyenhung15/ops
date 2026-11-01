const fs = require('fs');
const path = require('path');
const multer = require('multer');
const env = require('./env');
const ApiError = require('../utils/ApiError');

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function createImageUploader(subFolder = 'doctors') {
  const targetDir = path.join(env.uploadsDir, subFolder);
  fs.mkdirSync(targetDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      let prefix = 'img';
      if (req.params.doctorId) prefix = `doctor-${req.params.doctorId}`;
      else if (req.params.specialtyId) prefix = `specialty-${req.params.specialtyId}`;
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      cb(null, `${prefix}-${uniqueSuffix}${ext}`);
    },
  });

  const fileFilter = (_req, file, cb) => {
    if (!file || !file.mimetype || !ALLOWED_IMAGE_MIMES.has(file.mimetype.toLowerCase())) {
      return cb(new ApiError(400, 'Chỉ chấp nhận file ảnh định dạng JPEG, PNG, WEBP, GIF'));
    }
    return cb(null, true);
  };

  return multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  });
}

module.exports = { createImageUploader };

