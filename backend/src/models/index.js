const { Counter, getNextSequence, syncSequenceFloor } = require('./counter.model');
const User = require('./user.model');
const AuditLog = require('./auditLog.model');
const Specialty = require('./specialty.model');
const Image = require('./image.model');
const DoctorShift = require('./doctorShift.model');
const Appointment = require('./appointment.model');
const Prescription = require('./prescription.model');
const PaymentTransaction = require('./paymentTransaction.model');
const GroupHealthRequest = require('./GroupHealthRequest');
const GroupHealthAssignment = require('./GroupHealthAssignment');
const ShiftCancellationRequest = require('./ShiftCancellationRequest');
const RssSource = require('./rssSource.model');
const News = require('./news.model');
const BootstrapState = require('./bootstrapState.model');
const PatientProfile = require('./patientProfile.model');
const OutboxEvent = require('./outboxEvent.model');
const Event = require('./event.model');
const EventRegistration = require('./eventRegistration.model');
const { Voucher, UserVoucher } = require('./voucher.model');
const Feedback = require('./feedback.model');

module.exports = {
  Counter,
  getNextSequence,
  syncSequenceFloor,
  User,
  AuditLog,
  Specialty,
  Image,
  DoctorShift,
  Appointment,
  Prescription,
  PaymentTransaction,
  GroupHealthRequest,
  GroupHealthAssignment,
  ShiftCancellationRequest,
  RssSource,
  News,
  BootstrapState,
  PatientProfile,
  OutboxEvent,
  Event,
  EventRegistration,
  Voucher,
  UserVoucher,
  Feedback,
};

