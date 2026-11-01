const mongoose = require('mongoose');
const baseSchemaPlugin = require('./plugins/baseSchema.plugin');

const { PAYMENT_STATUSES } = require('../constants/enums');

const paymentTransactionSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: Number,
      required: true,
      index: true,
    },
    userId: {
      type: Number,
      default: null,
      index: true,
    },
    transactionNo: {
      type: String,
      default: null,
    },
    amount: {
      type: mongoose.Schema.Types.Mixed, // integer number or legacy string
      default: null,
    },
    discountAmount: {
      type: Number,
      default: 0,
    },
    userVoucherId: {
      type: Number,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUSES),
      default: PAYMENT_STATUSES.PENDING,
      index: true,
    },
    bankCode: {
      type: String,
      default: null,
    },
    orderInfo: {
      type: String,
      default: null,
    },
    payDate: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    responseCode: {
      type: String,
      default: null,
    },
    transactionStatus: {
      type: String,
      default: null,
    },
    needsReconcile: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index on appointmentId and status
paymentTransactionSchema.index({ appointmentId: 1, status: 1 });

// Partial unique index on transactionNo to allow multiple null/pending entries while guarding duplicates
paymentTransactionSchema.index(
  { transactionNo: 1 },
  { unique: true, partialFilterExpression: { transactionNo: { $type: 'string', $gt: '' } } },
);

paymentTransactionSchema.plugin(baseSchemaPlugin, {
  sequenceName: 'payment_transactions',
});

const PaymentTransaction = mongoose.model(
  'PaymentTransaction',
  paymentTransactionSchema,
  'payment_transactions',
);

module.exports = PaymentTransaction;

