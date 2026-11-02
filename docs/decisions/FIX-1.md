# Quyết định Kỹ thuật FIX-1: Cải tiến Luồng Thanh toán & Đối soát Lịch hẹn (Payment Flow Overhaul & Reconciliation)

### 1. Bối cảnh & Vấn đề (Context & Problem Statement)
- Trước thay đổi này, việc đặt lịch khám chưa có sự tách bạch rõ ràng giữa lịch khám trực tuyến (ONLINE) và trực tiếp (OFFLINE) trong luồng thanh toán trước (pre-payment).
- Lịch hẹn khám ONLINE nếu không thanh toán trước dẫn đến tình trạng chiếm giữ slot của bác sĩ mà không có sự ràng buộc, hoặc khi vào khám (`/appointments/:id/join-online`) mới bị chặn nhưng không có hướng dẫn thanh toán kèm URL.
- Quá trình callback IPN từ cổng thanh toán VNPay có thể gặp lỗi tạm thời khi cập nhật trạng thái lịch hẹn (state transition failure) hoặc tiền về khi lịch hẹn đã bị hủy/hết hạn giữ chỗ, dẫn đến bất đồng bộ dữ liệu giao dịch và lịch hẹn.
- Frontend (`web/src/pages/appointments/steps/Step4.tsx`) hiện vẫn sử dụng HTTP GET `/payment/create` để tạo giao dịch thanh toán.

---

### 2. Quyết định & Hành vi chuẩn hóa (Decisions & Defaults)

#### a) Chính sách tạo lịch hẹn (Booking Policy - Hướng A)
- **Lịch ONLINE có phí**: Khi `type === 'ONLINE'`, biến cấu hình `ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN=true`, và phí khám của lịch (`consultationFee` của bác sĩ $\times$ số lượng bệnh nhân) $> 0$:
  + Lịch hẹn được tạo ở trạng thái ban đầu là `PENDING_PAYMENT`.
  + `paymentStatus` được gán giá trị `'PENDING'`.
  + Phản hồi trả về bổ sung `requiresPayment: true` và `paymentDueAt` (thời điểm hết hạn thanh toán tính từ `createdAt` + `PAYMENT_APPOINTMENT_HOLD_MINUTES`).
  + Slot khám của bác sĩ vẫn được giữ ở trạng thái `BOOKED` với `bookingRef = appointmentNo` trong suốt thời gian giữ chỗ.
- **Lịch OFFLINE hoặc ONLINE phí 0**:
  + Được tạo ở trạng thái `PENDING_CONFIRMATION` như cũ.
  + `requiresPayment: false`.
  + Không đi qua luồng thanh toán online bắt buộc.

#### b) Quản lý trạng thái & Quyền thao tác
- **Danh sách upcoming & Hủy lịch của Patient**:
  + Thêm trạng thái `PENDING_PAYMENT` vào danh sách lịch sắp tới (upcoming) và danh sách trạng thái cho phép bệnh nhân chủ động hủy.
  + Khi bệnh nhân hủy lịch hẹn `PENDING_PAYMENT`, hệ thống tự động giải phóng slot (`AVAILABLE`, xóa `bookingRef`) và hoàn lại voucher người dùng đang giữ (`used: false`, `appointmentId: null`).
  + Đếm giới hạn lịch chờ (`maxPendingAppointmentsPerPatient`) tính cả `PENDING_CONFIRMATION` và `PENDING_PAYMENT`.
- **Lễ tân xác nhận lịch hẹn**:
  + Nếu lễ tân cố tình xác nhận một lịch hẹn đang ở trạng thái `PENDING_PAYMENT`, hệ thống trả về mã lỗi HTTP 409 `INVALID_STATE` kèm thông điệp `"Không thể xác nhận lịch hẹn: lịch đang chờ thanh toán"`.

#### c) Xử lý Callback VNPay (IPN/Return) & Đối soát (Reconciliation)
- Khi nhận callback thanh toán thành công (`vnp_ResponseCode === '00'`):
  + Cập nhật trạng thái `PaymentTransaction` thành `SUCCESS`.
  + Chuyển trạng thái lịch hẹn `PENDING_PAYMENT` sang `CONFIRMED` (theo `PAYMENT_SUCCESS_TARGET_STATE_ONLINE`) qua `appointmentStateService.transition`, cập nhật `paymentStatus = 'PAID'`.
  + **Xử lý lỗi bất đồng bộ**: Nếu quá trình transition lịch hẹn gặp lỗi và lịch chưa ở trạng thái đích, hệ thống ghi log lỗi (không lộ secret/signature), đánh dấu cờ `needsReconcile = true` trên bản ghi `PaymentTransaction`, ghi audit log `PAYMENT_STATE_SYNC_FAILED`, và IPN vẫn phản hồi `RspCode: '00'` cho VNPay để tránh bị retry vô hạn.
  + **Tiền về muộn khi lịch đã hủy/hết hạn**: Nếu lịch hẹn đã ở trạng thái `CANCELLED` hoặc `EXPIRED` khi tiền về thành công, hệ thống đánh dấu `refundRequired = true` và `paymentStatus = 'PAID'` trên lịch hẹn, gán `needsReconcile = true` trên transaction, ghi audit log, và tuyệt đối không ép lịch chuyển sang `CONFIRMED`.

#### d) Tương thích dữ liệu cũ (Backward Compatibility)
- Tại `onlineConsultation.service.js`:
  + Chỉ bắt buộc kiểm tra thanh toán thành công nếu `ONLINE_REQUIRE_PAYMENT_BEFORE_JOIN=true` VÀ lịch thuộc luồng thanh toán (có `paymentStatus` hoặc đã tồn tại `PaymentTransaction`).
  + Các lịch ONLINE cũ tạo trước thay đổi (không có trường `paymentStatus` và không có transaction) vẫn được phép tham gia phòng khám online bình thường khi đã được xác nhận.
  + Nhánh `PAYMENT_REQUIRED` sẽ tự động sinh và đính kèm `paymentUrl` nếu lịch đang ở `PENDING_PAYMENT` và còn trong thời hạn giữ chỗ.

#### e) Giữ route GET `/payment/create` và GET `/payments/create`
- Do giao diện web (`web/src/pages/appointments/steps/Step4.tsx`) hiện gọi `http.get('/payment/create', ...)`, hệ thống duy trì hỗ trợ phương thức GET song song với POST chuẩn RESTful để tránh phá vỡ giao diện người dùng.
- **Khuyến nghị**: Đội ngũ phát triển Frontend nên chuyển dần lời gọi tạo URL thanh toán sang phương thức HTTP POST.

#### f) Job nền bảo trì thanh toán (`src/jobs/paymentMaintenance.job.js`)
- Cung cấp 3 hàm xuất khẩu: `start()`, `stop()`, `runOnce()`.
- Được khởi động cùng server trong `src/server.js` khi `PAYMENT_JOB_ENABLED=true` và môi trường không phải `test`; tự động dừng khi shutdown ứng dụng (SIGINT/SIGTERM). Timer sử dụng `.unref()` để không treo event loop.
- Trong mỗi chu kỳ `runOnce()`, thực hiện tuần tự với cờ chống chạy chồng:
  1. **Dọn dẹp giao dịch quá hạn**: Các giao dịch `PENDING` quá `expiresAt` chuyển sang `EXPIRED` và giải phóng voucher.
  2. **Hết hạn giữ lịch hẹn**: Các lịch `PENDING_PAYMENT` có thời gian tạo $\le \text{now} - \text{HOLD}$ mà không có giao dịch `SUCCESS` hoặc `PENDING` hợp lệ sẽ chuyển sang `EXPIRED`, giải phóng slot của bác sĩ về `AVAILABLE`, hoàn voucher về người dùng, ghi audit log `APPOINTMENT_PAYMENT_EXPIRED`, và ghi outbox thông báo bệnh nhân.
  3. **Đối soát giao dịch**: Các giao dịch `SUCCESS` có cờ `needsReconcile === true` được thử chuyển trạng thái lịch hẹn lại; nếu thành công thì gỡ cờ `needsReconcile = false` và ghi audit log `PAYMENT_RECONCILED`.

---

### 3. Cấu hình & Biến môi trường (Configuration)

| Biến môi trường | Kiểu dữ liệu | Giá trị mặc định | Mô tả |
| :--- | :--- | :--- | :--- |
| `PAYMENT_APPOINTMENT_HOLD_MINUTES` | Number | `30` | Thời gian giữ chỗ lịch hẹn `PENDING_PAYMENT` (phút). Nếu nhỏ hơn `PAYMENT_PENDING_TTL_MINUTES`, ConfigService tự động nâng lên bằng TTL |
| `PAYMENT_JOB_ENABLED` | Boolean | `true` | Bật/tắt tiến trình nền dọn dẹp và đối soát thanh toán |
| `PAYMENT_JOB_INTERVAL_MS` | Number | `60000` | Chu kỳ chạy job nền (mili-giây) |
| `VNP_IPN_URL` | String | `http://localhost:3000/api/payments/vnpay-ipn` | Đường dẫn IPN chuẩn xác khớp với router backend |
| `AUDIT_ACTIONS` mới | Enum | - | `PAYMENT_STATE_SYNC_FAILED`, `PAYMENT_RECONCILED`, `APPOINTMENT_PAYMENT_EXPIRED` |
| `needsReconcile` | Boolean | `false` | Trường mới đánh chỉ mục (index) trong model `PaymentTransaction` |

---

### 4. Vị trí Model UserVoucher & Bổ sung trường `appointmentId` (Schema Alignment)
- **Vị trí Model**: Tại commit `74055e1` trên `origin/main`, model `UserVoucher` đã được tách độc lập thành `backend/src/models/userVoucher.model.js`.
- **Lý do bổ sung `appointmentId`**: Trong `userVoucherSchema` tại commit `74055e1`, trường `appointmentId` đã bị lược bỏ ngoài ý muốn so với đặc tả `docs/FIELD_MAP.md` (mục 4) và phiên bản schema trước đó trong `voucher.model.js`. Việc thiếu trường này khiến Mongoose loại bỏ `appointmentId` khi cập nhật (`UserVoucher.updateOne`), dẫn đến việc gắn lịch hẹn khi sử dụng voucher (`voucherRedemptionService.redeem`) và giải phóng hoàn voucher (`voucherRedemptionService.release`) khi hủy lịch hoặc hết hạn giữ chỗ thanh toán bị lỗi `VOUCHER_APPOINTMENT_MISMATCH`.
- **Giải pháp**: Khai báo bổ sung trường `appointmentId: { type: Number, default: null, index: true }` vào `userVoucherSchema` trong `backend/src/models/userVoucher.model.js`, đảm bảo document `UserVoucher` lưu được ID lịch hẹn và hàm `release()` đối soát chính xác lịch hẹn tương ứng.
