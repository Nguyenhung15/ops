# UC-PAT-09: Patient Xem và Sử Dụng Voucher (/vouchers/my)

### 1. Vấn đề (Context & Problem Statement)
- Bối cảnh: Bệnh nhân (Patient) cần quản lý các voucher được cấp (từ các sự kiện tham gia, chương trình tri ân), theo dõi tình trạng hiệu lực và áp dụng mã voucher để được giảm giá khi đặt lịch khám hoặc thanh toán dịch vụ.
- Thách thức và yêu cầu kỹ thuật:
  1. Bảo mật và cách ly người dùng: Endpoint `GET /vouchers/my` chỉ được trả về danh sách voucher thuộc sở hữu của bệnh nhân đăng nhập (dựa trên JWT `userId`), tuyệt đối không làm lộ voucher của người khác.
  2. Tránh xung đột đường dẫn: Router cũ của Lễ tân (`routes/voucher.routes.js`) đang quản lý `GET /vouchers/user/:userId` và `POST /vouchers/:voucherId/use`. Router mới của Patient phải sử dụng sub-path riêng biệt (`/vouchers/my`, `/vouchers/my/:userVoucherId/redeem`), mount qua `routes/features/patientVoucher.routes.js` mà không nuốt nhầm các route của Lễ tân/Admin.
  3. Tính nguyên tử và chống race condition khi áp dụng voucher: Ngăn chặn triệt để tình trạng hai request song song áp dụng cùng một voucher nhiều lần.
  4. Cơ chế hoàn lại (Release): Cần trích xuất logic `redeem` và `release` vào `services/voucherRedemption.service.js` để có thể tái sử dụng cho các use case tiếp theo (như UC-PAT-10 thanh toán và hủy lịch).

### 2. Mặc định & Lựa chọn (Decision & Default)
- **Trạng thái dẫn xuất của Voucher (`derivedStatus`)**:
  + Được tính toán động tại thời điểm query theo thời gian thực từ `clock.service`:
    * `USED`: Nếu `userVoucher.used === true`.
    * `EXPIRED`: Nếu `userVoucher.used === false` và thời gian hiện tại (`clock.now()`) đã vượt quá `userVoucher.expiryDate` (hoặc voucher gốc `Voucher.enable === false`).
    * `AVAILABLE`: Nếu chưa sử dụng, chưa hết hạn và voucher gốc đang được kích hoạt (`enable: true`).
- **Quy tắc tính số tiền giảm giá (`calculateDiscount`)**:
  + Tính toán hoàn toàn trên server dựa vào thông tin của voucher (`discountType`, `discountValue`, `type`) và tổng số tiền (`totalAmount`). Tuyệt đối không tin số tiền giảm do client gửi lên.
  + `discountType === 'AMOUNT'`: Giảm trực tiếp giá trị số tiền cố định.
  + `discountType === 'PERCENT'`: Giảm phần trăm theo công thức `Math.round((totalAmount * discountValue) / 100)`.
  + `type === 'SERVICE_TICKET'`: Là phiếu dịch vụ/khám miễn phí đặc thù, không trừ tiền trực tiếp trên hóa đơn khám (trả về 0đ giảm giá trừ khi cấu hình nghiệp vụ riêng).
  + Giới hạn an toàn: Số tiền giảm luôn là số nguyên không âm và không bao giờ vượt quá `totalAmount`.
- **Áp dụng voucher (`redeem`)**:
  + Bắt buộc vai trò `PATIENT`. Xác minh quyền sở hữu (`userVoucher.userId === actor.userId`), nếu không đúng trả về `404 VOUCHER_NOT_FOUND`.
  + Kiểm tra voucher còn hiệu lực: `VOUCHER_EXPIRED` (409) nếu quá hạn, `VOUCHER_DISABLED` (409) nếu voucher gốc bị tắt.
  + Kiểm tra lịch hẹn liên kết (nếu có `appointmentId`): Lịch hẹn phải thuộc về bệnh nhân và chưa ở trạng thái kết thúc (`COMPLETED`, `CANCELLED`, `EXPIRED`, `NO_SHOW`).
  + Cập nhật nguyên tử: `UserVoucher.updateOne({ id: userVoucherId, userId, used: false }, { $set: { used: true, usedAt: now, appointmentId } })`. Nếu `matchedCount === 0`, trả về ngay `409 VOUCHER_ALREADY_USED`.
  + Ghi Audit Log với action `REDEEM_VOUCHER`.
- **Hoàn lại voucher (`release`)**:
  + Chỉ cho phép hoàn lại voucher khi `userVoucher.appointmentId` khớp chính xác với lịch hẹn đang hủy/giải phóng.
  + Chặn hoàn voucher nếu lịch hẹn đã có giao dịch thanh toán thành công (`PaymentTransaction` với `status: 'SUCCESS'`) -> `409 PAYMENT_ALREADY_SUCCESS`.
  + Cập nhật nguyên tử: `used: true -> false`, `usedAt: null`, `appointmentId: null`. Giữ nguyên lịch sử bản ghi, tuyệt đối không xóa cứng (hard-delete) khỏi cơ sở dữ liệu.
  + Ghi Audit Log với action `RELEASE_VOUCHER`.

### 3. Lý do (Rationale)
- Trích xuất service độc lập [`services/voucherRedemption.service.js`](file:///c:/Code/FA26/SDN302/ClinicBooking/backend/src/services/voucherRedemption.service.js) cho phép cả UC-PAT-09 (áp dụng voucher độc lập) và UC-PAT-10 (tích hợp trong luồng thanh toán VNPay / hủy thanh toán) dùng chung một nguồn logic duy nhất, đảm bảo tính nhất quán và bảo vệ dữ liệu.
- Việc tính số tiền giảm giá trên server và ép kiểu số nguyên loại bỏ triệt để nguy cơ giả mạo số tiền (price tampering).

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- `JWT_SECRET`: Khóa bí mật dùng để xác thực Bearer token và trích xuất `userId` và `role` của người dùng.
