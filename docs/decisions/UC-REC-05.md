# UC-REC-05: Củng cố Hủy và Đổi lịch hẹn (Lễ tân / Admin)

### 1. Vấn đề (Context & Problem Statement)
- Bối cảnh: Khi Lễ tân hoặc Admin thực hiện hủy hoặc đổi lịch hẹn (`PUT /appointments/cancel/:id`, `PUT /appointments/reschedule/:id`), hệ thống cần đảm bảo tính toàn vẹn dữ liệu slot nhúng trong `DoctorShift.slots`, tránh tranh chấp đặt trùng slot (race condition), và hoàn tác (rollback) nếu phát sinh lỗi giữa chừng.
- Trong môi trường triển khai thực tế của hệ thống (standalone MongoDB hoặc replica set chưa cấu hình), `ENABLE_MONGO_TRANSACTIONS` có thể đặt là `false`. Nếu không có cơ chế bồi hoàn (compensation), việc lỗi mạng hoặc lỗi hệ thống sau khi giữ slot mới sẽ làm slot mới bị chiếm dụng vĩnh viễn (rò rỉ slot / orphaned hold).
- Đồng thời, logic giữ chỗ và giải phóng slot cần được trích xuất thành service độc lập để tái sử dụng thống nhất giữa các use case (UC-REC-05, UC-REC-06, UC-PAT-06b) mà không làm vỡ các bài test hiện có.

### 2. Mặc định & Lựa chọn (Decision & Default)
- **Chống lỗi giữa chừng bằng cơ chế bồi hoàn (Compensation Pattern)**:
  + Không phụ thuộc hoàn toàn vào MongoDB multi-document transactions.
  + Trong luồng đổi lịch (`rescheduleAppointmentByStaff`), sau khi giữ slot mới bằng atomic conditional reservation, toàn bộ quá trình tạo `Appointment` mới và chuyển trạng thái lịch cũ sang `RESCHEDULED` được bọc trong khối `try/catch`.
  + Nếu có bất kỳ ngoại lệ nào xảy ra, khối `catch` thực hiện compensation:
    1. Thu hồi slot mới đã giữ, trả về trạng thái `AVAILABLE` (xóa `bookingRef` và `bookedAt`) thông qua `appointmentSlotService.releaseSlot`.
    2. Dọn dẹp bản ghi lịch hẹn mới vừa tạo nếu đã insert vào DB (`Appointment.deleteOne`).
    3. Giữ nguyên lịch hẹn ban đầu ở trạng thái và ca trực cũ.
- **Tách `appointmentSlot.service.js`**:
  + Trích xuất hai hàm nghiệp vụ cốt lõi:
    * `holdSlot({ shiftId, slotId, bookingRef })`: Giữ slot bằng conditional update với `$elemMatch` (`id` và `status: 'AVAILABLE'`). Trả về 409 `SLOT_ALREADY_BOOKED` nếu slot đã có người giữ/đặt.
    * `releaseSlot({ shiftId, slotIds, bookingRef })`: Giải phóng slot về `AVAILABLE`, kèm điều kiện chặt chẽ `bookingRef` phải khớp chính xác với `appointmentNo` (hoặc `tempHoldRef`) của lịch hủy/đổi. Không giải phóng slot của lịch khác.
- **Hủy lịch hẹn**:
  + Bắt buộc `reason` không rỗng (400 `REASON_REQUIRED`).
  + Chỉ hủy lịch chưa ở trạng thái kết thúc (`COMPLETED`, `CANCELLED`, `EXPIRED`, `NO_SHOW`). Lịch `COMPLETED` trả 409 `INVALID_STATE`.
  + Ghi nhận `cancelledBy`, `cancelledAt`, `cancelReason`, và `cancelledByRole`.
  + Miễn trừ giới hạn 24h và không tăng bộ đếm hủy (`cancelledCount`) của Patient khi do Lễ tân/Admin thực hiện.
  + Tự động đánh dấu `refundRequired = true` khi phát hiện `PaymentTransaction` thành công liên kết với lịch hẹn.
  + Ghi Transactional Outbox và Audit Log.

### 3. Lý do (Rationale)
- Việc sử dụng Compensation Pattern đảm bảo tính đúng đắn cả khi `ENABLE_MONGO_TRANSACTIONS=false` lẫn `true`, phù hợp với cả môi trường dev local không có replica set lẫn production cluster.
- Truy vấn conditional update sử dụng `slots: { $elemMatch: { id, status: 'AVAILABLE' } }` đảm bảo vị trí `$` trong MongoDB trỏ chính xác vào phần tử thỏa mãn cả 2 điều kiện, loại bỏ triệt để hiện tượng 2 request song song cùng ghi đè một slot hoặc update nhầm phần tử khác trong mảng.

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- `ENABLE_MONGO_TRANSACTIONS`: Boolean (`true`/`false`, mặc định `true`). Khi đặt `false`, hệ thống hoạt động hoàn toàn bằng atomic document updates và compensation rollback.
- `JWT_SECRET`: Secret key ký và giải mã JSON Web Token để trích xuất `userId` và `userType/role`.
