const mongoose = require('mongoose');
const env = require('../config/env');
const { GroupHealthRequest } = require('../models');

async function seed() {
  await mongoose.connect(env.mongoUri);
  try {
    const existing = await GroupHealthRequest.findOne({ groupName: 'Công ty Cổ phần Công nghệ ABC' });
    if (!existing) {
      const created = await GroupHealthRequest.create({
        groupName: 'Công ty Cổ phần Công nghệ ABC',
        departments: 'Khối Kỹ thuật & Kinh doanh (50 nhân viên)',
        phoneNumber: '0905123456',
        preferredDate: '2026-11-20',
        status: 'PENDING',
        sourceFileName: 'danh-sach-kham-suc-khoe-abc.xlsx',
        sourceFileSize: 24500,
        sourceFileMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      console.log('SUCCESS_CREATED_ID:', created.id);
    } else {
      console.log('ALREADY_EXISTS_ID:', existing.id);
    }
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((err) => {
  console.error('SEED_ERROR:', err);
  process.exit(1);
});
