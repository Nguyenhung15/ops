const {
  Event,
  UserEvent,
  Voucher,
  UserVoucher,
  User,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { parseFlexibleDate } = require('../utils/dateParser');
const { parsePositiveInt } = require('../utils/normalizers');
const { USER_EVENT_STATUSES, AUDIT_ACTIONS } = require('../constants/enums');
const { recordAudit, buildAuditDiff, sanitizeSnapshot } = require('./audit.service');

const serializeEvent = (event, voucher) => {
  const e = event.toJSON ? event.toJSON() : event;
  const v = voucher || null;

  return {
    id: e.id,
    title: e.title,
    description: e.description || null,
    location: e.location || null,
    startDate: e.startDate instanceof Date ? e.startDate.toISOString() : (e.startDate || null),
    endDate: e.endDate instanceof Date ? e.endDate.toISOString() : (e.endDate || null),
    isEnabled: typeof e.isEnabled === 'boolean' ? e.isEnabled : true,
    enabled: typeof e.isEnabled === 'boolean' ? e.isEnabled : true,
    voucherId: e.voucherId || null,
    voucherCode: v?.code || null,
    voucherName: v?.name || null,
  };
};

/**
 * Public & Patient: Fetch active events.
 */
const getAvailableEvents = async () => {
  const events = await Event.find({ isEnabled: true }).sort({ startDate: 1 });
  if (events.length === 0) return [];

  const voucherIds = [...new Set(events.map((e) => e.voucherId).filter(Boolean))];
  const vouchers = await Voucher.find({ id: { $in: voucherIds } });
  const voucherMap = new Map(vouchers.map((v) => [v.id, v]));

  return events.map((e) => serializeEvent(e, voucherMap.get(e.voucherId)));
};

/**
 * Admin: Fetch all events.
 */
const getAllEvents = async () => {
  const events = await Event.find({}).sort({ createdAt: -1 });
  if (events.length === 0) return [];

  const voucherIds = [...new Set(events.map((e) => e.voucherId).filter(Boolean))];
  const vouchers = await Voucher.find({ id: { $in: voucherIds } });
  const voucherMap = new Map(vouchers.map((v) => [v.id, v]));

  return events.map((e) => serializeEvent(e, voucherMap.get(e.voucherId)));
};

/**
 * Fetch event details by ID.
 */
const getEventById = async (idParam) => {
  const id = parsePositiveInt(idParam, 'Event ID');
  const event = await Event.findOne({ id });
  if (!event) {
    throw new ApiError(404, `Không tìm thấy sự kiện #${id}`);
  }

  let voucher = null;
  if (event.voucherId) {
    voucher = await Voucher.findOne({ id: event.voucherId });
  }

  return serializeEvent(event, voucher);
};

/**
 * Admin creates a new event.
 */
const createEvent = async (actor, payload, req) => {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError(400, 'Dữ liệu sự kiện không hợp lệ');
  }

  const rawTitle = payload.title ? String(payload.title).trim() : '';
  if (!rawTitle) {
    throw new ApiError(400, 'Tiêu đề sự kiện (title) không được để trống');
  }

  const startDate = parseFlexibleDate(payload.startDate, 'Thời gian bắt đầu', true);
  const endDate = parseFlexibleDate(payload.endDate, 'Thời gian kết thúc', true);

  if (startDate.getTime() >= endDate.getTime()) {
    throw new ApiError(400, 'Thời gian kết thúc phải sau thời gian bắt đầu sự kiện');
  }

  let voucherId = null;
  let linkedVoucher = null;
  if (payload.voucherId !== undefined && payload.voucherId !== null && payload.voucherId !== '') {
    voucherId = parsePositiveInt(payload.voucherId, 'Voucher ID');
    linkedVoucher = await Voucher.findOne({ id: voucherId });
    if (!linkedVoucher) {
      throw new ApiError(404, `Không tìm thấy voucher #${voucherId} để liên kết sự kiện`);
    }
  }

  const isEnabled = payload.isEnabled !== undefined ? Boolean(payload.isEnabled) : true;
  const description = payload.description ? String(payload.description).trim() : null;
  const location = payload.location ? String(payload.location).trim() : null;

  const event = await Event.create({
    title: rawTitle,
    description,
    location,
    startDate,
    endDate,
    isEnabled,
    voucherId,
  });

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.EVENT_CREATE,
      targetType: 'Event',
      targetId: event.id,
      reason: `Tạo sự kiện mới [${event.title}]`,
      changes: { after: sanitizeSnapshot(event) },
      req,
    });
  }

  return serializeEvent(event, linkedVoucher);
};

/**
 * Admin updates an existing event.
 */
const updateEvent = async (actor, idParam, payload, req) => {
  const id = parsePositiveInt(idParam, 'Event ID');
  const event = await Event.findOne({ id });
  if (!event) {
    throw new ApiError(404, `Không tìm thấy sự kiện #${id}`);
  }

  const beforeSnap = sanitizeSnapshot(event);

  if (payload?.title !== undefined) {
    const rawTitle = String(payload.title).trim();
    if (!rawTitle) {
      throw new ApiError(400, 'Tiêu đề sự kiện (title) không được để trống');
    }
    event.title = rawTitle;
  }

  if (payload?.description !== undefined) {
    event.description = payload.description ? String(payload.description).trim() : null;
  }

  if (payload?.location !== undefined) {
    event.location = payload.location ? String(payload.location).trim() : null;
  }

  let newStart = event.startDate;
  let newEnd = event.endDate;

  if (payload?.startDate !== undefined) {
    newStart = parseFlexibleDate(payload.startDate, 'Thời gian bắt đầu', true);
  }
  if (payload?.endDate !== undefined) {
    newEnd = parseFlexibleDate(payload.endDate, 'Thời gian kết thúc', true);
  }

  if (newStart.getTime() >= newEnd.getTime()) {
    throw new ApiError(400, 'Thời gian kết thúc phải sau thời gian bắt đầu sự kiện');
  }
  event.startDate = newStart;
  event.endDate = newEnd;

  let linkedVoucher = null;
  if (payload?.voucherId !== undefined) {
    if (payload.voucherId === null || payload.voucherId === '') {
      event.voucherId = null;
    } else {
      const vId = parsePositiveInt(payload.voucherId, 'Voucher ID');
      linkedVoucher = await Voucher.findOne({ id: vId });
      if (!linkedVoucher) {
        throw new ApiError(404, `Không tìm thấy voucher #${vId} để liên kết sự kiện`);
      }
      event.voucherId = vId;
    }
  } else if (event.voucherId) {
    linkedVoucher = await Voucher.findOne({ id: event.voucherId });
  }

  let statusChanged = false;
  if (payload?.isEnabled !== undefined) {
    const newEnable = Boolean(payload.isEnabled);
    if (event.isEnabled !== newEnable) {
      event.isEnabled = newEnable;
      statusChanged = true;
    }
  }

  await event.save();

  if (actor) {
    let action = AUDIT_ACTIONS.EVENT_UPDATE;
    if (statusChanged) {
      action = event.isEnabled ? AUDIT_ACTIONS.EVENT_ENABLE : AUDIT_ACTIONS.EVENT_DISABLE;
    }
    await recordAudit({
      actor,
      action,
      targetType: 'Event',
      targetId: event.id,
      reason: `Cập nhật sự kiện [${event.title}]`,
      changes: buildAuditDiff(beforeSnap, event),
      req,
    });
  }

  return serializeEvent(event, linkedVoucher);
};

/**
 * Admin deletes an event.
 * Constraint: If event has participant registrations, DO NOT HARD DELETE.
 * Automatically soft-disable to preserve participant attendance history.
 */
const deleteEvent = async (actor, idParam, req) => {
  const id = parsePositiveInt(idParam, 'Event ID');
  const event = await Event.findOne({ id });
  if (!event) {
    throw new ApiError(404, `Không tìm thấy sự kiện #${id}`);
  }

  const regCount = await UserEvent.countDocuments({ eventId: id });
  if (regCount > 0) {
    // Preserve participant history
    event.isEnabled = false;
    await event.save();

    if (actor) {
      await recordAudit({
        actor,
        action: AUDIT_ACTIONS.EVENT_DISABLE,
        targetType: 'Event',
        targetId: event.id,
        reason: `Vô hiệu hóa sự kiện do đã có ${regCount} người đăng ký tham gia`,
        changes: { after: { isEnabled: false, reason: 'PRESERVE_REGISTRATION_HISTORY' } },
        req,
      });
    }

    return {
      success: true,
      softDeleted: true,
      message: `Sự kiện đã có ${regCount} người đăng ký. Hệ thống đã tự động vô hiệu hóa để bảo toàn lịch sử tham gia.`,
    };
  }

  await Event.deleteOne({ id });

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.EVENT_DELETE,
      targetType: 'Event',
      targetId: id,
      reason: `Xóa sự kiện #${id} [${event.title}] (chưa có người đăng ký)`,
      changes: { before: sanitizeSnapshot(event) },
      req,
    });
  }

  return {
    success: true,
    deleted: true,
    message: 'Xóa sự kiện thành công',
  };
};

/**
 * Patient registers for an event.
 */
const registerEvent = async (patientUser, eventIdParam) => {
  const eventId = parsePositiveInt(eventIdParam, 'Event ID');
  const event = await Event.findOne({ id: eventId });
  if (!event) {
    throw new ApiError(404, `Không tìm thấy sự kiện #${eventId}`);
  }

  if (!event.isEnabled) {
    throw new ApiError(400, 'Sự kiện này hiện đã đóng hoặc chưa mở đăng ký');
  }

  if (event.endDate.getTime() < Date.now()) {
    throw new ApiError(400, 'Sự kiện này đã kết thúc, không thể đăng ký');
  }

  const existing = await UserEvent.findOne({ eventId, userId: patientUser.id });
  if (existing) {
    throw new ApiError(400, 'Bạn đã đăng ký tham gia sự kiện này rồi');
  }

  const reg = await UserEvent.create({
    eventId,
    userId: patientUser.id,
    status: USER_EVENT_STATUSES.PENDING,
    registeredAt: new Date(),
  });

  return {
    success: true,
    message: 'Đăng ký tham gia sự kiện thành công',
    data: reg,
  };
};

/**
 * Patient fetches personal event registrations.
 */
const getMyEvents = async (patientUser) => {
  const userEvents = await UserEvent.find({ userId: patientUser.id }).sort({ registeredAt: -1 });
  if (userEvents.length === 0) return [];

  const eventIds = [...new Set(userEvents.map((ue) => ue.eventId))];
  const events = await Event.find({ id: { $in: eventIds } });
  const eventMap = new Map(events.map((e) => [e.id, e]));

  return userEvents.map((ue) => {
    const e = eventMap.get(ue.eventId);
    return {
      id: ue.id,
      userEventId: ue.id,
      eventId: ue.eventId,
      eventName: e?.title || '',
      title: e?.title || '',
      eventDescription: e?.description || null,
      description: e?.description || null,
      eventLocation: e?.location || null,
      location: e?.location || null,
      eventStart: e?.startDate instanceof Date ? e.startDate.toISOString() : null,
      startDate: e?.startDate instanceof Date ? e.startDate.toISOString() : null,
      eventEnd: e?.endDate instanceof Date ? e.endDate.toISOString() : null,
      endDate: e?.endDate instanceof Date ? e.endDate.toISOString() : null,
      status: ue.status,
      registeredAt: ue.registeredAt instanceof Date ? ue.registeredAt.toISOString() : null,
    };
  });
};

/**
 * Receptionist & Admin: Fetch all events with full registration participant list.
 */
const getReceptionEvents = async () => {
  const events = await Event.find({}).sort({ startDate: -1 });
  if (events.length === 0) return [];

  const eventIds = events.map((e) => e.id);
  const voucherIds = [...new Set(events.map((e) => e.voucherId).filter(Boolean))];

  const [vouchers, allUserEvents] = await Promise.all([
    Voucher.find({ id: { $in: voucherIds } }),
    UserEvent.find({ eventId: { $in: eventIds } }).sort({ registeredAt: -1 }),
  ]);

  const voucherMap = new Map(vouchers.map((v) => [v.id, v]));

  // Batch-fetch users for all registrations
  const userIds = [...new Set(allUserEvents.map((ue) => ue.userId))];
  const users = await User.find({ id: { $in: userIds } }).lean();
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Group userEvents by eventId
  const regMap = new Map();
  for (const ue of allUserEvents) {
    if (!regMap.has(ue.eventId)) regMap.set(ue.eventId, []);
    const u = userMap.get(ue.userId);
    regMap.get(ue.eventId).push({
      id: ue.id,
      userId: ue.userId,
      userFullName: u?.fullName || 'N/A',
      fullName: u?.fullName || 'N/A',
      name: u?.fullName || 'N/A',
      userEmail: u?.email || null,
      email: u?.email || null,
      userPhone: u?.phone || null,
      phone: u?.phone || null,
      status: ue.status,
      registeredAt: ue.registeredAt instanceof Date ? ue.registeredAt.toISOString() : null,
    });
  }

  return events.map((e) => {
    const v = voucherMap.get(e.voucherId);
    return {
      id: e.id,
      title: e.title,
      eventName: e.title,
      description: e.description || null,
      location: e.location || null,
      startDate: e.startDate instanceof Date ? e.startDate.toISOString() : null,
      eventStart: e.startDate instanceof Date ? e.startDate.toISOString() : null,
      endDate: e.endDate instanceof Date ? e.endDate.toISOString() : null,
      eventEnd: e.endDate instanceof Date ? e.endDate.toISOString() : null,
      isEnabled: e.isEnabled,
      enabled: e.isEnabled,
      voucherId: e.voucherId || null,
      voucherCode: v?.code || null,
      voucherName: v?.name || null,
      registrations: regMap.get(e.id) || [],
    };
  });
};

/**
 * Receptionist & Admin confirms attendee check-in and automatically issues voucher if event has one.
 */
const confirmEventAttendance = async (actor, eventIdParam, userIdParam, req) => {
  const eventId = parsePositiveInt(eventIdParam, 'Event ID');
  const userId = parsePositiveInt(userIdParam, 'User ID');

  const [event, user, userEvent] = await Promise.all([
    Event.findOne({ id: eventId }),
    User.findOne({ id: userId }).lean(),
    UserEvent.findOne({ eventId, userId }),
  ]);

  if (!event) throw new ApiError(404, `Không tìm thấy sự kiện #${eventId}`);
  if (!user) throw new ApiError(404, `Không tìm thấy người dùng #${userId}`);
  if (!userEvent) throw new ApiError(404, `Bệnh nhân #${userId} chưa đăng ký sự kiện #${eventId}`);

  // Confirm attendance
  userEvent.status = USER_EVENT_STATUSES.CONFIRMED;
  await userEvent.save();

  // If event has a voucher attached, automatically grant UserVoucher (per section 4.3 BACKEND_AGENT_GUIDE.md)
  let grantedVoucher = null;
  if (event.voucherId) {
    const voucher = await Voucher.findOne({ id: event.voucherId, enable: true });
    if (voucher) {
      // Check if user already got this voucher to prevent duplicate issuance
      const existingUV = await UserVoucher.findOne({ userId, voucherId: voucher.id });
      if (!existingUV) {
        grantedVoucher = await UserVoucher.create({
          userId,
          voucherId: voucher.id,
          issuedAt: new Date(),
          used: false,
        });

        if (actor) {
          await recordAudit({
            actor,
            action: AUDIT_ACTIONS.VOUCHER_ISSUE,
            targetType: 'UserVoucher',
            targetId: grantedVoucher.id,
            reason: `Tự động tặng voucher [${voucher.code}] khi check-in sự kiện [${event.title}]`,
            changes: { after: sanitizeSnapshot(grantedVoucher) },
            req,
          });
        }
      }
    }
  }

  return {
    id: userEvent.id,
    userId: userEvent.userId,
    userFullName: user.fullName,
    fullName: user.fullName,
    name: user.fullName,
    userEmail: user.email,
    email: user.email,
    userPhone: user.phone,
    phone: user.phone,
    status: userEvent.status,
    registeredAt: userEvent.registeredAt instanceof Date ? userEvent.registeredAt.toISOString() : null,
    grantedVoucherId: grantedVoucher ? grantedVoucher.id : null,
  };
};

module.exports = {
  getAvailableEvents,
  getAllEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  registerEvent,
  getMyEvents,
  getReceptionEvents,
  confirmEventAttendance,
};
