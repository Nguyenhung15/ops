const { DoctorShift } = require('../models');
const { clock } = require('./clock.service');
const ApiError = require('../utils/ApiError');

/**
 * Hold / Reserve a slot in an active DoctorShift using atomic conditional update.
 *
 * @param {object} params
 * @param {number} params.shiftId - Target DoctorShift numeric ID
 * @param {number} params.slotId - Target slot ID within the shift
 * @param {string} params.bookingRef - Temporary or final bookingRef (e.g. HOLD_... or appointmentNo)
 * @returns {Promise<{ success: boolean, shift: object, slot: object }>}
 */
async function holdSlot({ shiftId, slotId, bookingRef }) {
  if (!shiftId || !slotId || !bookingRef) {
    throw new ApiError(400, 'shiftId, slotId và bookingRef là bắt buộc để giữ chỗ slot');
  }

  const shift = await DoctorShift.findOne({ id: Number(shiftId) });
  if (!shift) {
    throw new ApiError(404, 'Ca trực không tồn tại', 'SHIFT_NOT_FOUND');
  }
  if (shift.status !== 'ACTIVE') {
    throw new ApiError(409, 'Ca trực không ở trạng thái hoạt động (ACTIVE)', 'SHIFT_NOT_ACTIVE');
  }

  const slot = (shift.slots || []).find((s) => s.id === Number(slotId));
  if (!slot) {
    throw new ApiError(404, `Không tìm thấy slot ${slotId} trong ca trực ${shiftId}`, 'SLOT_NOT_FOUND');
  }

  const updateResult = await DoctorShift.updateOne(
    {
      id: Number(shiftId),
      status: 'ACTIVE',
      slots: {
        $elemMatch: {
          id: Number(slotId),
          status: 'AVAILABLE',
        },
      },
    },
    {
      $set: {
        'slots.$.status': 'BOOKED',
        'slots.$.bookingRef': bookingRef,
        'slots.$.bookedAt': clock.now(),
      },
    },
  );

  if (updateResult.modifiedCount !== 1) {
    throw new ApiError(
      409,
      'Slot khám đã có người đặt trước đó hoặc không khả dụng, vui lòng chọn slot khác',
      'SLOT_ALREADY_BOOKED',
    );
  }

  return {
    success: true,
    shiftId: Number(shiftId),
    slotId: Number(slotId),
    bookingRef,
  };
}

/**
 * Release booked slot(s) back to AVAILABLE.
 * Guarded strictly: ONLY releases if slot's bookingRef matches the specified bookingRef.
 *
 * @param {object} params
 * @param {number} params.shiftId - Target DoctorShift numeric ID
 * @param {number[]|number} params.slotIds - Single slot ID or array of slot IDs
 * @param {string} params.bookingRef - appointmentNo or temp booking reference that currently owns the slot
 * @returns {Promise<{ modifiedCount: number }>}
 */
async function releaseSlot({ shiftId, slotIds, bookingRef }) {
  if (!shiftId || !bookingRef) {
    return { modifiedCount: 0 };
  }

  const targetSlotIds = Array.isArray(slotIds) ? slotIds.map(Number) : [Number(slotIds)];
  if (targetSlotIds.length === 0) {
    return { modifiedCount: 0 };
  }

  const result = await DoctorShift.updateOne(
    {
      id: Number(shiftId),
      'slots.bookingRef': bookingRef,
    },
    {
      $set: {
        'slots.$[elem].status': 'AVAILABLE',
        'slots.$[elem].bookingRef': null,
        'slots.$[elem].bookedAt': null,
      },
    },
    {
      arrayFilters: [
        {
          'elem.bookingRef': bookingRef,
          'elem.id': { $in: targetSlotIds },
        },
      ],
    },
  );

  return { modifiedCount: result.modifiedCount || 0 };
}

module.exports = {
  holdSlot,
  releaseSlot,
};
