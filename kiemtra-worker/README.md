# Máy chủ "Kiểm tra theo lớp" (tlagv-kiemtra)

Máy chủ và cơ sở dữ liệu riêng, tách biệt hoàn toàn với phần **Tự kiểm tra kiến thức** (`bmth-k10-quiz`).

- Trang giáo viên: `giaovien.html` — đăng nhập, tải bộ câu hỏi Word, tạo đợt kiểm tra, mã QR, bảng điểm.
- Trang học viên: `kiemtra.html?ma=MÃĐỀ` — nhập họ tên, làm bài trên điện thoại.
- Địa chỉ máy chủ được khai báo ở `kiemtraApiUrl` trong `config.js`.

## Cấu hình trên Cloudflare

| Mục | Giá trị |
| --- | --- |
| Worker | `tlagv-kiemtra`, mã nguồn `src/index.js` |
| D1 binding | `DB` → cơ sở dữ liệu `tlagv-kiemtra-db` (bảng tự tạo ở lần chạy đầu) |
| Biến `ALLOWED_ORIGINS` | `https://ccongpho-dotcom.github.io` |
| Biến `SETUP_OPEN` | `1` để tạo tài khoản quản trị đầu tiên, sau đó đặt `0` |

Không có khóa bí mật nào cần nhập: khóa ký phiên đăng nhập được tự sinh và lưu trong D1; mật khẩu được băm PBKDF2.

## Chạy thử trên máy

```
npx wrangler dev --local
```
Tạo tệp `.dev.vars` với `ALLOWED_ORIGINS="http://localhost:8080"` và `SETUP_OPEN="1"`.
