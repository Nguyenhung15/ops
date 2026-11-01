# UC-PAT-10 & UC-SYS-03: VNPay Payment Integration & Cleanup Job

### 1. Vấn đề (Context & Problem Statement)
- **Bối cảnh:**
  - Bệnh nhân (Patient) đặt lịch khám ONLINE (hoặc OFFLINE có yêu cầu thanh toán trước) cần thực hiện thanh toán trực tuyến qua cổng VNPay.
  - Sau khi người dùng thanh toán trên cổng VNPay, hệ thống nhận callback qua hai kênh:
    1. **Return URL (`GET /payment/vnpay-return`):** Kênh đồng bộ khi trình duyệt người dùng được redirect về FE.
    2. **IPN URL (`GET /payment/vnpay-ipn`):** Kênh webhook server-to-server bất đồng bộ từ VNPay.
  - Các giao dịch `PENDING` bị bỏ dở hoặc quá hạn (`expiresAt <= now`) cần được định kỳ dọn dẹp và hoàn lại voucher khuyến mãi đã giữ chỗ cho bệnh nhân (UC-SYS-03).
- **Thách thức và yêu cầu kỹ thuật:**
  1. **Tính toán số tiền:** Phí khám được tính toán chặt chẽ trên backend từ `doctor.consultationFee` (từ `User` model) nhân số lượng bệnh nhân `appointment.patients.length || 1`, trừ đi `discountAmount` từ `voucherRedemption.service.js`. Client gửi lên `amount` gì cũng bị bỏ qua để ngăn chặn gian lận giá (price tampering). Số tiền gửi sang VNPay bắt buộc nhân 100 theo chuẩn tiền tệ VNPay.
  2. **Bảo mật và toàn vẹn:**
     - Xác thực chữ ký số HMAC-SHA512 bằng `crypto.timingSafeEqual`.
     - Tuyệt đối không log secret key, hash secret, hoặc lưu thông tin thẻ/tài khoản ngân hàng của khách hàng.
     - Lịch hẹn phải thuộc về người dùng trong JWT, trạng thái phải là `PENDING_PAYMENT`, chưa có giao dịch `SUCCESS` nào trước đó.
     - Vô hiệu hóa giao dịch `PENDING` cũ trước khi tạo giao dịch mới để tránh có nhiều giao dịch hợp lệ song song cho cùng một lịch hẹn.
  3. **Tính Idempotent & Concurrency:**
     - Sử dụng conditional update `PENDING -> SUCCESS/FAILED`. Callback lặp lại 2-5 lần chỉ được xử lý đúng 1 lần duy nhất, các lần sau trả kết quả cũ mà không thực hiện lại side-effect.
     - IPN trả chuẩn mã lỗi VNPay: `97` (Invalid checksum), `01` (Order not found), `04` (Invalid amount), `02` (Order already confirmed), `00` (Confirm success).
  4. **State Machine sau thanh toán:**
     - Sau khi thanh toán thành công, trạng thái lịch hẹn phải được chuyển đổi qua `appointmentStateService.transition(...)`.
     - Điểm cần chủ sản phẩm chốt: Lịch ONLINE chuyển sang `CONFIRMED` hay `PENDING_CONFIRMATION`? Tương tự với lịch OFFLINE.

### 2. Mặc định & Lựa chọn (Decision & Default)
- **State sau thanh toán thành công:**
  - **Lịch ONLINE:** Chuyển sang `CONFIRMED` (cấu hình qua `PAYMENT_SUCCESS_TARGET_STATE_ONLINE`, mặc định `CONFIRMED`) vì khám từ xa đã được thanh toán đầy đủ, có thể tham gia phòng khám trực tuyến đúng giờ.
  - **Lịch OFFLINE:** Chuyển sang `PENDING_CONFIRMATION` (cấu hình qua `PAYMENT_SUCCESS_TARGET_STATE_OFFLINE`, mặc định `PENDING_CONFIRMATION`) để lễ tân kiểm tra và sắp xếp phòng khám thực tế tại cơ sở y tế.
  - *Lưu ý:* Đây là điểm cấu hình linh hoạt qua biến môi trường để chủ sản phẩm (Product Owner) có thể điều chỉnh theo quy trình vận hành thực tế của phòng khám mà không cần sửa code.
- **Xử lý khi thanh toán thất bại:**
  - Giao dịch được đánh dấu `FAILED`.
  - Giải phóng voucher (nếu có) thông qua `voucherRedemptionService.release(...)` để bệnh nhân có thể sử dụng lại cho lần đặt tiếp theo.
  - Lịch hẹn vẫn giữ nguyên trạng thái `PENDING_PAYMENT` để bệnh nhân có thể thử thanh toán lại trước khi hết hạn ca khám.
- **Job dọn dẹp giao dịch quá hạn (UC-SYS-03):**
  - Hàm `paymentService.cleanupExpiredTransactions()` quét các giao dịch có `status: 'PENDING'` và `expiresAt <= clock.now()`.
  - Cập nhật batch idempotent `PENDING -> EXPIRED` và tự động giải phóng voucher liên kết qua `voucherRedemptionService.release(...)`.
  - Do LUẬT FILE không cho phép sửa `server.js`, logic dọn dẹp được đóng gói và export hoàn chỉnh dưới dạng service method sẵn sàng để cron worker / scheduler gọi định kỳ.
- **Bảo mật và nhật ký:**
  - Ghi Outbox Event: `PAYMENT_SUCCESS` và `PAYMENT_FAILED` phục vụ gửi email thông báo và cập nhật socket.
  - Ghi Audit Log: `PAYMENT_CREATED`, `PAYMENT_SUCCESS`, `PAYMENT_FAILED`.
  - Endpoint `GET /payments` (và alias `GET /payment/my`): Chỉ trả về các giao dịch thuộc về `userId` trong JWT, có phân trang, bảo vệ quyền riêng tư người dùng.

### 3. Lý do (Rationale)
- Việc tạo hai route feature độc lập `routes/features/payment.routes.js` và `routes/features/payments.routes.js` đảm bảo tương thích 100% với cả Frontend (`web/src/pages/appointments/steps/Step4.tsx` gọi `GET /payment/create`) lẫn chuẩn RESTful và cấu hình VNPay callback URL (`VNP_IPN_URL`, `VNP_RETURN_URL`).
- Sử dụng `crypto.timingSafeEqual` loại bỏ triệt để nguy cơ tấn công Timing Attack khi xác thực chữ ký SHA-512.

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- `VNP_TMN_CODE`: Mã website của phòng khám tại hệ thống VNPay.
- `VNP_HASH_SECRET`: Chuỗi bí mật dùng để tạo và xác thực chữ ký HMAC-SHA512.
- `VNP_URL`: URL cổng thanh toán VNPay (mặc định sandbox: `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html`).
- `VNP_RETURN_URL`: URL redirect trình duyệt về sau khi thanh toán.
- `VNP_IPN_URL`: URL webhook server-to-server của backend để nhận thông báo IPN.
- `PAYMENT_PENDING_TTL_MINUTES`: Thời gian giữ chỗ thanh toán (mặc định 15 phút).
- `PAYMENT_SUCCESS_TARGET_STATE_ONLINE`: Trạng thái lịch ONLINE sau khi thanh toán (mặc định `'CONFIRMED'`).
- `PAYMENT_SUCCESS_TARGET_STATE_OFFLINE`: Trạng thái lịch OFFLINE sau khi thanh toán (mặc định `'PENDING_CONFIRMATION'`).
