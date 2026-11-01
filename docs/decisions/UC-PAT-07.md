# UC-PAT-07: Patient Vào Khám Online (POST /appointments/:id/join-online)

### 1. Vấn đề (Context & Problem Statement)
- **Bối cảnh:**
  - Bệnh nhân (Patient) đã đặt lịch khám trực tuyến (ONLINE) và lịch đã được xác nhận (CONFIRMED) cần tham gia vào phòng khám online với bác sĩ vào đúng khung giờ khám.
  - Sau khi UC-PAT-10 (Thanh toán trực tuyến VNPay) hoàn tất, hệ thống có thể yêu cầu bệnh nhân phải hoàn tất thanh toán trước khi được phép vào phòng khám trực tuyến.
- **Thách thức và yêu cầu kỹ thuật:**
  1. **Xác thực quyền sở hữu & Bảo mật danh tính:**
     - Endpoint `POST /appointments/:id/join-online` chỉ cho phép vai trò `PATIENT`.
     - Lịch hẹn phải thuộc sở hữu của bệnh nhân trong JWT (`appointment.patientId === actor.userId`). Nếu sai hoặc không tìm thấy lịch hẹn, trả về chung mã lỗi `404 APPOINTMENT_NOT_FOUND` để ngăn chặn tấn công dò quét mã lịch (User Enumeration).
  2. **Kiểm tra loại lịch & Trạng thái State Machine:**
     - Hình thức khám bắt buộc là `ONLINE` (`appointment.type === 'ONLINE'`). Nếu là `OFFLINE`, trả về `409 NOT_ONLINE_APPOINTMENT`.
     - Trạng thái hợp lệ cho lần đầu vào phòng khám là `CONFIRMED`.
     - Cho phép vào lại (re-join) khi lịch hẹn đang ở trạng thái `CHECKED_IN` hoặc `IN_PROGRESS` (ví dụ: bệnh nhân bị rớt mạng hoặc tải lại trang).
     - Các trạng thái khác (`PENDING_PAYMENT`, `CANCELLED`, `COMPLETED`, `EXPIRED`, `NO_SHOW`) đều bị từ chối với mã lỗi `409 INVALID_APPOINTMENT_STATUS`.
  3. **Ràng buộc thanh toán (`ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN`):**
     - Nếu cờ cấu hình `ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN=true`, bắt buộc lịch hẹn phải có bản ghi giao dịch `PaymentTransaction` với `status: 'SUCCESS'`.
     - Nếu chưa thanh toán, trả về `409 PAYMENT_REQUIRED` kèm đường link `paymentUrl` tách riêng để bệnh nhân tiến hành thanh toán.
  4. **Khung giờ tham gia (Join Window) & Múi giờ Clinic:**
     - Khung giờ tham gia mở trong khoảng `[slotStart - JOIN_EARLY_MINUTES, slotEnd + JOIN_LATE_GRACE_MINUTES]`.
     - `slotStart` tính từ `appointment.appointmentDate` và `appointment.appointmentTime` (theo múi giờ `CLINIC_TIMEZONE`, mặc định `Asia/Ho_Chi_Minh`).
     - `slotEnd` lấy từ slot thực tế của lịch trong `DoctorShift.slots`. Nếu ca khám không lưu `endTime` từng slot hoặc slot bị thiếu, sử dụng `slotDurationMinutes` của `DoctorShift` (mặc định 45 phút) để tính `slotEnd = slotStart + slotDurationMinutes`.
     - Vào quá sớm -> `409 JOIN_TOO_EARLY` kèm `availableFrom`.
     - Vào quá muộn -> `409 JOIN_WINDOW_CLOSED`.
  5. **Meeting Code & Token bảo mật:**
     - Trả về `meetingUrl` và `joinToken` ngắn hạn được ký bằng bí mật riêng `JOIN_TOKEN_SECRET` (tuyệt đối không dùng chung `JWT_SECRET` của access token).
     - Payload của `joinToken`: `{ appointmentId, appointmentNo, userId, role }`.
     - Thời hạn hết hạn (`exp`) của token không được vượt quá thời điểm kết thúc cửa sổ tham gia (`windowEnd`).
     - Nếu hệ thống thiếu `JOIN_TOKEN_SECRET`, trả về lỗi cấu hình máy chủ `500 MISSING_JOIN_TOKEN_SECRET`, không dùng giá trị mặc định dễ đoán.
     - Meeting code được tạo ngẫu nhiên bằng `crypto.randomBytes(6).toString('hex').toUpperCase()` và cập nhật nguyên tử bằng conditional update để đảm bảo hai request song song sinh cùng một mã meeting.
  6. **Audit & Quyền riêng tư:**
     - Ghi Audit Log với action `JOIN_ONLINE`.
     - Tuyệt đối không lưu/log `joinToken` hay `JOIN_TOKEN_SECRET` vào database log. Response không trả về thông tin PII thừa.

### 2. Mặc định & Lựa chọn (Decision & Default)
- **Thời lượng slot khám (Slot Duration Fallback):**
  - Mặc định tìm slot tương ứng trong mảng `DoctorShift.slots` theo `slot.id` hoặc `slot.bookingRef === appointment.appointmentNo`.
  - Nếu không tìm thấy slot trong ca khám hoặc slot không có `endTime`, fallback sử dụng `shift.slotDurationMinutes` (mặc định 45 phút).
- **Tính ổn định của meetingCode:**
  - Sử dụng conditional update `{ id: appointment.id, $or: [{ 'meeting.code': null }, { meeting: null }] }` kết hợp `returnDocument: 'after'` để đảm bảo tính idempotent và đồng nhất khi gọi song song.
- **Tách biệt Route & Controller:**
  - Tạo mới `controllers/onlineConsultation.controller.js` và `services/onlineConsultation.service.js`.
  - Mount qua `routes/features/onlineConsultation.routes.js` với `basePath: '/appointments'`, không chỉnh sửa file gốc `routes/patientAppointment.routes.js`.

### 3. Lý do (Rationale)
- Việc sử dụng `JOIN_TOKEN_SECRET` riêng biệt giúp cách ly hoàn toàn chữ ký của phiên phòng họp khám từ xa với token xác thực tài khoản đăng nhập (Access Token). Nếu một token phòng họp bị rò rỉ, kẻ tấn công cũng không thể giả mạo danh tính để truy cập các API cốt lõi khác của hệ thống.
- Cửa sổ thời gian linh hoạt trước và sau slot khám (`JOIN_EARLY_MINUTES` và `JOIN_LATE_GRACE_MINUTES`) giúp bệnh nhân có thời gian chuẩn bị thiết bị (camera, mic) và xử lý sự cố mạng mà không bị khóa phòng đột ngột.

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- `JOIN_TOKEN_SECRET`: Khóa bí mật riêng dùng để ký `joinToken` cho phòng khám trực tuyến (bắt buộc cấu hình).
- `ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN`: Cờ kiểm tra giao dịch thanh toán thành công trước khi vào phòng khám (mặc định `true`).
- `JOIN_EARLY_MINUTES`: Số phút cho phép vào trước ca khám (mặc định 15 phút).
- `JOIN_LATE_GRACE_MINUTES`: Số phút ân hạn cho phép vào sau giờ kết thúc ca (mặc định 15 phút).
- `CLINIC_TIMEZONE`: Múi giờ chuẩn của phòng khám (mặc định `Asia/Ho_Chi_Minh`).
