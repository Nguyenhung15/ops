const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');
const { SHIFT_TYPES, SHIFT_STATUSES, SLOT_STATUSES } = require('../constants/enums');

const shiftSlotSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true },
    slotNumber: { type: Number, required: true },
    startTime: { type: String, required: true }, // "HH:mm"
    endTime: { type: String, required: true },   // "HH:mm"
    status: {
      type: String,
      enum: SLOT_STATUSES,
      default: 'AVAILABLE',
    },
    bookingRef: {
      type: String,
      default: null,
    },
    bookedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const doctorShiftSchema = new mongoose.Schema(
  {
    doctorId: {
      type: Number,
      required: true,
      index: true,
    },
    date: {
      type: String, // "YYYY-MM-DD"
      required: true,
      index: true,
    },
    shift: {
      type: String,
      enum: SHIFT_TYPES,
      required: true,
    },
    startTime: {
      type: String,
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    slotDurationMinutes: {
      type: Number,
      default: 45,
    },
    bufferMinutes: {
      type: Number,
      default: 15,
    },
    maxPatients: {
      type: Number,
      default: 10,
    },
    note: {
      type: String,
      default: null,
    },
    repeatWeekly: {
      type: Boolean,
      default: false,
    },
    repeatCount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: SHIFT_STATUSES,
      default: 'ACTIVE',
      index: true,
    },
    slots: {
      type: [shiftSlotSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

doctorShiftSchema.index({ date: 1, startTime: 1 });
doctorShiftSchema.index({ doctorId: 1, date: 1, shift: 1 }, { unique: true });

doctorShiftSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'doctor_shifts',
  extraTransform: (_doc, ret) => {
    const slots = Array.isArray(ret.slots) ? ret.slots : [];
    ret.availableSlots = slots.filter((s) => s.status === 'AVAILABLE').length;
    ret.shiftType = ret.shift;
    return ret;
  },
});

const DoctorShift = mongoose.model('DoctorShift', doctorShiftSchema, 'doctor_shifts');

module.exports = DoctorShift;

