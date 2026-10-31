const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');
const { APPOINTMENT_STATUSES } = require('../constants/enums');

const appointmentPatientSnapshotSchema = new mongoose.Schema(
  {
    id: { type: Number, default: null },
    fullName: { type: String, required: true },
    gender: { type: String, default: 'Other' },
    phoneNumber: { type: String, default: null },
    dob: { type: String, default: null },
    relationship: { type: String, default: null },
  },
  { _id: false },
);

const appointmentSchema = new mongoose.Schema(
  {
    appointmentNo: {
      type: String,
      required: true,
      unique: true,
    },
    patientId: {
      type: Number,
      required: true,
      index: true,
    },
    doctorId: {
      type: Number,
      required: true,
      index: true,
    },
    specialtyId: {
      type: Number,
      required: true,
      index: true,
    },
    shiftId: {
      type: Number,
      required: true,
      index: true,
    },
    slotIds: {
      type: [Number],
      default: [],
    },
    appointmentDate: {
      type: String, // "YYYY-MM-DD"
      required: true,
      index: true,
    },
    appointmentTime: {
      type: String, // "HH:mm"
      required: true,
    },
    actualStartTime: {
      type: String,
      default: null,
    },
    actualEndTime: {
      type: String,
      default: null,
    },
    type: {
      type: String,
      enum: ['OFFLINE', 'ONLINE'],
      default: 'OFFLINE',
    },
    status: {
      type: String,
      enum: Object.values(APPOINTMENT_STATUSES),
      default: APPOINTMENT_STATUSES.PENDING_CONFIRMATION,
      index: true,
    },
    checkedIn: {
      type: Boolean,
      default: false,
    },
    checkedInAt: {
      type: Date,
      default: null,
    },
    checkedInBy: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },
    confirmedBy: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },
    confirmedAt: {
      type: Date,
      default: null,
    },
    reason: {
      type: String,
      default: null,
    },
    cancelReason: {
      type: String,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },
    refundRequired: {
      type: Boolean,
      default: false,
    },
    rescheduledFromId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },
    rescheduledToId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
    },
    joinCode: {
      type: String,
      default: null,
    },
    meetingUrl: {
      type: String,
      default: null,
    },
    patients: {
      type: [appointmentPatientSnapshotSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

// P0 & Operational Schedule Required Indexes
appointmentSchema.index({ appointmentDate: 1, appointmentTime: 1 });
appointmentSchema.index({ appointmentDate: 1, status: 1 });
appointmentSchema.index({ patientId: 1, appointmentDate: 1 });
appointmentSchema.index({ doctorId: 1, appointmentDate: 1, status: 1 });
appointmentSchema.index({ doctorId: 1, appointmentDate: 1 });
appointmentSchema.index({ shiftId: 1, slotIds: 1 });

appointmentSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'appointments',
});

const Appointment = mongoose.model('Appointment', appointmentSchema, 'appointments');

module.exports = Appointment;

