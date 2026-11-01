# ÁNH XẠ TRƯỜNG DỮ LIỆU: ĐẶC TẢ VS CSDL THỰC TẾ (FIELD MAP)

> **Tài liệu tham chiếu:** Phục vụ các use case UC-PAT-07..12 và chuẩn hóa giao tiếp giữa tầng Đặc tả (Specification / PRD) và CSDL MongoDB / MySQL Dump thực tế.

---

## 1. Bảng Appointment (`appointments`)

| Tên theo Đặc tả (Specification) | Tên field thật trong Code / Model | Kiểu dữ liệu | Chú thích / Mapping |
| :--- | :--- | :--- | :--- |
| `id` / `appointmentId` | `id` (hoặc `_id`) | `Number` (MySQL ID) / `ObjectId` | Chuẩn hóa string khi so khớp trong Service |
| `bookingRef` / `appointmentCode` | `appointmentNo` | `String` (Unique) | Ví dụ: `OFF60E56958`, `ONL...` |
| `patient` / `patientId` | `patientId` | `Number` | Tham chiếu User (`id` của Patient) |
| `doctor` / `doctorId` | `doctorId` | `Number` | Tham chiếu Doctor/User |
| `specialty` / `specialtyId` | `specialtyId` | `Number` | Chuyên khoa |
| `shift` / `shiftId` | `shiftId` | `Number` | ID ca khám của bác sĩ (`DoctorShift`) |
| `slot` / `slotId` / `slotIds` | `slotIds` | `[Number]` | Danh sách slot ID (Dump MySQL cũ là `slot_id`) |
| `appointmentDate` | `appointmentDate` | `String` (`YYYY-MM-DD`) | Theo múi giờ `CLINIC_TIMEZONE` |
| `appointmentTime` | `appointmentTime` | `String` (`HH:mm`) | Giờ bắt đầu slot khám |
| `actualStartTime` | `actualStartTime` | `String` / `null` | Giờ bác sĩ bấm khám |
| `actualEndTime` | `actualEndTime` | `String` / `null` | Giờ kết thúc |
| `type` | `type` | `String` (`'OFFLINE'` / `'ONLINE'`) | Hình thức khám |
| `status` | `status` | `String` (Enum) | `PENDING_PAYMENT`, `PENDING_CONFIRMATION`, `CONFIRMED`, `CHECKED_IN`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `RESCHEDULED`, `EXPIRED`, `NO_SHOW` |
| `paymentStatus` | `paymentStatus` | `String` / `null` | Trạng thái thanh toán (`PAYMENT_STATUSES`) |
| `refundRequired` | `refundRequired` | `Boolean` (default `false`) | Đánh dấu cần hoàn tiền nếu đã thanh toán mà hủy |
| `meeting` | `meeting` | `Object` `{ url, code, createdAt }` | Thông tin phòng họp khám online (cũ là `meetingUrl`, `joinCode`) |
| `confirmedBy` | `confirmedBy` | `Mixed` (`Number`/`String`) | ID nhân viên xác nhận lịch |
| `confirmedAt` | `confirmedAt` | `Date` (UTC) | Thời điểm xác nhận |
| `checkedInBy` | `checkedInBy` | `Mixed` (`Number`/`String`) | ID nhân viên check-in |
| `checkedInAt` | `checkedInAt` | `Date` (UTC) | Thời điểm check-in |
| `cancelledBy` | `cancelledBy` | `Mixed` | ID người hủy lịch |
| `cancelledAt` | `cancelledAt` | `Date` | Thời điểm hủy |
| `cancelReason` | `cancelReason` | `String` | Lý do hủy |
| `patients` (người khám phụ thuộc) | `patients` | `[Object]` snapshot | Mảng `{ id, fullName, gender, phoneNumber, dob, relationship }` |

---

## 2. Bảng Doctor Shift & Slot (`doctor_shifts`)

| Tên theo Đặc tả | Tên field thật trong Code | Kiểu dữ liệu | Chú thích |
| :--- | :--- | :--- | :--- |
| `shiftId` | `id` | `Number` | ID ca làm việc |
| `doctorId` | `doctorId` | `Number` | ID bác sĩ trực ca |
| `date` / `shiftDate` | `date` | `String` (`YYYY-MM-DD`) | Ngày trực |
| `shiftType` | `shift` | `String` | `'MORNING'`, `'AFTERNOON'`, `'EVENING'` |
| `startTime` / `endTime` | `startTime` / `endTime` | `String` (`HH:mm`) | Khung giờ toàn ca |
| `status` | `status` | `String` | `'ACTIVE'`, `'CANCELLED'`, `'GROUP_BLOCKED'` |
| `slots` | `slots` | `[Object]` | Mảng slot lồng trong document |
| `slot.id` | `slots[i].id` | `Number` | ID từng slot khám |
| `slot.slotNumber` | `slots[i].slotNumber` | `Number` | Số thứ tự slot trong ca (1, 2, 3...) |
| `slot.startTime` / `endTime` | `slots[i].startTime` / `endTime` | `String` (`HH:mm`) | Khung giờ của slot |
| `slot.status` | `slots[i].status` | `String` | `'AVAILABLE'`, `'BOOKED'`, `'CANCELLED'`, `'COMPLETED'` |
| `slot.bookingRef` | `slots[i].bookingRef` | `String` / `null` | Lưu `appointmentNo` đang giữ slot này |

---

## 3. Bảng Event & Event Registration (`events`, `event_registrations`)

| Tên theo Đặc tả | Tên field thật trong Code | Kiểu dữ liệu | Chú thích |
| :--- | :--- | :--- | :--- |
| `eventId` | `id` | `Number` | ID sự kiện |
| `title` | `title` | `String` | Tên sự kiện |
| `description` | `description` | `String` | Mô tả |
| `location` | `location` | `String` | Địa điểm |
| `startDate` / `endDate` | `startDate` / `endDate` | `Date` | Thời gian diễn ra sự kiện |
| `isEnabled` / `enabled` | `isEnabled` | `Boolean` (default `true`) | Trạng thái mở/đóng sự kiện |
| `capacity` | `capacity` | `Number` / `null` | Sức chứa tối đa (null = không giới hạn) |
| `registeredCount` | `registeredCount` | `Number` (default `0`) | Số người đã đăng ký |
| `voucherId` | `voucherId` | `Number` | Voucher liên kết cấp khi tham dự |
| `registrationId` / `userEventId`| `id` (trong `EventRegistration`) | `Number` | ID đăng ký sự kiện |
| `registration.status` | `status` | `String` | `'PENDING'`, `'CONFIRMED'`, `'CANCELLED'` |
| `registeredAt` | `registeredAt` | `Date` | Thời điểm đăng ký |
| `confirmedBy` / `confirmedAt` | `confirmedBy` / `confirmedAt` | `Mixed` / `Date` | Lễ tân duyệt tham dự |

---

## 4. Bảng Voucher & User Voucher (`vouchers`, `user_vouchers`)

| Tên theo Đặc tả | Tên field thật trong Code | Kiểu dữ liệu | Chú thích |
| :--- | :--- | :--- | :--- |
| `voucherId` | `id` | `Number` | ID Voucher |
| `code` | `code` | `String` (Unique) | Mã voucher (ví dụ: `WOMANDAY2026`) |
| `name` | `name` | `String` | Tên voucher |
| `discountValue` | `discountValue` | `Number` | Giá trị giảm |
| `discountType` | `discountType` | `String` | `'AMOUNT'` hoặc `'PERCENT'` (default `'AMOUNT'`) |
| `type` | `type` | `String` | `'SERVICE_TICKET'` hoặc `'DISCOUNT'` |
| `enable` | `enable` | `Boolean` | Còn hiệu lực hay không |
| `expiryDate` | `expiryDate` | `Date` | Ngày hết hạn |
| `userVoucherId` | `id` (trong `UserVoucher`) | `Number` | ID bản ghi ví voucher của user |
| `userId` | `userId` | `Number` | User sở hữu voucher |
| `used` | `used` | `Boolean` (default `false`) | Đã sử dụng hay chưa |
| `usedAt` | `usedAt` | `Date` / `null` | Thời điểm sử dụng |
| `appointmentId` | `appointmentId` | `Number` / `null` | Lịch hẹn áp dụng voucher |

---

## 5. Bảng Payment Transaction (`payment_transactions`)

| Tên theo Đặc tả | Tên field thật trong Code | Kiểu dữ liệu | Chú thích |
| :--- | :--- | :--- | :--- |
| `transactionId` | `id` | `Number` | ID giao dịch |
| `appointmentId` | `appointmentId` | `Number` (Indexed) | Lịch khám thanh toán |
| `userId` | `userId` | `Number` / `null` | Người thanh toán |
| `transactionNo` | `transactionNo` | `String` (Unique) | Mã giao dịch ngân hàng / VNPay |
| `amount` | `amount` | `Number` / `String` | Số tiền thanh toán (nguyên) |
| `discountAmount` | `discountAmount` | `Number` / `null` | Số tiền giảm trừ nếu có voucher |
| `userVoucherId` | `userVoucherId` | `Number` / `null` | Voucher đã áp dụng |
| `status` | `status` | `String` (`PAYMENT_STATUSES`) | `PENDING`, `SUCCESS`, `FAILED`, `EXPIRED` |
| `bankCode` | `bankCode` | `String` | Mã ngân hàng (`NCB`, `VCB`...) |
| `responseCode` | `responseCode` | `String` | Mã phản hồi gateway (`00` = success) |
| `payDate` | `payDate` | `Date` | Thời điểm thanh toán |
| `expiresAt` | `expiresAt` | `Date` / `null` | Hết hạn giữ chỗ thanh toán |
| `orderInfo` | `orderInfo` | `String` | Nội dung giao dịch |

---

## 6. Bảng Prescription (`prescriptions`)

| Tên theo Đặc tả | Tên field thật trong Code | Kiểu dữ liệu | Chú thích |
| :--- | :--- | :--- | :--- |
| `prescriptionId` | `id` | `Number` | ID đơn thuốc |
| `appointmentId` | `appointmentId` | `Number` (Indexed) | Lịch hẹn tương ứng |
| `medicineName` | `medicineName` | `String` | Tên thuốc |
| `dosage` | `dosage` | `String` | Liều lượng |
| `duration` | `duration` | `String` | Thời gian uống |
| `instructions` | `instructions` | `String` | Hướng dẫn sử dụng |
| `version` | `version` | `Number` (default `1`) | Phiên bản đơn thuốc |

---

## 7. Bảng Feedback (`feedbacks`)

| Tên theo Đặc tả | Tên field thật trong Code | Kiểu dữ liệu | Chú thích |
| :--- | :--- | :--- | :--- |
| `feedbackId` | `id` | `Number` | ID đánh giá |
| `userId` | `userId` | `Number` (Indexed) | Bệnh nhân đánh giá |
| `appointmentId` | `appointmentId` | `Number` (Indexed) | Lịch khám được đánh giá |
| `doctorId` | `doctorId` | `Number` / `null` | Bác sĩ được đánh giá |
| `rating` | `rating` | `Number` (1..5) | Điểm số nguyên |
| `comment` | `comment` | `String` (<= 1000 ký tự) | Nội dung phản hồi |
| `status` | `status` | `String` (`FEEDBACK_STATUSES`) | `PENDING`, `PUBLISHED`, `HIDDEN` (mặc định `PENDING`) |
| `title` | `title` | `String` / `null` | Tiêu đề đánh giá |
| `category` | `category` | `String` / `null` | Phân loại |
| `isAnonymous` | `isAnonymous` | `Boolean` (default `false`) | Đánh giá ẩn danh |
| `deletedAt` | `deletedAt` | `Date` / `null` | Xóa mềm |
