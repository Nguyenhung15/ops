const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');

const specialtySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    isEnable: {
      type: Boolean,
      default: true,
      index: true,
    },
    imageUrl: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

specialtySchema.plugin(baseSchemaPlugin, {
  sequenceName: 'specialties',
  extraTransform: (_doc, ret) => {
    ret.isEnabled = Boolean(ret.isEnable);
    return ret;
  },
});

const Specialty = mongoose.model('Specialty', specialtySchema, 'specialties');

module.exports = Specialty;

