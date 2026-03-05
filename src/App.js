import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { supabase } from "./supabase";

const HOURLY_NORMAL = 1116;
const HOURLY_WEEKEND = 1200; // ← 重要：未定義バグ修正
const BUSINESS_START = 11 * 60;
const BUSINESS_END = 18 * 60 + 30;
const BREAK_MINUTES = 45;

// スナップ：各シフト開始の直前の窓だけスナップ
// 〜10:59 → 11:00、14:00〜14:59 → 15:00、それ以外はそのまま
const SNAP_RULES = [
  { from: 0, to: 11 * 60, snapTo: 11 * 60 },
  { from: 14 * 60, to: 15 * 60, snapTo: 15 * 60 },
];

const KINMU_OPTIONS = ["出勤", "欠勤", "遅刻", "早退", "休日出勤", "有給休暇"];

const HOLIDAYS = {
  "2026-01-01": "元日",
  "2026-01-12": "成人の日",
  "2026-02-11": "建国記念の日",
  "2026-02-23": "天皇誕生日",
  "2026-03-20": "春分の日",
  "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日",
  "2026-05-04": "みどりの日",
  "2026-05-05": "こどもの日",
  "2026-09-21": "敬老の日",
  "2026-09-23": "秋分の日",
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];

// ─── ユーティリティ ─────────────────────────────────────────────────────────────
function pad2(n) {
  return String(n).padStart(2, "0");
}
function getDaysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

function t2m(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function m2t(m) {
  if (m == null || m < 0) return null;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function isWE(d) {
  const dow = new Date(d).getDay();
  return dow === 0 || dow === 6 || !!HOLIDAYS[d];
}
function snapStart(ts) {
  if (!ts) return ts;
  const t = t2m(ts);
  for (const rule of SNAP_RULES) {
    if (t >= rule.from && t < rule.to) return m2t(rule.snapTo);
  }
  return ts; // 窓外はそのまま（11:01以降は変更なし）
}

function calcWork(dateStr, startStr, endStr) {
  if (!startStr || !endStr) return null;
  const s = t2m(startStr),
    e = t2m(endStr);
  if (s == null || e == null || e <= s) return null;

  const span = e - s; // 経過
  const breakMin = span >= 6 * 60 ? BREAK_MINUTES : 0; // 6時間以上のみ休憩45分
  const workMin = span - breakMin;
  if (workMin <= 0) return null;

  const overtime = Math.max(0, e - BUSINESS_END);
  const rate = isWE(dateStr) ? HOURLY_WEEKEND : HOURLY_NORMAL;
  return { workMin, breakMin, overtime, rate, wage: Math.floor((workMin / 60) * rate) };
}
function calcActualWork(rawStart, rawEnd) {
  if (!rawStart || !rawEnd) return null;
  const s = t2m(rawStart),
    e = t2m(rawEnd);
  if (s == null || e == null || e <= s) return null;
  const span = e - s;
  const workMin = span - (span >= 6 * 60 ? BREAK_MINUTES : 0);
  return workMin > 0 ? workMin : null;
}

// れこるCSVパース → { name → [{dateStr, rawStart, rawEnd, snapSt, snapEnd}] }
function parseRecoruCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const h = lines[0].split(",");
  const idx = {
    name: h.indexOf("名前"),
    date: h.indexOf("年月日"),
    start: h.indexOf("開始"),
    end: h.indexOf("終了"),
    startR: h.indexOf("開始(丸め)"),
    endR: h.indexOf("終了(丸め)"),
  };
  const byName = {};
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const name = c[idx.name]?.trim(),
      dateRaw = c[idx.date]?.trim();
    if (!name || !dateRaw || dateRaw.length !== 8) continue;
    const dateStr = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
    const rawStart = c[idx.start]?.trim() || "";
    const rawEnd = c[idx.end]?.trim() || "";
    const rStart = c[idx.startR]?.trim() || rawStart;
    const rEnd = c[idx.endR]?.trim() || rawEnd;

    if (!byName[name]) byName[name] = [];
    byName[name].push({ dateStr, rawStart, rawEnd, snapSt: snapStart(rStart), snapEnd: rEnd });
  }
  return byName;
}

// ─── Supabase I/O（user_id対応） ───────────────────────────────────────────────
function monthRange(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const end = `${year}-${pad2(month)}-${pad2(getDaysInMonth(year, month))}`;
  return { start, end };
}

async function sbLoadAttendance(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const { data, error } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", userId)
    .gte("date_str", start)
    .lte("date_str", end);

  if (error) throw error;

  const all = {};
  for (const row of data || []) {
    if (!all[row.name]) all[row.name] = {};
    all[row.name][row.date_str] = {
      status: row.status || "",
      start: row.start_time || "",
      end: row.end_time || "",
      rawStart: row.raw_start || "",
      rawEnd: row.raw_end || "",
      modified: !!row.modified,
    };
  }
  return all;
}

async function sbLoadSettings(userId) {
  const { data, error } = await supabase
    .from("employee_settings")
    .select("*")
    .eq("user_id", userId);

  if (error) throw error;

  const fare = {};
  const paid = {};
  for (const r of data || []) {
    fare[r.name] = r.fare ?? 0;
    paid[r.name] = r.paid_leave_wage ?? 0;
  }
  return { fare, paid };
}

async function sbUpsertAttendance(userId, name, dateStr, entry) {
  const payload = {
    user_id: userId,
    name,
    date_str: dateStr,
    status: entry.status ?? "",
    start_time: entry.start ?? "",
    end_time: entry.end ?? "",
    raw_start: entry.rawStart ?? "",
    raw_end: entry.rawEnd ?? "",
    modified: !!entry.modified,
  };
  const { error } = await supabase.from("attendance").upsert(payload, {
    onConflict: "user_id,name,date_str",
  });
  if (error) throw error;
}

async function sbDeleteAttendance(userId, name, dateStr) {
  const { error } = await supabase
    .from("attendance")
    .delete()
    .eq("user_id", userId)
    .eq("name", name)
    .eq("date_str", dateStr);
  if (error) throw error;
}

async function sbUpsertSettings(userId, name, fare, paidLeaveWage) {
  const payload = {
    user_id: userId,
    name,
    fare: fare ?? 0,
    paid_leave_wage: paidLeaveWage ?? 0,
  };
  const { error } = await supabase.from("employee_settings").upsert(payload, {
    onConflict: "user_id,name",
  });
  if (error) throw error;
}

async function sbDeleteEmployee(userId, name) {
  const { error: e1 } = await supabase.from("attendance").delete().eq("user_id", userId).eq("name", name);
  if (e1) throw e1;
  const { error: e2 } = await supabase.from("employee_settings").delete().eq("user_id", userId).eq("name", name);
  if (e2) throw e2;
}

// ─── 勤怠テーブル（一人分） ────────────────────────────────────────────────────
function AttendanceTable({ name, year, month, entries, fare, paidLeaveWage, onUpdate }) {
  const [editing, setEditing] = useState(null);
  const [tempVal, setTempVal] = useState("");

  const startEdit = (dateStr, field, val) => {
    setEditing({ dateStr, field });
    setTempVal(val || "");
  };
  const commitEdit = useCallback(
    (dateStr, field) => {
      const entry = { ...(entries[dateStr] || {}) };
      if (tempVal.trim()) {
        entry[field] = tempVal.trim();
        entry.modified = true;
      } else {
        delete entry[field];
      }

      if (!entry.start && !entry.end && !entry.status && !entry.rawStart && !entry.rawEnd) {
        onUpdate(name, dateStr, null);
      } else {
        onUpdate(name, dateStr, entry);
      }
      setEditing(null);
      setTempVal("");
    },
    [tempVal, entries, name, onUpdate]
  );

  const setStatus = (dateStr, val) => {
    const entry = { ...(entries[dateStr] || {}), status: val };
    onUpdate(name, dateStr, entry);
  };

  const clearEntry = (dateStr) => {
    onUpdate(name, dateStr, null);
  };

  const days = Array.from({ length: getDaysInMonth(year, month) }, (_, i) => {
    const d = i + 1,
      key = `${year}-${pad2(month)}-${pad2(d)}`,
      dow = new Date(key).getDay();
    return { d, key, dow, wdJP: WD[dow] };
  });

  const totals = useMemo(() => {
    return days.reduce(
      (a, { key }) => {
        const e = entries[key];

        if (e?.status === "有給休暇") return { ...a, paidDays: a.paidDays + 1 };

        if (!e?.start || !e?.end) return a;
        const c = calcWork(key, e.start, e.end);
        if (!c) return a;

        return {
          workMin: a.workMin + c.workMin,
          overtime: a.overtime + c.overtime,
          wage: a.wage + c.wage,
          days: a.days + 1,
          paidDays: a.paidDays,
        };
      },
      { workMin: 0, overtime: 0, wage: 0, days: 0, paidDays: 0 }
    );
  }, [days, entries]);

  return (
    <div>
      <div style={S.tableWrap}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#1a2e1a", color: "#e8f5e8" }}>
              <th style={S.thBig} rowSpan={2}>
                日付
              </th>
              <th style={S.thBig} rowSpan={2}>
                曜
              </th>
              <th style={S.thBig} rowSpan={2}>
                勤怠
              </th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} colSpan={2}>
                始業時刻
              </th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} colSpan={2}>
                終業時刻
              </th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} colSpan={2}>
                勤務時間
              </th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>
                普通残業
              </th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>
                休憩
              </th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>
                時給
              </th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>
                日給
              </th>
              <th style={S.thBig} rowSpan={2}></th>
            </tr>
            <tr style={{ background: "#243424", color: "#8db08d", fontSize: 10 }}>
              <th style={{ ...S.thSub, borderLeft: "1px solid #3d5c3d" }}>実際</th>
              <th style={S.thSub}>丸め</th>
              <th style={{ ...S.thSub, borderLeft: "1px solid #3d5c3d" }}>実際</th>
              <th style={S.thSub}>丸め</th>
              <th style={{ ...S.thSub, borderLeft: "1px solid #3d5c3d" }}>実際</th>
              <th style={S.thSub}>丸め</th>
            </tr>
          </thead>

          <tbody>
            {days.map(({ d, key, dow, wdJP }) => {
              const isSat = dow === 6,
                isSun = dow === 0,
                isHol = !!HOLIDAYS[key],
                isWeekend = isSat || isSun || isHol;
              const entry = entries[key] || {};
              const calc = calcWork(key, entry.start, entry.end);
              const actualWorkMin = entry.rawStart && entry.rawEnd ? calcActualWork(entry.rawStart, entry.rawEnd) : null;

              const isES = editing?.dateStr === key && editing?.field === "start";
              const isEE = editing?.dateStr === key && editing?.field === "end";
              const startSnapped = entry.rawStart && entry.rawStart !== entry.start;
              const endSnapped = entry.rawEnd && entry.rawEnd !== entry.end;

              return (
                <tr
                  key={key}
                  style={{
                    background: isWeekend ? (isSat ? "rgba(37,99,235,0.05)" : "rgba(220,38,38,0.05)") : "transparent",
                    borderBottom: "1px solid #ede8e0",
                  }}
                >
                  <td style={S.td}>
                    <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                      {month}/{d}
                    </span>
                    {HOLIDAYS[key] && <div style={S.htag}>{HOLIDAYS[key]}</div>}
                  </td>

                  <td style={{ ...S.td, textAlign: "center" }}>
                    <span style={{ fontWeight: 700, color: isSun || isHol ? "#dc2626" : isSat ? "#2563eb" : "#6b5e4c" }}>
                      {wdJP}
                    </span>
                  </td>

                  <td style={S.td}>
                    <select
                      value={entry.status || ""}
                      onChange={(e) => setStatus(key, e.target.value)}
                      style={{
                        fontSize: 11,
                        border: "1px solid #ddd",
                        borderRadius: 5,
                        padding: "3px 4px",
                        color: entry.status ? "#1a1209" : "#aaa",
                        background: entry.status === "出勤" ? "#f0faf0" : entry.status ? "#fffbe6" : "#fafafa",
                        cursor: "pointer",
                        outline: "none",
                        maxWidth: 78,
                      }}
                    >
                      <option value="">—</option>
                      {KINMU_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4" }}>
                    <span
                      style={{
                        fontSize: 11,
                        color: startSnapped ? "#aaa" : "#6b5e4c",
                        fontVariantNumeric: "tabular-nums",
                        textDecoration: startSnapped ? "line-through" : "none",
                      }}
                    >
                      {entry.rawStart || entry.start || <span style={{ color: "#ddd" }}>—</span>}
                    </span>
                  </td>

                  <td style={S.td}>
                    {isES ? (
                      <input
                        autoFocus
                        type="time"
                        value={tempVal}
                        onChange={(e) => setTempVal(e.target.value)}
                        onBlur={() => commitEdit(key, "start")}
                        style={S.tinput}
                      />
                    ) : (
                      <button
                        style={{
                          ...S.tbtn,
                          color: entry.start ? (entry.modified ? "#b45309" : "#1a4d12") : "#b0a090",
                          borderColor: entry.modified ? "#fcd34d" : "#c8bfb2",
                          fontWeight: entry.start ? 700 : 400,
                        }}
                        onClick={() => startEdit(key, "start", entry.start)}
                      >
                        {entry.start || "——"}
                        {entry.modified && <span style={S.modTag}>修</span>}
                      </button>
                    )}
                  </td>

                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4" }}>
                    <span
                      style={{
                        fontSize: 11,
                        color: endSnapped ? "#aaa" : "#6b5e4c",
                        fontVariantNumeric: "tabular-nums",
                        textDecoration: endSnapped ? "line-through" : "none",
                      }}
                    >
                      {entry.rawEnd || entry.end || <span style={{ color: "#ddd" }}>—</span>}
                    </span>
                  </td>

                  <td style={S.td}>
                    {isEE ? (
                      <input
                        autoFocus
                        type="time"
                        value={tempVal}
                        onChange={(e) => setTempVal(e.target.value)}
                        onBlur={() => commitEdit(key, "end")}
                        style={S.tinput}
                      />
                    ) : (
                      <button
                        style={{
                          ...S.tbtn,
                          color: entry.end ? (entry.modified ? "#b45309" : "#1a4d12") : "#b0a090",
                          borderColor: entry.modified ? "#fcd34d" : "#c8bfb2",
                          fontWeight: entry.end ? 700 : 400,
                        }}
                        onClick={() => startEdit(key, "end", entry.end)}
                      >
                        {entry.end || "——"}
                      </button>
                    )}
                  </td>

                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "right", paddingRight: 10 }}>
                    {actualWorkMin != null ? (
                      <span style={{ fontSize: 11, color: "#8b7355", fontVariantNumeric: "tabular-nums" }}>{m2t(actualWorkMin)}</span>
                    ) : calc ? (
                      <span style={{ fontSize: 11, color: "#8b7355", fontVariantNumeric: "tabular-nums" }}>{m2t(calc.workMin)}</span>
                    ) : (
                      <span style={{ color: "#ddd" }}>—</span>
                    )}
                  </td>

                  <td style={S.td}>
                    {calc ? <span style={{ color: "#1a4d12", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{m2t(calc.workMin)}</span> : <span style={{ color: "#ddd" }}>—</span>}
                  </td>

                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "center" }}>
                    {calc && calc.overtime > 0 ? (
                      <span style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, fontVariantNumeric: "tabular-nums", background: "#fee2e2", borderRadius: 4, padding: "2px 6px" }}>
                        {m2t(calc.overtime)}
                      </span>
                    ) : (
                      <span style={{ color: "#ddd" }}>—</span>
                    )}
                  </td>

                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "center" }}>
                    {calc ? (calc.breakMin > 0 ? <span style={{ fontSize: 11, background: "#f5f0e8", color: "#8b7355", borderRadius: 4, padding: "2px 5px" }}>{calc.breakMin}分</span> : <span style={{ color: "#ccc", fontSize: 11 }}>なし</span>) : <span style={{ color: "#ddd" }}>—</span>}
                  </td>

                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "right", paddingRight: 8 }}>
                    {calc ? <span style={{ fontSize: 11, fontWeight: 600, color: isWeekend ? "#2563eb" : "#6b5e4c" }}>¥{calc.rate.toLocaleString()}</span> : <span style={{ color: "#ddd" }}>—</span>}
                  </td>

                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "right", paddingRight: 10 }}>
                    {calc ? <span style={{ fontWeight: 700, color: "#1a4d12", fontVariantNumeric: "tabular-nums" }}>¥{calc.wage.toLocaleString()}</span> : <span style={{ color: "#ddd" }}>—</span>}
                  </td>

                  <td style={{ ...S.td, textAlign: "center" }}>
                    {(entry.start || entry.end || entry.status || entry.rawStart || entry.rawEnd) && (
                      <button onClick={() => clearEntry(key)} style={{ background: "none", border: "none", cursor: "pointer", color: "#ccc", fontSize: 11, padding: "2px 4px" }}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 月合計 */}
      <div style={{ margin: "12px 14px 0", background: "linear-gradient(135deg,#1a2e1a 0%,#2d5a27 100%)", borderRadius: 12, padding: "18px 22px", boxShadow: "0 4px 20px rgba(26,46,26,0.2)" }}>
        <div style={{ fontSize: 11, color: "#8db08d", fontWeight: 700, marginBottom: 12, letterSpacing: "0.08em" }}>
          {name} ／ {year}年{month}月 集計
        </div>

        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0, marginBottom: 14 }}>
          {[
            ["出勤日数", `${totals.days}日`],
            ["総勤務時間", m2t(totals.workMin) || "0:00"],
            ["普通残業", totals.overtime > 0 ? m2t(totals.overtime) : "なし"],
          ].map(([l, v], i) => (
            <>
              <div key={l} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, padding: "0 16px", minWidth: 100 }}>
                <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{l}</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: "#e8f5e8", fontVariantNumeric: "tabular-nums" }}>{v}</span>
              </div>
              {i < 2 && <div key={`d${i}`} style={{ width: 1, height: 40, background: "rgba(255,255,255,0.2)" }} />}
            </>
          ))}
          <div style={{ width: 1, height: 40, background: "rgba(255,255,255,0.2)" }} />
          <div style={{ flex: 1.4, display: "flex", flexDirection: "column", gap: 3, padding: "0 16px", minWidth: 130 }}>
            <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{month}月 給与合計</span>
            <span style={{ fontSize: 26, fontWeight: 800, color: "#b9f0b0", fontVariantNumeric: "tabular-nums" }}>¥{totals.wage.toLocaleString()}</span>
          </div>
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12, marginBottom: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em" }}>🌿 有給休暇</span>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: "#8db08d", fontSize: 11 }}>単価 ¥</span>
            <input
              type="number"
              min={0}
              step={100}
              value={paidLeaveWage || 0}
              onChange={(e) => onUpdate(name, "__paid__", +e.target.value)}
              style={{
                width: 80,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.25)",
                borderRadius: 6,
                padding: "4px 8px",
                color: "#e8f5e8",
                fontSize: 13,
                fontWeight: 700,
                outline: "none",
                textAlign: "right",
              }}
            />
          </div>
          <span style={{ color: "#8db08d", fontSize: 11 }}>× {totals.paidDays}日</span>
          <span style={{ color: "#b9f0b0", fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            = ¥{((paidLeaveWage || 0) * totals.paidDays).toLocaleString()}
          </span>
          {totals.paidDays === 0 && <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>（有給取得なし）</span>}
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em" }}>🚃 交通費（往復）</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#e8f5e8", fontSize: 12 }}>¥</span>
              <input
                type="number"
                min={0}
                step={10}
                value={fare || 0}
                onChange={(e) => onUpdate(name, "__fare__", +e.target.value)}
                style={{
                  width: 80,
                  background: "rgba(255,255,255,0.12)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  borderRadius: 6,
                  padding: "4px 8px",
                  color: "#e8f5e8",
                  fontSize: 13,
                  fontWeight: 700,
                  outline: "none",
                  textAlign: "right",
                }}
              />
              <span style={{ color: "#8db08d", fontSize: 11 }}>円 × {totals.days}回</span>
            </div>
            <span style={{ color: "#b9f0b0", fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              = ¥{((fare || 0) * totals.days).toLocaleString()}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em" }}>総支給額（給与＋有給＋交通費）</span>
            <span style={{ fontSize: 26, fontWeight: 800, color: "#ffffff", fontVariantNumeric: "tabular-nums", textShadow: "0 0 20px rgba(185,240,176,0.5)" }}>
              ¥{(totals.wage + (paidLeaveWage || 0) * totals.paidDays + (fare || 0) * totals.days).toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ログインUI ───────────────────────────────────────────────────────────────
function Login({ onLoggedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const login = async () => {
    try {
      setBusy(true);
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      onLoggedIn(data.user);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#fbfaf8", padding: 16 }}>
      <div style={{ width: "min(520px,100%)", background: "#fff", border: "1px solid #eee2d8", borderRadius: 14, padding: 18, boxShadow: "0 10px 30px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 12, color: "#1a2e1a" }}>とりここ勤怠管理ログイン</div>
        <div style={{ display: "grid", gap: 10 }}>
          <input placeholder="メール" value={email} onChange={(e) => setEmail(e.target.value)} style={S.inp} />
          <input type="password" placeholder="パスワード" value={password} onChange={(e) => setPassword(e.target.value)} style={S.inp} />
          <button onClick={login} disabled={busy} style={{ ...S.btnP, width: "100%" }}>
            {busy ? "ログイン中…" : "ログイン"}
          </button>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "#8b7355" }}>
          ※ メールアドレスは1つ（管理用）で運用します
        </div>
      </div>
    </div>
  );
}

// ─── メイン（ログイン統合） ───────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);

  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(2);

  const [allData, setAllData] = useState({});
  const [fareSettings, setFareSettings] = useState({});
  const [paidLeaveSettings, setPaidLeaveSettings] = useState({});

  const [activeName, setActiveName] = useState("");
  const [toast, setToast] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  const fileRef = useRef();

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const names = useMemo(() => Object.keys(allData).sort((a, b) => a.localeCompare(b, "ja")), [allData]);

  // 初回：セッション確認（ログイン維持）
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (data?.user) setUser(data.user);
    })();
  }, []);

  // ログイン後＆年月切替で読み込み
  useEffect(() => {
    if (!user) return;
    let alive = true;

    (async () => {
      try {
        setLoading(true);
        const [att, st] = await Promise.all([sbLoadAttendance(user.id, year, month), sbLoadSettings(user.id)]);
        if (!alive) return;

        setAllData(att);
        setFareSettings(st.fare);
        setPaidLeaveSettings(st.paid);

        const first = Object.keys(att)[0] || Object.keys(st.fare)[0] || Object.keys(st.paid)[0] || "";
        setActiveName((prev) => prev || first);
      } catch (e) {
        showToast(`読込エラー: ${e.message}`, "err");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [user, year, month]);

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setAllData({});
    setFareSettings({});
    setPaidLeaveSettings({});
    setActiveName("");
  };

  const handleUpdate = useCallback(
    async (name, dateStrOrField, entryOrVal) => {
      if (!user) return;

      try {
        if (dateStrOrField === "__fare__") {
          const val = entryOrVal ?? 0;
          setFareSettings((prev) => ({ ...prev, [name]: val }));
          await sbUpsertSettings(user.id, name, val, paidLeaveSettings[name] ?? 0);
          return;
        }
        if (dateStrOrField === "__paid__") {
          const val = entryOrVal ?? 0;
          setPaidLeaveSettings((prev) => ({ ...prev, [name]: val }));
          await sbUpsertSettings(user.id, name, fareSettings[name] ?? 0, val);
          return;
        }

        const dateStr = dateStrOrField;

        if (entryOrVal === null) {
          setAllData((prev) => {
            const next = { ...prev };
            const m = { ...(next[name] || {}) };
            delete m[dateStr];
            next[name] = m;
            return next;
          });
          await sbDeleteAttendance(user.id, name, dateStr);
          return;
        }

        const entry = entryOrVal;
        setAllData((prev) => {
          const next = { ...prev };
          next[name] = { ...(next[name] || {}), [dateStr]: entry };
          return next;
        });
        await sbUpsertAttendance(user.id, name, dateStr, entry);
      } catch (e) {
        showToast(`保存エラー: ${e.message}`, "err");
      }
    },
    [user, fareSettings, paidLeaveSettings]
  );

  const onFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const byName = parseRecoruCSV(ev.target.result);
      if (!Object.keys(byName).length) {
        showToast("CSVにデータがありません", "err");
        return;
      }
      const allKeys = new Set();
      Object.entries(byName).forEach(([n, rows]) => rows.forEach((r) => allKeys.add(n + "|" + r.dateStr)));
      setPreview({ byName, selKeys: allKeys });
    };
    reader.readAsText(file, "Shift-JIS");
    e.target.value = "";
  };

  const toggleSelKey = (k) => {
    setPreview((prev) => {
      const s = new Set(prev.selKeys);
      s.has(k) ? s.delete(k) : s.add(k);
      return { ...prev, selKeys: s };
    });
  };

  const confirmImport = async () => {
    if (!preview || !user) return;
    try {
      setLoading(true);
      let count = 0;

      const next = { ...allData };
      const upserts = [];
      const ensureSettings = [];

      for (const [name, rows] of Object.entries(preview.byName)) {
        if (!next[name]) next[name] = {};

        if (fareSettings[name] == null || paidLeaveSettings[name] == null) {
          ensureSettings.push(sbUpsertSettings(user.id, name, fareSettings[name] ?? 0, paidLeaveSettings[name] ?? 0));
        }

        for (const row of rows) {
          const k = name + "|" + row.dateStr;
          if (!preview.selKeys.has(k)) continue;

          const existing = next[name][row.dateStr] || {};
          if (existing.modified) continue;

          const merged = {
            ...existing,
            status: "出勤",
            start: row.snapSt || existing.start || "",
            end: row.snapEnd || existing.end || "",
            rawStart: row.rawStart || "",
            rawEnd: row.rawEnd || "",
          };

          next[name][row.dateStr] = merged;
          upserts.push(sbUpsertAttendance(user.id, name, row.dateStr, merged));
          count++;
        }
      }

      await Promise.allSettled([...ensureSettings, ...upserts]);
      setAllData(next);

      const firstRow = Object.values(preview.byName).flat()[0];
      if (firstRow) {
        const [y, m] = firstRow.dateStr.split("-").map(Number);
        setYear(y);
        setMonth(m);
      }
      const firstName = Object.keys(preview.byName)[0];
      if (firstName) setActiveName(firstName);

      setPreview(null);
      showToast(`${count}件を取り込みました ✓`);
    } catch (e) {
      showToast(`取込エラー: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  const addName = async () => {
    if (!user) return;
    const n = prompt("氏名を入力してください");
    const name = (n || "").trim();
    if (!name) return;

    setAllData((prev) => (prev[name] ? prev : { ...prev, [name]: {} }));
    setFareSettings((prev) => ({ ...prev, [name]: prev[name] ?? 0 }));
    setPaidLeaveSettings((prev) => ({ ...prev, [name]: prev[name] ?? 0 }));
    setActiveName(name);

    try {
      await sbUpsertSettings(user.id, name, fareSettings[name] ?? 0, paidLeaveSettings[name] ?? 0);
    } catch (e) {
      showToast(`従業員追加エラー: ${e.message}`, "err");
    }
  };

  const removeName = async (name) => {
    if (!user) return;
    if (!window.confirm(`「${name}」のデータ（勤怠・設定）を削除しますか？`)) return;
    try {
      setLoading(true);
      await sbDeleteEmployee(user.id, name);

      setAllData((prev) => {
        const n = { ...prev };
        delete n[name];
        return n;
      });
      setFareSettings((prev) => {
        const n = { ...prev };
        delete n[name];
        return n;
      });
      setPaidLeaveSettings((prev) => {
        const n = { ...prev };
        delete n[name];
        return n;
      });

      setActiveName((prev) => {
        if (prev !== name) return prev;
        const remain = names.filter((x) => x !== name);
        return remain[0] || "";
      });

      showToast(`「${name}」を削除しました`);
    } catch (e) {
      showToast(`削除エラー: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return <Login onLoggedIn={(u) => setUser(u)} />;
  }

  const activeEntries = allData[activeName] || {};

  return (
    <div style={S.root}>
      {toast && <div style={{ ...S.toast, background: toast.type === "err" ? "#dc2626" : "#1a4d12" }}>{toast.msg}</div>}

      {preview && (
        <div style={S.overlay} onClick={() => setPreview(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>📋 れこるCSV 取り込み確認</span>
              <button style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#888" }} onClick={() => setPreview(null)}>
                ✕
              </button>
            </div>
            <div style={S.noteBox}>
              <b>スナップ：</b>〜10:59着 → <b>11:00から</b>、14:00〜14:59着 → <b>15:00から</b>
              <br />
              11:01以降はそのまま。※ 手動修正済み（修）は上書きしません
            </div>

            <div style={{ maxHeight: "48vh", overflowY: "auto", marginBottom: 14 }}>
              {Object.entries(preview.byName).map(([name, rows]) => (
                <div key={name} style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 800, fontSize: 13, color: "#1a2e1a", background: "#e8f5e8", borderRadius: 7, padding: "5px 10px", marginBottom: 3, display: "flex", alignItems: "center", gap: 8 }}>
                    👤 {name}
                    <span style={{ fontSize: 10, color: "#2d6a2d", fontWeight: 600 }}>{rows.length}件</span>
                  </div>
                  {rows.map((row) => {
                    const k = name + "|" + row.dateStr;
                    const snapped = row.rawStart && row.snapSt !== row.rawStart;
                    return (
                      <label key={k} style={{ display: "flex", alignItems: "center", padding: "5px 10px", borderBottom: "1px solid #f5f0e8", cursor: "pointer", fontSize: 12, gap: 6, flexWrap: "wrap" }}>
                        <input type="checkbox" checked={preview.selKeys.has(k)} onChange={() => toggleSelKey(k)} />
                        <span style={{ minWidth: 96, color: "#6b5e4c", fontWeight: 600 }}>{row.dateStr}</span>
                        <span>
                          {row.rawStart ? (
                            <>
                              <s style={{ color: "#bbb", fontSize: 11 }}>{row.rawStart}</s>
                              <span style={{ color: "#888", margin: "0 3px" }}>→</span>
                              <b style={{ color: "#1a4d12" }}>{row.snapSt || "—"}</b>
                            </>
                          ) : (
                            <span style={{ color: "#aaa" }}>開始なし</span>
                          )}
                        </span>
                        <span style={{ color: "#aaa", margin: "0 2px" }}>〜</span>
                        <span style={{ color: "#1a1209" }}>{row.snapEnd || <span style={{ color: "#aaa" }}>未退勤</span>}</span>
                        {snapped && <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>スナップ</span>}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button style={S.btnG} onClick={() => setPreview(null)}>
                キャンセル
              </button>
              <button style={S.btnP} onClick={confirmImport}>
                取り込む（{preview.selKeys.size}件）
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={S.header}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: "#e8f5e8", letterSpacing: "0.05em" }}>勤怠管理</span>
          <span style={{ fontSize: 12, color: "#8db08d" }}>給与計算システム / とりここ</span>
          {loading && <span style={{ fontSize: 11, color: "#cfe9cf", marginLeft: 8 }}>（同期中…）</span>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select style={S.sel} value={year} onChange={(e) => setYear(+e.target.value)}>
            {[2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>
                {y}年
              </option>
            ))}
          </select>
          <select style={S.sel} value={month} onChange={(e) => setMonth(+e.target.value)}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m}月
              </option>
            ))}
          </select>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={onFile} />
          <button style={S.csvBtn} onClick={() => fileRef.current.click()}>
            📂 れこるCSV 読み込み
          </button>
          <button style={{ ...S.csvBtn, borderColor: "rgba(255,255,255,0.35)" }} onClick={logout}>
            ログアウト
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 7, padding: "9px 14px", background: "#f0ece4", borderBottom: "1px solid #e0d8cc", flexWrap: "wrap" }}>
        {[
          ["平日時給", `¥${HOURLY_NORMAL.toLocaleString()}`],
          ["土日祝時給", `¥${HOURLY_WEEKEND.toLocaleString()}`],
          ["営業時間", "11:00〜18:30"],
          ["休憩", "45分(6h以上)"],
          ["スナップ", "〜10:59→11:00 / 14:xx→15:00"],
          ["残業", "18:30超過"],
        ].map(([l, v]) => (
          <div key={l} style={{ background: "#fff", border: "1px solid #ddd5c8", borderRadius: 999, padding: "6px 10px", fontSize: 11, color: "#6b5e4c" }}>
            <b style={{ color: "#1a2e1a" }}>{l}</b> {v}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", flexWrap: "wrap" }}>
        <button style={S.addBtn} onClick={addName}>
          ＋ 追加
        </button>
        {names.length === 0 && <span style={{ fontSize: 12, color: "#8b7355" }}>（この月のデータがまだありません。CSV読み込みか、＋追加してください）</span>}
        {names.map((n) => {
          const e = allData[n] || {};
          const days = Object.keys(e).filter((d) => e[d]?.start && e[d]?.end).length;
          const paidDays = Object.keys(e).filter((d) => e[d]?.status === "有給休暇").length;
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                onClick={() => setActiveName(n)}
                style={{
                  ...S.tabBtn,
                  background: activeName === n ? "#1a2e1a" : "#fff",
                  color: activeName === n ? "#e8f5e8" : "#1a2e1a",
                  borderColor: activeName === n ? "#1a2e1a" : "#ddd5c8",
                }}
                title={`${days}回 / 有給${paidDays}日`}
              >
                {n}
              </button>
              <button onClick={() => removeName(n)} style={S.xBtn} title="従業員削除">
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ paddingBottom: 22 }}>
        {activeName ? (
          <AttendanceTable
            name={activeName}
            year={year}
            month={month}
            entries={activeEntries}
            fare={fareSettings[activeName] ?? 0}
            paidLeaveWage={paidLeaveSettings[activeName] ?? 0}
            onUpdate={handleUpdate}
          />
        ) : (
          <div style={{ padding: 18, color: "#8b7355", fontSize: 13 }}>従業員が未選択です（＋追加 か CSV読込 をしてください）</div>
        )}
      </div>
    </div>
  );
}

// ─── スタイル ────────────────────────────────────────────────────────────────
const S = {
  root: {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif',
    background: "#fbfaf8",
    minHeight: "100vh",
  },
  header: {
    background: "linear-gradient(135deg,#1a2e1a 0%,#2d5a27 100%)",
    padding: "14px 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  sel: {
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.25)",
    color: "#e8f5e8",
    borderRadius: 10,
    padding: "7px 10px",
    fontSize: 12,
    outline: "none",
    cursor: "pointer",
  },
  csvBtn: {
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.25)",
    color: "#e8f5e8",
    borderRadius: 10,
    padding: "7px 10px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 700,
  },
  toast: {
    position: "fixed",
    top: 12,
    right: 12,
    color: "#fff",
    padding: "10px 12px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 700,
    boxShadow: "0 8px 30px rgba(0,0,0,0.2)",
    zIndex: 9999,
  },
  addBtn: {
    border: "1px solid #ddd5c8",
    background: "#fff",
    borderRadius: 10,
    padding: "7px 10px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 800,
    color: "#1a2e1a",
  },
  tabBtn: {
    border: "1px solid #ddd5c8",
    background: "#fff",
    borderRadius: 999,
    padding: "7px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 800,
  },
  xBtn: {
    border: "1px solid #eee",
    background: "#fff",
    borderRadius: 8,
    padding: "5px 8px",
    fontSize: 11,
    cursor: "pointer",
    color: "#999",
  },
  tableWrap: {
    margin: "0 14px",
    background: "#fff",
    border: "1px solid #eee2d8",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 3px 16px rgba(0,0,0,0.04)",
  },
  thBig: { padding: "10px 8px", textAlign: "center", fontSize: 11, fontWeight: 800 },
  thSub: { padding: "7px 8px", textAlign: "center", fontSize: 10, fontWeight: 800 },
  td: { padding: "8px 8px", verticalAlign: "middle", color: "#1a1209" },
  htag: { marginTop: 2, fontSize: 10, color: "#dc2626", fontWeight: 800 },
  tbtn: {
    width: "100%",
    border: "1px solid #c8bfb2",
    background: "#fff",
    borderRadius: 8,
    padding: "6px 8px",
    cursor: "pointer",
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  },
  tinput: {
    width: "100%",
    border: "2px solid #1a4d12",
    borderRadius: 8,
    padding: "6px 8px",
    outline: "none",
    fontSize: 12,
  },
  modTag: {
    marginLeft: 6,
    fontSize: 10,
    background: "#fef3c7",
    color: "#92400e",
    borderRadius: 6,
    padding: "1px 5px",
    fontWeight: 800,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9990,
    padding: 14,
  },
  modal: {
    width: "min(860px, 100%)",
    background: "#fff",
    borderRadius: 14,
    padding: 14,
    boxShadow: "0 18px 60px rgba(0,0,0,0.25)",
  },
  noteBox: {
    background: "#fffbe6",
    border: "1px solid #fde68a",
    color: "#6b5e4c",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 12,
    marginBottom: 10,
  },
  btnG: {
    border: "1px solid #ddd5c8",
    background: "#fff",
    borderRadius: 10,
    padding: "9px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 800,
  },
  btnP: {
    border: "1px solid #1a2e1a",
    background: "#1a2e1a",
    color: "#e8f5e8",
    borderRadius: 10,
    padding: "9px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 900,
  },
  inp: {
    width: "100%",
    border: "1px solid #ddd5c8",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 14,
    outline: "none",
  },
};