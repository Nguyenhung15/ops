const ApiError = require('../utils/ApiError');
const { parsePositiveInt } = require('../utils/normalizers');
const { ROLES, AUDIT_ACTIONS } = require('../constants/enums');
const { Specialty, User, Appointment, Image } = require('../models');
const { recordAudit, buildAuditDiff, sanitizeSnapshot } = require('./audit.service');

async function listSpecialties({ onlyActive = false } = {}) {
  const filter = {};
  if (onlyActive) {
    filter.isEnable = true;
  }
  const list = await Specialty.find(filter).sort({ id: 1 });
  return list.map((s) => s.toJSON());
}

async function getSpecialtyById(id) {
  const specId = parsePositiveInt(id, 'specialtyId');
  const spec = await Specialty.findOne({ id: specId });
  if (!spec) {
    throw new ApiError(404, 'Không tìm thấy chuyên khoa');
  }
  return spec;
}

/**
 * Resolve specialty from either `specialtyId` (number) or `specialization` (name string).
 * Required because AdminCreateUser.tsx sends `specialization: sp.name` while UpdateDoctor sends `specialtyId`.
 */
async function resolveSpecialty({ specialtyId, specialization }) {
  if (specialtyId !== undefined && specialtyId !== null && specialtyId !== '' && Number(specialtyId) > 0) {
    const id = parsePositiveInt(specialtyId, 'specialtyId');
    const byId = await Specialty.findOne({ id });
    if (!byId) {
      throw new ApiError(400, `Chuyên khoa với ID #${id} không tồn tại`);
    }
    return byId;
  }

  if (typeof specialization === 'string' && specialization.trim()) {
    const trimmed = specialization.trim();
    const byName = await Specialty.findOne({
      name: { $regex: `^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
    });
    if (!byName) {
      throw new ApiError(400, `Chuyên khoa '${trimmed}' không tồn tại`);
    }
    return byName;
  }

  throw new ApiError(400, 'Bác sĩ bắt buộc phải thuộc một chuyên khoa hợp lệ');
}

async function createSpecialty(actor, payload, req) {
  const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  const description = typeof payload?.description === 'string' ? payload.description.trim() : '';

  if (!name) {
    throw new ApiError(400, 'Tên chuyên khoa không được để trống');
  }
  if (name.length < 2 || name.length > 100) {
    throw new ApiError(400, 'Tên chuyên khoa phải có độ dài từ 2 đến 100 ký tự');
  }

  const existing = await Specialty.findOne({
    name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
  });
  if (existing) {
    throw new ApiError(409, 'Tên chuyên khoa đã tồn tại');
  }

  const isEnable =
    payload?.isEnable !== undefined
      ? Boolean(payload.isEnable)
      : payload?.isEnabled !== undefined
      ? Boolean(payload.isEnabled)
      : true;

  const created = await Specialty.create({
    name,
    description,
    isEnable,
  });

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.SPECIALTY_CREATE,
      targetType: 'Specialty',
      targetId: created.id,
      reason: payload?.reason || 'Tạo chuyên khoa mới',
      changes: { before: null, after: sanitizeSnapshot(created) },
      req,
    });
  }

  return created.toJSON();
}

async function updateSpecialty(actor, id, payload, req) {
  const spec = await getSpecialtyById(id);
  const beforeSnap = sanitizeSnapshot(spec);
  let statusChanged = false;
  let nextStatus = spec.isEnable;

  if (payload?.name !== undefined) {
    const name = String(payload.name).trim();
    if (!name) {
      throw new ApiError(400, 'Tên chuyên khoa không được để trống');
    }
    if (name.length < 2 || name.length > 100) {
      throw new ApiError(400, 'Tên chuyên khoa phải có độ dài từ 2 đến 100 ký tự');
    }
    const conflict = await Specialty.findOne({
      id: { $ne: spec.id },
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
    });
    if (conflict) {
      throw new ApiError(409, 'Tên chuyên khoa đã tồn tại');
    }
    spec.name = name;
  }

  if (payload?.description !== undefined) {
    spec.description = String(payload.description).trim();
  }

  if (payload?.isEnable !== undefined || payload?.isEnabled !== undefined) {
    const rawVal = payload.isEnable !== undefined ? payload.isEnable : payload.isEnabled;
    nextStatus = Boolean(rawVal);
    if (nextStatus !== spec.isEnable) {
      statusChanged = true;
      spec.isEnable = nextStatus;
    }
  }

  await spec.save();

  if (actor) {
    let action = AUDIT_ACTIONS.SPECIALTY_UPDATE;
    if (statusChanged) {
      action = nextStatus ? AUDIT_ACTIONS.SPECIALTY_ENABLE : AUDIT_ACTIONS.SPECIALTY_DISABLE;
    }

    await recordAudit({
      actor,
      action,
      targetType: 'Specialty',
      targetId: spec.id,
      reason:
        payload?.reason ||
        (statusChanged
          ? nextStatus
            ? 'Kích hoạt lại chuyên khoa'
            : 'Vô hiệu hóa chuyên khoa'
          : 'Cập nhật thông tin chuyên khoa'),
      changes: buildAuditDiff(beforeSnap, spec),
      req,
    });
  }

  return spec.toJSON();
}

async function setSpecialtyStatus(actor, id, isEnable, req) {
  return updateSpecialty(actor, id, { isEnable }, req);
}

/**
 * UC-ADM-03: Delete or disable a specialty.
 * Hard constraint: CANNOT delete a specialty currently referenced by doctors or appointments
 * unless a valid `migrateToSpecialtyId` is provided.
 */
async function deleteSpecialty(actor, id, { migrateToSpecialtyId = null, req = null } = {}) {
  const spec = await getSpecialtyById(id);

  // Check references
  const [doctorsCount, appointmentsCount] = await Promise.all([
    User.countDocuments({ specialtyId: spec.id, userType: ROLES.DOCTOR }),
    Appointment.countDocuments({ specialtyId: spec.id }),
  ]);

  const hasReferences = doctorsCount > 0 || appointmentsCount > 0;

  if (hasReferences) {
    if (!migrateToSpecialtyId) {
      throw new ApiError(
        409,
        `Không thể xóa chuyên khoa #${spec.id} ('${spec.name}') vì đang được tham chiếu bởi ` +
          `${doctorsCount} bác sĩ và ${appointmentsCount} lịch hẹn khám. ` +
          `Vui lòng di chuyển (migration) dữ liệu sang chuyên khoa khác hoặc chuyển trạng thái sang vô hiệu hóa (disable).`,
      );
    }

    const targetId = parsePositiveInt(migrateToSpecialtyId, 'migrateToSpecialtyId');
    if (targetId === spec.id) {
      throw new ApiError(400, 'Không thể di chuyển dữ liệu sang chính chuyên khoa đang xóa');
    }

    const targetSpec = await Specialty.findOne({ id: targetId });
    if (!targetSpec) {
      throw new ApiError(404, `Chuyên khoa đích #${targetId} để migration không tồn tại`);
    }
    if (!targetSpec.isEnable) {
      throw new ApiError(400, `Chuyên khoa đích #${targetId} ('${targetSpec.name}') đang bị vô hiệu hóa`);
    }

    // Perform migration
    if (doctorsCount > 0) {
      await User.updateMany(
        { specialtyId: spec.id, userType: ROLES.DOCTOR },
        { $set: { specialtyId: targetSpec.id } },
      );
    }
    if (appointmentsCount > 0) {
      await Appointment.updateMany(
        { specialtyId: spec.id },
        { $set: { specialtyId: targetSpec.id } },
      );
    }
  }

  // Delete specialty
  const beforeSnap = sanitizeSnapshot(spec);

  // Delete any linked specialty image
  if (Image) {
    await Image.deleteMany({ specialtyId: spec.id });
  }

  await Specialty.deleteOne({ id: spec.id });

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.SPECIALTY_DELETE,
      targetType: 'Specialty',
      targetId: spec.id,
      reason: migrateToSpecialtyId
        ? `Xóa chuyên khoa và migrate (${doctorsCount} bác sĩ, ${appointmentsCount} lịch khám) sang #${migrateToSpecialtyId}`
        : 'Xóa chuyên khoa không có liên kết tham chiếu',
      changes: { before: beforeSnap, after: null },
      req,
    });
  }

  return {
    deleted: true,
    id: spec.id,
    name: spec.name,
    migratedTo: migrateToSpecialtyId ? Number(migrateToSpecialtyId) : null,
    message: `Đã xóa chuyên khoa '${spec.name}' thành công`,
  };
}

/**
 * Assign one or multiple doctors to a specialty.
 */
async function assignDoctorsToSpecialty(actor, specialtyId, doctorIds, req) {
  const spec = await getSpecialtyById(specialtyId);
  if (!spec.isEnable) {
    throw new ApiError(400, `Chuyên khoa '${spec.name}' đang bị vô hiệu hóa`);
  }

  const ids = (Array.isArray(doctorIds) ? doctorIds : [doctorIds]).map((id) =>
    parsePositiveInt(id, 'doctorId'),
  );

  if (ids.length === 0) {
    throw new ApiError(400, 'Danh sách bác sĩ không được để trống');
  }

  const doctors = await User.find({ id: { $in: ids }, userType: ROLES.DOCTOR });
  if (doctors.length !== ids.length) {
    const foundIds = new Set(doctors.map((d) => d.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    throw new ApiError(404, `Không tìm thấy bác sĩ với ID: ${missing.join(', ')}`);
  }

  await User.updateMany(
    { id: { $in: ids }, userType: ROLES.DOCTOR },
    { $set: { specialtyId: spec.id } },
  );

  if (actor) {
    await recordAudit({
      actor,
      action: AUDIT_ACTIONS.SPECIALTY_UPDATE,
      targetType: 'Specialty',
      targetId: spec.id,
      reason: `Gắn ${ids.length} bác sĩ (${ids.join(', ')}) vào chuyên khoa '${spec.name}'`,
      changes: { doctorIds: ids },
      req,
    });
  }

  const updatedDoctors = await User.find({ specialtyId: spec.id, userType: ROLES.DOCTOR }).lean();
  return {
    specialty: spec.toJSON(),
    assignedDoctorIds: ids,
    doctors: updatedDoctors.map((d) => ({ id: d.id, fullName: d.fullName, email: d.email })),
  };
}

module.exports = {
  listSpecialties,
  getSpecialtyById,
  resolveSpecialty,
  createSpecialty,
  updateSpecialty,
  setSpecialtyStatus,
  deleteSpecialty,
  assignDoctorsToSpecialty,
};

