const Appointment = require('../models/appointment.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const DoctorShift = require('../models/doctorShift.model');
const UserVoucher = require('../models/userVoucher.model');
const { appointmentStateService } = require('../services/appointmentState.service');
const appointmentSlotService = require('../services/appointmentSlot.service');
const voucherRedemptionService = require('../services/voucherRedemption.service');
const auditService = require('../services/audit.service');
const outboxService = require('../services/outbox.service');
const { clock } = require('../services/clock.service');
const env = require('../config/env');
const configService = require('../config/config.service');
const { APPOINTMENT_STATUSES, PAYMENT_STATUSES, AUDIT_ACTIONS } = require('../constants/enums');

let isRunning = false;
let jobTimer = null;

const runOnce = async () => {
  if (isRunning) {
    return;
  }
  isRunning = true;

  try {
    const now = clock.now();

    // a) cleanupExpiredTransactions: PENDING quá expiresAt -> EXPIRED + release voucher
    try {
      const expiredTransactions = await PaymentTransaction.find({
        status: PAYMENT_STATUSES.PENDING,
        expiresAt: { $lte: now },
      }).limit(100);

      for (const tx of expiredTransactions) {
        try {
          tx.status = PAYMENT_STATUSES.EXPIRED;
          await tx.save();

          if (tx.userVoucherId) {
            await voucherRedemptionService.release(
              tx.userVoucherId,
              tx.appointmentId,
            ).catch((err) => {
              console.error(`[paymentMaintenance] Failed to release voucher for expired transaction ${tx.transactionNo}:`, err.message);
            });
          }
        } catch (itemErr) {
          console.error(`[paymentMaintenance] Error expiring transaction ${tx.transactionNo}:`, itemErr.message);
        }
      }
    } catch (errA) {
      console.error('[paymentMaintenance] Error in step a (cleanupExpiredTransactions):', errA.message);
    }

    // b) Lịch PENDING_PAYMENT có createdAt <= now - HOLD và không còn transaction PENDING hợp lệ và chưa có SUCCESS
    // -> transition EXPIRED (audit APPOINTMENT_PAYMENT_EXPIRED), releaseSlot theo bookingRef, release voucher, outbox thông báo bệnh nhân.
    try {
      const holdMinutes = configService.paymentAppointmentHoldMinutes || 30;
      const holdCutoff = new Date(now.getTime() - holdMinutes * 60 * 1000);

      const pendingAppointments = await Appointment.find({
        status: APPOINTMENT_STATUSES.PENDING_PAYMENT,
        createdAt: { $lte: holdCutoff },
      }).limit(50);

      for (const appt of pendingAppointments) {
        try {
          // Kiểm tra xem có transaction SUCCESS không
          const hasSuccessTx = await PaymentTransaction.exists({
            appointmentId: appt.id,
            status: PAYMENT_STATUSES.SUCCESS,
          });
          if (hasSuccessTx) {
            continue;
          }

          // Kiểm tra xem có transaction PENDING nào còn hạn (expiresAt > now) không
          const hasValidPendingTx = await PaymentTransaction.exists({
            appointmentId: appt.id,
            status: PAYMENT_STATUSES.PENDING,
            expiresAt: { $gt: now },
          });
          if (hasValidPendingTx) {
            continue;
          }

          // Transition sang EXPIRED
          await appointmentStateService.transition({
            appointmentId: appt.id,
            fromStatus: APPOINTMENT_STATUSES.PENDING_PAYMENT,
            toStatus: APPOINTMENT_STATUSES.EXPIRED,
            actor: { role: 'SYSTEM' },
            extraFields: { cancellationReason: 'Quá thời hạn thanh toán giữ chỗ' },
          });

          // Giải phóng slot theo bookingRef = appt.appointmentNo
          if (appt.shiftId) {
            const shift = await DoctorShift.findOne({ id: appt.shiftId });
            if (shift) {
              const bookedSlotIds = (shift.slots || [])
                .filter((s) => s.bookingRef === appt.appointmentNo)
                .map((s) => s.id);

              if (bookedSlotIds.length > 0) {
                await appointmentSlotService.releaseSlot({
                  shiftId: appt.shiftId,
                  slotIds: bookedSlotIds,
                  bookingRef: appt.appointmentNo,
                }).catch((slotErr) => {
                  console.error(`[paymentMaintenance] Failed to release slot for appointment ${appt.appointmentNo}:`, slotErr.message);
                });
              }
            }
          }

          // Release voucher nếu có voucher đang gắn và đang được dùng cho appointment này
          const txWithVoucher = await PaymentTransaction.findOne({
            appointmentId: appt.id,
            userVoucherId: { $ne: null },
          });
          if (txWithVoucher && txWithVoucher.userVoucherId) {
            const uv = await UserVoucher.findOne({ id: txWithVoucher.userVoucherId });
            if (uv && uv.used && uv.appointmentId === appt.id) {
              await voucherRedemptionService.release(
                txWithVoucher.userVoucherId,
                appt.id,
              ).catch((vErr) => {
                console.error(`[paymentMaintenance] Failed to release voucher for appointment ${appt.appointmentNo}:`, vErr.message);
              });
            }
          }

          // Audit
          await auditService.log({
            actor: { role: 'SYSTEM', userId: 'SYSTEM' },
            action: AUDIT_ACTIONS.APPOINTMENT_PAYMENT_EXPIRED,
            resource: {
              type: 'Appointment',
              id: appt.id,
            },
            reason: 'Payment hold expired without successful payment',
            changes: {
              appointmentNo: appt.appointmentNo,
            },
          }).catch((audErr) => {
            console.error(`[paymentMaintenance] Failed to audit expiration for ${appt.appointmentNo}:`, audErr.message);
          });

          // Outbox thông báo bệnh nhân
          await outboxService.recordEvent({
            eventType: 'APPOINTMENT_PAYMENT_EXPIRED',
            payload: {
              appointmentId: appt.id,
              appointmentNo: appt.appointmentNo,
              patientId: appt.patientId,
            },
          }).catch((outErr) => {
            console.error(`[paymentMaintenance] Failed to record outbox event for ${appt.appointmentNo}:`, outErr.message);
          });
        } catch (itemErr) {
          console.error(`[paymentMaintenance] Error expiring appointment ${appt.appointmentNo || appt.id}:`, itemErr.message);
        }
      }
    } catch (errB) {
      console.error('[paymentMaintenance] Error in step b (expirePendingAppointments):', errB.message);
    }

    // c) Giao dịch SUCCESS có needsReconcile=true: thử lại transition; thành công thì needsReconcile=false, audit PAYMENT_RECONCILED
    try {
      const reconcileTxs = await PaymentTransaction.find({
        status: PAYMENT_STATUSES.SUCCESS,
        needsReconcile: true,
      }).limit(50);

      for (const tx of reconcileTxs) {
        try {
          const appt = await Appointment.findOne({ id: tx.appointmentId });
          if (!appt) {
            continue;
          }

          const targetState = env.paymentSuccessTargetStateOnline || APPOINTMENT_STATUSES.CONFIRMED;

          if (appt.status === targetState) {
            tx.needsReconcile = false;
            await tx.save();
            continue;
          }

          if (appt.status === APPOINTMENT_STATUSES.PENDING_PAYMENT || appt.status === APPOINTMENT_STATUSES.PENDING_CONFIRMATION) {
            await appointmentStateService.transition({
              appointmentId: appt.id,
              fromStatus: appt.status,
              toStatus: targetState,
              actor: { role: 'SYSTEM' },
              extraFields: { paymentStatus: 'PAID' },
            });

            tx.needsReconcile = false;
            await tx.save();

            await auditService.log({
              actor: { role: 'SYSTEM', userId: 'SYSTEM' },
              action: AUDIT_ACTIONS.PAYMENT_RECONCILED,
              resource: {
                type: 'PaymentTransaction',
                id: tx.id,
              },
              reason: 'Reconciled transaction and transitioned appointment successfully',
              changes: {
                transactionNo: tx.transactionNo,
                appointmentId: appt.id,
                targetState,
              },
            }).catch(() => {});
          } else {
            // Lịch đã CANCELLED hoặc EXPIRED, không transition được sang CONFIRMED
            // Đánh dấu refundRequired
            if (!appt.refundRequired) {
              appt.refundRequired = true;
              await appt.save();
            }
            // Giữ needsReconcile hoặc xử lý theo nghiệp vụ hoàn tiền
          }
        } catch (recErr) {
          console.error(`[paymentMaintenance] Error reconciling transaction ${tx.transactionNo}:`, recErr.message);
        }
      }
    } catch (errC) {
      console.error('[paymentMaintenance] Error in step c (reconcileTransactions):', errC.message);
    }
  } finally {
    isRunning = false;
  }
};

const start = () => {
  if (jobTimer) {
    return;
  }
  const intervalMs = configService.paymentJobIntervalMs || env.paymentJobIntervalMs || 60000;
  jobTimer = setInterval(() => {
    runOnce().catch((err) => {
      console.error('[paymentMaintenance] Unhandled error during scheduled run:', err);
    });
  }, intervalMs);

  if (jobTimer.unref) {
    jobTimer.unref();
  }
};

const stop = () => {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
  }
};

module.exports = {
  start,
  stop,
  runOnce,
};
