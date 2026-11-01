const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');
const { FEEDBACK_STATUSES } = require('../constants/enums');

const feedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    appointmentId: {
      type: Number,
      required: true,
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
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer between 1 and 5',
      },
    },
    comment: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: Object.values(FEEDBACK_STATUSES),
      default: FEEDBACK_STATUSES.PENDING,
      index: true,
    },
    title: {
      type: String,
      default: null,
      trim: true,
    },
    category: {
      type: String,
      default: null,
      trim: true,
    },
    isAnonymous: {
      type: Boolean,
      default: false,
    },
    adminResponse: {
      type: String,
      default: null,
      trim: true,
    },
    adminRespondedAt: {
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

// Partial unique index: each appointment can only have one active feedback per user (deletedAt == null)
feedbackSchema.index(
  { appointmentId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

feedbackSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'feedbacks',
});

const Feedback = mongoose.model('Feedback', feedbackSchema, 'feedbacks');

module.exports = Feedback;
