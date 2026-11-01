const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');
const { VOUCHER_TYPE_VALUES, VOUCHER_TYPES } = require('../constants/enums');
const UserVoucher = require('./userVoucher.model');

const voucherSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      default: null,
      trim: true,
    },
    discountValue: {
      type: Number,
      default: null,
    },
    discountType: {
      type: String,
      enum: ['AMOUNT', 'PERCENT'],
      default: 'AMOUNT',
    },
    type: {
      type: String,
      enum: VOUCHER_TYPE_VALUES,
      default: VOUCHER_TYPES.SERVICE_TICKET,
      required: true,
    },
    enable: {
      type: Boolean,
      default: true,
      index: true,
    },
    expiryDate: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

voucherSchema.virtual('isEnabled').get(function () {
  return this.enable;
});

voucherSchema.virtual('isEnabled').set(function (val) {
  this.enable = Boolean(val);
});

voucherSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'vouchers',
  extraTransform: (_doc, ret) => {
    if (ret.expiryDate instanceof Date) {
      ret.expiryDate = ret.expiryDate.toISOString();
    }
    return ret;
  },
});

const Voucher = mongoose.model('Voucher', voucherSchema, 'vouchers');

Voucher.Voucher = Voucher;
Voucher.UserVoucher = UserVoucher;

module.exports = Voucher;
