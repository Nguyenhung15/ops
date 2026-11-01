# QUY TRÌNH & MẪU TÀI LIỆU QUYẾT ĐỊNH KIẾN TRÚC (ARCHITECTURE DECISIONS)

> Mọi quyết định kỹ thuật quan trọng khi triển khai use case (UC-PAT-07..12, v.v.) phải được ghi lại trong thư mục này hoặc `docs/DECISIONS.md`.

---

## Mẫu tài liệu quyết định (Decision Template)

```markdown
# [Mã UC / Tên quyết định]

### 1. Vấn đề (Context & Problem Statement)
- Bối cảnh nghiệp vụ là gì?
- Tại sao cần đưa ra quyết định này?

### 2. Mặc định & Lựa chọn (Decision & Default)
- Phương án được chọn là gì?
- Giá trị hoặc hành vi mặc định?

### 3. Lý do (Rationale)
- Tại sao chọn phương án này mà không chọn các giải pháp khác?
- Đánh đổi (Trade-offs) và lợi ích?

### 4. Biến môi trường & Cấu hình liên quan (Environment Variables)
- Danh sách các biến env điều khiển hành vi:
  + `ENV_VAR_NAME`: Ý nghĩa, kiểu dữ liệu, giá trị mặc định.
```
