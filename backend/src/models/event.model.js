const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');

const eventSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: null,
      trim: true,
    },
    location: {
      type: String,
      default: null,
      trim: true,
    },
    startDate: {
      type: Date,
      required: true,
      index: true,
    },
    endDate: {
      type: Date,
      required: true,
      index: true,
    },
    isEnabled: {
      type: Boolean,
      default: true,
      index: true,
    },
    voucherId: {
      type: Number,
      default: null,
      index: true,
    },
    capacity: {
      type: Number,
      default: null,
    },
    registeredCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

eventSchema.index({ startDate: 1, endDate: 1, isEnabled: 1 });

eventSchema.virtual('enabled').get(function () {
  return this.isEnabled;
});

eventSchema.virtual('enabled').set(function (val) {
  this.isEnabled = Boolean(val);
});

eventSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'events',
  extraTransform: (_doc, ret) => {
    ret.enabled = Boolean(ret.isEnabled);
    if (ret.startDate instanceof Date) {
      ret.startDate = ret.startDate.toISOString();
    }
    if (ret.endDate instanceof Date) {
      ret.endDate = ret.endDate.toISOString();
    }
    return ret;
  },
});

const Event = mongoose.model('Event', eventSchema, 'events');

module.exports = Event;
