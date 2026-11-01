import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Form,
  Modal,
  Row,
  Spinner,
  Table,
} from "react-bootstrap";
import {
  createVoucher,
  deleteVoucher,
  fetchVoucherById,
  fetchVouchers,
  updateVoucher,
  type VoucherItem,
  type VoucherPayload,
  type VoucherType,
} from "../../api/voucher";
import "../../styles/appointmentlist.css";

type VoucherFormState = {
  code: string;
  name: string;
  discountValue: string;
  type: VoucherType;
  enable: boolean;
  expiryDateLocal: string;
};

const emptyForm: VoucherFormState = {
  code: "",
  name: "",
  discountValue: "",
  type: "SERVICE_TICKET",
  enable: true,
  expiryDateLocal: "",
};

const VOUCHER_TYPE_OPTIONS: { value: VoucherType; label: string }[] = [
  { value: "SERVICE_TICKET", label: "Vé dịch vụ" },
  { value: "DISCOUNT", label: "Giảm giá" },
];

function toDateTimeLocal(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString();
  return iso.slice(0, 16);
}

function toRequestDate(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function formatDisplayDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN");
}

function formatDiscount(type: VoucherType, value?: number | null): string {
  if (value === null || value === undefined) return "—";
  if (type === "DISCOUNT") {
    return `${value}%`;
  }
  return `${value} điểm`;
}

export default function AdminVouchers() {
  const [vouchers, setVouchers] = useState<VoucherItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<VoucherFormState>({ ...emptyForm });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<VoucherItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadVouchers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await fetchVouchers();
      setVouchers(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể tải danh sách voucher.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVouchers();
  }, [loadVouchers]);

  const sortedVouchers = useMemo(
    () =>
      [...vouchers].sort((a, b) => {
        const aDate = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
        const bDate = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
        return aDate - bDate;
      }),
    [vouchers]
  );

  const openCreateModal = () => {
    setError("");
    setEditingId(null);
    setForm({ ...emptyForm });
    setShowForm(true);
  };

  const openEditModal = async (voucherId: number) => {
    setSaving(true);
    setError("");
    try {
      const detail = await fetchVoucherById(voucherId);
      setEditingId(detail.id);
      setForm({
        code: detail.code ?? "",
        name: detail.name ?? "",
        discountValue: detail.discountValue !== null && detail.discountValue !== undefined ? String(detail.discountValue) : "",
        type: detail.type,
        enable: detail.enable,
        expiryDateLocal: toDateTimeLocal(detail.expiryDate),
      });
      setShowForm(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể tải thông tin voucher.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
    setEditingId(null);
    setForm({ ...emptyForm });
  };

  const handleFormChange = (
    field: keyof VoucherFormState,
    value: string | boolean
  ) => {
    setForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const submitForm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.code.trim()) {
      setError("Mã voucher không được để trống.");
      return;
    }
    if (!form.name.trim()) {
      setError("Tên voucher không được để trống.");
      return;
    }
    let discountValue: number | undefined;
    if (form.type === "DISCOUNT") {
      const value = Number(form.discountValue);
      if (Number.isNaN(value) || value <= 0 || value > 100) {
        setError("Giá trị giảm phải nằm trong khoảng 1-100%.");
        return;
      }
      discountValue = value;
    } else if (form.discountValue.trim()) {
      const value = Number(form.discountValue);
      if (Number.isNaN(value) || value <= 0) {
        setError("Giá trị ưu đãi phải là số dương.");
        return;
      }
      discountValue = value;
    }

    const expiryFormatted = toRequestDate(form.expiryDateLocal);
    if (!expiryFormatted) {
      setError("Vui lòng chọn hạn sử dụng hợp lệ.");
      return;
    }

    const payload: VoucherPayload = {
      code: form.code.trim(),
      name: form.name.trim(),
      discountValue: discountValue,
      type: form.type,
      enable: form.enable,
      expiryDate: expiryFormatted,
    };

    setSaving(true);
    setError("");
    try {
      if (editingId) {
        await updateVoucher(editingId, payload);
      } else {
        await createVoucher(payload);
      }
      closeForm();
      await loadVouchers();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể lưu voucher.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteVoucher(deleteTarget.id);
      setDeleteTarget(null);
      await loadVouchers();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể xóa voucher.";
      setError(message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page-section">
      <Row className="align-items-center mb-3">
        <Col>
          <h2 className="mb-0">Quản lý voucher</h2>
          <p className="text-muted mb-0">
            Tạo và quản lý mã ưu đãi được sử dụng trong các sự kiện hoặc đặt lịch.
          </p>
        </Col>
        <Col className="text-end">
          <Button onClick={openCreateModal}>+ Tạo voucher</Button>
        </Col>
      </Row>

      {!showForm && error && (
        <Alert variant="danger" onClose={() => setError("")} dismissible>
          {error}
        </Alert>
      )}

      {loading ? (
        <Card body className="d-flex align-items-center gap-2">
          <Spinner animation="border" size="sm" />
          <span>Đang tải danh sách voucher...</span>
        </Card>
      ) : sortedVouchers.length === 0 ? (
        <Card body className="text-center text-muted">
          Chưa có voucher nào.
        </Card>
      ) : (
        <Card>
          <Card.Body>
            <Table responsive hover className="align-middle">
              <thead>
                <tr>
                  <th>Mã voucher</th>
                  <th>Tên voucher</th>
                  <th>Loại</th>
                  <th>Giá trị</th>
                  <th>Hạn sử dụng</th>
                  <th>Trạng thái</th>
                  <th style={{ width: 160 }}>Hành động</th>
                </tr>
              </thead>
              <tbody>
                {sortedVouchers.map((voucher) => (
                  <tr key={voucher.id}>
                    <td className="fw-semibold">{voucher.code}</td>
                    <td>{voucher.name || "—"}</td>
                    <td>
                      {voucher.type === "DISCOUNT" ? "Giảm giá" : "Vé dịch vụ"}
                    </td>
                    <td>{formatDiscount(voucher.type, voucher.discountValue)}</td>
                    <td>{formatDisplayDate(voucher.expiryDate)}</td>
                    <td>
                      <Badge bg={voucher.enable ? "success" : "secondary"}>
                        {voucher.enable ? "Đang hoạt động" : "Đã vô hiệu"}
                      </Badge>
                    </td>
                    <td>
                      <div className="d-flex gap-2">
                        <Button
                          size="sm"
                          variant="outline-primary"
                          onClick={() => void openEditModal(voucher.id)}
                        >
                          Sửa
                        </Button>
                        <Button
                          size="sm"
                          variant="outline-danger"
                          onClick={() => setDeleteTarget(voucher)}
                        >
                          Xóa
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      )}

      <Modal show={showForm} onHide={closeForm} centered>
        <Form onSubmit={submitForm}>
          <Modal.Header closeButton={!saving}>
            <Modal.Title>{editingId ? "Chỉnh sửa voucher" : "Tạo voucher"}</Modal.Title>
          </Modal.Header>
          <Modal.Body className="d-grid gap-3">
            {error && (
              <Alert variant="danger" onClose={() => setError("")} dismissible className="mb-0">
                {error}
              </Alert>
            )}
            <Form.Group controlId="voucherCode">
              <Form.Label>Mã voucher</Form.Label>
              <Form.Control
                value={form.code}
                onChange={(e) => handleFormChange("code", e.target.value)}
                placeholder="Ví dụ: SUMMER2025"
                required
              />
            </Form.Group>
            <Form.Group controlId="voucherName">
              <Form.Label>Tên voucher</Form.Label>
              <Form.Control
                value={form.name}
                onChange={(e) => handleFormChange("name", e.target.value)}
                placeholder="Tên mô tả ngắn gọn"
                required
              />
            </Form.Group>
            <Form.Group controlId="voucherType">
              <Form.Label>Loại voucher</Form.Label>
              <Form.Select
                value={form.type}
                onChange={(e) => handleFormChange("type", e.target.value as VoucherType)}
              >
                {VOUCHER_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            <Form.Group controlId="voucherValue">
              <Form.Label>Giá trị ưu đãi</Form.Label>
              <Form.Control
                type="number"
                min="0"
                step="0.01"
                value={form.discountValue}
                onChange={(e) => handleFormChange("discountValue", e.target.value)}
                placeholder={form.type === "DISCOUNT" ? "Phần trăm (%)" : "Điểm hoặc số tiền"}
              />
              {form.type === "DISCOUNT" && (
                <Form.Text className="text-muted">Giá trị % từ 1 đến 100.</Form.Text>
              )}
            </Form.Group>
            <Form.Group controlId="voucherExpiry">
              <Form.Label>Hạn sử dụng</Form.Label>
              <Form.Control
                type="datetime-local"
                value={form.expiryDateLocal}
                onChange={(e) => handleFormChange("expiryDateLocal", e.target.value)}
                required
              />
            </Form.Group>
            <Form.Check
              type="switch"
              id="voucherEnable"
              label="Kích hoạt voucher"
              checked={form.enable}
              onChange={(e) => handleFormChange("enable", e.target.checked)}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline-secondary" onClick={closeForm} disabled={saving}>
              Hủy
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner animation="border" size="sm" /> : "Lưu voucher"}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      <Modal show={!!deleteTarget} onHide={() => (deleting ? undefined : setDeleteTarget(null))} centered>
        <Modal.Header closeButton={!deleting}>
          <Modal.Title>Xóa voucher</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Bạn có chắc chắn muốn xóa voucher{" "}
          <strong>{deleteTarget?.code}</strong>? Hành động này không thể hoàn tác.
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            onClick={() => setDeleteTarget(null)}
            disabled={deleting}
          >
            Hủy
          </Button>
          <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
            {deleting ? <Spinner animation="border" size="sm" /> : "Xóa"}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}


