# UC-REC-06: Củng cố Lễ tân duyệt yêu cầu hủy ca của Bác sĩ

### 1. Vấn đề (Context & Problem Statement)
- Bối cảnh: Khi Bác sĩ có việc đột xuất, họ gửi yêu cầu hủy ca khám (`POST /shifts/:shiftId/cancellation-requests`). Lễ tân hoặc Admin xem danh sách yêu cầu chờ duyệt (`GET /shifts/cancellation-requests/pending`) và tiến hành Duyệt (`PUT /shifts/cancellation-requests/:id/approve`) hoặc Từ chối (`PUT /shifts/cancellation-requests/:id/reject`).
- Thách thức:
  1. Ca trực có thể đang có các lịch hẹn hoạt động của bệnh nhân (`PENDING_PAYMENT`, `PENDING_CONFIRMATION`, `CONFIRMED`, `CHECKED_IN`). Cần có chính sách xử lý rõ ràng: chặn duyệt cho đến khi xử lý xong các booking (`BLOCK_UNTIL_RESOLVED`) hoặc tự động hủy các lịch bị ảnh hưởng (`AUTO_CANCEL_AFFECTED`).
  2. Khi tự động hủy trong `AUTO_CANCEL_AFFECTED`, hệ thống KHÔNG được ghi đè status tùy tiện mà phải tuân thủ chuẩn nghiệp vụ của UC-REC-05: chuyển trạng thái qua `appointmentStateService.transition`, giải phóng slot, phát hiện thanh toán thành công để đánh dấu `refundRequired = true`, ghi outbox và audit log cho từng bệnh nhân.
  3. Khi hủy ca, toàn bộ ca trực và các slot chưa đặt (`AVAILABLE`) phải chuyển thành `CANCELLED`. Các slot đã được đặt tuyệt đối không bị hủy nhầm.
  4. Tránh tình trạng tranh chấp duyệt song song (concurrency) và đảm bảo tính idempotent khi duyệt/từ chối lặp lại.

### 2. Mặc định & Lựa chọn (Decision & Default)
- **Chính sách hủy ca (`SHIFT_CANCEL_POLICY`)**:
  + Mặc định: `BLOCK_UNTIL_RESOLVED`. Nếu ca trực còn lịch hẹn hoạt động, hệ thống từ chối duyệt với mã lỗi HTTP 409 `SHIFT_HAS_ACTIVE_BOOKINGS`, trả về danh sách lịch hẹn chi tiết và **giữ nguyên 100% trạng thái của request (PENDING) cũng như ca trực (ACTIVE)**.
  + Chế độ `AUTO_CANCEL_AFFECTED`: Duyệt hủy ca và tự động hủy từng lịch hẹn hoạt động thông qua `cancelAppointmentByStaff` (sử dụng `appointmentStateService.transition`, bồi hoàn slot qua `appointmentSlotService.releaseSlot`, đánh dấu `refundRequired` nếu đã thanh toán, phát Outbox thông báo bệnh nhân).
- **Conditional Update & Idempotency**:
  + Thao tác Approve/Reject chỉ thực hiện khi trạng thái yêu cầu là `PENDING` thông qua `findOneAndUpdate({ status: 'PENDING' }, ..., { returnDocument: 'after' })`.
  + Ghi nhận `approvedBy`/`rejectedBy` lấy từ JWT của nhân viên thực hiện, `approvedAt`/`rejectedAt`, và `decisionNote`.
  + Reject BẮT BUỘC có note (`cleanNote.length > 0`), nếu thiếu trả 400 `REJECTION_NOTE_REQUIRED`.
  + Nếu yêu cầu đã ở trạng thái mục tiêu (`APPROVED` hoặc `REJECTED`), hệ thống trả về HTTP 200 kèm trạng thái hiện tại (idempotent), không thay đổi người duyệt và thời gian duyệt ban đầu.
- **Hủy ca và slot**:
  + Ca trực chuyển thành `status: 'CANCELLED'`.
  + Các slot trống trong ca (`slots.status === 'AVAILABLE'`) chuyển thành `CANCELLED` bằng conditional update với `arrayFilters: [{ 'elem.status': 'AVAILABLE' }]`. Các slot đã `BOOKED` không bị can thiệp.
- **Phân quyền & Tạo yêu cầu**:
  + Doctor tạo request: `doctorId` luôn lấy từ JWT (`actor.userId`), không nhận từ body hay query. Bác sĩ chỉ được tạo yêu cầu cho ca của chính mình (`shift.doctorId === actor.userId`), cố tình tạo cho bác sĩ khác bị từ chối 403 `DOCTOR_MISMATCH`.
  + Chống trùng lặp bằng unique partial index `one_pending_cancellation_per_doctor_shift` trên `(doctorId, shiftId)` khi `status: 'PENDING'`.
  + Phân quyền route: Toàn bộ route duyệt/từ chối/danh sách pending yêu cầu role `RECEPTIONIST` hoặc `ADMIN`. Bệnh nhân gọi bị chặn 403.

### 3. Lý do (Rationale)
- Việc tái sử dụng `cancelAppointmentByStaff` (UC-REC-05) thay vì cập nhật trực tiếp `Appointment.updateMany` đảm bảo toàn bộ quy trình state transition, auditing, kiểm tra hoàn tiền (`refundRequired`), và outbox notification cho từng bệnh nhân diễn ra nhất quán và an toàn.
- `arrayFilters: [{ 'elem.status': 'AVAILABLE' }]` đảm bảo tính nguyên tử (atomic) khi cập nhật slot trong MongoDB Document mà không ảnh hưởng tới các slot đã đặt của các cuộc hẹn.

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- `SHIFT_CANCEL_POLICY`: Chuỗi (`BLOCK_UNTIL_RESOLVED` hoặc `AUTO_CANCEL_AFFECTED`, mặc định: `BLOCK_UNTIL_RESOLVED`).
- `ENABLE_MONGO_TRANSACTIONS`: Boolean (`true`/`false`). Hệ thống hoạt động an toàn kể cả khi không bật replica set transaction.
