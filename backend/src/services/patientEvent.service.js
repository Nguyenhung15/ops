const { Event, EventRegistration, Voucher } = require('../models');
const { ROLES, AUDIT_ACTIONS } = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const auditService = require('./audit.service');
const outboxService = require('./outbox.service');
const { clock } = require('./clock.service');

/**
 * UC-PAT-08: Lấy danh sách sự kiện đang mở (Available Events)
 * GET /events
 * Endpoint public / dành cho mọi người, hoặc patient
 */
async function getAvailableEvents(user = null) {
  const now = clock.now();

  const filter = {
    isEnabled: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  };

  const events = await Event.find(filter).sort({ startDate: 1 }).lean();

  // If user is authenticated, query user's registrations to attach registrationStatus
  let registeredEventMap = new Map();
  if (user && user.id) {
    const registrations = await EventRegistration.find({
      userId: user.id,
      eventId: { $in: events.map((e) => e.id) },
    }).lean();

    for (const reg of registrations) {
      registeredEventMap.set(reg.eventId, reg.status);
    }
  }

  // Fetch voucher details for events with voucherId
  const voucherIds = events.map((e) => e.voucherId).filter((id) => Number.isSafeInteger(id) && id > 0);
  const vouchers = voucherIds.length > 0
    ? await Voucher.find({ id: { $in: voucherIds } }).lean()
    : [];
  const voucherMap = new Map(vouchers.map((v) => [v.id, v]));

  return events.map((ev) => {
    const v = ev.voucherId ? voucherMap.get(ev.voucherId) : null;
    return {
      id: ev.id,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      startDate: ev.startDate ? ev.startDate.toISOString() : null,
      endDate: ev.endDate ? ev.endDate.toISOString() : null,
      isEnabled: Boolean(ev.isEnabled),
      enabled: Boolean(ev.isEnabled),
      voucherId: ev.voucherId || null,
      voucherCode: v?.code || null,
      voucherName: v?.name || null,
      capacity: ev.capacity ?? null,
      registeredCount: ev.registeredCount || 0,
      registrationStatus: registeredEventMap.get(ev.id) || undefined,
    };
  });
}

/**
 * UC-PAT-08: Bệnh nhân đăng ký tham gia sự kiện
 * POST /events/:eventId/register
 * Role: PATIENT (userId từ JWT)
 */
async function registerEvent(actor, eventId, req = null) {
  if (!actor || (actor.role !== ROLES.PATIENT && actor.userType !== ROLES.PATIENT)) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền đăng ký sự kiện', 'FORBIDDEN_ROLE');
  }

  const numUserId = Number(actor.id || actor.userId);
  if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
    throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
  }

  const numEventId = Number(eventId);
  if (!Number.isSafeInteger(numEventId) || numEventId <= 0) {
    throw new ApiError(400, 'Định danh sự kiện không hợp lệ', 'INVALID_EVENT_ID');
  }

  const event = await Event.findOne({ id: numEventId });
  if (!event) {
    throw new ApiError(404, 'Không tìm thấy sự kiện', 'EVENT_NOT_FOUND');
  }

  const now = clock.now();

  // Kiểm tra sự kiện đang mở (isEnabled = true, startDate <= now <= endDate)
  if (!event.isEnabled || (event.startDate && event.startDate > now) || (event.endDate && event.endDate < now)) {
    throw new ApiError(409, 'Sự kiện đã kết thúc hoặc tạm đóng đăng ký', 'EVENT_CLOSED');
  }

  // Kiểm tra đã đăng ký trước đó chưa (bảo vệ sớm tầng logic)
  const existingRegistration = await EventRegistration.findOne({
    eventId: numEventId,
    userId: numUserId,
  }).lean();

  if (existingRegistration) {
    throw new ApiError(409, 'Bạn đã đăng ký sự kiện này trước đó', 'ALREADY_REGISTERED');
  }

  // Giữ chỗ nếu sự kiện có giới hạn capacity
  let capacityReserved = false;
  if (event.capacity !== null && event.capacity !== undefined) {
    const updatedEvent = await Event.findOneAndUpdate(
      {
        id: numEventId,
        registeredCount: { $lt: event.capacity },
      },
      {
        $inc: { registeredCount: 1 },
      },
      { returnDocument: 'after' },
    );

    if (!updatedEvent) {
      throw new ApiError(409, 'Sự kiện đã hết số lượng đăng ký', 'EVENT_FULL');
    }
    capacityReserved = true;
  } else {
    // Không giới hạn capacity, vẫn tăng registeredCount để theo dõi
    await Event.updateOne({ id: numEventId }, { $inc: { registeredCount: 1 } });
    capacityReserved = true;
  }

  let registration;
  try {
    registration = await EventRegistration.create({
      eventId: numEventId,
      userId: numUserId,
      status: 'PENDING',
      registeredAt: now,
    });
  } catch (error) {
    // Hoàn tác capacity nếu lưu registration thất bại
    if (capacityReserved) {
      await Event.updateOne(
        { id: numEventId, registeredCount: { $gt: 0 } },
        { $inc: { registeredCount: -1 } },
      );
    }

    // Bắt lỗi trùng lặp từ unique index (E11000)
    if (error.code === 11000 || error.name === 'MongoServerError') {
      throw new ApiError(409, 'Bạn đã đăng ký sự kiện này trước đó', 'ALREADY_REGISTERED');
    }
    throw error;
  }

  // Ghi Transactional Outbox thông báo đăng ký sự kiện thành công
  try {
    await outboxService.recordEvent({
      eventType: 'EVENT_REGISTRATION_CREATED',
      channel: 'ALL',
      payload: {
        registrationId: registration.id,
        eventId: numEventId,
        userId: numUserId,
        eventTitle: event.title,
        registeredAt: now.toISOString(),
      },
    });
  } catch (outboxErr) {
    console.warn(`[Outbox] Failed to record event registration event: ${outboxErr.message}`);
  }

  // Ghi Audit Log REGISTER_EVENT
  await auditService.log({
    actor: {
      userId: numUserId,
      role: actor.role || actor.userType,
      email: actor.email,
    },
    action: AUDIT_ACTIONS.REGISTER_EVENT,
    resource: {
      type: 'EventRegistration',
      id: registration.id,
    },
    reason: `Bệnh nhân #${numUserId} đăng ký sự kiện #${numEventId} (${event.title})`,
    changes: {
      eventId: numEventId,
      userId: numUserId,
      status: 'PENDING',
      registeredAt: now.toISOString(),
    },
    req,
  });

  return {
    id: registration.id,
    userEventId: registration.id,
    eventId: registration.eventId,
    userId: registration.userId,
    status: registration.status,
    registeredAt: registration.registeredAt.toISOString(),
    title: event.title,
    eventName: event.title,
  };
}

/**
 * UC-PAT-08: Bệnh nhân xem danh sách sự kiện đã đăng ký
 * GET /events/my
 * Role: PATIENT (userId từ JWT)
 */
async function getMyEvents(actor, query = {}) {
  if (!actor || (actor.role !== ROLES.PATIENT && actor.userType !== ROLES.PATIENT)) {
    throw new ApiError(403, 'Chỉ bệnh nhân mới có quyền xem sự kiện đã đăng ký', 'FORBIDDEN_ROLE');
  }

  const numUserId = Number(actor.id || actor.userId);
  if (!Number.isSafeInteger(numUserId) || numUserId <= 0) {
    throw new ApiError(401, 'Thông tin người dùng không hợp lệ', 'INVALID_USER_ID');
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
  const skip = (page - 1) * limit;

  const [registrations, total] = await Promise.all([
    EventRegistration.find({ userId: numUserId })
      .sort({ registeredAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    EventRegistration.countDocuments({ userId: numUserId }),
  ]);

  const eventIds = [...new Set(registrations.map((r) => r.eventId))];
  const events = eventIds.length > 0
    ? await Event.find({ id: { $in: eventIds } }).lean()
    : [];
  const eventMap = new Map(events.map((e) => [e.id, e]));

  const formattedItems = registrations.map((r) => {
    const ev = eventMap.get(r.eventId);
    return {
      id: r.id,
      userEventId: r.id,
      eventId: r.eventId,
      title: ev?.title || '',
      eventName: ev?.title || '',
      description: ev?.description || null,
      eventDescription: ev?.description || null,
      location: ev?.location || null,
      eventLocation: ev?.location || null,
      startDate: ev?.startDate ? ev.startDate.toISOString() : null,
      eventStart: ev?.startDate ? ev.startDate.toISOString() : null,
      endDate: ev?.endDate ? ev.endDate.toISOString() : null,
      eventEnd: ev?.endDate ? ev.endDate.toISOString() : null,
      status: r.status,
      registeredAt: r.registeredAt ? r.registeredAt.toISOString() : null,
      confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
      voucherId: ev?.voucherId || null,
    };
  });

  return {
    items: formattedItems,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

module.exports = {
  getAvailableEvents,
  registerEvent,
  getMyEvents,
};
