# UC-PAT-08: Patient Đăng Ký Tham Gia Sự Kiện (/events)

### 1. Vấn đề (Context & Problem Statement)
- Bối cảnh: Bệnh nhân (Patient) có nhu cầu tìm hiểu các sự kiện sức khỏe, hội thảo y khoa của phòng khám và đăng ký tham gia (`POST /events/:eventId/register`, `GET /events`, `GET /events/my`).
- Rủi ro kỹ thuật:
  1. Tranh chấp đăng ký vượt quá số lượng tối đa (`capacity`): Nhiều bệnh nhân đồng thời đăng ký sự kiện còn ít chỗ có thể làm vượt quá sức chứa cho phép nếu không có conditional atomic update.
  2. Đăng ký trùng lặp: Cùng một bệnh nhân gửi 2 request cùng lúc hoặc bấm nhiều lần có thể tạo nhiều bản ghi nếu chỉ kiểm tra ở tầng ứng dụng mà thiếu bảo vệ ở tầng cơ sở dữ liệu.
  3. Lộ dữ liệu cá nhân: Endpoint lấy danh sách sự kiện đã đăng ký (`GET /events/my`) phải nghiêm ngặt lọc theo `userId` từ JWT, tuyệt đối không được lộ bản ghi đăng ký của người dùng khác.
  4. Đăng ký sự kiện đã quá hạn, chưa mở hoặc bị vô hiệu hóa (`isEnabled = false`).

### 2. Mặc định & Lựa chọn (Decision & Default)
- **Đăng ký sự kiện (`POST /events/:eventId/register`)**:
  + Bắt buộc vai trò `PATIENT`. `userId` được trích xuất an toàn từ JWT (`req.user.id`).
  + Kiểm tra sự kiện tồn tại (`404 EVENT_NOT_FOUND`).
  + Kiểm tra sự kiện đang mở theo `clock.service` (`409 EVENT_CLOSED` nếu `isEnabled = false`, `startDate > now`, hoặc `endDate < now`).
  + Kiểm tra trùng lặp:
    * Kiểm tra trước bằng query `EventRegistration.findOne({ eventId, userId })` (`409 ALREADY_REGISTERED`).
    * Bảo vệ tầng DB bằng unique index `{ eventId: 1, userId: 1 }`, bắt mã lỗi `11000` (E11000 duplicate key error) và chuyển đổi thành `409 ALREADY_REGISTERED`.
  + Kiểm soát sức chứa (`capacity`):
    * Sử dụng atomic conditional update: `Event.findOneAndUpdate({ id: numEventId, registeredCount: { $lt: event.capacity } }, { $inc: { registeredCount: 1 } }, { returnDocument: 'after' })`.
    * Nếu không tìm thấy document thỏa điều kiện -> `409 EVENT_FULL`.
    * Nếu lưu `EventRegistration` thất bại, thực hiện compensation rollback: giảm `$inc: { registeredCount: -1 }`.
  + Tạo bản ghi `EventRegistration` với trạng thái `PENDING` và `registeredAt = now`.
  + Ghi Transactional Outbox event (`EVENT_REGISTRATION_CREATED`).
  + Ghi Audit Log với action `REGISTER_EVENT`.
- **Xem danh sách sự kiện cá nhân (`GET /events/my`)**:
  + Chỉ truy vấn các đăng ký có `userId` khớp với JWT của người dùng gọi.
  + Phân trang (`page`, `limit`), sắp xếp giảm dần theo thời gian đăng ký (`registeredAt: -1`).
  + Kèm thông tin sự kiện rút gọn: `userEventId`, `eventId`, `title`/`eventName`, `description`, `location`, `startDate`, `endDate`, `status` (`PENDING`/`CONFIRMED`), `registeredAt`, `voucherId`.
- **Xem danh sách sự kiện đang mở (`GET /events`)**:
  + Endpoint mở: lọc các sự kiện có `isEnabled: true`, `startDate <= now <= endDate`.
  + Nếu bệnh nhân đã đăng nhập (`optionalAuthenticate`), đính kèm `registrationStatus` tương ứng cho từng sự kiện.
- **Hủy đăng ký sự kiện**:
  + Phân tích mã nguồn Frontend `web/src/api/patientEvents.ts`: Không có hàm hủy đăng ký sự kiện (`cancelRegistration`). Do đó tính năng hủy đăng ký nằm ngoài phạm vi yêu cầu hiện tại (out of scope).

### 3. Lý do (Rationale)
- Việc kết hợp atomic update trên `Event.registeredCount` với unique index trên `EventRegistration` đảm bảo tính toàn vẹn dữ liệu hoàn hảo trước mọi tranh chấp song song (concurrency race conditions) mà không làm nghẽn hiệu năng.
- Mount router qua `backend/src/routes/features/patientEvent.routes.js` tuân thủ nghiêm ngặt quy tắc không sửa đổi các file dùng chung (`routes/index.js`, models, enums).

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- `JWT_SECRET`: Dùng để xác thực JWT token và trích xuất `userId` và `role`.
- `clinicTimeZone`: Cấu hình múi giờ phòng khám (mặc định: `Asia/Ho_Chi_Minh`), được đồng bộ thông qua `clock.service` và `timezone.js`.
