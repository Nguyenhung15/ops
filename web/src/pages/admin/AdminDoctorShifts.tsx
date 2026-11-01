import { useEffect, useMemo, useState } from "react";
import { Card, Dropdown, DropdownButton, Form, Spinner } from "react-bootstrap";
import { fetchShiftsInWeek, type AdminShift } from "../../api/shift";
import { fetchSpecialties, type Specialty } from "../../api/specialty";
import "../../styles/shift.css";

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const slotOrder = ["MORNING", "AFTERNOON", "EVENING"] as const;
const slotLabel: Record<typeof slotOrder[number], string> = {
  MORNING: "Morning (08:00 - 12:00)",
  AFTERNOON: "Afternoon (13:00 - 17:00)",
  EVENING: "Evening (18:00 - 21:00)",
};

function parseLocalDate(dateStr: string) {
  if (!dateStr) return new Date();
  const parts = dateStr.split("-").map(Number);
  if (parts.length === 3 && !parts.some(Number.isNaN)) {
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date(dateStr);
}

function getISOWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day; // Monday as start
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function toISO(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function formatDM(date: Date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

export default function AdminDoctorShifts() {
  const [dateStr, setDateStr] = useState<string>(toISO(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [items, setItems] = useState<AdminShift[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [currentSpecId, setCurrentSpecId] = useState<number | null>(null);

  useEffect(() => {
    fetchSpecialties().then(setSpecialties).catch(() => {});
  }, []);

  const monday = useMemo(() => getISOWeekStart(parseLocalDate(dateStr)), [dateStr]);
  const headers = useMemo(() => {
    const list: { iso: string; label: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      list.push({ iso: toISO(d), label: `${days[i]} ${formatDM(d)}` });
    }
    return list;
  }, [monday]);
  const weekRangeLabel = useMemo(() => {
    const s = new Date(monday);
    const e = new Date(monday);
    e.setDate(monday.getDate() + 6);
    return `${formatDM(s)} - ${formatDM(e)}`;
  }, [monday]);

  useEffect(() => {
    const sISO = headers[0]?.iso;
    const eISO = headers[6]?.iso;
    if (!sISO || !eISO) return;
    setLoading(true);
    setError("");
    fetchShiftsInWeek(sISO, eISO)
      .then(setItems)
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [headers]);

  const filtered = useMemo(() => {
    if (!currentSpecId) return items;
    const specName = specialties.find((s) => s.id === currentSpecId)?.name;
    if (!specName) return items;
    return items.filter((it) => (it.specialtyName || "") === specName);
  }, [items, currentSpecId, specialties]);

  const grid = useMemo(() => {
    const map: Record<typeof slotOrder[number], Record<string, AdminShift[]>> = {
      MORNING: {},
      AFTERNOON: {},
      EVENING: {},
    };
    const normalizeSlot = (value: string | undefined): typeof slotOrder[number] => {
      if (value === "AFTERNOON" || value === "EVENING") return value;
      return "MORNING";
    };
    for (const it of filtered) {
      const date = it.date;
      const slot = normalizeSlot(it.shiftType);
      if (!map[slot][date]) map[slot][date] = [];
      map[slot][date].push(it);
    }
    return map;
  }, [filtered]);

  return (
    <div className="shift-wrap">
      {/* Filter Bar */}
      <div className="shift-filterbar">
        <div className="left">
          <h5 className="title">Shifts by Week</h5>
          <span className="week-range">Week: {weekRangeLabel}</span>
        </div>

        <div className="right">
          <div className="week-picker">
            <Form.Control
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              className="date-input"
            />
          </div>

          <DropdownButton
            id="filter-spec"
            title={
              currentSpecId
                ? specialties.find((s) => s.id === currentSpecId)?.name || "By specialty"
                : "All specialties"
            }
            variant="light"
          >
            <Dropdown.Item active={!currentSpecId} onClick={() => setCurrentSpecId(null)}>
              All
            </Dropdown.Item>
            <Dropdown.Divider />
            {specialties.map((s) => (
              <Dropdown.Item
                key={s.id}
                active={currentSpecId === s.id}
                onClick={() => setCurrentSpecId(s.id)}
              >
                {s.name}
              </Dropdown.Item>
            ))}
          </DropdownButton>
        </div>
      </div>

      {/* Error / Loading */}
      {error && (
        <Card body className="border-danger-subtle text-danger mb-3">
          {error}
        </Card>
      )}
      {loading ? (
        <div className="loading-inline">
          <Spinner animation="border" size="sm" />
          <span>Đang tải…</span>
        </div>
      ) : (
        <div className="shift-table-responsive">
          <table className="shift-table table table-bordered align-middle">
            <thead>
              <tr>
                <th className="col-shift">Shift</th>
                {headers.map((h) => (
                  <th key={h.iso} className="col-day">
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slotOrder.map((slot) => (
                <tr key={slot}>
                  <td className="fw-semibold col-shift sticky">{slotLabel[slot]}</td>
                  {headers.map((h) => {
                    const list = grid[slot][h.iso] || [];
                    return (
                      <td key={h.iso} className="cell">
                        {list.length === 0 ? (
                          <span className="cell-empty">—</span>
                        ) : (
                          <div className="cell-inner">
                            <div className="appt-list">
                              {list.map((it, idx) => (
                                <DoctorChip
                                  key={idx}
                                  doctorName={it.doctorName || `#${it.doctorId}`}
                                  specialtyName={it.specialtyName}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** ====== Small atom ====== */
function DoctorChip({
  doctorName,
  specialtyName,
}: {
  doctorName: string;
  specialtyName?: string;
}) {
  return (
    <div className="appt appt-default" style={{ justifyContent: "flex-start" }}>
      <span className="appt-left">
        <span className="doctor-name" style={{ fontWeight: 600 }}>{doctorName}</span>
        {specialtyName && <span className="specialty-name text-muted" style={{ fontSize: "11px" }}> · {specialtyName}</span>}
      </span>
    </div>
  );
}
