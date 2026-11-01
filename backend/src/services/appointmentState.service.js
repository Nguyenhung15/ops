const mongoose = require('mongoose');
const { Appointment } = require('../models');
const { APPOINTMENT_STATUSES, AUDIT_ACTIONS } = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const { clock } = require('./clock.service');
const auditService = require('./audit.service');
const outboxService = require('./outbox.service');

/**
 * State machine definition for Appointments.
 * Terminal states have no valid transitions out.
 */
const VALID_TRANSITIONS = Object.freeze({
  [APPOINTMENT_STATUSES.PENDING_PAYMENT]: Object.freeze([
    APPOINTMENT_STATUSES.PENDING_CONFIRMATION,
    APPOINTMENT_STATUSES.CONFIRMED,
    APPOINTMENT_STATUSES.CANCELLED,
    APPOINTMENT_STATUSES.EXPIRED,
  ]),
  [APPOINTMENT_STATUSES.PENDING_CONFIRMATION]: Object.freeze([
    APPOINTMENT_STATUSES.CONFIRMED,
    APPOINTMENT_STATUSES.CANCELLED,
    APPOINTMENT_STATUSES.RESCHEDULED,
    APPOINTMENT_STATUSES.EXPIRED,
  ]),
  [APPOINTMENT_STATUSES.CONFIRMED]: Object.freeze([
    APPOINTMENT_STATUSES.CHECKED_IN,
    APPOINTMENT_STATUSES.CANCELLED,
    APPOINTMENT_STATUSES.RESCHEDULED,
    APPOINTMENT_STATUSES.EXPIRED,
    APPOINTMENT_STATUSES.NO_SHOW,
  ]),
  [APPOINTMENT_STATUSES.CHECKED_IN]: Object.freeze([
    APPOINTMENT_STATUSES.IN_PROGRESS,
    APPOINTMENT_STATUSES.CANCELLED,
    APPOINTMENT_STATUSES.NO_SHOW,
  ]),
  [APPOINTMENT_STATUSES.IN_PROGRESS]: Object.freeze([
    APPOINTMENT_STATUSES.COMPLETED,
  ]),
  [APPOINTMENT_STATUSES.COMPLETED]: Object.freeze([]),
  [APPOINTMENT_STATUSES.CANCELLED]: Object.freeze([]),
  [APPOINTMENT_STATUSES.EXPIRED]: Object.freeze([]),
  [APPOINTMENT_STATUSES.NO_SHOW]: Object.freeze([]),
  [APPOINTMENT_STATUSES.RESCHEDULED]: Object.freeze([]),
});

const TERMINAL_STATUSES = new Set([
  APPOINTMENT_STATUSES.COMPLETED,
  APPOINTMENT_STATUSES.CANCELLED,
  APPOINTMENT_STATUSES.EXPIRED,
  APPOINTMENT_STATUSES.NO_SHOW,
  APPOINTMENT_STATUSES.RESCHEDULED,
]);

/**
 * Build flexible identifier filter supporting Number id, ObjectId string, or appointmentNo string.
 * @param {string|number} identifier
 * @returns {Record<string, any>}
 */
function buildIdFilter(identifier) {
  if (identifier === null || identifier === undefined) {
    throw new ApiError(400, 'Appointment identifier is required');
  }

  const str = String(identifier).trim();
  const num = Number(str);
  const conditions = [];

  if (Number.isSafeInteger(num) && num > 0) {
    conditions.push({ id: num });
  }

  if (mongoose.Types.ObjectId.isValid(str)) {
    conditions.push({ _id: new mongoose.Types.ObjectId(str) });
  }

  conditions.push({ appointmentNo: str });

  return conditions.length === 1 ? conditions[0] : { $or: conditions };
}

/**
 * Check if a state transition is permitted by the state machine table.
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isValidTransition(fromStatus, toStatus) {
  const allowed = VALID_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

class AppointmentStateService {
  /**
   * Transition an appointment to a new state atomically and idempotently.
   *
   * @param {string|number} appointmentId
   * @param {string[]} fromStatuses - Array of acceptable current statuses
   * @param {string} toStatus - Desired target status
   * @param {object} actor - Principal executing the transition ({ userId, role, email })
   * @param {object} [extraFields={}] - Optional metadata (reason, meetingUrl, notes, etc.)
   * @param {object} [options={}] - Options e.g. { session, skipAudit, skipOutbox }
   * @returns {Promise<{ appointment: object, changed: boolean, idempotent: boolean }>}
   */
  async transition(
    appointmentIdOrParams,
    fromStatuses,
    toStatus,
    actor,
    extraFields = {},
    options = {},
  ) {
    let appointmentId = appointmentIdOrParams;
    let actualFromStatuses = fromStatuses;
    let actualToStatus = toStatus;
    let actualActor = actor;
    let actualExtraFields = extraFields;
    let actualOptions = options;

    if (
      appointmentIdOrParams &&
      typeof appointmentIdOrParams === 'object' &&
      !Array.isArray(appointmentIdOrParams) &&
      appointmentIdOrParams.appointmentId !== undefined
    ) {
      appointmentId = appointmentIdOrParams.appointmentId;
      actualFromStatuses = appointmentIdOrParams.fromStatuses || appointmentIdOrParams.fromStatus;
      actualToStatus = appointmentIdOrParams.toStatus;
      actualActor = appointmentIdOrParams.actor;
      actualExtraFields = appointmentIdOrParams.extraFields || {};
      actualOptions = appointmentIdOrParams.options || {};
    }

    toStatus = actualToStatus;
    actor = actualActor;
    extraFields = actualExtraFields;
    options = actualOptions;

    if (!toStatus || !Object.values(APPOINTMENT_STATUSES).includes(toStatus)) {
      throw new ApiError(400, `Trạng thái đích không hợp lệ: ${toStatus}`, 'INVALID_TARGET_STATUS');
    }

    const fromList = Array.isArray(actualFromStatuses)
      ? actualFromStatuses.filter(Boolean)
      : [actualFromStatuses].filter(Boolean);

    if (fromList.length === 0) {
      throw new ApiError(400, 'Danh sách trạng thái hợp lệ nguồn (fromStatuses) không được để trống', 'EMPTY_FROM_STATUSES');
    }

    // Validate that transition is theoretically allowed from at least one of the fromStatuses
    const hasAnyValidPath = fromList.some((s) => isValidTransition(s, toStatus));
    if (!hasAnyValidPath) {
      throw new ApiError(
        409,
        `Quy tắc nghiệp vụ không cho phép chuyển trạng thái từ [${fromList.join(', ')}] sang '${toStatus}'`,
        'ILLEGAL_STATE_TRANSITION',
      );
    }

    const idFilter = buildIdFilter(appointmentId);
    const session = options.session || null;

    // Fetch existing document to check idempotency and current status
    const existing = await Appointment.findOne(idFilter).session(session);
    if (!existing) {
      throw new ApiError(404, `Không tìm thấy lịch hẹn với định danh: ${appointmentId}`, 'APPOINTMENT_NOT_FOUND');
    }

    // IDEMPOTENT CHECK: If appointment is already in the target state
    if (existing.status === toStatus) {
      return {
        appointment: existing.toJSON ? existing.toJSON() : existing,
        changed: false,
        idempotent: true,
        status: toStatus,
      };
    }

    // Check if transition is valid from the actual current status
    if (!fromList.includes(existing.status)) {
      throw new ApiError(
        409,
        `Lịch hẹn đang ở trạng thái '${existing.status}', không thuộc các trạng thái cho phép [${fromList.join(', ')}] để chuyển sang '${toStatus}'`,
        'INVALID_STATE',
      );
    }

    if (!isValidTransition(existing.status, toStatus)) {
      throw new ApiError(
        409,
        `Không thể chuyển lịch hẹn từ trạng thái '${existing.status}' sang '${toStatus}'`,
        'INVALID_TRANSITION',
      );
    }

    const nowUtc = clock.now();
    const updateSet = {
      status: toStatus,
      updatedAt: nowUtc,
    };

    // State-specific automatic field population
    if (toStatus === APPOINTMENT_STATUSES.CONFIRMED) {
      updateSet.confirmedAt = nowUtc;
      if (actor?.userId) {
        updateSet.confirmedBy = Number(actor.userId) || actor.userId;
      }
    }
    if (toStatus === APPOINTMENT_STATUSES.CHECKED_IN) {
      updateSet.checkedIn = true;
      updateSet.checkedInAt = nowUtc;
      if (actor?.userId) {
        updateSet.checkedInBy = Number(actor.userId) || actor.userId;
      }
    }
    if (toStatus === APPOINTMENT_STATUSES.IN_PROGRESS && !existing.actualStartTime) {
      updateSet.actualStartTime = clock.currentTime();
    }
    if (toStatus === APPOINTMENT_STATUSES.COMPLETED && !existing.actualEndTime) {
      updateSet.actualEndTime = clock.currentTime();
    }
    if (toStatus === APPOINTMENT_STATUSES.CANCELLED) {
      updateSet.cancelledAt = nowUtc;
      if (extraFields.reason || extraFields.cancelReason) {
        updateSet.cancelReason = String(extraFields.reason || extraFields.cancelReason).trim();
      }
    }

    // Merge sanitized extra fields (exclude id, _id, __v, status)
    for (const [key, val] of Object.entries(extraFields || {})) {
      if (!['_id', 'id', '__v', 'status'].includes(key)) {
        updateSet[key] = val;
      }
    }

    // Conditional atomic update query (protects against concurrent race conditions)
    const conditionalFilter = {
      _id: existing._id,
      status: existing.status,
    };

    const updated = await Appointment.findOneAndUpdate(
      conditionalFilter,
      { $set: updateSet },
      { returnDocument: 'after', session },
    );

    if (!updated) {
      // Race condition occurred: status changed between read and write
      const fresh = await Appointment.findById(existing._id).session(session);
      if (fresh && fresh.status === toStatus) {
        return {
          appointment: fresh.toJSON ? fresh.toJSON() : fresh,
          changed: false,
          idempotent: true,
          status: toStatus,
        };
      }
      throw new ApiError(
        409,
        'Xung đột trạng thái: Lịch hẹn đã bị thay đổi bởi thao tác đồng thời khác',
        'CONCURRENT_STATE_MODIFICATION',
      );
    }

    const previousStatus = existing.status;
    const actorInfo = {
      id: actor?.userId ? (Number(actor.userId) || actor.userId) : (actor?.id || 'SYSTEM'),
      userId: String(actor?.userId || actor?.id || 'SYSTEM'),
      email: actor?.email || null,
      userType: actor?.role || actor?.userType || 'SYSTEM',
    };

    // Audit logging
    if (!options.skipAudit) {
      try {
        await auditService.log({
          actor: actorInfo,
          action: options.auditAction || AUDIT_ACTIONS.APPOINTMENT_STATUS_CHANGE || 'APPOINTMENT_STATUS_CHANGE',
          resource: {
            type: 'Appointment',
            id: String(updated.id || updated._id),
          },
          reason:
            extraFields.cancelReason ||
            extraFields.reason ||
            options.auditReason ||
            `Chuyển trạng thái từ ${previousStatus} sang ${toStatus}`,
          summary: `Appointment ${updated.appointmentNo || updated.id}: ${previousStatus} -> ${toStatus}`,
          changes: {
            before: { status: previousStatus },
            after: { status: toStatus },
          },
        });
      } catch (auditErr) {
        // Audit failure should not break critical state transition, but log warning
        console.warn(`[AppointmentStateService] Audit log warning: ${auditErr.message}`);
      }
    }

    // Outbox notification event
    if (!options.skipOutbox) {
      try {
        await outboxService.recordEvent({
          eventType: options.outboxEventType || `APPOINTMENT_${toStatus}`,
          channel: options.outboxChannel || 'ALL',
          payload: {
            appointmentId: updated.id || String(updated._id),
            appointmentNo: updated.appointmentNo,
            patientId: updated.patientId,
            doctorId: updated.doctorId,
            previousStatus,
            newStatus: toStatus,
            actor: actorInfo,
            timestamp: nowUtc.toISOString(),
            ...(options.outboxPayload || {}),
          },
          session,
        });
      } catch (outboxErr) {
        console.warn(`[AppointmentStateService] Outbox event warning: ${outboxErr.message}`);
      }
    }

    return {
      appointment: updated.toJSON ? updated.toJSON() : updated,
      changed: true,
      idempotent: false,
      status: toStatus,
      previousStatus,
    };
  }
}

const appointmentStateService = new AppointmentStateService();

module.exports = {
  VALID_TRANSITIONS,
  TERMINAL_STATUSES,
  isValidTransition,
  AppointmentStateService,
  appointmentStateService,
};
