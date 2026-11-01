# UC-PAT-11: Patient Xem Đơn Thuốc Và Lịch Sử Khám (Chỉ Đọc)

## 1. Bối cảnh & Mục tiêu
- **Mục tiêu**: Cho phép Bệnh nhân (Patient) tra cứu đơn thuốc theo lịch hẹn (`GET /prescriptions/by-appointment/:appointmentId`) và xem lại lịch sử các ca khám đã hoàn tất (`GET /appointments/my-completed`) một cách an toàn, minh bạch, bảo mật dữ liệu y tế và tuân thủ các quy tắc bảo vệ quyền riêng tư người bệnh.
- **Tài liệu tham chiếu**: `docs/RULES.md`, `docs/DECISIONS.md`, `web/src/api/prescription.ts`, `web/src/api/appointment.ts`.

---

## 2. Quyết định Thiết kế & Kiến trúc

### 2.1. Tái sử dụng & Tối ưu hóa Lịch sử khám (PAT-05)
- Tuyệt đối không viết lại hoặc tạo endpoint trùng lặp với `GET /appointments/my-completed` (thuộc UC-PAT-05).
- Đã bổ sung an toàn tối thiểu tại `patientAppointment.service.js`:
  - Thêm trường `actualStartTime`, `actualEndTime` vào hàm serializer `serializePatientAppointment` để bệnh nhân nắm rõ thời gian khám thực tế của bác sĩ.
  - Bổ sung hỗ trợ lọc theo khoảng ngày tùy chọn thông qua query params (`fromDate`/`toDate` hoặc `startDate`/`endDate`), mặc định sắp xếp mới nhất trước (`appointmentDate DESC, appointmentTime DESC`).
  - Đảm bảo 100% không làm gãy hoặc hồi quy 14/14 test cases hiện có của `uc-pat-05.test.js`.

### 2.2. Route Mount & Phân quyền trên `/prescriptions/by-appointment/:appointmentId`
- **Vấn đề**: Hệ thống trước đây đã có `doctorPrescription.routes.js` mount tại `/prescriptions` với middleware `getByAppointment` cho phép bác sĩ tra cứu đơn thuốc ca khám.
- **Giải pháp**:
  - Tận dụng cơ chế nạp động feature routes trước core routers của `src/routes/index.js` (`features/*.routes.js` được mount trước `router.use('/prescriptions', doctorPrescriptionRoutes)`).
  - Tạo `routes/features/patientPrescription.routes.js` với `basePath: '/prescriptions'`.
  - Trên route `GET /by-appointment/:appointmentId`:
    - Nếu request đến từ user có vai trò `PATIENT`: Chuyển xử lý vào `patientPrescriptionController.getPrescriptionByAppointment` (với đầy đủ kiểm tra quyền sở hữu, không rò rỉ dữ liệu).
    - Nếu request đến từ vai trò khác (`DOCTOR`, `RECEPTIONIST`, `ADMIN`): Gọi `next()` để chuyển quyền xử lý xuống `doctorPrescriptionRoutes` phía sau mà không gây xung đột hay phá vỡ nghiệp vụ của bác sĩ.
  - Đồng thời mở endpoint chuyên biệt `GET /prescriptions/my-prescriptions/by-appointment/:appointmentId` với middleware `requireRoles(ROLES.PATIENT)` để trả về lỗi `403 FORBIDDEN_ROLE` chuẩn mực khi bác sĩ/lễ tân cố ý gọi route dành riêng cho bệnh nhân.

### 2.3. Kiểm tra Quyền sở hữu (Ownership Isolation)
- **Quy tắc bắt buộc**: Ownership được lọc trực tiếp tại tầng truy vấn cơ sở dữ liệu (`Appointment.findOne(...)`), không bao giờ query toàn bộ rồi lọc thủ công trên RAM ở controller.
- **Phạm vi sở hữu**:
  - Lịch hẹn của chính tài khoản (`appointment.patientId === user.id`).
  - Lịch hẹn đặt hộ cho hồ sơ phụ thuộc (con cái, cha mẹ, vợ chồng) do user quản lý (`appointment.patients.id` nằm trong danh sách `PatientProfile.find({ ownerId: user.id })`).
- **Ngăn chặn User Enumeration**: Trường hợp lịch hẹn không tồn tại HOẶC lịch hẹn tồn tại nhưng không thuộc về user đều trả về cùng một mã lỗi `404 APPOINTMENT_NOT_FOUND`. Tuyệt đối không trả 403 để tránh rò rỉ ID lịch hẹn của bệnh nhân khác.

### 2.4. Quản lý Phiên bản Đơn thuốc (Prescription Versioning)
- Đơn thuốc trong CSDL hỗ trợ cột `version` (mặc định 1).
- Khi người dùng gọi không kèm query param `?version=`: Hệ thống tự động chọn và trả về version mới nhất (`version` cao nhất của appointment đó).
- Khi người dùng truyền `?version=X`: Hệ thống lọc trả về chính xác đơn thuốc của phiên bản X đó.
- Nếu lịch hẹn chưa chuyển sang `COMPLETED` hoặc bác sĩ chưa kê đơn: Hệ thống trả về danh sách rỗng `[]` (hoặc `{ data: [] }`), tuyệt đối không quăng ngoại lệ 500.

### 2.5. Bảo mật Y tế & Audit Log
- **Không trả ghi chú nội bộ**: Loại bỏ các ghi chú điều trị nội bộ hay thông tin nhạy cảm của bác sĩ.
- **Audit Log**:
  - Ghi nhận hành động `AUDIT_ACTIONS.VIEW_PRESCRIPTION`.
  - Chỉ ghi nhận `actor` (ID, role, email) và `resource` (ID lịch hẹn, version, số lượng loại thuốc).
  - **TUYỆT ĐỐI KHÔNG ghi nội dung chi tiết đơn thuốc** (tên thuốc, hàm lượng, liều dùng, hướng dẫn uống) vào audit log nhằm tuân thủ tiêu chuẩn an toàn dữ liệu y tế (HIPAA/GDPR-like).

---

## 3. Hợp đồng API (API Contract)

### 3.1. Endpoint: `GET /prescriptions/by-appointment/:appointmentId`
- **Headers**: `Authorization: Bearer <token>`
- **Query params (tùy chọn)**: `?version=1`
- **Response thành công (`200 OK`)**:
```json
{
  "ok": true,
  "success": true,
  "message": "Lấy đơn thuốc thành công",
  "appointmentId": 4001,
  "appointmentNo": "OFF2611010001",
  "appointmentStatus": "COMPLETED",
  "doctor": {
    "id": 1103,
    "fullName": "BS CKII Trần Văn Bác Sĩ"
  },
  "version": 1,
  "prescribedAt": "2026-11-01T08:05:00.000Z",
  "medicines": [
    {
      "id": 7001,
      "medicineName": "Amoxicillin 500mg",
      "dosage": "1 viên x 3 lần/ngày",
      "duration": "7 ngày",
      "instructions": "Uống sau ăn no",
      "version": 1,
      "createdAt": "2026-11-01T08:05:00.000Z",
      "appointmentId": 4001
    }
  ],
  "data": [
    {
      "id": 7001,
      "medicineName": "Amoxicillin 500mg",
      "dosage": "1 viên x 3 lần/ngày",
      "duration": "7 ngày",
      "instructions": "Uống sau ăn no",
      "version": 1,
      "createdAt": "2026-11-01T08:05:00.000Z",
      "appointmentId": 4001
    }
  ]
}
```
*(Tương thích 100% với hàm `getPrescriptionsByAppointment` trong `web/src/api/prescription.ts` khi dùng helper `extractArray(res.data)`)*.

---

## 4. Danh sách Kiểm thử (Verification)
- `tests/uc-pat-11.test.js`:
  1. Đơn thuốc của chính mình: xem thành công, đầy đủ thông tin thuốc, bác sĩ, ngày kê.
  2. Lịch người khác: trả mã 404 (chống user enumeration).
  3. Hồ sơ phụ thuộc: hồ sơ do mình quản lý xem được, hồ sơ người khác quản lý trả 404.
  4. Lịch chưa có đơn hoặc chưa hoàn tất: trả mảng rỗng `[]`, không lỗi 500.
  5. Quản lý phiên bản (`?version=`): mặc định lấy bản mới nhất, lấy đúng bản chỉ định.
  6. Bảo mật và Audit Log: ghi nhận `VIEW_PRESCRIPTION` có actor và appointmentId, không log nội dung đơn thuốc.
  7. Phân quyền: Doctor/Receptionist gọi route bệnh nhân bị 403 `FORBIDDEN_ROLE`.
  8. Lịch sử khám (PAT-05): `GET /appointments/my-completed` trả `actualStartTime`/`actualEndTime` và hỗ trợ lọc khoảng ngày.
  9. Route fallback tương thích cho Bác sĩ trên `GET /prescriptions/by-appointment/:appointmentId`.
