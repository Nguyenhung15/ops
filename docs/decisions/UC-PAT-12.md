# UC-PAT-12: Patient Gửi Và Xem Feedback

## 1. Bối cảnh & Mục tiêu
- **Mục tiêu**: Cho phép Bệnh nhân (Patient) gửi đánh giá, phản hồi sau khi hoàn tất khám bệnh (`POST /feedbacks`), xem danh sách các phản hồi của chính mình (`GET /feedbacks/my`), chỉnh sửa (`PUT /feedbacks/:id`) và xóa mềm (`DELETE /feedbacks/:id`) trong khung thời gian cho phép.
- **Tài liệu tham chiếu**: `docs/RULES.md`, `docs/DECISIONS.md`, `web/src/api/feedback.ts`, bảng `feedbacks` trong `docs/Dump20261029.sql`.
- **Phạm vi loại trừ**: Việc kiểm duyệt (moderation) và phản hồi từ Quản trị viên thuộc phạm vi của UC-ADM-11, không triển khai ở đây.

---

## 2. Quyết định Thiết kế & Kiến trúc

### 2.1. Model & Trạng thái Feedback
- Tận dụng Model `Feedback` đã định nghĩa sẵn từ giai đoạn PREP (`backend/src/models/feedback.model.js`). Tuyệt đối không can thiệp sửa đổi model.
- **Trạng thái mặc định**: Khi gửi mới, status luôn là `PENDING` (`FEEDBACK_STATUSES.PENDING`).
- Khi người dùng chỉnh sửa một feedback đã được duyệt (`PUBLISHED`), hệ thống tự động đưa status trở lại `PENDING` để kiểm duyệt lại nội dung mới, đảm bảo an toàn nội dung.

### 2.2. Kiểm tra Điều kiện Gửi Feedback
1. **Lịch hẹn**: `appointmentId` bắt buộc phải là số nguyên dương hợp lệ.
2. **Quyền sở hữu**: Lịch hẹn phải thuộc về người dùng đang đăng nhập (`appointment.patientId === user.id`). Nếu không tồn tại hoặc không thuộc quyền sở hữu -> trả cùng mã lỗi `404 APPOINTMENT_NOT_FOUND` (ngăn chặn user enumeration).
3. **Trạng thái lịch**: BẮT BUỘC lịch hẹn phải ở trạng thái `COMPLETED`. Nếu chưa hoàn thành -> từ chối với mã lỗi `409 APPOINTMENT_NOT_COMPLETED`.
4. **Tính duy nhất**: Mỗi lịch hẹn chỉ được tồn tại một feedback đang hoạt động (`deletedAt == null`). Nếu đã có -> trả `409 FEEDBACK_EXISTS`. Các bản ghi đã bị xóa mềm (`deletedAt != null`) không tính, người dùng có thể gửi lại feedback mới cho lịch đó.
5. **Thông tin bác sĩ**: `doctorId` được tự động trích xuất trực tiếp từ bản ghi `Appointment`, không tin cậy hoặc nhận từ client payload.
6. **Đánh giá & Bình luận**:
   - `rating`: Bắt buộc là số nguyên từ `1` đến `5` (sai định dạng hoặc ngoài khoảng -> `400 INVALID_RATING`).
   - `comment`: Bắt buộc, giới hạn tối đa 1000 ký tự. Hệ thống tự động sanitize để loại bỏ hoàn toàn các thẻ HTML/script độc hại (`<script>`, `<style>`, `<b>`, `<iframe>`, ...), phòng chống tấn công XSS triệt để.

### 2.3. Khung Thời gian Chỉnh sửa & Xóa mềm
- **Khung thời gian**: Bệnh nhân chỉ được chỉnh sửa (`PUT /feedbacks/:id`) hoặc xóa mềm (`DELETE /feedbacks/:id`) trong vòng `FEEDBACK_EDIT_DAYS` ngày (mặc định lấy từ `configService.feedbackEditDays`, tức 7 ngày) kể từ ngày tạo `createdAt`.
- **Hết hạn**: Nếu vượt quá khung thời gian trên -> từ chối với mã lỗi `409 FEEDBACK_EDIT_WINDOW_CLOSED`.
- **Xóa mềm (Soft Delete)**: Cập nhật trường `deletedAt = clock.now()`. Sau khi xóa mềm, bản ghi sẽ không hiển thị trên danh sách `GET /feedbacks/my` và bệnh nhân có quyền gửi một đánh giá phản hồi mới cho lịch hẹn đó.

### 2.4. Hàm Query Public Ẩn Danh (`getPublishedAnonymous`)
- Xây dựng sẵn hàm `feedbackService.getPublishedAnonymous(query)`:
  - Chỉ lọc các bản ghi có trạng thái `PUBLISHED` và chưa bị xóa mềm (`deletedAt: null`).
  - **Bảo mật danh tính**: TUYỆT ĐỐI không trả các trường định danh như `userId`, `patientEmail`.
  - Nếu `isAnonymous = true`: Trả `patientName = 'Ẩn danh'`.
  - Nếu `isAnonymous = false`: Trả tên rút gọn/che giấu (ví dụ: `Bệnh Nhân Feedback 1` -> `B. Nhân Feedback 1`).
- **Quyết định endpoint public**: CHƯA mở route public cho khách vãng lai (Guest) trong router lần này, chờ tài liệu quy định rõ ràng về quyền truy cập Guest và rate limit riêng cho người dùng chưa đăng nhập.

### 2.5. Rate Limiting & Audit Logging
- **Rate Limit**: Áp dụng middleware `createRateLimiter` trên endpoint `POST /feedbacks` theo từng `userId` với ngưỡng `FEEDBACK_RATE_PER_HOUR` (mặc định 10 lượt/giờ theo `configService.feedbackRatePerHour`). Khi vượt ngưỡng, trả về mã lỗi chuẩn `429 RATE_LIMIT_EXCEEDED`.
- **Audit Logging**: Ghi nhận đầy đủ vào hệ sinh thái audit của hệ thống thông qua `auditService.log`:
  - `AUDIT_ACTIONS.CREATE_FEEDBACK`: Lưu actorId, targetId (feedbackId), appointmentId, rating, doctorId.
  - `AUDIT_ACTIONS.UPDATE_FEEDBACK`: Lưu actorId, targetId, status mới.
  - `AUDIT_ACTIONS.DELETE_FEEDBACK`: Lưu actorId, targetId, appointmentId.

---

## 3. Hợp đồng API (API Contract)

### 3.1. `POST /feedbacks`
- **Headers**: `Authorization: Bearer <patient_token>`
- **Request Body**:
```json
{
  "appointmentId": 5001,
  "rating": 5,
  "title": "Dịch vụ chất lượng cao",
  "comment": "Bác sĩ thăm khám cẩn thận, tận tình giải đáp.",
  "category": "Chất lượng khám chữa bệnh",
  "isAnonymous": false
}
```
- **Response thành công (`201 Created`)**:
```json
{
  "ok": true,
  "success": true,
  "message": "Gửi đánh giá phản hồi thành công",
  "data": {
    "id": 1,
    "userId": 1201,
    "appointmentId": 5001,
    "doctorId": 1203,
    "patientName": "Bệnh Nhân Feedback 1",
    "rating": 5,
    "title": "Dịch vụ chất lượng cao",
    "comment": "Bác sĩ thăm khám cẩn thận, tận tình giải đáp.",
    "category": "Chất lượng khám chữa bệnh",
    "status": "PENDING",
    "isAnonymous": false,
    "createdAt": "2026-11-01T10:00:00.000Z",
    "isOwner": true
  }
}
```

### 3.2. `GET /feedbacks/my`
- **Headers**: `Authorization: Bearer <patient_token>`
- **Query params (tùy chọn)**: `?page=1&limit=20&status=PENDING`
- **Response thành công (`200 OK`)**:
```json
{
  "ok": true,
  "success": true,
  "message": "Lấy danh sách phản hồi thành công",
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

### 3.3. `PUT /feedbacks/:id`
- **Headers**: `Authorization: Bearer <patient_token>`
- **Request Body**: `{ "rating": 4, "comment": "Nội dung cập nhật..." }`
- **Response thành công (`200 OK`)**: Trả về dữ liệu feedback sau cập nhật với status trở về `PENDING`.

### 3.4. `DELETE /feedbacks/:id`
- **Headers**: `Authorization: Bearer <patient_token>`
- **Response thành công (`200 OK`)**: `{ "ok": true, "success": true, "message": "Xóa phản hồi thành công", "data": { "id": 1 } }`

---

## 4. Danh mục Kiểm thử (Test Cases Verification)
Bộ kiểm thử tại `backend/tests/uc-pat-12.test.js` đã xác nhận 14/14 trường hợp:
1. Gửi feedback thành công với đầy đủ các điều kiện (appointmentId, COMPLETED, status PENDING, doctorId tự động gán, ghi audit).
2. Lịch chưa COMPLETED bị từ chối 409 `APPOINTMENT_NOT_COMPLETED`.
3. Lịch của người khác bị từ chối 404 (chống enumeration).
4. Gửi trùng feedback trên cùng một ca khám bị từ chối 409 `FEEDBACK_EXISTS`.
5. Rating không phải số nguyên 1..5 bị từ chối 400 `INVALID_RATING`.
6. Comment chứa mã độc XSS được sanitize làm sạch triệt để.
7. `GET /feedbacks/my` phân trang và cô lập dữ liệu tuyệt đối giữa các bệnh nhân.
8. Chỉnh sửa feedback của người khác bị từ chối 404.
9. Chỉnh sửa bản ghi PUBLISHED tự động quay về PENDING để kiểm duyệt lại.
10. Sửa/xóa ngoài thời hạn quy định (sau 8 ngày) bị từ chối 409 `FEEDBACK_EDIT_WINDOW_CLOSED`.
11. Xóa mềm (gán `deletedAt`) và cho phép gửi lại phản hồi mới cho ca khám đó.
12. Hàm query public `getPublishedAnonymous` chỉ lấy `PUBLISHED`, không chứa `userId`, email, ẩn danh an toàn.
13. Rate limiter kích hoạt mã 429 `RATE_LIMIT_EXCEEDED` khi gửi vượt ngưỡng trong giờ.
14. Phân quyền: Bác sĩ và Lễ tân gọi route bệnh nhân bị chặn 403 `FORBIDDEN_ROLE`.
