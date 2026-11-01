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
  createEvent,
  deleteEvent,
  fetchEvents,
  updateEvent,
  type EventItem,
  type EventPayload,
} from "../../api/event";
import {
  fetchVouchers as fetchAllVouchers,
  type VoucherItem,
} from "../../api/voucher";
import "../../styles/appointment.css";

type EventFormState = {
  title: string;
  description: string;
  location: string;
  startDateLocal: string;
  endDateLocal: string;
  voucherId: string;
  isEnabled: boolean;
};

const emptyForm: EventFormState = {
  title: "",
  description: "",
  location: "",
  startDateLocal: "",
  endDateLocal: "",
  voucherId: "",
  isEnabled: true,
};

function toDateTimeLocal(value?: string): string {
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

function formatDisplayDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN");
}

export default function AdminEvents() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [voucherList, setVoucherList] = useState<VoucherItem[]>([]);
  const [loadingVouchers, setLoadingVouchers] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<EventFormState>({ ...emptyForm });
  const [editing, setEditing] = useState<EventItem | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<EventItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await fetchEvents();
      setEvents(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể tải sự kiện";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    const loadVouchers = async () => {
      setLoadingVouchers(true);
      try {
        const list = await fetchAllVouchers();
        setVoucherList(list);
      } catch (err) {
        // Không chặn luồng event nếu voucher lỗi, chỉ log ra
        console.error("Failed to load vouchers", err);
      } finally {
        setLoadingVouchers(false);
      }
    };
    void loadVouchers();
  }, []);

  const sortedEvents = useMemo(
    () =>
      [...events].sort((a, b) => {
        const aTime = a.startDate ? new Date(a.startDate).getTime() : 0;
        const bTime = b.startDate ? new Date(b.startDate).getTime() : 0;
        return bTime - aTime;
      }),
    [events]
  );

  const openCreateModal = () => {
    setError("");
    setEditing(null);
    setForm({ ...emptyForm });
    setShowForm(true);
  };

  const openEditModal = (eventItem: EventItem) => {
    setEditing(eventItem);
    setForm({
      title: eventItem.title || "",
      description: eventItem.description || "",
      location: eventItem.location || "",
      startDateLocal: toDateTimeLocal(eventItem.startDate),
      endDateLocal: toDateTimeLocal(eventItem.endDate),
      voucherId: eventItem.voucherId ? String(eventItem.voucherId) : "",
      isEnabled: eventItem.isEnabled,
    });
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
    setEditing(null);
    setForm({ ...emptyForm });
  };

  const handleFormChange = (
    field: keyof EventFormState,
    value: string | boolean
  ) => {
    setForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      setError("Tiêu đề không được để trống.");
      return;
    }
    const startFormatted = toRequestDate(form.startDateLocal);
    const endFormatted = toRequestDate(form.endDateLocal);
    if (!startFormatted || !endFormatted) {
      setError("Vui lòng nhập thời gian bắt đầu và kết thúc hợp lệ.");
      return;
    }
    if (new Date(form.startDateLocal) > new Date(form.endDateLocal)) {
      setError("Thời gian kết thúc phải sau thời gian bắt đầu.");
      return;
    }
    setSaving(true);
    setError("");
    const payload: EventPayload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      location: form.location.trim() || null,
      startDate: startFormatted,
      endDate: endFormatted,
      isEnabled: form.isEnabled,
      voucherId: form.voucherId ? Number(form.voucherId) : undefined,
    };

    try {
      if (editing) {
        await updateEvent(editing.id, payload);
      } else {
        await createEvent(payload);
      }
      closeForm();
      await loadEvents();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể lưu sự kiện.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteEvent(deleteTarget.id);
      setDeleteTarget(null);
      await loadEvents();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể xóa sự kiện.";
      setError(message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page-section">
      <Row className="align-items-center mb-3">
        <Col>
          <h2 className="mb-0">Quản lý sự kiện</h2>
          <p className="text-muted mb-0">
            Thêm, chỉnh sửa và quản lý các sự kiện khuyến mãi của phòng khám.
          </p>
        </Col>
        <Col className="text-end">
          <Button onClick={openCreateModal}>+ Tạo sự kiện</Button>
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
          <span>Đang tải sự kiện...</span>
        </Card>
      ) : sortedEvents.length === 0 ? (
        <Card body className="text-center text-muted">Chưa có sự kiện nào.</Card>
      ) : (
        <Card>
          <Card.Body>
            <Table responsive hover className="align-middle">
              <thead>
                <tr>
                  <th>Tiêu đề</th>
                  <th>Thời gian</th>
                  <th>Địa điểm</th>
                  <th>Voucher</th>
                  <th>Trạng thái</th>
                  <th style={{ width: 160 }}>Hành động</th>
                </tr>
              </thead>
              <tbody>
                {sortedEvents.map((eventItem) => (
                  <tr key={eventItem.id}>
                    <td>
                      <div className="fw-semibold">{eventItem.title}</div>
                      {eventItem.description && (
                        <div className="text-muted small">{eventItem.description}</div>
                      )}
                    </td>
                    <td>
                      <div>{formatDisplayDate(eventItem.startDate)}</div>
                      <div className="text-muted small">
                        đến {formatDisplayDate(eventItem.endDate)}
                      </div>
                    </td>
                    <td>{eventItem.location || "—"}</td>
                    <td>
                      {eventItem.voucherName ? (
                        <>
                          <div>{eventItem.voucherName}</div>
                          {eventItem.voucherCode && (
                            <div className="text-muted small">{eventItem.voucherCode}</div>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <Badge bg={eventItem.isEnabled ? "success" : "secondary"}>
                        {eventItem.isEnabled ? "Đang hiển thị" : "Đã ẩn"}
                      </Badge>
                    </td>
                    <td>
                      <div className="d-flex gap-2">
                        <Button
                          size="sm"
                          variant="outline-primary"
                          onClick={() => openEditModal(eventItem)}
                        >
                          Sửa
                        </Button>
                        <Button
                          size="sm"
                          variant="outline-danger"
                          onClick={() => setDeleteTarget(eventItem)}
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
            <Modal.Title>{editing ? "Chỉnh sửa sự kiện" : "Tạo sự kiện"}</Modal.Title>
          </Modal.Header>
          <Modal.Body className="d-grid gap-3">
            {error && (
              <Alert variant="danger" onClose={() => setError("")} dismissible className="mb-0">
                {error}
              </Alert>
            )}
            <Form.Group controlId="eventTitle">
              <Form.Label>Tiêu đề</Form.Label>
              <Form.Control
                value={form.title}
                onChange={(e) => handleFormChange("title", e.target.value)}
                placeholder="Ví dụ: Sự kiện tri ân khách hàng"
                required
              />
            </Form.Group>
            <Form.Group controlId="eventDescription">
              <Form.Label>Mô tả</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                value={form.description}
                onChange={(e) => handleFormChange("description", e.target.value)}
                placeholder="Thông tin chi tiết về sự kiện"
              />
            </Form.Group>
            <Form.Group controlId="eventLocation">
              <Form.Label>Địa điểm</Form.Label>
              <Form.Control
                value={form.location}
                onChange={(e) => handleFormChange("location", e.target.value)}
                placeholder="Phòng khám, trực tuyến..."
              />
            </Form.Group>
            <Row className="g-3">
              <Col md={6}>
                <Form.Group controlId="eventStart">
                  <Form.Label>Thời gian bắt đầu</Form.Label>
                  <Form.Control
                    type="datetime-local"
                    value={form.startDateLocal}
                    onChange={(e) => handleFormChange("startDateLocal", e.target.value)}
                    required
                  />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group controlId="eventEnd">
                  <Form.Label>Thời gian kết thúc</Form.Label>
                  <Form.Control
                    type="datetime-local"
                    value={form.endDateLocal}
                    onChange={(e) => handleFormChange("endDateLocal", e.target.value)}
                    required
                  />
                </Form.Group>
              </Col>
            </Row>
            <Form.Group controlId="eventVoucher">
              <Form.Label>Voucher áp dụng</Form.Label>
              <Form.Select
                value={form.voucherId}
                onChange={(e) => handleFormChange("voucherId", e.target.value)}
                disabled={loadingVouchers}
              >
                <option value="">— Không gắn voucher —</option>
                {voucherList.map((voucher) => (
                  <option key={voucher.id} value={voucher.id}>
                    {voucher.code} {voucher.name ? `- ${voucher.name}` : ""}
                  </option>
                ))}
              </Form.Select>
              {loadingVouchers && (
                <Form.Text className="text-muted">Đang tải danh sách voucher...</Form.Text>
              )}
            </Form.Group>
            <Form.Check
              type="switch"
              id="eventEnabled"
              label="Hiển thị sự kiện"
              checked={form.isEnabled}
              onChange={(e) => handleFormChange("isEnabled", e.target.checked)}
            />
          </Modal.Body>
          {error && (
                <Alert variant="danger" onClose={() => setError("")} dismissible>
                {error}
                </Alert>
            )}
          <Modal.Footer>
            <Button variant="outline-secondary" onClick={closeForm} disabled={saving}>
              Hủy
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner animation="border" size="sm" /> : "Lưu sự kiện"}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      <Modal show={!!deleteTarget} onHide={() => (deleting ? undefined : setDeleteTarget(null))} centered>
        <Modal.Header closeButton={!deleting}>
          <Modal.Title>Xóa sự kiện</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Bạn có chắc chắn muốn xóa sự kiện{" "}
          <strong>{deleteTarget?.title}</strong>? Hành động này không thể hoàn tác.
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


