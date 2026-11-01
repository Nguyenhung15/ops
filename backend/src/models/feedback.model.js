const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');
const { FEEDBACK_STATUS_VALUES, FEEDBACK_STATUSES } = require('../constants/enums');

const feedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    appointmentId: {
      type: Number,
      default: null,
      index: true,
    },
    doctorId: {
      type: Number,
      default: null,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      index: true,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer between 1 and 5',
      },
    },
    title: {
      type: String,
      default: null,
      trim: true,
      maxlength: 255,
    },
    comment: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    category: {
      type: String,
      default: 'Khác',
      trim: true,
      maxlength: 100,
      index: true,
    },
    isAnonymous: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: FEEDBACK_STATUS_VALUES,
      default: FEEDBACK_STATUSES.APPROVED,
      index: true,
    },
    adminResponse: {
      type: String,
      default: null,
      trim: true,
      maxlength: 2000,
    },
    adminRespondedAt: {
      type: Date,
      default: null,
    },
    adminRespondedBy: {
      type: Number,
      default: null,
    },
    moderatedBy: {
      type: Number,
      default: null,
    },
    moderatedAt: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

feedbackSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'feedbacks',
  extraTransform: (_doc, ret) => {
    if (ret.adminRespondedAt instanceof Date) {
      ret.adminRespondedAt = ret.adminRespondedAt.toISOString();
    }
    if (ret.moderatedAt instanceof Date) {
      ret.moderatedAt = ret.moderatedAt.toISOString();
    }
    if (ret.createdAt instanceof Date) {
      ret.createdAt = ret.createdAt.toISOString();
    }
    if (ret.updatedAt instanceof Date) {
      ret.updatedAt = ret.updatedAt.toISOString();
    }
    return ret;
  },
});

const Feedback = mongoose.model('Feedback', feedbackSchema, 'feedbacks');

module.exports = Feedback;
