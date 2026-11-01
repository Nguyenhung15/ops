# UC-REC-01: Củng cố Tra cứu người dùng và Voucher (Lễ tân / Admin)

### 1. Vấn đề (Context & Problem Statement)
- Bối cảnh: Lễ tân và Quản trị viên cần tra cứu hồ sơ người dùng theo từ khóa (tên, email, số điện thoại) và kiểm tra danh sách voucher của bệnh nhân để áp dụng giảm giá trực tiếp tại quầy tiếp đón.
- Rủi ro an toàn và hiệu năng:
  1. Tra cứu bằng từ khóa không kiểm soát (rỗng, ngắn hơn 3 ký tự, hoặc chuỗi toàn ký tự wildcard như `.*`, `*`, `%`, `_`) có thể gây quét toàn bộ cơ sở dữ liệu (full collection scan) hoặc ReDoS (Regular Expression Denial of Service).
  2. Rò rỉ thông tin định danh cá nhân (PII) và dữ liệu nhạy cảm: `password`, `passwordHash`, OAuth tokens, cũng như hồ sơ y tế, đơn thuốc.
  3. Lạm dụng tra cứu hàng loạt (scraping) gây quá tải server nếu thiếu rate limit per-user.
  4. Tranh chấp sử dụng voucher (race conditions) khi hai nhân viên hoặc hai phiên thao tác cùng kích hoạt một voucher cùng lúc, hoặc áp dụng voucher đã hết hạn / bị vô hiệu hóa (`enable: false`).

### 2. Mặc định & Lựa chọn (Decision & Default)
- **Chuẩn hóa & Bảo vệ tìm kiếm người dùng (`GET /users/search`)**:
  + Bắt buộc từ khóa tìm kiếm (`keyword`) tối thiểu 3 ký tự. Từ khóa rỗng hoặc chỉ chứa ký tự đại diện/ký tự đặc biệt (`.*`, `*`, `%`, `_`) trả về `400 Bad Request` (`INVALID_KEYWORD_LENGTH` hoặc `INVALID_KEYWORD_FORMAT`).
  + Sử dụng hàm `escapeRegex` làm sạch từ khóa trước khi đưa vào biểu thức chính quy (case-insensitive regex) để chống injection và ReDoS.
  + Phân trang bắt buộc: `limit` mặc định là 10 và bị cắt giới hạn cứng tối đa là 20 (`Math.min(20, Math.max(1, limit))`).
  + Projection tối thiểu: Chỉ trả về `id`, `fullName`, `email` (đã mask), `phoneNumber`/`phone` (đã mask), `role`/`userType`, `isEnabled`/`isEnable`. Tuyệt đối loại trừ và không bao giờ rò rỉ `password`, `passwordHash`, OAuth tokens, hồ sơ bệnh án.
  + Che giấu PII (Masking): Email được che theo định dạng `a***@domain` và số điện thoại theo định dạng `09****123` (giữ 2 số đầu, 3 số cuối, che 4 số giữa).
- **Xem và sử dụng Voucher của người dùng**:
  + `GET /vouchers/user/:userId`: Kiểm tra và trả về danh sách voucher kèm các trường thông tin cơ bản: `id`, `voucherId`, `code`, `name`, `discountValue`, `type`, `expiryDate`, `issuedAt`, `used`, `usedAt`, `userId`, `userFullName`.
  + `POST /vouchers/:voucherId/use?userId=...`:
    * Kiểm tra tính hợp lệ của `userId` và `voucherId` (số nguyên dương an toàn).
    * Kiểm tra voucher người dùng có tồn tại và thuộc sở hữu của đúng `userId`.
    * Kiểm tra thời hạn hiệu lực của voucher người dùng (`expiryDate`) so với thời gian hiện tại từ `clock.service`.
    * Kiểm tra trạng thái của voucher gốc (`Voucher.enable !== false` và voucher gốc chưa hết hạn).
    * Áp dụng **atomic conditional update** trên MongoDB: `findOneAndUpdate({ _id: existingUserVoucher._id, used: false }, { $set: { used: true, usedAt: now } })` để ngăn ngừa race condition tuyệt đối. Nếu gọi lại voucher đã sử dụng, hệ thống xử lý idempotent an toàn.
- **Rate Limiting theo người dùng gọi (`userId`)**:
  + Áp dụng `createRateLimiter` cho cả endpoint tìm kiếm `GET /users/search` và endpoint xem voucher `GET /vouchers/user/:userId`.
  + Giới hạn dựa trên JWT `userId` của tài khoản nhân viên đang đăng nhập, fallback theo client IP.
  + Vượt quá giới hạn trả về `429 Too Many Requests` (`RATE_LIMIT_EXCEEDED`) kèm header `Retry-After` và `X-RateLimit-*`.
- **Ghi vết kiểm toán (Audit Logging)**:
  + Ghi audit đầy đủ qua `recordAudit` cho `SEARCH_USERS`, `VIEW_USER_VOUCHERS` và `USE_VOUCHER`.
  + Tuyệt đối không ghi thông tin PII đầy đủ vào reason hay changes của audit log; chỉ lưu `keywordHash` (SHA-256 rút gọn 16 ký tự), độ dài từ khóa, số lượng kết quả trả về và định danh tài nguyên.
- **Phân quyền nghiêm ngặt (Role-Based Access Control)**:
  + Chỉ cho phép vai trò `Receptionist` và `Admin`.
  + Mọi truy cập từ vai trò `Patient` hoặc `Doctor` đều bị từ chối với mã lỗi `403 Forbidden` (`FORBIDDEN_ROLE`).

### 3. Lý do (Rationale)
- Việc validate chặt từ khóa và giới hạn kết quả tối đa 20 giúp bảo vệ tài nguyên hệ thống, ngăn ngừa rò rỉ dữ liệu qua tấn công suy diễn (inference attacks).
- Conditional update với điều kiện `used: false` trên tầng database đảm bảo tính nguyên tử (atomicity) mà không phụ thuộc vào lock phân tán phức tạp.
- Sử dụng `clock.service` để kiểm tra thời gian hết hạn giúp hệ thống có thể kiểm thử linh hoạt với fake clock / timezone cố định.

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- `RECEPTION_SEARCH_RATE_PER_MIN`: Số lượng yêu cầu tra cứu tối đa cho phép trong mỗi phút cho mỗi nhân viên tiếp đón (mặc định: 30 lượt/phút).
- `JWT_SECRET`: Khóa bí mật dùng để xác thực danh tính và trích xuất vai trò (`role`/`userType`) từ JWT.
