const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');
const { USER_EVENT_STATUSES, USER_EVENT_STATUS_VALUES } = require('../constants/enums');

const userEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: Number,
      required: true,
      index: true,
    },
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: USER_EVENT_STATUS_VALUES,
      default: USER_EVENT_STATUSES.PENDING,
      required: true,
      index: true,
    },
    registeredAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

userEventSchema.index({ eventId: 1, userId: 1 }, { unique: true });

userEventSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'user_events',
  extraTransform: (_doc, ret) => {
    if (ret.registeredAt instanceof Date) {
      ret.registeredAt = ret.registeredAt.toISOString();
    }
    return ret;
  },
});

const UserEvent = mongoose.model('UserEvent', userEventSchema, 'user_events');

module.exports = UserEvent;
