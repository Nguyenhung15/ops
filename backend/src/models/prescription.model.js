const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');

const prescriptionSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: Number,
      required: true,
      index: true,
    },
    medicineName: {
      type: String,
      required: true,
      trim: true,
    },
    dosage: {
      type: String,
      default: null,
    },
    duration: {
      type: String,
      default: null,
    },
    instructions: {
      type: String,
      default: null,
    },
    version: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
  },
);

prescriptionSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'prescriptions',
});

const Prescription = mongoose.model('Prescription', prescriptionSchema, 'prescriptions');

module.exports = Prescription;

