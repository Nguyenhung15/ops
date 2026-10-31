# CÁC QUYẾT ĐỊNH THIẾT KẾ KIẾN TRÚC P0 (ARCHITECTURE DECISIONS)

Tài liệu này ghi nhận toàn bộ các quyết định kỹ thuật nền tảng (P0 Architecture Decisions) được áp dụng trong quá trình chuyển đổi và phát triển hệ thống ClinicBooking.

---

## 1. Cơ chế Định danh (Identity & ID Format)

- **Vấn đề:** Hệ thống SQL cũ dùng số tự tăng `bigint` (MySQL), trong khi chuẩn NoSQL MongoDB dùng chuỗi `ObjectId`. Frontend có nhiều điểm kiểm tra `Number(id)` nhưng cũng có nơi truyền string. Đặc tả mới quy định: `ID là string (ObjectId), JWT userId là string, không parseInt ID. Không tin userId/role/doctorId từ client, lấy từ JWT`.
- **Mặc định đã chọn:**
  - Tầng Service, State Machine, Outbox, Audit Log và JWT Payload chuẩn hóa sử dụng **String ID** (`userId: string`, `actorId: string`, `appointmentId: string`).
  - Hỗ trợ linh hoạt: Các query tìm kiếm tài nguyên (`findOne`) chấp nhận cả `ObjectId` (hex string) lẫn `id: Number` để tương thích ngược 100% với Frontend hiện có và các bộ dữ liệu đã import từ SQL dump.
  - Tuyệt đối không dùng `parseInt(id)` trên các định danh mới.
- **Lý do:** Đảm bảo hệ thống đạt tính an toàn cao, không rủi ro tràn số nguyên JS, đồng bộ chuẩn ObjectId của MongoDB mà không phá vỡ hợp đồng dữ liệu hiện hữu với client.
- **Biến env để đổi:** Không cần biến env (mặc định chấp nhận cả 2 dạng định danh).

---

## 2. Giao dịch CSDL & Tính Nguyên tử (Atomic Operations & MongoDB Replica Set)

- **Vấn đề:** Chức năng đặt/hủy/dời lịch cần cập nhật đồng thời trạng thái Lịch hẹn (`appointments`) và Ca trực (`doctor_shifts.slots`). MongoDB chỉ hỗ trợ Multi-document ACID Transactions (`ClientSession`) khi chạy ở chế độ **Replica Set**; ở chế độ Standalone (môi trường dev cục bộ phổ biến), `session.startTransaction()` sẽ gây lỗi.
- **Mặc định đã chọn:**
  - Áp dụng kỹ thuật **Conditional Atomic Updates** làm lớp bảo vệ cốt lõi: Câu lệnh cập nhật trạng thái luôn kèm filter điều kiện hiện tại (ví dụ: `status: { $in: fromStatuses }`, `"slots.status": "AVAILABLE"`).
  - Tích hợp cờ cấu hình `ENABLE_MONGO_TRANSACTIONS`:
    + Nếu `true`: Bọc qua MongoDB Client Session Transaction.
    + Nếu `false` (mặc định trên môi trường dev/standalone): Dùng Atomic Conditional Updates kèm cơ chế **Compensation Logic** (nếu bước sau thất bại thì tự động hoàn tác bước trước và ghi nhận log bồi hoàn).
- **Lý do:** Giúp hệ thống hoạt động ổn định ngay lập tức trên máy của mọi lập trình viên và môi trường CI/CD (không bắt buộc cài đặt Replica Set), nhưng sẵn sàng kích hoạt Full ACID Transaction khi triển khai Production (MongoDB Atlas / Docker Replica Set).
- **Biến env để đổi:** `ENABLE_MONGO_TRANSACTIONS=false` (đổi sang `true` khi kết nối vào MongoDB Replica Set).

---

## 3. Múi giờ và Dịch vụ Đồng hồ Thời gian (Clock & Timezone)

- **Vấn đề:** Phòng khám hoạt động tại Việt Nam (GMT+7). Nếu server chạy trên cloud dùng UTC hoặc múi giờ khác, các thao tác so sánh ngày (`YYYY-MM-DD`), tính khoảng cách hủy lịch 24h/48h, hoặc quét lịch quá hạn có thể bị lệch ngày nếu không quản lý múi giờ tập trung.
- **Mặc định đã chọn:**
  - Cung cấp `ClockService` tập trung: Toàn bộ code nghiệp vụ gọi `clock.now()` hoặc `clock.today()` thay vì gọi trực tiếp `new Date()`. Cung cấp class `FakeClock` cho phép tua và cố định thời gian phục vụ Unit/Integration Test.
  - Mọi timestamp trong CSDL (`createdAt`, `updatedAt`, `cancelledAt`, `decidedAt`) được lưu trữ dưới dạng chuẩn **UTC**.
  - Chuỗi ngày khám (`appointmentDate`, `shiftDate`) và giờ ca khám được tính toán và chuẩn hóa theo múi giờ phòng khám: `Asia/Ho_Chi_Minh`.
- **Lý do:** Ngăn chặn triệt để lỗi lệch ngày giờ khám bệnh giữa server cloud (UTC) và bệnh nhân/bác sĩ tại Việt Nam. Cho phép kiểm thử thời gian tự động cực kỳ chính xác.
- **Biến env để đổi:** `CLINIC_TIMEZONE=Asia/Ho_Chi_Minh`.

---

## 4. Xử lý Bất đồng bộ & Mẫu Transactional Outbox (Outbox / Notification Adapter)

- **Vấn đề:** Gửi email thông báo (SMTP) hoặc đẩy tin WebSocket trực tiếp trong luồng request/response có thể làm nghẽn tiến trình, tăng độ trễ HTTP request, và nếu dịch vụ mail lỗi thì dễ làm rollback nhầm dữ liệu nghiệp vụ đã hoàn tất.
- **Mặc định đã chọn:**
  - Áp dụng mẫu kiến trúc **Transactional Outbox**: Khi một nghiệp vụ hoàn tất (commit), một bản ghi sự kiện được ghi vào collection `outbox_events` với trạng thái `PENDING`.
  - Cung cấp `OutboxService` và background worker xử lý:
    + Quét các event `PENDING`, phân phối đến các adapter (Email, WebSocket, Mock).
    + Nếu adapter lỗi mạng: Event được đánh dấu tăng số lần thử (`retries`), tính toán thời gian thử lại (Exponential Backoff), **tuyệt đối không rollback dữ liệu khám bệnh**.
    + Đảm bảo tính Idempotent: Mỗi event có `id` duy nhất, không xử lý trùng lặp.
- **Lý do:** Tách rời (decoupling) nghiệp vụ phòng khám khỏi hạ tầng mạng bên ngoài, đảm bảo trải nghiệm người dùng phản hồi tức thì và dữ liệu thông báo không bao giờ bị mất (at-least-once delivery).
- **Biến env để đổi:**
  - `OUTBOX_ENABLE_WORKER=true` (bật/tắt tiến trình nền xử lý outbox).
  - `OUTBOX_POLL_INTERVAL_MS=5000` (chu kỳ quét outbox, tính bằng mili-giây).
  - `OUTBOX_MAX_RETRIES=5` (số lần thử lại tối đa trước khi đánh dấu `FAILED`).

---

## 5. Chuẩn hóa Phản hồi Lỗi (Unified Error Envelope)

- **Vấn đề:** Các lỗi từ tầng database (Mongoose), validation, middleware xác thực, và nghiệp vụ nếu trả về nhiều cấu trúc khác nhau sẽ khiến client khó bắt lỗi, đồng thời có nguy cơ lộ stack trace ra môi trường production.
- **Mặc định đã chọn:**
  - Mọi lỗi trả về theo cấu trúc chuẩn:
    ```json
    {
      "success": false,
      "error": {
        "code": "VALIDATION_ERROR",
        "message": "Thông báo lỗi chi tiết",
        "details": [],
        "traceId": "req-1730419200000-xxxx"
      },
      "message": "Thông báo lỗi chi tiết"
    }
    ```
  - Trường `message` top-level được giữ lại để tương thích 100% với Axios interceptors hiện hữu của `web/`.
  - Không bao giờ trả `stack` khi `NODE_ENV === 'production'`.
  - Map mã HTTP status code chuẩn: `400` (Validation/Bad Request), `401` (Unauthorized), `403` (Forbidden/Role Denied), `404` (Not Found), `409` (Conflict/State Violation), `429` (Rate Limited), `500` (Internal Error).
- **Lý do:** Giúp việc debug có traceId theo dõi, bảo mật an toàn thông tin hệ thống và frontend dễ dàng hiển thị thông báo.
- **Biến env để đổi:** `NODE_ENV=development` hoặc `NODE_ENV=production`.

---

## 6. Phân quyền Deny-by-default & Principal Extraction

- **Vấn đề:** Nếu không quản lý tập trung, lập trình viên có thể quên gắn middleware kiểm tra quyền, dẫn đến lỗ hổng bảo mật truy cập trái phép.
- **Mặc định đã chọn:**
  - Nguyên tắc **Deny-by-default**: Cung cấp middleware/guard `@Roles(...)` / `requireRoles(...)` chặn toàn bộ truy cập không có role hợp lệ.
  - Helper `getPrincipal(req)`: Trả về đối tượng `{ userId: string, role: string, email: string }` lấy trực tiếp từ JWT verified payload. Mọi controller/service lấy thông tin người gọi qua helper này, không đọc từ body.
- **Lý do:** Tuân thủ nguyên tắc Least Privilege (Đặc quyền tối thiểu) và chuẩn OWASP.
- **Biến env để đổi:** `JWT_SECRET`, `JWT_EXPIRES_IN`.

---

## 7. Giới hạn Tần suất (Rate Limiting)

- **Vấn đề:** Cần bảo vệ hệ thống khỏi tấn công DDoS, spam đặt chỗ hoặc brute-force mật khẩu.
- **Mặc định đã chọn:**
  - Cung cấp middleware `createRateLimiter({ windowMs, maxRequests, keyGenerator })` tái sử dụng được.
  - Định danh rate limit ưu tiên theo `userId` (nếu đã đăng nhập) hoặc theo `clientIp` (nếu là khách).
  - Tự động gắn response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
  - Khi vượt ngưỡng: Trả lỗi chuẩn HTTP `429 Too Many Requests` với code `RATE_LIMIT_EXCEEDED`.
- **Lý do:** Tự chủ trong mã nguồn, nhẹ nhàng, không phụ thuộc bắt buộc vào Redis trong giai đoạn P0 nhưng thiết kế giao diện adapter sẵn sàng cắm Redis khi scale.
- **Biến env để đổi:**
  - `RATE_LIMIT_WINDOW_MS=60000` (mặc định: 1 phút).
  - `RATE_LIMIT_MAX=100` (mặc định: 100 requests / phút).

---

## 8. Quản lý Cấu hình Tập trung (ConfigService)

- **Vấn đề:** Đọc trực tiếp `process.env` rải rác trong code dễ dẫn đến lỗi chính tả, thiếu giá trị mặc định và thiếu ép kiểu (`boolean`, `number`).
- **Mặc định đã chọn:**
  - Xây dựng `ConfigService` có kiểu dữ liệu rõ ràng, tự động validate các biến bắt buộc, cung cấp giá trị mặc định an toàn cho môi trường development/test.
- **Lý do:** Giúp khởi động ứng dụng an toàn (fail-fast nếu thiếu biến quan trọng), code sạch sẽ và dễ mock trong unit test.
- **Biến env để đổi:** Khai báo đầy đủ trong `.env.example`.

---

## 9. Thiết kế Nghiệp vụ UC-REC-03: Xác nhận Lịch hẹn (Confirm Appointment)

- **Vấn đề:** 
  1. Frontend gọi xác nhận lịch hẹn qua endpoint `PUT /appointments/confirm/:id` (`web/src/api/appointment.ts`). Cần đảm bảo endpoint giữ nguyên phương thức và đường dẫn.
  2. Quyền thực thi chỉ dành cho `RECEPTIONIST` và `ADMIN`.
  3. Lịch chỉ được chuyển từ `PENDING_CONFIRMATION` -> `CONFIRMED`.
  4. Lịch đã `CONFIRMED` gọi lại phải idempotent (trả HTTP 200 kèm state hiện tại, không gây side-effect lặp lại).
  5. Khi lịch ở trạng thái khác (`CANCELLED`, `EXPIRED`, `COMPLETED`, `IN_PROGRESS`), hệ thống phải trả HTTP 409 với code `INVALID_STATE`.
  6. Phải kiểm tra tính hợp lệ trước khi xác nhận: ca trực (`DoctorShift`) phải còn tồn tại và ở trạng thái `ACTIVE`; thời gian khám (`appointmentDate` + `appointmentTime`) chưa ở trong quá khứ so với thời gian phòng khám (`clock`).
  7. Sau khi xác nhận thành công: lưu `confirmedBy` (userId từ JWT) và `confirmedAt` (UTC Date), phát outbox event `APPOINTMENT_CONFIRMED` (kênh EMAIL) và ghi audit log `CONFIRM_APPOINTMENT`.
- **Mặc định đã chọn:**
  - Route: `PUT /appointments/confirm/:id` (được mount tại `/api/appointments/confirm/:id` và bảo vệ bởi `requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN)`).
  - Sử dụng `AppointmentStateService.transition`: áp dụng conditional atomic update để ngăn ngừa race condition (nếu 2 lễ tân confirm cùng lúc, chỉ 1 bên ghi nhận thành công và bên còn lại nhận kết quả `CONFIRMED` idempotent).
  - Lỗi gửi thông báo outbox không rollback nghiệp vụ chính (Transactional Outbox pattern).
- **Lý do:** Đảm bảo toàn vẹn dữ liệu, tính nhất quán trạng thái và trải nghiệm mượt mà cho nhân viên tiếp đón phòng khám mà không ảnh hưởng tới bất kỳ use case nào khác.
- **Biến env để đổi:** Không cần biến env mới.

---

## 10. Thiết kế Nghiệp vụ UC-REC-04: Check-in Bệnh nhân (Check-in Appointment)

- **Vấn đề:**
  1. Frontend gọi check-in bệnh nhân qua endpoint `PUT /appointments/checkin/:id` (`web/src/api/appointment.ts`). Cần giữ nguyên method và path.
  2. Quyền thực thi chỉ dành cho `RECEPTIONIST` và `ADMIN`.
  3. Lịch chỉ được chuyển từ `CONFIRMED` -> `CHECKED_IN` qua `AppointmentStateService`.
  4. Cần bổ sung các trường schema mới: `checkedInAt: Date` (UTC) và `checkedInBy: Mixed` (hỗ trợ Number ID cũ và String ObjectId mới) vì hệ thống Java/MySQL cũ chưa lưu trữ 2 thông tin này.
  5. Kiểm tra ngày và cửa sổ giờ check-in:
     - Phải đúng ngày khám theo múi giờ phòng khám (`CLINIC_TIMEZONE`). Khác ngày: trả 409 (`CHECKIN_TOO_EARLY` hoặc `CHECKIN_WINDOW_CLOSED`).
     - Trong ngày khám: cửa sổ mở từ `CHECKIN_EARLY_MINUTES` (mặc định 60 phút) trước giờ slot khám đến hết giờ ca trực (`shift.endTime`). Ngoài cửa sổ: trả 409 (`CHECKIN_TOO_EARLY` hoặc `CHECKIN_WINDOW_CLOSED`).
  6. Xác minh người đến khám:
     - Request có thể nhận `verifyPhoneLast4` (4 số cuối điện thoại bệnh nhân) hoặc `identityVerified=true` (xác nhận thẻ BHYT / CCCD trực tiếp tại quầy).
     - Nếu truyền `verifyPhoneLast4`, hệ thống đối chiếu 4 số cuối với số điện thoại trong snapshot bệnh nhân của lịch hẹn (`appointment.patients[].phoneNumber`) hoặc tài khoản bệnh nhân (`user.phoneNumber`). Nếu không khớp: trả 409 `IDENTITY_VERIFICATION_FAILED`.
     - Nếu gửi thiếu cả hai hoặc `identityVerified=false` mà không có SĐT: trả 400 `MISSING_VERIFICATION_INFO`. Để tương thích tối đa với nút bấm nhanh trên giao diện hiện hữu của lễ tân (`handleCheckin(id)` gửi body rỗng), hệ thống tự động coi đây là `identityVerified=true` (xác minh trực tiếp tại quầy).
  7. Lịch đã `CHECKED_IN`: trả state hiện tại kèm HTTP 200 (idempotent, không tạo side-effect lặp lại).
  8. Lịch ở sai trạng thái (`PENDING_CONFIRMATION`, `CANCELLED`, `COMPLETED`...): trả 409 `INVALID_STATE`.
  9. Sau commit: ghi outbox event `DOCTOR_PATIENT_CHECKED_IN` thông báo cho bác sĩ phụ trách ca khám.
  10. Ghi Audit Log hành động `CHECKIN`.
- **Mặc định đã chọn:**
  - Route: `PUT /appointments/checkin/:id` (được bảo vệ bởi `requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN)`).
  - Cấu hình cửa sổ check-in: `CHECKIN_EARLY_MINUTES=60` (quản lý qua `ConfigService`).
- **Lý do:** Đáp ứng đầy đủ quy trình tiếp đón thực tế của phòng khám, ngăn chặn việc check-in nhầm ca/nhầm ngày, hỗ trợ đa dạng phương thức xác minh danh tính và đảm bảo khả năng mở rộng.
- **Biến env để đổi:** `CHECKIN_EARLY_MINUTES=60`.

---

## 11. Thiết kế Nghiệp vụ UC-REC-05: Lễ tân/Admin Hủy hoặc Đổi lịch hẹn (Cancel & Reschedule Appointment)

- **Vấn đề:**
  1. Đây là use case có rủi ro cao nhất về slot và tính toàn vẹn dữ liệu: dời lịch và hủy lịch phải đồng bộ nguyên tử giữa collection `appointments` và `doctor_shifts.slots`.
  2. Endpoint hiện hữu của hệ thống:
     - `PUT /appointments/cancel/:id`: Bản dành cho Lễ tân / Quản trị viên (`RECEPTIONIST`, `ADMIN`), nhận `reason`.
     - `PUT /appointments/reschedule/:id`: Bản dành cho Lễ tân / Quản trị viên, nhận `newShiftId` (qua body hoặc query param), `newSlotId` (tùy chọn hoặc chọn slot AVAILABLE đầu tiên), và `reason`.
  3. Bắt buộc `reason` không rỗng cho cả hai thao tác (trả 400 `REASON_REQUIRED` nếu thiếu hoặc chuỗi khoảng trắng).
  4. Trạng thái cho phép: Chỉ lịch chưa ở các trạng thái kết thúc (`COMPLETED`, `CANCELLED`, `EXPIRED`, `NO_SHOW`). Lịch ở trạng thái kết thúc gọi đến sẽ bị từ chối với HTTP 409 `INVALID_STATE`.
  5. **Quy tắc Hủy Lịch bởi Nhân viên (Staff Cancellation):**
     - Chuyển trạng thái sang `CANCELLED` qua `AppointmentStateService`, lưu `cancelledBy` (userId từ JWT), `cancelledAt` (UTC Date) và `cancelReason`.
     - Giải phóng slot (`BOOKED` -> `AVAILABLE`, clear `bookingRef`, `bookedAt`) trong cùng đơn vị atomic với việc đổi state.
     - **Chỉ giải phóng nếu slot đang gắn đúng appointment này** (`slots.bookingRef === appointment.appointmentNo`).
     - **Miễn trừ chính sách phạt:** Lễ tân/Admin hủy lịch phòng khám **KHÔNG** bị giới hạn cửa sổ 48h/24h và **KHÔNG** làm tăng bộ đếm số lần hủy hay kích hoạt khóa đặt lịch của bệnh nhân (`cancelledCount` / `isBookingLocked`). Chính sách khóa 24h chỉ áp dụng riêng cho luồng Bệnh nhân tự hủy (`UC-PAT-06`).
     - **Chính sách hoàn tiền (Refund Flag):** Hệ thống không tự động hoàn tiền trực tiếp qua API ngân hàng; nếu lịch đã thanh toán thành công (hoặc có giao dịch thanh toán thành công), hệ thống gắn cờ `refundRequired=true` để bộ phận kế toán đối soát xử lý hoàn tiền thủ công.
  6. **Quy tắc Đổi Lịch (Reschedule):**
     - Ca trực mới (`DoctorShift`) phải tồn tại, có trạng thái `ACTIVE` (không `CANCELLED` hay `GROUP_BLOCKED`), và phải thuộc cùng bác sĩ phụ trách ca khám cũ (`newShift.doctorId === oldAppointment.doctorId`).
     - Slot mới phải `AVAILABLE`. Sử dụng conditional atomic update trên slot (`slots.status: 'AVAILABLE'`). Nếu slot đã bị người khác đặt hoặc concurrent conflict -> trả 409 `SLOT_ALREADY_BOOKED` và **KHÔNG THAY ĐỔI BẤT KỲ DỮ LIỆU NÀO**.
     - Lịch cũ chuyển sang `RESCHEDULED` qua `AppointmentStateService`.
     - Tạo một `Appointment` mới (với mã `appointmentNo` mới dạng `OFF...`, bảo lưu toàn bộ snapshot bệnh nhân `patients`, hình thức khám `type`, và lý do đổi lịch `reason`).
     - **Liên kết lịch sử (History Link):** Lịch mới lưu `rescheduledFromId = oldAppointment.id`, và lịch cũ lưu `rescheduledToId = newAppointment.id`.
     - **Quy tắc State Appointment mới:** Nếu lịch cũ đã ở trạng thái `CONFIRMED` hoặc `CHECKED_IN`, lịch mới tự động ở trạng thái `CONFIRMED` (và lưu `confirmedBy`, `confirmedAt`). Nếu lịch cũ đang ở `PENDING_CONFIRMATION` hoặc `PENDING_PAYMENT`, lịch mới duy trì trạng thái tương ứng.
     - Giải phóng slot cũ của ca khám cũ (`BOOKED` -> `AVAILABLE`, xóa `bookingRef`).
     - **Cơ chế Bồi hoàn (Compensation Rollback):** Toàn bộ quy trình được bọc trong khối try/catch bồi hoàn. Nếu xảy ra lỗi giữa chừng (ví dụ: chuyển state lịch cũ lỗi, đứt kết nối DB), hệ thống ngay lập tức hoàn tác slot mới vừa giữ chỗ về `AVAILABLE`, xóa bản ghi appointment mới vừa tạo (nếu có), đảm bảo slot và appointment không bao giờ bị lệch trạng thái.
  7. **Hậu kiểm & Sự kiện (Post-commit):**
     - Ghi nhận Transactional Outbox event (`APPOINTMENT_CANCELLED_BY_STAFF` và `APPOINTMENT_RESCHEDULED_BY_STAFF`) để phát thông báo tới bệnh nhân và bác sĩ.
     - Ghi nhận Audit Log hành động `CANCEL_APPOINTMENT` và `RESCHEDULE_APPOINTMENT`.
- **Mặc định đã chọn:**
  - Route:
    + `PUT /appointments/cancel/:id` (phân quyền `requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN)`).
    + `PUT /appointments/reschedule/:id` (phân quyền `requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN)`).
- **Biến env để đổi:** Không cần biến env mới.

---

## 12. Thiết kế Nghiệp vụ UC-REC-06: Lễ tân duyệt yêu cầu hủy ca của bác sĩ (Doctor Shift Cancellation Review)

- **Vấn đề:**
  1. Trong hệ thống Java cũ, bác sĩ gửi yêu cầu hủy ca nhưng hệ thống chỉ đổi trạng thái của yêu cầu mà không cập nhật ca trực (`DoctorShift`) hay hủy/dời các lịch hẹn đã đặt (`Appointment`), đồng thời thiếu role guard trên các endpoint duyệt yêu cầu.
  2. Endpoint quản lý yêu cầu hủy ca trực:
     - `GET /shifts/cancellation-requests/pending`: Danh sách yêu cầu `PENDING` (hỗ trợ phân trang `page`, `limit`), kèm số lượng booking thực tế bị ảnh hưởng (`affectedAppointmentCount`) và thống kê tóm tắt (`summary`).
     - `PUT /shifts/cancellation-requests/:id/approve`: Duyệt yêu cầu hủy ca.
     - `PUT /shifts/cancellation-requests/:id/reject`: Từ chối yêu cầu hủy ca (bắt buộc có `note`).
  3. Quyền thực thi: Chỉ dành cho `RECEPTIONIST` và `ADMIN` (`requireRoles(ROLES.RECEPTIONIST, ROLES.ADMIN)`). Phía tạo yêu cầu (`POST /shifts/:shiftId/cancellation-requests`): Bắt buộc `ROLES.DOCTOR` và `shift.doctorId === actor.userId` (không được tạo hộ bác sĩ khác), không cho phép tạo trùng lặp yêu cầu `PENDING` cho cùng một ca trực.
  4. Duyệt (`Approve`) / Từ chối (`Reject`):
     - Chỉ thực hiện khi request đang ở trạng thái `PENDING` (sử dụng conditional update nguyên tử `status: 'PENDING'`).
     - Lưu đầy đủ định danh người duyệt/từ chối `approvedBy` / `rejectedBy` / `decidedBy` (String/ObjectId lấy trực tiếp từ JWT), `approvedAt` / `rejectedAt` / `decidedAt` (UTC Date) và `decisionNote`.
     - Reject bắt buộc có `note` không rỗng (trả 400 `REJECTION_NOTE_REQUIRED` nếu thiếu).
     - Xử lý lặp (Idempotent): Nếu yêu cầu đã ở trạng thái đích (`APPROVED` hoặc `REJECTED`), hệ thống trả về bản ghi hiện tại kèm HTTP 200 mà không gây xung đột hay phát sinh side-effect lặp lại.
  5. **Chính sách Xử lý Lịch hẹn bị ảnh hưởng (`SHIFT_CANCEL_POLICY`):**
     - Mặc định: `BLOCK_UNTIL_RESOLVED`. Nếu ca trực còn bất kỳ lịch hẹn nào đang hoạt động (`PENDING_PAYMENT`, `PENDING_CONFIRMATION`, `CONFIRMED`, `CHECKED_IN`), hệ thống từ chối duyệt với HTTP 409 `SHIFT_HAS_ACTIVE_BOOKINGS`, trả về danh sách lịch hẹn cần xử lý, yêu cầu lễ tân đổi lịch hoặc hủy từng lịch (theo luồng `UC-REC-05`) trước khi duyệt hủy ca.
     - Chế độ `AUTO_CANCEL_AFFECTED`: Khi được bật qua cấu hình env `SHIFT_CANCEL_POLICY=AUTO_CANCEL_AFFECTED` (hoặc truyền qua body request `{ policy: 'AUTO_CANCEL_AFFECTED' }`), hệ thống tự động tái sử dụng logic hủy lịch của `UC-REC-05` (`cancelAppointmentByStaff`) cho từng ca khám: gắn cờ `refundRequired=true` nếu đã thanh toán, giải phóng slot và phát outbox thông báo cho từng bệnh nhân.
  6. **Đổi trạng thái Ca trực & Slot:**
     - Khi đủ điều kiện duyệt: Ca trực chuyển `status: 'CANCELLED'`.
     - Toàn bộ slot chưa đặt (`status: 'AVAILABLE'`) trong ca trực được cập nhật nguyên tử chuyển sang `CANCELLED`.
  7. **Hậu kiểm & Sự kiện (Post-commit):**
     - Ghi nhận Transactional Outbox event (`SHIFT_CANCELLATION_APPROVED` / `SHIFT_CANCELLATION_REJECTED`) để thông báo cho bác sĩ phụ trách.
     - Ghi nhận Audit Log hành động `APPROVE_SHIFT_CANCEL` và `REJECT_SHIFT_CANCEL`.
- **Mặc định đã chọn:**
  - Route:
    + `GET /shifts/cancellation-requests/pending`
    + `PUT /shifts/cancellation-requests/:id/approve`
    + `PUT /shifts/cancellation-requests/:id/reject`
  - Biến env: `SHIFT_CANCEL_POLICY=BLOCK_UNTIL_RESOLVED`.
- **Lý do:** Đảm bảo bảo vệ quyền lợi của bệnh nhân đã đặt lịch trước khi bác sĩ được phép hủy ca, tránh triệt để tình trạng bỏ rơi bệnh nhân đến khám, hỗ trợ đầy đủ cả 2 chế độ xử lý linh hoạt và kiểm soát phân quyền chặt chẽ.
- **Biến env để đổi:** `SHIFT_CANCEL_POLICY=BLOCK_UNTIL_RESOLVED` (hoặc `AUTO_CANCEL_AFFECTED`).

---

## 13. Thiết kế Nghiệp vụ UC-REC-07: Lễ tân xác nhận người tham dự event (Event Attendance Confirmation)

- **Vấn đề & Bối cảnh:**
  1. Phòng khám tổ chức các sự kiện y tế/tri ân khách hàng (`Event`). Người dùng (Bệnh nhân) đăng ký tham gia sự kiện trước (`EventRegistration` có `status: 'PENDING'`).
  2. Khi người tham dự đến sự kiện, Lễ tân hoặc Quản trị viên thực hiện check-in/xác nhận tham gia tại quầy.
  3. Nếu sự kiện có gắn mã quà tặng (`voucherId`), hệ thống tự động cấp `UserVoucher` cho người tham dự.
- **Quy tắc Nghiệp vụ Chi tiết:**
  1. **Endpoint & Nhóm định tuyến:**
     - Bảo toàn nhóm route `/reception/events/*` theo thiết kế Frontend:
       + `GET /reception/events`: Lấy danh sách sự kiện kèm mảng người đăng ký `registrations[]`.
       + `POST /reception/events/:eventId/confirm/:userId`: Xác nhận người tham dự theo `eventId` và `userId`.
  2. **Phân quyền (RBAC):**
     - Chỉ cho phép `ROLES.RECEPTIONIST` và `ROLES.ADMIN`. Các vai trò khác (`Patient`, `Doctor`) bị chặn với HTTP 403 `FORBIDDEN_ROLE`.
  3. **Truy vấn & Đảm bảo toàn vẹn dữ liệu:**
     - Tìm kiếm đăng ký theo cặp khóa `eventId` + `userId`.
     - Không tìm thấy đăng ký -> HTTP 404 `REGISTRATION_NOT_FOUND` (hoặc `EVENT_NOT_FOUND` nếu không tìm thấy sự kiện).
     - Đảm bảo unique index compound `{ eventId: 1, userId: 1 }` trên collection `event_registrations` để ngăn chặn hoàn toàn việc tạo trùng bản ghi đăng ký.
  4. **Chính sách Trạng thái Sự kiện (Event Status & Expiry Policy):**
     - **Sự kiện đã bị đóng/tắt kích hoạt (`isEnabled: false`):** Trả về HTTP 409 `EVENT_CLOSED`, từ chối check-in.
     - **Sự kiện đã hết hạn (`endDate < clock.now()`):** Trả về HTTP 409 `EVENT_EXPIRED`, từ chối check-in.
  5. **Chuyển đổi trạng thái nguyên tử (Conditional Update) & Tính Idempotency:**
     - Chỉ chuyển đổi trạng thái khi đăng ký ở `status: 'PENDING'` bằng conditional atomic update: `{ _id, status: 'PENDING' }`.
     - Cập nhật `status = 'CONFIRMED'`, `confirmedBy = userId` (lấy trực tiếp từ JWT payload của actor), `confirmedAt = clock.now()` (UTC Date).
     - **Xử lý lặp (Idempotent):** Nếu đăng ký đã ở trạng thái `CONFIRMED`, hệ thống trả về HTTP 200 kèm dữ liệu hiện hành và cờ `idempotent: true`, không báo lỗi và không cấp trùng voucher.
  6. **Cấp Voucher Tự động (Automatic Voucher Issuance):**
     - Nếu sự kiện có `voucherId` và voucher đó còn hiệu lực (`enable: true`), hệ thống kiểm tra và tự động tạo bản ghi `UserVoucher` (`{ voucherId, userId, voucherCode, voucherName, discountValue, type, expiryDate, issuedAt, used: false }`).
     - Chống cấp trùng voucher nếu người dùng đã có voucher của sự kiện đó.
  7. **Kiểm toán (Audit Trail):**
     - Ghi nhận `AuditLog` với action `CONFIRM_EVENT_ATTENDANCE`, lưu trữ định danh nhân viên thực hiện, thông tin người tham dự và sự kiện.
- **Mặc định đã chọn:**
  - Route: `POST /reception/events/:eventId/confirm/:userId`
  - Unique index: `{ eventId: 1, userId: 1 }` trên `event_registrations`.
  - Expiry Policy: Kiểm tra `isEnabled` và `endDate` so với `clock.now()`.
- **Lý do:** Đáp ứng chính xác giao diện quản lý sự kiện của Lễ tân, bảo toàn RBAC, chống xung đột song song (concurrency-safe), và đảm bảo tính idempotent tuyệt đối khi thao tác nhiều lần.

---

## 14. Thiết kế Nghiệp vụ UC-REC-02: Lễ tân xem lịch vận hành (Receptionist Operational Schedule)

- **Vấn đề & Bối cảnh:**
  1. Lễ tân và Quản trị viên cần xem toàn bộ lịch vận hành trong ngày hoặc một khoảng ngày nhất định, bao gồm:
     - Danh sách các ca làm việc của bác sĩ (`DoctorShift`).
     - Danh sách các lịch hẹn khám (`Appointment`) đã được đặt.
  2. Frontend React/Vite hiện tại đang gọi các API:
     - `GET /appointments/by-date?date=YYYY-MM-DD`
     - `GET /appointments/status/:status?date=YYYY-MM-DD`
     - `GET /appointments/by-shift/:shiftId`
     - `GET /shifts/by-date?date=YYYY-MM-DD`
  3. Cần cung cấp endpoint tổng hợp chuẩn vận hành `GET /appointments/schedule` (trả về cả `appointments` và `shifts` kèm metadata phân trang và bộ lọc) đồng thời giữ tương thích ngược hoàn toàn với các endpoint đơn lẻ mà Frontend đang sử dụng.

- **Quy tắc Nghiệp vụ Chi tiết:**
  1. **Phân quyền (RBAC):**
     - Chỉ cho phép `ROLES.RECEPTIONIST` và `ROLES.ADMIN`. Các vai trò khác (`Patient`, `Doctor`) bị chặn với HTTP 403 `FORBIDDEN_ROLE`.
  2. **Bộ lọc Ngày & Giới hạn Khoảng ngày:**
     - Cho phép lọc theo ngày cụ thể (`date`) hoặc khoảng ngày (`startDate` và `endDate`).
     - Ngày giờ được xử lý theo múi giờ phòng khám (`CLINIC_TIMEZONE`, mặc định `Asia/Ho_Chi_Minh`). Nếu không truyền ngày, hệ thống mặc định lấy ngày hôm nay theo `clock.today()`.
     - **Giới hạn khoảng ngày:** Tối đa 31 ngày. Nếu vượt quá 31 ngày, hệ thống từ chối với HTTP 400 và mã lỗi `DATE_RANGE_EXCEEDED`.
     - Nếu `startDate > endDate`, trả về HTTP 400 `INVALID_DATE_RANGE`.
  3. **Bộ lọc Bác sĩ & Trạng thái:**
     - `doctorId`: Lọc theo bác sĩ phụ trách.
     - `status`: Lọc theo trạng thái lịch hẹn (`PENDING_CONFIRMATION`, `CONFIRMED`, `CHECKED_IN`, `COMPLETED`, `CANCELLED`... hoặc `ALL`). Hỗ trợ danh sách trạng thái phân cách bằng dấu phẩy.
  4. **Phân trang & Sắp xếp:**
     - Phân trang: `page` (mặc định 1), `limit` (mặc định 20, tối đa 100).
     - Sắp xếp: Luôn sắp xếp theo thứ tự thời gian tăng dần (`appointmentDate ASC, appointmentTime ASC`).
  5. **Bảo mật & Tối thiểu hóa Dữ liệu Nhạy cảm (Minimal PII):**
     - Trả về: Tên bệnh nhân (`patientName`), giờ khám (`appointmentTime`), bác sĩ (`doctorName`, `doctorId`), chuyên khoa (`specialtyName`, `specialtyId`), ca trực (`shiftId`), hình thức (`type`: `ONLINE`/`OFFLINE`), trạng thái (`status`), lý do rút gọn (`reason` tối đa 100 ký tự).
     - **TUYỆT ĐỐI KHÔNG TRẢ VỀ:** Đơn thuốc (`prescriptions`), bệnh sử khám (`medical history`, chẩn đoán chi tiết), mật khẩu/mã băm (`password`, `passwordHash`), hay thông tin danh tính nhạy cảm khác.
  6. **Đánh chỉ mục (Indexing) & Hiệu năng Query:**
     - Bắt buộc sử dụng compound index trên `appointments`:
       + `{ doctorId: 1, appointmentDate: 1, status: 1 }`
       + `{ appointmentDate: 1, appointmentTime: 1 }`
       + `{ appointmentDate: 1, status: 1 }`
     - Bắt buộc index trên `doctor_shifts`:
       + `{ date: 1, startTime: 1 }`
     - Đã kiểm tra qua MongoDB `explain('executionStats')` để đảm bảo truy vấn sử dụng chỉ mục (`IXSCAN`), tuyệt đối không để xảy ra quét toàn bộ bộ sưu tập (`COLLSCAN`).
  7. **Phạm vi Phòng khám (`clinicId` Scope):**
     - **Hiện trạng:** Trong cơ sở dữ liệu hiện tại, các schema `User`, `Appointment`, `DoctorShift` chưa có trường `clinicId` (hệ thống hiện tại hoạt động theo mô hình phòng khám đơn lẻ - single clinic).
     - **Quyết định:** Bỏ qua bộ lọc theo `clinicId` ở cấp cơ sở dữ liệu để đảm bảo tương thích với cấu trúc schema hiện có; sẵn sàng mở rộng thêm khi hệ thống tiến hành nâng cấp multi-tenancy trong tương lai.

- **Mặc định đã chọn:**
  - Route tổng hợp: `GET /appointments/schedule` (trả về `{ appointments, shifts, pagination, filter }`).
  - Route tương thích:
    + `GET /appointments/by-date`
    + `GET /appointments/status/:status`
    + `GET /appointments/by-shift/:shiftId`
    + `GET /shifts/by-date`
  - Max date range: 31 ngày (HTTP 400 `DATE_RANGE_EXCEEDED`).
  - Pagination: Default 20, Max 100.
  - Reason truncation: 100 ký tự.

