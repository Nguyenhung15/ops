# Quyết định Kỹ thuật FIX-3: Tích hợp State Machine cho Doctor Appointment Service & Đánh giá Luồng Hủy Lịch của Patient

### 1. Bối cảnh & Vấn đề (Context & Problem Statement)
- **Bối cảnh vi phạm kiến trúc**:
  + Tại `doctorAppointment.service.js`, các hàm `startAppointment` và `completeAppointment` cập nhật trạng thái lịch hẹn trực tiếp qua Mongoose `Appointment.findOneAndUpdate`.
  + `patientAppointment.service.js` (tại `cancelPatientAppointment`) cập nhật trạng thái `CANCELLED` trực tiếp qua `findOneAndUpdate`.
  + Việc cập nhật trực tiếp vi phạm quy tắc cốt lõi được quy định trong `docs/RULES.md`: **mọi thao tác thay đổi trạng thái lịch hẹn bắt buộc phải đi qua `appointmentStateService.transition`** để đảm bảo tính nhất quán của máy trạng thái (state machine), ghi nhận AuditLog (`auditService.log`) và bắn sự kiện Outbox (`outboxService.recordEvent`).

---

### 2. Quyết định & Hành vi Chuẩn hóa (Decisions & Defaults)

#### a) VIỆC 1: Doctor Start / Complete Khám Bệnh (`src/services/doctorAppointment.service.js`)
1. **Tích hợp `appointmentStateService.transition`**:
   - `startAppointment`:
     - Kiểm tra quyền sở hữu lịch hẹn của bác sĩ thông qua truy vấn `{ id, doctorId: doctor.id }`. Nếu không tìm thấy, ném lỗi 404 `Appointment not found`.
     - Nếu lịch hẹn đã ở trạng thái `IN_PROGRESS`, trả về dữ liệu lịch hẹn hiện tại (đảm bảo tính idempotent).
     - Nếu trạng thái hiện tại khác `CHECKED_IN`, ném lỗi 409 `Only a checked-in appointment can be started`.
     - Gọi `appointmentStateService.transition({ appointmentId: id, fromStatus: 'CHECKED_IN', toStatus: 'IN_PROGRESS', actor, extraFields: { actualStartTime } })`.
   - `completeAppointment`:
     - Kiểm tra quyền sở hữu lịch hẹn `{ id, doctorId: doctor.id }`.
     - Nếu lịch hẹn đã ở trạng thái `COMPLETED`, trả về kết quả hiện tại (idempotent).
     - Nếu khác `IN_PROGRESS`, ném lỗi 409 `Only an in-progress appointment can be completed`.
     - Bắt buộc kiểm tra đã có đơn thuốc trước khi hoàn thành: `await Prescription.exists({ appointmentId: id })`, nếu chưa có ném lỗi 409 `Add at least one prescription before completing this appointment`.
     - Gọi `appointmentStateService.transition({ appointmentId: id, fromStatus: 'IN_PROGRESS', toStatus: 'COMPLETED', actor, extraFields: { actualEndTime } })`.
2. **Bảo toàn Định dạng Dữ liệu (Format Compatibility)**:
   - Giữ nguyên định dạng chuỗi ISO UTC (`clock.toISOString()`, ví dụ `2026-11-02T08:30:00.000Z`) cho `actualStartTime` và `actualEndTime` theo đúng giao ước mà các API lịch sử khám (`GET /appointments/my-completed`) và Frontend đang đọc.
   - Hàm `serialize` kiểm tra an toàn `createdAt.toISOString()` cho cả Mongoose Document và plain JSON object trả về từ `transition`.
3. **AuditLog & Outbox Event**:
   - Quá trình chuyển trạng thái qua `transition` tự động ghi nhận:
     - AuditLog: `targetType: 'Appointment'`, actor chứa thông tin bác sĩ từ JWT (`id`, `userId`, `role: 'DOCTOR'`), thông tin trạng thái trước và sau khi đổi.
     - OutboxEvent: `APPOINTMENT_IN_PROGRESS` và `APPOINTMENT_COMPLETED`.

#### b) VIỆC 2: Đánh giá Luồng Hủy Lịch Khám của Patient (`src/services/patientAppointment.service.js`)
- **Quyết định**: **GIỮ NGUYÊN CODE CŨ TẠI `cancelPatientAppointment`, KHÔNG THAY THẾ BẰNG `transition` TRONG PHIÊN NÀY.**
- **Lý do kỹ thuật chi tiết**:
  1. **Định dạng AuditLog và Outbox chuyên biệt cho UC-PAT-06**:
     - `cancelPatientAppointment` ghi bản ghi `AuditLog` riêng biệt (`action: AUDIT_ACTIONS.APPOINTMENT_CANCEL` với cấu trúc `changes: { previousStatus, newStatus, releasedSlotIds, totalCancellations, bookingLocked, bookingLockedUntil }`). Bộ test `tests/uc-pat-06.test.js` kiểm tra nghiêm ngặt sự tồn tại của các trường đặc thù này trong `changes`.
     - `appointmentStateService.transition` ghi AuditLog với cấu trúc chung chung (`action: APPOINTMENT_STATUS_CHANGE`, `changes: { before: { status }, after: { status } }`), không chứa các trường nghiệp vụ đặc thù của UC-PAT-06.
  2. **Luồng giải phóng Slot khám & Cơ chế Rollback**:
     - `cancelPatientAppointment` thực hiện chuỗi phối hợp nghiệp vụ phức tạp:
       1. Cập nhật trạng thái Appointment sang `CANCELLED`.
       2. Giải phóng slot trong `DoctorShift` qua `arrayFilters` với điều kiện nghiêm ngặt `bookingRef === appointment.appointmentNo`.
       3. Nếu giải phóng slot thất bại, **thực hiện rollback** trạng thái Appointment trở lại `previousStatus` và ném lỗi 500 (`Không thể giải phóng khung giờ khám, thao tác hủy đã được hoàn tác`).
       4. Giải phóng voucher đang giữ (nếu có) qua `voucherRedemptionService.release`.
       5. Đếm số lần hủy lịch và kích hoạt chính sách khóa quyền đặt lịch 24 giờ nếu đạt ngưỡng 3 lần.
     - `appointmentStateService.transition` hiện tại chỉ cập nhật bảng `Appointment` đơn thuần, không hỗ trợ hook tự động giải phóng slot khám lồng trong `DoctorShift` hoặc rollback khi slot release thất bại.
  3. **Rủi ro hồi quy (Regression Risk)**:
     - Thay thế trực tiếp sang `transition` sẽ làm phá vỡ các assertion trong `tests/uc-pat-06.test.js` (17/17 subtests đang pass) và làm thay đổi hành vi xử lý rollback slot khi gặp lỗi.
- **Đề xuất kiến trúc cho giai đoạn sau (Future Proposal)**:
  - Bổ sung hệ thống Lifecycle Hooks hoặc Event Listeners vào `appointmentStateService` (ví dụ `onAfterTransition` / `onTransitionRollback`).
  - Khi đó, các side-effects như `releaseSlot`, `releaseVoucher`, `enforceCancellationLock` có thể được đăng ký thành hook chính thức, cho phép mọi use case hủy lịch đều đi qua `transition` một cách an toàn và nhất quán.

---

### 3. Kết quả Kiểm thử (Test Verification)
1. **Kiểm thử bộ test mới `tests/fix-3-state-machine.test.js`**:
   - `ok 1`: Doctor start lịch từ `CHECKED_IN` thành công, lưu `actualStartTime` dạng chuỗi ISO UTC, tự động ghi AuditLog và OutboxEvent.
   - `ok 2`: Start lịch từ trạng thái không hợp lệ (`CONFIRMED`) bị từ chối HTTP 409 `Only a checked-in appointment can be started`.
   - `ok 3`: Start lịch thuộc về bác sĩ khác bị từ chối HTTP 404 `Appointment not found` (bảo vệ data isolation).
   - `ok 4`: Complete lịch yêu cầu có `Prescription`, chuyển `IN_PROGRESS` sang `COMPLETED`, lưu `actualEndTime` ISO UTC, ghi AuditLog và OutboxEvent.
   - `ok 5`: Tính idempotent khi gọi lại `completeAppointment` trên lịch đã `COMPLETED` trả về HTTP 200 kèm state hiện tại.
   - `ok 6`: Xử lý đồng thời (concurrency): 2 request start song song trên cùng 1 lịch chỉ thực hiện chuyển trạng thái 1 lần, cả 2 đều phản hồi HTTP 200 `IN_PROGRESS`.
2. **Kiểm thử hồi quy các use case liên quan**:
   - `tests/uc-pat-05.test.js`: 14/14 subtests pass 100%.
   - `tests/uc-pat-06.test.js`: 17/17 subtests pass 100%.
   - Toàn bộ 37/37 subtests liên quan chạy tuần tự đạt kết quả PASS tuyệt đối.
