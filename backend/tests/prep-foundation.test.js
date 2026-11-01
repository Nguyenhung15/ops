const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const {
  AUDIT_ACTIONS,
  PAYMENT_STATUSES,
  FEEDBACK_STATUSES,
  APPOINTMENT_STATUSES,
} = require('../src/constants/enums');
const { configService } = require('../src/config/config.service');
const env = require('../src/config/env');
const models = require('../src/models');
const { isValidTransition, VALID_TRANSITIONS } = require('../src/services/appointmentState.service');

test('PREP: Baseline verification for UC-PAT-07..12 preparation', async (t) => {
  await t.test('1. Constants & Enums completeness', () => {
    // Audit actions
    const requiredAuditActions = [
      'REGISTER_EVENT',
      'REDEEM_VOUCHER',
      'RELEASE_VOUCHER',
      'PAYMENT_CREATED',
      'PAYMENT_SUCCESS',
      'PAYMENT_FAILED',
      'VIEW_PRESCRIPTION',
      'JOIN_ONLINE',
      'CREATE_FEEDBACK',
      'UPDATE_FEEDBACK',
      'DELETE_FEEDBACK',
    ];
    for (const action of requiredAuditActions) {
      assert.equal(typeof AUDIT_ACTIONS[action], 'string', `Missing AUDIT_ACTIONS.${action}`);
    }

    // Payment statuses
    assert.deepEqual(PAYMENT_STATUSES, {
      PENDING: 'PENDING',
      SUCCESS: 'SUCCESS',
      FAILED: 'FAILED',
      EXPIRED: 'EXPIRED',
    });

    // Feedback statuses
    assert.deepEqual(FEEDBACK_STATUSES, {
      PENDING: 'PENDING',
      PUBLISHED: 'PUBLISHED',
      HIDDEN: 'HIDDEN',
    });
  });

  await t.test('2. ConfigService & Env exposure with safe defaults', () => {
    assert.equal(configService.joinEarlyMinutes, 15);
    assert.equal(configService.joinLateGraceMinutes, 15);
    assert.equal(configService.onlineRequirePaymentBeforeJoin, true);
    assert.equal(typeof configService.joinTokenSecret, 'string');
    assert.equal(configService.paymentPendingTtlMinutes, 15);
    assert.equal(configService.paymentSuccessTargetStateOnline, 'CONFIRMED');
    assert.equal(configService.paymentSuccessTargetStateOffline, 'PENDING_CONFIRMATION');
    assert.equal(typeof configService.vnpTmnCode, 'string');
    assert.equal(typeof configService.vnpHashSecret, 'string');
    assert.equal(typeof configService.vnpUrl, 'string');
    assert.equal(typeof configService.vnpReturnUrl, 'string');
    assert.equal(typeof configService.vnpIpnUrl, 'string');
    assert.equal(configService.feedbackEditDays, 7);
    assert.equal(configService.feedbackRatePerHour, 10);

    // Proxy env exposure
    assert.equal(env.joinEarlyMinutes, 15);
    assert.equal(env.paymentSuccessTargetStateOnline, 'CONFIRMED');
    assert.equal(env.feedbackRatePerHour, 10);
  });

  await t.test('3. Models schema fields & indexes', () => {
    // Event model
    const eventPaths = models.Event.schema.paths;
    assert.ok(eventPaths.capacity, 'Event must have capacity');
    assert.ok(eventPaths.registeredCount, 'Event must have registeredCount');

    // EventRegistration unique index
    const regIndexes = models.EventRegistration.schema.indexes();
    const hasRegUnique = regIndexes.some(
      ([fields, opts]) => fields.eventId === 1 && fields.userId === 1 && opts && opts.unique,
    );
    assert.ok(hasRegUnique, 'EventRegistration must have unique index on (eventId, userId)');

    // Voucher model
    const voucherPaths = models.Voucher.schema.paths;
    assert.ok(voucherPaths.discountType, 'Voucher must have discountType');
    const userVoucherPaths = models.UserVoucher.schema.paths;
    assert.ok(userVoucherPaths.appointmentId, 'UserVoucher must have appointmentId');
    assert.ok(userVoucherPaths.used, 'UserVoucher must have used');

    // PaymentTransaction model
    const paymentPaths = models.PaymentTransaction.schema.paths;
    assert.ok(paymentPaths.appointmentId, 'PaymentTransaction must have appointmentId');
    assert.ok(paymentPaths.userId, 'PaymentTransaction must have userId');
    assert.ok(paymentPaths.transactionNo, 'PaymentTransaction must have transactionNo');
    assert.ok(paymentPaths.amount, 'PaymentTransaction must have amount');
    assert.ok(paymentPaths.status, 'PaymentTransaction must have status');
    assert.ok(paymentPaths.discountAmount, 'PaymentTransaction must have discountAmount');
    assert.ok(paymentPaths.userVoucherId, 'PaymentTransaction must have userVoucherId');

    const paymentIndexes = models.PaymentTransaction.schema.indexes();
    const hasApptStatusIndex = paymentIndexes.some(
      ([fields]) => fields.appointmentId === 1 && fields.status === 1,
    );
    assert.ok(hasApptStatusIndex, 'PaymentTransaction must have compound index on (appointmentId, status)');

    // Appointment model
    const apptPaths = models.Appointment.schema.paths;
    assert.ok(apptPaths['meeting.url'] || apptPaths.meeting, 'Appointment must have meeting');
    assert.ok(apptPaths.paymentStatus, 'Appointment must have paymentStatus');
    assert.ok(apptPaths.refundRequired, 'Appointment must have refundRequired');

    // Prescription model
    const prescriptionPaths = models.Prescription.schema.paths;
    assert.ok(prescriptionPaths.version, 'Prescription must have version');

    // Feedback model
    assert.ok(models.Feedback, 'Feedback model must be exported in models/index.js');
    const feedbackPaths = models.Feedback.schema.paths;
    assert.ok(feedbackPaths.userId, 'Feedback must have userId');
    assert.ok(feedbackPaths.appointmentId, 'Feedback must have appointmentId');
    assert.ok(feedbackPaths.doctorId, 'Feedback must have doctorId');
    assert.ok(feedbackPaths.rating, 'Feedback must have rating');
    assert.ok(feedbackPaths.comment, 'Feedback must have comment');
    assert.ok(feedbackPaths.status, 'Feedback must have status');
    assert.ok(feedbackPaths.deletedAt, 'Feedback must have deletedAt');

    const feedbackIndexes = models.Feedback.schema.indexes();
    const hasFeedbackPartial = feedbackIndexes.some(
      ([fields, opts]) =>
        fields.appointmentId === 1 &&
        fields.userId === 1 &&
        opts &&
        opts.unique &&
        opts.partialFilterExpression &&
        opts.partialFilterExpression.deletedAt === null,
    );
    assert.ok(hasFeedbackPartial, 'Feedback must have partial unique index on (appointmentId, userId) with deletedAt: null');
  });

  await t.test('4. AppointmentStateService transition: PENDING_PAYMENT -> CONFIRMED', () => {
    assert.ok(
      VALID_TRANSITIONS[APPOINTMENT_STATUSES.PENDING_PAYMENT].includes(APPOINTMENT_STATUSES.CONFIRMED),
      'VALID_TRANSITIONS for PENDING_PAYMENT must include CONFIRMED',
    );
    assert.equal(
      isValidTransition(APPOINTMENT_STATUSES.PENDING_PAYMENT, APPOINTMENT_STATUSES.CONFIRMED),
      true,
      'isValidTransition(PENDING_PAYMENT, CONFIRMED) must return true',
    );
  });

  await t.test('5. Features Router dynamic loader in routes/index.js', async () => {
    const mainRouter = require('../src/routes/index');
    assert.ok(mainRouter, 'Main router must export an Express router');

    // Verify loader handles empty directory and dynamic feature routes cleanly
    const testFeaturePath = path.join(__dirname, '../src/routes/features/testSample.routes.js');
    try {
      fs.writeFileSync(
        testFeaturePath,
        `
        const { Router } = require('express');
        const router = Router();
        router.get('/ping', (req, res) => res.json({ pong: true }));
        module.exports = { basePath: '/sample-test', router };
      `,
        'utf8',
      );

      // Re-require route loader
      delete require.cache[require.resolve('../src/routes/index')];
      delete require.cache[require.resolve(testFeaturePath)];

      const freshRouter = require('../src/routes/index');
      assert.ok(freshRouter, 'Router reloads with feature files successfully');
    } finally {
      if (fs.existsSync(testFeaturePath)) {
        fs.unlinkSync(testFeaturePath);
      }
      delete require.cache[require.resolve('../src/routes/index')];
    }
  });
});
