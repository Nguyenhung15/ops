# Quyết định Kỹ thuật FIX-2: Xử lý Đăng ký Sự kiện (PAT-08) & Hệ thống Đánh giá Lịch hẹn (PAT-12)

### 1. Bối cảnh & Vấn đề (Context & Problem Statement)
- **PAT-08 (Đăng ký sự kiện cộng đồng)**:
  + Trước đây, `patientEvent.service.js` bắt mọi lỗi Mongo khi tạo `EventRegistration` và quy về `ALREADY_REGISTERED`. Điều này dẫn đến việc các lỗi nghiêm trọng khác (như lỗi kết nối, validation, disk, hoặc write conflict) bị ẩn đi dưới dạng thông báo đăng ký trùng.
  + Khi giữ chỗ thành công bằng `$inc: { registeredCount: 1 }`, nếu quá trình tạo bản ghi đăng ký thất bại, nhánh lỗi không phải lúc nào cũng hoàn lại `registeredCount`, đặc biệt với sự kiện không giới hạn số lượng (`capacity = null`) hoặc khi gặp lỗi trùng/lỗi hệ thống.
  + Chính sách thời gian cũ yêu cầu `startDate <= now <= endDate` mới cho phép hiển thị và đăng ký sự kiện. Điều này vô hiệu hóa tính năng quan trọng: cho phép bệnh nhân **đăng ký trước (pre-registration)** cho các sự kiện sắp diễn ra.
- **PAT-12 (Đánh giá dịch vụ khám bệnh / Feedback)**:
  + Cần đảm bảo quy tắc "mỗi lịch hẹn chỉ có một feedback đang hoạt động" ở tầng cơ sở dữ liệu để chống race condition.
  + Khi 2 request gửi feedback song song cho cùng một lịch hẹn, hệ thống cần chặn trùng ở mức DB và trả về đúng HTTP 409 `FEEDBACK_EXISTS` (không gây lỗi 500).
  + Khi sửa feedback (comment, title, rating), nội dung phải được lọc sạch mã độc/HTML (XSS sanitization) tương tự như lúc tạo mới. Khi sửa đánh giá đã được duyệt (`PUBLISHED`), trạng thái phải quay về `PENDING` để kiểm duyệt lại.
  + Endpoint công khai `getPublishedAnonymous` phải bảo vệ quyền riêng tư người dùng: tuyệt đối không bao giờ trả ra `userId` hoặc `patientEmail`, và hiển thị đúng tên hoặc 'Ẩn danh' tùy thuộc cờ `isAnonymous`.

---

### 2. Quyết định & Hành vi chuẩn hóa (Decisions & Defaults)

#### a) PAT-08: Quản lý Đăng ký Sự kiện (`src/services/patientEvent.service.js`)
1. **Phân loại lỗi Mongo chính xác**:
   - Chỉ bắt lỗi duplicate key khi `error.code === 11000` (dựa trên unique index `{ eventId: 1, userId: 1 }`) và ném ra lỗi `ApiError(409, 'Bạn đã đăng ký sự kiện này rồi', 'ALREADY_REGISTERED')`.
   - Mọi lỗi Mongo khác (không phải 11000) được ném tiếp (rethrow) để Express error middleware xử lý thành lỗi HTTP 500.
2. **Hoàn tác số lượng đăng ký (`registeredCount`) nhất quán**:
   - Bất kể sự kiện có giới hạn số lượng (`capacity > 0`) hay không giới hạn (`capacity = null`), hệ thống đều tăng giữ chỗ `$inc: { registeredCount: 1 }`.
   - Nếu xảy ra bất kỳ lỗi nào trong quá trình tạo `EventRegistration` (kể cả lỗi 11000 hay lỗi DB khác), hệ thống **BẮT BUỘC** thực hiện rollback giảm 1:
     ```javascript
     await Event.updateOne(
       { id: eventId, registeredCount: { $gt: 0 } },
       { $inc: { registeredCount: -1 } }
     );
     ```
   - Điều kiện `registeredCount: { $gt: 0 }` đảm bảo số lượng đăng ký không bao giờ bị âm khi xảy ra rollback hoặc hủy đăng ký.
3. **Thay đổi chính sách thời gian (Intentional Policy Change)**:
   - **Chính sách mới**: Một sự kiện được coi là đang mở và cho phép đăng ký nếu `isEnabled === true` VÀ `now <= endDate`. Điều này cho phép bệnh nhân đăng ký trước cho các sự kiện tương lai (`startDate > now`).
   - Nếu `now > endDate`, sự kiện bị coi là đã kết thúc và từ chối đăng ký với mã `409 EVENT_CLOSED`.
   - API lấy danh sách sự kiện mở (`GET /events`) lọc theo cùng điều kiện `{ isEnabled: true, endDate: { $gte: now } }` và sắp xếp tăng dần theo thời gian bắt đầu (`startDate: 1`).
   - **Cách quay lại hành vi cũ (Rollback Guide)**:
     Nếu cần khôi phục lại chính sách cũ (chỉ cho phép đăng ký khi sự kiện đang diễn ra), thay đổi điều kiện trong `patientEvent.service.js`:
     + Trong `getAvailableEvents`: thay `{ isEnabled: true, endDate: { $gte: now } }` thành `{ isEnabled: true, startDate: { $lte: now }, endDate: { $gte: now } }`.
     + Trong `registerEvent`: thay `(event.endDate && event.endDate < now)` thành `(event.startDate && event.startDate > now) || (event.endDate && event.endDate < now)`.

#### b) PAT-12: Hệ thống Đánh giá Lịch hẹn (`src/services/feedback.service.js`, `src/models/feedback.model.js`)
1. **Partial Unique Index trên MongoDB**:
   - Đã xác nhận index được tạo thành công trên MongoDB thông qua cấu hình trong `src/models/feedback.model.js`:
     ```javascript
     feedbackSchema.index(
       { appointmentId: 1, userId: 1 },
       {
         unique: true,
         partialFilterExpression: { deletedAt: null },
       }
     );
     ```
   - **Lưu ý triển khai cho cơ sở dữ liệu đã có trước đó (Production Note)**:
     Nếu database triển khai từ trước đã có index tên cũ hoặc index chưa có partialFilterExpression, DBA cần chạy lệnh drop index cũ rồi để Mongoose tự động tạo lại:
     ```javascript
     db.feedbacks.dropIndex('appointmentId_1_userId_1');
     ```
     (Không tạo script tự động migration để tránh khóa bảng ngoài ý muốn trong môi trường production).
   - Đảm bảo mọi document feedback mới luôn lưu `deletedAt = null` tường minh khi tạo để khớp chính xác với partialFilterExpression.
2. **Xử lý trùng lặp & Race Condition**:
   - Khi gọi `Feedback.create`, bắt lỗi `error.code === 11000` và chuyển đổi thành `ApiError(409, 'Bạn đã gửi đánh giá cho lịch hẹn này rồi', 'FEEDBACK_EXISTS')`. Tuyệt đối không để lộ mã lỗi 500 khi có 2 request song song gửi đánh giá cho cùng một lịch hẹn.
   - Hỗ trợ luồng gửi lại sau khi xóa mềm: Khi feedback cũ đã được xóa mềm (`deletedAt` có timestamp), unique index với partial filter bỏ qua bản ghi này, cho phép bệnh nhân gửi bản ghi feedback mới cho cùng lịch hẹn đó.
3. **Chỉnh sửa & Kiểm duyệt**:
   - Khi chỉnh sửa feedback (`updateFeedback`), comment và title đều được làm sạch qua `sanitizeComment` (loại bỏ toàn bộ tag HTML/XSS).
   - Kiểm tra cửa sổ chỉnh sửa: chỉ cho phép sửa/xóa trong vòng `FEEDBACK_EDIT_DAYS` (mặc định 7 ngày) kể từ ngày tạo. Quá hạn trả về `409 FEEDBACK_EDIT_WINDOW_CLOSED`.
   - Nếu bản ghi đang ở trạng thái `PUBLISHED`, sau khi chỉnh sửa sẽ tự động hoàn về trạng thái `PENDING` để nhân viên quản trị duyệt lại.
4. **Bảo mật & Quyền riêng tư (`getPublishedAnonymous`)**:
   - Endpoint công khai chỉ lấy các bản ghi có `status: 'PUBLISHED'` và `deletedAt: null`.
   - Tuyệt đối loại bỏ `userId` và `patientEmail` khỏi kết quả trả về.
   - Tôn trọng cờ `isAnonymous`: Nếu `isAnonymous: true`, `patientName` trả về là `'Ẩn danh'`. Nếu `false`, họ tên bệnh nhân được làm mờ (masking, ví dụ "B. Nhân").

---

### 3. Kết quả Kiểm thử (Test Verification)
- Tất cả các kịch bản kiểm thử trong `tests/fix-2-event-feedback.test.js`, `tests/uc-pat-08.test.js`, và `tests/uc-pat-12.test.js` đều đã được chạy tuần tự độc lập và vượt qua toàn bộ 100% (35/35 tests pass).
- Các trường hợp kiểm thử bao gồm:
  + Lỗi Mongo giả lập (không phải 11000) được rethrow, `registeredCount` được rollback chính xác.
  + Đăng ký sự kiện tương lai (`startDate > now`) thành công theo chính sách mới.
  + Đăng ký sự kiện quá hạn (`now > endDate`) bị chặn 409 `EVENT_CLOSED`.
  + N request song song vào sự kiện còn 1 chỗ: đúng 1 thành công, N-1 nhận 409 `EVENT_FULL`, count đúng bằng capacity.
  + 2 request song song cùng user: 1 thành công, 1 nhận 409 `ALREADY_REGISTERED`, count bằng 1.
  + 2 request gửi feedback song song cho cùng lịch hẹn: 1 thành công (201), 1 nhận 409 `FEEDBACK_EXISTS`, không có lỗi 500.
  + Xóa mềm và gửi lại feedback cho cùng lịch hẹn thành công.
  + Sửa feedback có chứa HTML được sanitize sạch, status quay về `PENDING`.
  + Hàm query public không lộ `userId`/`patientEmail`.
