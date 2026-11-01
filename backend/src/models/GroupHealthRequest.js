const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');

const groupHealthRequestSchema = new mongoose.Schema(
  {
    groupName: { type: String, required: true, trim: true, maxlength: 255 },
    departments: { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
    preferredDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED'],
      default: 'PENDING',
      index: true,
    },
    createdBy: { type: Number, default: null },
    approvedBy: { type: Number, default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: Number, default: null },
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: '', maxlength: 500 },
    completedBy: { type: Number, default: null },
    completedAt: { type: Date, default: null },
    sourceFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceFileName: { type: String, default: '' },
    sourceFileSize: { type: Number, default: null },
    sourceFileMimeType: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);

groupHealthRequestSchema.index({ status: 1, preferredDate: 1 });
groupHealthRequestSchema.plugin(baseSchemaPlugin, { sequenceName: 'group_health_requests' });

module.exports = mongoose.model('GroupHealthRequest', groupHealthRequestSchema);
