const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');

const voucherSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
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
    type: {
      type: String,
      enum: ['SERVICE_TICKET', 'DISCOUNT'],
      default: 'SERVICE_TICKET',
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

voucherSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'vouchers',
});

const userVoucherSchema = new mongoose.Schema(
  {
    voucherId: {
      type: Number,
      required: true,
      index: true,
    },
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    voucherCode: {
      type: String,
      default: null,
    },
    voucherName: {
      type: String,
      default: null,
    },
    discountValue: {
      type: Number,
      default: null,
    },
    type: {
      type: String,
      enum: ['SERVICE_TICKET', 'DISCOUNT'],
      default: 'SERVICE_TICKET',
    },
    expiryDate: {
      type: Date,
      default: null,
    },
    issuedAt: {
      type: Date,
      default: Date.now,
    },
    used: {
      type: Boolean,
      default: false,
      index: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

userVoucherSchema.index({ voucherId: 1, userId: 1 });

userVoucherSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'user_vouchers',
});

const Voucher = mongoose.model('Voucher', voucherSchema, 'vouchers');
const UserVoucher = mongoose.model('UserVoucher', userVoucherSchema, 'user_vouchers');

module.exports = {
  Voucher,
  UserVoucher,
};
