# QUY TẮC PHÁT TRIỂN NỀN TẢNG (CORE RULES) — CLINIC BOOKING

> **Tài liệu tham chiếu:** Quy chuẩn kiến trúc P0 bắt buộc cho toàn bộ Backend (Node.js + MongoDB, Modular Monolith). Mọi use case nghiệp vụ ở các phase sau phải tuân thủ tuyệt đối các quy tắc trong tài liệu này.

---

## 1. ĐỊNH DANH VÀ BẢO MẬT ĐẦU VÀO (IDENTIFIERS & SECURITY PRINCIPALS)

1. **Định danh ID là String:**
   - ID của tài nguyên trong tầng Service/Core, JWT `userId`, `patientUserId`, `doctorId` được xử lý dưới dạng `string` (chuỗi ObjectId hợp lệ hoặc String ID).
   - **Tuyệt đối không dùng `parseInt(id)`** làm mất tính toàn vẹn của chuỗi định danh.
   - Đối với các model kế thừa có trường số tự tăng tương thích FE cũ, tầng service phải chấp nhận và xử lý chuỗi ID chuẩn tắc.

2. **Không tin dữ liệu Client gửi lên:**
   - **Không tin `userId`, `role`, `doctorId`, `patientId`** từ body hoặc query params của client gửi lên nếu đã có token đăng nhập.
   - Mọi thông tin danh tính, vai trò và phân quyền bắt buộc phải được trích xuất trực tiếp từ JWT payload đã xác thực (`req.user` / Principal: `{ userId: string, role: string, email: string }`).

3. **Nguyên tắc Deny-by-default:**
   - Mọi endpoint mặc định từ chối truy cập trừ khi được khai báo quyền cụ thể thông qua Guard/Role decorator (`@Roles(...)` / `requireRoles(...)`).
   - Kiểm tra vai trò (RBAC) tại tầng Middleware/Guard.
   - Kiểm tra quyền sở hữu (Ownership & Scope Verification) bắt buộc thực hiện tại tầng Service (`patientId === actor.userId` hoặc `doctorId === actor.userId`).

---

## 2. STATE MACHINE CHO LỊCH HẸN (APPOINTMENT STATE MACHINE)

Toàn bộ các thay đổi trạng thái của Lịch hẹn (`Appointment`) **bắt buộc phải đi qua `AppointmentStateService`**, không được `updateOne({ status })` tùy tiện trong các controller/service khác.

### 2.1. Danh mục trạng thái hợp lệ
- `PENDING_PAYMENT`: Lịch khám ONLINE vừa khởi tạo, đang chờ thanh toán qua cổng thanh toán (VNPay).
- `PENDING_CONFIRMATION`: Lịch khám OFFLINE vừa đặt (hoặc ONLINE đã thanh toán), đang chờ Lễ tân xác nhận.
- `CONFIRMED`: Lễ tân đã duyệt và xác nhận lịch hẹn hợp lệ.
- `CHECKED_IN`: Bệnh nhân đã có mặt tại phòng khám và được Lễ tân check-in.
- `IN_PROGRESS`: Bác sĩ đã bấm bắt đầu ca khám cho bệnh nhân.
- `COMPLETED`: Bác sĩ đã hoàn tất ca khám và kê đơn thuốc (nếu có).
- `CANCELLED`: Lịch hẹn đã bị hủy (bởi Bệnh nhân, Lễ tân hoặc Bác sĩ theo policy).
- `RESCHEDULED`: Lịch hẹn đã được dời sang ca trực/thời gian khác.
- `EXPIRED`: Lịch hẹn quá hạn thanh toán hoặc quá ngày khám mà chưa được xác nhận.
- `NO_SHOW`: Ca khám đã kết thúc nhưng bệnh nhân không đến khám.

### 2.2. Bảng chuyển trạng thái hợp lệ (Valid Transitions)
```text
[Khởi tạo] ──┬──> PENDING_PAYMENT ───────> PENDING_CONFIRMATION
            └──> PENDING_CONFIRMATION ──> CONFIRMED ──> CHECKED_IN ──> IN_PROGRESS ──> COMPLETED
                      │                      │              │
                      ├──> EXPIRED           ├──> CANCELLED └──> NO_SHOW
                      ├──> CANCELLED         ├──> RESCHEDULED
                      └──> RESCHEDULED       └──> EXPIRED
```

- `PENDING_PAYMENT` ➔ `PENDING_CONFIRMATION`, `CANCELLED`, `EXPIRED`.
- `PENDING_CONFIRMATION` ➔ `CONFIRMED`, `CANCELLED`, `RESCHEDULED`, `EXPIRED`.
- `CONFIRMED` ➔ `CHECKED_IN`, `CANCELLED`, `RESCHEDULED`, `EXPIRED`, `NO_SHOW`.
- `CHECKED_IN` ➔ `IN_PROGRESS`, `CANCELLED`, `NO_SHOW`.
- `IN_PROGRESS` ➔ `COMPLETED`.
- Trạng thái kết thúc (Terminal states): `COMPLETED`, `CANCELLED`, `EXPIRED`, `NO_SHOW`, `RESCHEDULED`. Không chuyển tiếp từ terminal state.

### 2.3. Nguyên tắc chuyển đổi trạng thái
- **Conditional Update:** Khi chuyển trạng thái, câu lệnh DB phải chứa điều kiện trạng thái hiện tại (ví dụ: `{ id, status: { $in: fromStatuses } }`).
- **Idempotency:** Nếu lịch hẹn đã ở trạng thái đích `to`, service trả về bản ghi hiện tại mà không báo lỗi hoặc gây trùng lặp side-effect.
- **Audit & Actor:** Mọi lần đổi trạng thái phải lưu lại định danh `actor` (`userId`, `role`), thời điểm timestamp và lý do chuyển đổi.

---

## 3. NGUYÊN TẮC NGUYÊN TỬ VÀ TOÀN VẸN DỮ LIỆU (ATOMICITY & TRANSACTIONS)

1. **Cập nhật nguyên tử (Atomic Conditional Updates):**
   - Đặt giữ chỗ slot và lịch hẹn sử dụng conditional update (ví dụ: `DoctorShift.updateOne({ id: shiftId, "slots.id": slotId, "slots.status": "AVAILABLE" }, { $set: { "slots.$.status": "BOOKED" } })`).
   - Nếu môi trường hỗ trợ MongoDB Replica Set: sử dụng Database Transaction (Session) bọc nhiều collection.
   - Nếu môi trường chạy MongoDB Standalone (không hỗ trợ multi-document transactions): sử dụng Conditional Update kết hợp cơ chế Compensation Rollback (hoàn trả slot nếu tạo appointment thất bại). Chi tiết ghi tại `docs/DECISIONS.md`.

2. **Index nền tảng (Database Indexes):**
   - Collection `appointments`:
     + Unique index: `{ appointmentNo: 1 }`
     + Compound index: `{ patientId: 1, appointmentDate: 1 }`
     + Compound index: `{ doctorId: 1, appointmentDate: 1, status: 1 }`
     + Compound index: `{ shiftId: 1, slotIds: 1 }`
   - Collection `doctor_shifts`:
     + Unique index: `{ doctorId: 1, date: 1, shift: 1 }`

---

## 4. XỬ LÝ SỰ KIỆN VÀ THÔNG BÁO (OUTBOX PATTERN & NOTIFICATIONS)

1. **Transactional Outbox sau Commit:**
   - Nghiệp vụ không gọi trực tiếp API gửi email, SMS hoặc WebSocket bên thứ ba trong luồng đồng bộ.
   - Sau khi cập nhật trạng thái/tạo lịch thành công, ghi bản ghi sự kiện vào collection `outbox_events` (gồm `{ eventType, payload, status: 'PENDING', retries: 0 }`).
2. **Xử lý bất đồng bộ (Worker / Adapter):**
   - Background worker định kỳ quét các event `PENDING` để phát thông báo qua adapter thích hợp (Email, WebSocket, Push Notification).
   - **Lỗi gửi thông báo không được rollback nghiệp vụ chính**.
   - Cơ chế retry có giới hạn (exponential backoff / max retries) và đảm bảo tính Idempotent (không gửi lặp cho cùng một event).

---

## 5. NHẬT KÝ KIỂM TOÁN VÀ BẢO MẬT THÔNG TIN (AUDIT TRAIL & PII)

1. **Audit bắt buộc cho mọi thao tác nhạy cảm:**
   - Mọi thay đổi trạng thái lịch khám, hủy lịch, đổi ca, kê đơn, khóa/mở khóa tài khoản, thay đổi cấu hình phải được ghi vào `audit_logs`.
   - Cấu trúc bản ghi: `{ actor: { userId, role, email }, action, resource: { type, id }, reason, summary, diff, ipAddress, userAgent, timestamp }`.
2. **Lọc dữ liệu nhạy cảm (PII & Secrets):**
   - **Tuyệt đối không ghi vào log:** `password`, `temporaryPassword`, token JWT, API Keys, CVV/thông tin thẻ, secret keys.
   - Dữ liệu trước/sau (diff) phải đi qua bộ lọc `sanitizeAuditPayload` trước khi lưu vào CSDL hoặc ghi ra console.

---

## 6. QUẢN LÝ THỜI GIAN VÀ MÚI GIỜ (CLOCK & TIMEZONE)

1. **Clock Service:**
   - Mọi thao tác lấy thời gian hiện tại trong nghiệp vụ và state machine phải gọi qua `ClockService` (`clock.now()`, `clock.today()`).
   - Cung cấp `FakeClock` trong môi trường test để tua/đặt thời gian chính xác cho các ca kiểm thử quá hạn, 24 giờ, 48 giờ.
2. **Quy tắc múi giờ (Timezone):**
   - Timestamp trong database luôn lưu ở định dạng chuẩn **UTC** (`Date` object / ISO-8601 UTC).
   - Ngày lịch khám (`YYYY-MM-DD`) và giờ ca khám (`HH:mm`) được tính toán và chuẩn hóa theo biến cấu hình `CLINIC_TIMEZONE` (mặc định: `Asia/Ho_Chi_Minh`).

---

## 7. ĐỊNH DẠNG LỖI VÀ RATE LIMITING (ERROR FORMAT & RATE LIMITING)

1. **Định dạng lỗi thống nhất:**
   - Mọi phản hồi lỗi trả về định dạng chuẩn:
     ```json
     {
       "success": false,
       "error": {
         "code": "BAD_REQUEST",
         "message": "Thông điệp lỗi chi tiết cho người dùng",
         "details": [],
         "traceId": "req-uuid-or-timestamp"
       },
       "message": "Thông điệp lỗi chi tiết cho người dùng"
     }
     ```
   - **Không làm lộ stack trace** trên môi trường production.
   - Map chính xác các HTTP status code tiêu chuẩn:
     + `400 Bad Request`: Dữ liệu đầu vào sai cú pháp hoặc vi phạm validation.
     + `401 Unauthorized`: Chưa đăng nhập, thiếu Bearer token hoặc token hết hạn.
     + `403 Forbidden`: Đã đăng nhập nhưng không đủ quyền hoặc không phải chủ sở hữu tài nguyên.
     + `404 Not Found`: Không tìm thấy tài nguyên theo định danh.
     + `409 Conflict`: Xung đột trạng thái (slot đã có người đặt, chuyển state không hợp lệ, email đã tồn tại).
     + `429 Too Many Requests`: Vượt quá tần suất yêu cầu cho phép.
2. **Rate Limiting:**
   - Bổ sung middleware giới hạn tần suất gọi API tái sử dụng được, định danh theo `userId` (nếu đã đăng nhập) hoặc `clientIp` (nếu là khách).
   - Cấu hình linh hoạt qua biến môi trường.

---

## 8. QUY ƯỚC FILE & GIT (FILE & GIT CONVENTIONS)

### 8.1. Luật File (File Modification Rules)
1. **Lần sửa chung duy nhất (PREP):** Giai đoạn PREP là lần duy nhất được phép bổ sung/sửa đổi các file dùng chung (`constants/enums.js`, `config/config.service.js`, `.env.example`, `models/*`, `routes/index.js`, `package.json`, `docs/*`).
2. **Các UC tiếp theo chỉ TẠO FILE MỚI:**
   - Các use case tiếp theo (UC-PAT-07..12) tuyệt đối **KHÔNG SỬA FILE DÙNG CHUNG**.
   - Mọi router nghiệp vụ mới phải đặt trong thư mục `src/routes/features/*.routes.js` và export `{ basePath, router }`. Dynamic loader trong `src/routes/index.js` sẽ tự động quét và mount trước các router cũ.
   - Các service, controller, test mới viết thành file riêng tương ứng với mã use case.
3. **Nguyên tắc bảo toàn:** Giữ nguyên kiểu xuống dòng của từng file, không reformat hàng loạt, mọi field mới trong model là optional.

### 8.2. Quy trình Git (Git Push Workflow)
1. **Làm việc trực tiếp trên nhánh `main`:** Push thẳng vào `main` theo yêu cầu của dự án, không tạo thêm Pull Request rườm rà.
2. **Luôn kéo code mới nhất trước khi làm việc:** `git pull origin main`.
3. **Commit rõ ràng & kiểm tra chất lượng trước khi push:**
   - Chạy `npm run lint` và `npm test` đảm bảo 100% xanh trước khi commit.
   - Định dạng commit theo Conventional Commits: `feat(scope): implement UC-...`
   - Đẩy code an toàn: `git push origin main`.
