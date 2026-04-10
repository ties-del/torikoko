// ════════════════════════════════════════════════════════════════════════
//  とりここ 勤怠管理システム
//  ※ 初回セットアップ：SupabaseのSQLエディターで下記を実行してください
// ════════════════════════════════════════════════════════════════════════
//
//  create table attendance (
//    id uuid default gen_random_uuid() primary key,
//    name text not null,
//    date_str text not null,
//    status text,
//    shift_type text default '',
//    start_time text,
//    end_time text,
//    raw_start text,
//    raw_end text,
//    modified boolean default false,
//    unique(name, date_str)
//  );
//
//  create table employee_settings (
//    id uuid default gen_random_uuid() primary key,
//    name text unique not null,
//    fare integer default 0,
//    paid_leave_wage integer default 0,
//    employment_type text default 'パート',
//    monthly_wage integer default 0
//  );
//
//  create table workplace_rules (
//    id uuid default gen_random_uuid() primary key,
//    location_name text unique not null,
//    business_start text default '11:00',
//    business_end text default '18:30',
//    snap_early_threshold text default '11:00',
//    snap_early_to text default '11:00',
//    snap_range_start text default '14:00',
//    snap_range_end text default '15:00',
//    snap_range_to text default '15:00',
//    break_minutes_full_time integer default 45,
//    break_threshold_minutes_full_time integer default 360,
//    break_minutes_part_time integer default 45,
//    break_threshold_minutes_part_time integer default 360,
//    hourly_normal integer default 1116,
//    hourly_weekend integer default 1200
//  );
//
//  create table bento_checks (
//    id uuid default gen_random_uuid() primary key,
//    name text not null,
//    date_str text not null,
//    checked boolean default true,
//    unique(name, date_str)
//  );
//
//  ※ 臨時支給をDBに保存するには下記も実行してください
//  ALTER TABLE employee_settings ADD COLUMN IF NOT EXISTS extras_json text default '{}';
//
// ════════════════════════════════════════════════════════════════════════

import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { supabase } from "./supabase";
import * as XLSX from "xlsx";

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const DEFAULT_WORK_RULE = {
  locationName: "とりここ",
  businessStart: "11:00",
  businessEnd: "18:30",
  snapEarlyThreshold: "11:00",
  snapEarlyTo: "11:00",
  snapRangeStart: "00:00",
  snapRangeEnd: "00:00",
  snapRangeTo: "00:00",
  breakMinutesFullTime: 45,
  breakThresholdMinutesFullTime: 6 * 60,
  breakMinutesPartTime: 45,
  breakThresholdMinutesPartTime: 6 * 60,
  hourlyNormal: 1116,
  hourlyWeekend: 1200,
};

// 初期3店舗
const DEFAULT_LOCATIONS = ["とりここ", "Ties", "Lien"];
const DEFAULT_BENTO_PRICE_PER_MEAL = 500;
const LEGACY_SHARED_BENTO_PRICE_KEY = "__shared__";
const BENTO_PRICE_APP_KEY_PREFIX = "bento_price:";

const EMPLOYMENT_TYPES = ["正社員", "パート"];
const DEFAULT_EMPLOYMENT_TYPE = "パート";
const RULE_MODE_STORE = "store_shared";
const RULE_MODE_INDIVIDUAL = "store_individual";
const KINMU_OPTIONS = ["出勤", "欠勤", "遅刻", "早退", "休日出勤", "有給休暇", "半有給"];
const TORIKOKO_SHIFT_RULES = {
  morning: { label: "午前", start: "11:00", end: "15:00" },
  afternoon: { label: "午後", start: "15:00", end: "18:30" },
};

const HOLIDAYS = {
  "2026-01-01": "元日", "2026-01-12": "成人の日",
  "2026-02-11": "建国記念の日", "2026-02-23": "天皇誕生日",
  "2026-03-20": "春分の日", "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日", "2026-05-04": "みどりの日", "2026-05-05": "こどもの日",
  "2026-09-21": "敬老の日", "2026-09-23": "秋分の日",
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];

// ─── ユーティリティ ────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");
const getLocalToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
};

// 21日締め：選択月の「前月21日〜当月20日」を返す
// 例: year=2026, month=3 → "2026-02-21" 〜 "2026-03-20"
function getPeriodRange(year, month) {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const start = `${prevYear}-${pad2(prevMonth)}-21`;
  const end   = `${year}-${pad2(month)}-20`;
  return { start, end };
}

// 期間内の全日付を配列で返す（前月21日〜当月20日）
function getPeriodDays(year, month) {
  const { start, end } = getPeriodRange(year, month);
  const days = [];
  let cur = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (cur <= endDate) {
    const y = cur.getFullYear(), mo = cur.getMonth() + 1, d = cur.getDate();
    days.push({
      mo,
      d, key: `${y}-${pad2(mo)}-${pad2(d)}`,
      dow: cur.getDay(),
      wdJP: WD[cur.getDay()],
    });
    cur = new Date(cur.getTime() + 86400000);
  }
  return days;
}

// 締め期間ラベル
function getPeriodLabel(year, month) {
  const { start, end } = getPeriodRange(year, month);
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const sLabel = sy !== ey ? `${sy}年${sm}月${sd}日` : `${sm}月${sd}日`;
  return `${sLabel}〜${em}月${ed}日`;
}

// 勤務日(yyyy-mm-dd)が属する「21日締めの表示年月」を返す
// 例: 2026-02-21 -> { year: 2026, month: 3 }
function getPeriodFromDateStr(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  let mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  // 21日以降は翌月の締め期間
  if (d >= 21) {
    mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
  }
  return { year: y, month: mo };
}

function getPreviousPeriod(year, month) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function toHalfWidth(text) {
  return String(text || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/：/g, ":")
    .replace(/．/g, ".")
    .replace(/／/g, "/")
    .replace(/－/g, "-");
}

function parseCsvRows(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuote = false;
  const src = String(text || "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (inQuote && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (!inQuote && ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!inQuote && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function detectCsvDelimiter(text) {
  const src = String(text || "");
  const head = src.split(/\r?\n/).slice(0, 20).join("\n");
  const choices = [",", "\t", ";"];
  let best = { delimiter: ",", count: -1 };
  for (const delimiter of choices) {
    const rows = parseCsvRows(head, delimiter);
    const count = rows.reduce((sum, row) => sum + Math.max(0, row.length - 1), 0);
    if (count > best.count) best = { delimiter, count };
  }
  return best.delimiter;
}

function normalizeCsvHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/[ 　\t]/g, "")
    .toLowerCase();
}

function findHeaderIndex(headers, aliases) {
  const norms = headers.map(normalizeCsvHeader);
  const aliasNorms = aliases.map(normalizeCsvHeader);
  const exact = norms.findIndex((h) => aliasNorms.includes(h));
  if (exact >= 0) return exact;
  const contains = norms.findIndex((h) => aliasNorms.some((a) => h.includes(a) || a.includes(h)));
  return contains;
}

function normalizeDateStr(value) {
  const text = toHalfWidth(value).trim();
  if (!text) return "";
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 40000 && serial < 70000) {
    const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const compact = text.replace(/[^\d]/g, "");
  if (/^\d{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }
  const normalized = text.replace(/[./年月]/g, "-").replace(/日/g, "").replace(/--+/g, "-");
  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeTimeStr(value) {
  const text = toHalfWidth(value).trim();
  if (!text) return "";

  const hhmm = text.match(/^(\d{3,4})$/);
  if (hhmm) {
    const raw = hhmm[1].padStart(4, "0");
    const h = Number(raw.slice(0, 2));
    const min = Number(raw.slice(2, 4));
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  const jp = text.match(/^(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分?)?$/);
  if (jp) {
    const h = Number(jp[1]);
    const min = Number(jp[2] || "0");
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  const m = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function chooseEarlierTime(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  const am = t2m(a);
  const bm = t2m(b);
  if (am == null) return b;
  if (bm == null) return a;
  return am <= bm ? a : b;
}

function chooseLaterTime(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  const am = t2m(a);
  const bm = t2m(b);
  if (am == null) return b;
  if (bm == null) return a;
  return am >= bm ? a : b;
}

function formatAverageHours(minutes) {
  const hours = (Number(minutes) || 0) / 60;
  return `${hours.toFixed(1)}時間`;
}

function getBentoStorageKey(userId) {
  return `torikoko:bento:${userId || "anon"}`;
}

function getBentoPriceStorageKey(userId) {
  return `torikoko:bentoPrice:${userId || "anon"}`;
}

function normalizeBentoPriceMap(source = {}) {
  const next = {};
  for (const [rawKey, rawValue] of Object.entries(source || {})) {
    const price = Math.max(0, Math.round(Number(rawValue) || 0));
    if (rawKey === LEGACY_SHARED_BENTO_PRICE_KEY) {
      next[rawKey] = price;
      continue;
    }
    const locationName = normalizeLocation(rawKey);
    if (!locationName) continue;
    next[locationName] = price;
  }
  return next;
}

function loadBentoPriceMapFromStorage(userId) {
  try {
    const raw = localStorage.getItem(getBentoPriceStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalizeBentoPriceMap(parsed);
    }
  } catch {
    // fall back to the legacy scalar format below
  }
  try {
    const raw = localStorage.getItem(getBentoPriceStorageKey(userId));
    const price = Math.max(0, Math.round(Number(raw) || 0));
    if (price > 0) return { [LEGACY_SHARED_BENTO_PRICE_KEY]: price };
  } catch {
    // ignore storage issues
  }
  return {};
}

function saveBentoPriceMapToStorage(userId, bentoPriceMap) {
  try {
    localStorage.setItem(getBentoPriceStorageKey(userId), JSON.stringify(normalizeBentoPriceMap(bentoPriceMap)));
  } catch {
    // ignore storage issues
  }
}

function getBentoAppKey(locationName) {
  return `${BENTO_PRICE_APP_KEY_PREFIX}${normalizeLocation(locationName) || DEFAULT_WORK_RULE.locationName}`;
}

function resolveBentoFallbackPrice(fallbackPrice, name, dateStr) {
  const value = typeof fallbackPrice === "function" ? fallbackPrice(name, dateStr) : fallbackPrice;
  return Math.max(0, Math.round(Number(value) || 0));
}

function isBentoCheckedValue(value) {
  if (value === true) return true;
  if (typeof value === "number") return value > 0;
  if (value && typeof value === "object") {
    if (value.checked === true) return true;
    if (Number(value.price) > 0) return true;
    if (Number(value.unitPrice) > 0) return true;
  }
  return false;
}

function getBentoUnitPrice(value, fallbackPrice = 0) {
  if (!isBentoCheckedValue(value)) return 0;
  if (typeof value === "number") return Math.max(0, Math.round(value));
  if (value && typeof value === "object") {
    const direct = Math.max(0, Math.round(Number(value.price) || Number(value.unitPrice) || 0));
    if (direct > 0) return direct;
  }
  return Math.max(0, Math.round(Number(fallbackPrice) || 0));
}

function countBentoEntries(byDate, dateFilter = null) {
  return Object.entries(byDate || {}).filter(([dateStr, value]) => {
    if (!isBentoCheckedValue(value)) return false;
    if (typeof dateFilter === "function" && !dateFilter(dateStr)) return false;
    return true;
  }).length;
}

function sumBentoEntries(byDate, fallbackPrice = 0, dateFilter = null) {
  return Object.entries(byDate || {}).reduce((sum, [dateStr, value]) => {
    if (!isBentoCheckedValue(value)) return sum;
    if (typeof dateFilter === "function" && !dateFilter(dateStr)) return sum;
    return sum + getBentoUnitPrice(value, fallbackPrice);
  }, 0);
}

function loadBentoChecksFromStorage(userId) {
  try {
    const raw = localStorage.getItem(getBentoStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveBentoChecksToStorage(userId, bentoChecks) {
  try {
    localStorage.setItem(getBentoStorageKey(userId), JSON.stringify(bentoChecks || {}));
  } catch {
    // ignore storage quota / private mode issues
  }
}

function filterRecordByKeys(record, allowedKeys) {
  const allowed = new Set((allowedKeys || []).filter(Boolean));
  return Object.fromEntries(
    Object.entries(record || {}).filter(([key]) => allowed.has(key))
  );
}

function replaceBentoChecksPeriodInStorage(userId, bentoChecks, year, month) {
  const { start, end } = getPeriodRange(year, month);
  const stored = loadBentoChecksFromStorage(userId);
  const next = {};

  for (const [name, byDate] of Object.entries(stored)) {
    const filtered = Object.fromEntries(
      Object.entries(byDate || {}).filter(([dateStr, value]) => !(dateStr >= start && dateStr <= end) && isBentoCheckedValue(value))
    );
    if (Object.keys(filtered).length) next[name] = filtered;
  }

  for (const [name, byDate] of Object.entries(bentoChecks || {})) {
    const filtered = Object.fromEntries(
      Object.entries(byDate || {}).filter(([dateStr, value]) => dateStr >= start && dateStr <= end && isBentoCheckedValue(value))
    );
    if (Object.keys(filtered).length) next[name] = { ...(next[name] || {}), ...filtered };
  }

  saveBentoChecksToStorage(userId, next);
}

function mergeBentoChecks(dbChecks, localChecks, year, month, fallbackPrice = 0) {
  const { start, end } = getPeriodRange(year, month);
  const merged = {};
  const names = new Set([
    ...Object.keys(dbChecks || {}),
    ...Object.keys(localChecks || {}),
  ]);

  for (const name of names) {
    const byDate = {};
    for (const [dateStr, value] of Object.entries(dbChecks?.[name] || {})) {
      if (isBentoCheckedValue(value) && dateStr >= start && dateStr <= end) {
        byDate[dateStr] = getBentoUnitPrice(value, resolveBentoFallbackPrice(fallbackPrice, name, dateStr));
      }
    }
    for (const [dateStr, value] of Object.entries(localChecks?.[name] || {})) {
      if (isBentoCheckedValue(value) && dateStr >= start && dateStr <= end && !byDate[dateStr]) {
        byDate[dateStr] = getBentoUnitPrice(value, resolveBentoFallbackPrice(fallbackPrice, name, dateStr));
      }
    }
    if (Object.keys(byDate).length) merged[name] = byDate;
  }

  return merged;
}

function getAttendanceShiftStorageKey(userId) {
  return `torikoko:attendanceShift:${userId || "anon"}`;
}

function loadAttendanceShiftsFromStorage(userId) {
  try {
    const raw = localStorage.getItem(getAttendanceShiftStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mergeAttendanceShiftMap(attendance, shiftMap, year, month) {
  const merged = {};
  const { start, end } = getPeriodRange(year, month);
  const names = new Set([
    ...Object.keys(attendance || {}),
    ...Object.keys(shiftMap || {}),
  ]);

  for (const name of names) {
    const currentEntries = attendance?.[name] || {};
    const storedShifts = Object.fromEntries(
      Object.entries(shiftMap?.[name] || {}).filter(([dateStr]) => dateStr >= start && dateStr <= end)
    );
    const dates = new Set([
      ...Object.keys(currentEntries),
      ...Object.keys(storedShifts),
    ]);
    const nextEntries = {};

    for (const dateStr of dates) {
      const normalized = normalizeAttendanceEntry(currentEntries[dateStr] || {});
      const storedShift = normalizeShiftType(storedShifts[dateStr]);
      if (!normalized.shiftType && storedShift) normalized.shiftType = storedShift;
      if (normalized.status || normalized.start || normalized.end || normalized.rawStart || normalized.rawEnd || normalized.modified || normalized.shiftType) {
        nextEntries[dateStr] = normalized;
      }
    }

    if (Object.keys(nextEntries).length) merged[name] = nextEntries;
  }

  return merged;
}

function replaceAttendanceShiftsPeriodInStorage(userId, allData, year, month) {
  const { start, end } = getPeriodRange(year, month);
  const stored = loadAttendanceShiftsFromStorage(userId);
  const next = {};

  for (const [name, byDate] of Object.entries(stored || {})) {
    const filtered = Object.fromEntries(
      Object.entries(byDate || {}).filter(([dateStr, shiftType]) => !(dateStr >= start && dateStr <= end) && normalizeShiftType(shiftType))
    );
    if (Object.keys(filtered).length) next[name] = filtered;
  }

  for (const [name, byDate] of Object.entries(allData || {})) {
    const filtered = Object.fromEntries(
      Object.entries(byDate || {})
        .filter(([dateStr, entry]) => dateStr >= start && dateStr <= end && normalizeShiftType(entry?.shiftType))
        .map(([dateStr, entry]) => [dateStr, normalizeShiftType(entry?.shiftType)])
    );
    if (Object.keys(filtered).length) next[name] = { ...(next[name] || {}), ...filtered };
  }

  try {
    localStorage.setItem(getAttendanceShiftStorageKey(userId), JSON.stringify(next));
  } catch {
    // ignore storage quota / private mode issues
  }
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
  return new Date(d).getDay() === 0 || new Date(d).getDay() === 6 || !!HOLIDAYS[d];
}
function normalizeLocation(v) {
  return String(v || "").replace(/\u3000/g, " ").trim().replace(/\s+/g, " ");
}
function normalizePersonName(v) {
  return String(v || "").replace(/\u3000/g, " ").trim().replace(/\s+/g, "");
}
function normalizeEmployment(v) {
  return v === "正社員" ? "正社員" : "パート";
}
function normalizeShiftType(v) {
  const value = String(v || "").trim();
  if (value === "morning" || value === "午前") return "morning";
  if (value === "afternoon" || value === "午後") return "afternoon";
  return "";
}
function getShiftLabel(shiftType) {
  return TORIKOKO_SHIFT_RULES[normalizeShiftType(shiftType)]?.label || "";
}
function guessTorikokoShiftType(locationName, entry) {
  if (normalizeLocation(locationName) !== "とりここ") return "";
  const start = normalizeTimeStr(entry?.rawStart || entry?.start || entry?.roundedStart || "");
  const end = normalizeTimeStr(entry?.rawEnd || entry?.end || entry?.roundedEnd || "");
  const startMin = t2m(start);
  const endMin = t2m(end);
  if (startMin != null) {
    if (startMin < 13 * 60) return "morning";
    if (startMin >= 14 * 60) return "afternoon";
  }
  if (endMin != null) {
    if (endMin <= 16 * 60) return "morning";
    if (endMin >= 17 * 60) return "afternoon";
  }
  return "";
}
function getEntryShiftType(workRule, entry) {
  return normalizeShiftType(entry?.shiftType) || guessTorikokoShiftType(workRule?.locationName, entry);
}
function applyEntryShiftRule(workRule = DEFAULT_WORK_RULE, entry = {}) {
  const base = sanitizeRule(workRule);
  if (normalizeLocation(base.locationName) !== "とりここ") return base;
  const shiftType = getEntryShiftType(base, entry);
  const shift = TORIKOKO_SHIFT_RULES[shiftType];
  if (!shift) return base;
  return {
    ...sanitizeRule({
      ...base,
      snapEarlyThreshold: shift.start,
      snapEarlyTo: shift.start,
      businessEnd: shift.end,
    }),
    startRoundWindowMinutes: 30,
  };
}
function getPaidLeaveUnits(status) {
  if (status === "有給休暇") return 1;
  if (status === "半有給") return 0.5;
  return 0;
}
function normalizeAttendanceEntry(entry) {
  const e = { ...(entry || {}) };
  e.shiftType = normalizeShiftType(e.shiftType);
  if (!e.shiftType) delete e.shiftType;
  const hasAnyTime = !!(e.start || e.end || e.rawStart || e.rawEnd);
  if (!hasAnyTime && !e.modified && e.status === "出勤") {
    e.status = "";
  }
  return e;
}
function normalizeRuleMode(v) {
  return v === RULE_MODE_INDIVIDUAL ? RULE_MODE_INDIVIDUAL : RULE_MODE_STORE;
}
function safeNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ─── 交通費・臨時支給 計算ヘルパー ─────────────────────────────────────────────
function calcFareTotal(name, workDays, year, month, fareConfig, fareSettings) {
  const cfg = fareConfig?.[name];
  if (cfg?.type === "teiki") {
    const periodKey = `${year}-${pad2(month)}`;
    return cfg.teikiNextBilling === periodKey ? (cfg.teikiAmount ?? 0) : 0;
  }
  return (fareSettings?.[name] ?? 0) * workDays;
}

function calcExtrasTotal(name, year, month, extras) {
  const periodKey = `${year}-${pad2(month)}`;
  return (extras?.[name] || [])
    .filter(e => e.periodKey === periodKey)
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);
}

function sanitizeRule(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const legacyBreak = Math.max(0, Math.floor(safeNum(b.breakMinutes, DEFAULT_WORK_RULE.breakMinutesFullTime)));
  const legacyThreshold = Math.max(0, Math.floor(safeNum(b.breakThresholdMinutes, DEFAULT_WORK_RULE.breakThresholdMinutesFullTime)));

  const str = (key, alt, def) =>
    (typeof b[key] === "string" && b[key]) ? b[key] :
    (typeof b[alt] === "string" && b[alt]) ? b[alt] : def;

  return {
    locationName:                  normalizeLocation(b.locationName) || DEFAULT_WORK_RULE.locationName,
    businessStart:                 str("businessStart",  "business_start",  DEFAULT_WORK_RULE.businessStart),
    businessEnd:                   str("businessEnd",    "business_end",    DEFAULT_WORK_RULE.businessEnd),
    snapEarlyThreshold:            str("snapEarlyThreshold", "snap_early_threshold", DEFAULT_WORK_RULE.snapEarlyThreshold),
    snapEarlyTo:                   str("snapEarlyTo",    "snap_early_to",   DEFAULT_WORK_RULE.snapEarlyTo),
    snapRangeStart:                str("snapRangeStart", "snap_range_start", "00:00"),
    snapRangeEnd:                  str("snapRangeEnd",   "snap_range_end",   "00:00"),
    snapRangeTo:                   str("snapRangeTo",    "snap_range_to",    "00:00"),
    breakMinutesFullTime:          Math.max(0, Math.floor(safeNum(b.breakMinutesFullTime    ?? b.break_minutes_full_time,    legacyBreak))),
    breakThresholdMinutesFullTime: Math.max(0, Math.floor(safeNum(b.breakThresholdMinutesFullTime ?? b.break_threshold_minutes_full_time, legacyThreshold))),
    breakMinutesPartTime:          Math.max(0, Math.floor(safeNum(b.breakMinutesPartTime    ?? b.break_minutes_part_time,    legacyBreak))),
    breakThresholdMinutesPartTime: Math.max(0, Math.floor(safeNum(b.breakThresholdMinutesPartTime ?? b.break_threshold_minutes_part_time, legacyThreshold))),
    hourlyNormal:                  Math.max(0, Math.floor(safeNum(b.hourlyNormal,  DEFAULT_WORK_RULE.hourlyNormal))),
    hourlyWeekend:                 Math.max(0, Math.floor(safeNum(b.hourlyWeekend, DEFAULT_WORK_RULE.hourlyWeekend))),
  };
}

function getBreakRule(workRule, employmentType) {
  const r = sanitizeRule(workRule);
  return normalizeEmployment(employmentType) === "正社員"
    ? { breakMinutes: r.breakMinutesFullTime,   breakThreshold: r.breakThresholdMinutesFullTime }
    : { breakMinutes: r.breakMinutesPartTime,   breakThreshold: r.breakThresholdMinutesPartTime };
}

function defaultRulesMap() {
  const map = {};
  for (const loc of DEFAULT_LOCATIONS) {
    map[loc] = sanitizeRule({ ...DEFAULT_WORK_RULE, locationName: loc });
  }
  return map;
}

function snapStart(ts, workRule = DEFAULT_WORK_RULE) {
  if (!ts) return ts;
  const t = t2m(ts);
  if (t == null) return ts;
  const r = sanitizeRule(workRule);
  const earlyWindowMin = Math.max(0, Number(workRule?.startRoundWindowMinutes) || 0);

  // 早朝スナップ：指定境界より前で、かつ指定ウィンドウ内の時刻のみ境界時刻へ丸める
  const earlyThreshold = t2m(r.snapEarlyThreshold) ?? t2m(r.businessStart);
  const earlySnapTo    = t2m(r.snapEarlyTo)        ?? t2m(r.businessStart);
  if (earlyThreshold != null && earlySnapTo != null && t < earlyThreshold) {
    if (earlyWindowMin > 0 && t < (earlyThreshold - earlyWindowMin)) return ts;
    return m2t(Math.max(earlyThreshold, earlySnapTo));
  }

  // 範囲スナップ：start === end のとき無効（削除済み）
  const from = t2m(r.snapRangeStart);
  const to   = t2m(r.snapRangeEnd);
  const snapTo = t2m(r.snapRangeTo);
  if (from != null && to != null && snapTo != null && from !== to) {
    const rangeFrom = Math.min(from, to);
    const rangeTo   = Math.max(from, to);
    if (t >= rangeFrom && t < rangeTo) return m2t(snapTo);
  }

  return ts; // 上記以外はそのまま
}

function resolveAutoEnd(rawEnd, storedEnd, workRule = DEFAULT_WORK_RULE) {
  const rawMin = t2m(rawEnd);
  const businessEndMin = t2m(workRule?.businessEnd);
  if (rawMin == null) return storedEnd || rawEnd || "";
  if (businessEndMin == null) return rawEnd || storedEnd || "";

  // 終了時刻が businessEnd 以降なら businessEnd に丸める（全店舗共通）
  if (rawMin >= businessEndMin) {
    return m2t(businessEndMin) || rawEnd || storedEnd || "";
  }

  // raw打刻がある自動計算行は、保存済みの丸め値ではなく現在のルールで毎回再計算する。
  // これにより管理画面の店舗ルール訂正が既存データの勤務値にも反映される。
  return rawEnd || storedEnd || "";
}

function resolveEntryTimes(entry, workRule = DEFAULT_WORK_RULE) {
  const e = entry || {};
  const effectiveRule = applyEntryShiftRule(workRule, e);
  const effectiveStart = e.rawStart
    ? (e.modified ? (e.start || snapStart(e.rawStart, effectiveRule)) : snapStart(e.rawStart, effectiveRule))
    : (e.start || "");
  const effectiveEnd = e.rawEnd
    ? (e.modified ? (e.end || resolveAutoEnd(e.rawEnd, e.end, effectiveRule)) : resolveAutoEnd(e.rawEnd, e.end, effectiveRule))
    : (e.end || "");
  return { effectiveStart, effectiveEnd };
}

function calcWork(dateStr, startStr, endStr, workRule = DEFAULT_WORK_RULE, employmentType = DEFAULT_EMPLOYMENT_TYPE, entry = null) {
  if (!startStr || !endStr) return null;
  const r = applyEntryShiftRule(workRule, entry || {});
  const br = getBreakRule(r, employmentType);
  const s = t2m(startStr), e = t2m(endStr);
  if (s == null || e == null || e <= s) return null;

  const span     = e - s;
  const breakMin = span >= br.breakThreshold ? br.breakMinutes : 0;
  const workMin  = span - breakMin;
  if (workMin <= 0) return null;

  const businessEndMin = t2m(r.businessEnd) ?? 0;
  const overtime = Math.max(0, e - businessEndMin);
  const rate = isWE(dateStr) ? r.hourlyWeekend : r.hourlyNormal;
  return { workMin, breakMin, overtime, rate, wage: Math.floor((workMin / 60) * rate) };
}

function calcActualWork(rawStart, rawEnd, workRule = DEFAULT_WORK_RULE, employmentType = DEFAULT_EMPLOYMENT_TYPE) {
  if (!rawStart || !rawEnd) return null;
  const br = getBreakRule(sanitizeRule(workRule), employmentType);
  const s = t2m(rawStart), e = t2m(rawEnd);
  if (s == null || e == null || e <= s) return null;
  const span = e - s;
  const workMin = span - (span >= br.breakThreshold ? br.breakMinutes : 0);
  return workMin > 0 ? workMin : null;
}

function summarizeAttendanceMetrics(entries, periodDays, workRule = DEFAULT_WORK_RULE, employmentType = DEFAULT_EMPLOYMENT_TYPE) {
  let workDays = 0;
  let paidDays = 0;
  let totalWorkMin = 0;
  let totalOvertimeMin = 0;

  for (const { key: dateStr } of periodDays) {
    const entry = normalizeAttendanceEntry(entries?.[dateStr] || {});
    paidDays += getPaidLeaveUnits(entry.status);
    if (entry.status === "有給休暇") continue;
    const { effectiveStart, effectiveEnd } = resolveEntryTimes(entry, workRule);
    if (!effectiveStart || !effectiveEnd) continue;
    const calc = calcWork(dateStr, effectiveStart, effectiveEnd, workRule, employmentType, entry);
    if (!calc) continue;
    workDays++;
    totalWorkMin += calc.workMin;
    totalOvertimeMin += calc.overtime;
  }

  return {
    workDays,
    paidDays,
    totalWorkMin,
    totalOvertimeMin,
    avgDailyMin: workDays > 0 ? totalWorkMin / workDays : 0,
  };
}

function floorToQuarterHour(timeStr) {
  const mins = t2m(timeStr);
  if (mins == null) return timeStr || "";
  return m2t(Math.floor(mins / 15) * 15) || "";
}

function getCsvRoundedEnd(endStr, employmentType, locationName = "", workRule = DEFAULT_WORK_RULE) {
  if (!endStr) return "";
  const loc = normalizeLocation(locationName);
  const endMin = t2m(endStr);
  const contractEndMin = t2m(workRule?.businessEnd);
  if (endMin == null) return endStr;

  if (loc === "Ties" || loc === "Lien") {
    const defaultCapMin = t2m("16:15");
    const capMin = contractEndMin != null ? Math.min(defaultCapMin ?? contractEndMin, contractEndMin) : defaultCapMin;
    if (capMin == null) return endStr;
    return endMin > capMin ? m2t(capMin) || endStr : endStr;
  }

  if (loc === "とりここ") {
    const thresholdMin = contractEndMin ?? t2m("18:30");
    if (thresholdMin == null || endMin <= thresholdMin) return endStr;
    return floorToQuarterHour(endStr);
  }

  if (normalizeEmployment(employmentType) !== "パート") return endStr;
  const defaultCapMin = t2m("16:15");
  const capMin = contractEndMin != null ? Math.min(defaultCapMin ?? contractEndMin, contractEndMin) : defaultCapMin;
  if (capMin == null) return endStr;
  return endMin > capMin ? m2t(capMin) || endStr : endStr;
}

function getCsvDailyExportRow(entry, dateStr, workRule = DEFAULT_WORK_RULE, employmentType = DEFAULT_EMPLOYMENT_TYPE, locationName = "") {
  const normalized = normalizeAttendanceEntry(entry || {});
  const effectiveRule = applyEntryShiftRule(workRule, normalized);
  const { effectiveStart, effectiveEnd } = resolveEntryTimes(normalized, effectiveRule);
  const csvRoundedEnd = getCsvRoundedEnd(effectiveEnd, employmentType, locationName, effectiveRule);
  const calc = effectiveStart && csvRoundedEnd
    ? calcWork(dateStr, effectiveStart, csvRoundedEnd, effectiveRule, employmentType, normalized)
    : null;
  const actualMin = normalized.rawStart && normalized.rawEnd
    ? calcActualWork(normalized.rawStart, normalized.rawEnd, effectiveRule, employmentType)
    : null;
  const wasEndCapped = !!effectiveEnd && !!csvRoundedEnd && effectiveEnd !== csvRoundedEnd;

  return {
    status: normalized.status || "",
    rawStart: normalized.rawStart || "",
    roundedStart: effectiveStart || "",
    rawEnd: normalized.rawEnd || "",
    roundedEnd: csvRoundedEnd || "",
    actualWork: actualMin != null ? m2t(actualMin) : "",
    roundedWork: calc ? m2t(calc.workMin) : "",
    overtime: calc && calc.overtime > 0 ? m2t(calc.overtime) : "",
    note: wasEndCapped ? `CSV終了丸め:${csvRoundedEnd}` : "",
  };
}

function summarizeCsvExportMetrics(entries, periodDays, workRule = DEFAULT_WORK_RULE, employmentType = DEFAULT_EMPLOYMENT_TYPE, locationName = "") {
  let workDays = 0;
  let paidDays = 0;
  let totalWorkMin = 0;
  let totalOvertimeMin = 0;

  for (const { key: dateStr } of periodDays) {
    const row = getCsvDailyExportRow(entries?.[dateStr] || {}, dateStr, workRule, employmentType, locationName);
    paidDays += getPaidLeaveUnits((entries?.[dateStr] || {}).status);
    if (row.status === "有給休暇") continue;
    if (!row.roundedStart || !row.roundedEnd) continue;
    const calc = calcWork(dateStr, row.roundedStart, row.roundedEnd, workRule, employmentType, entries?.[dateStr] || {});
    if (!calc) continue;
    workDays++;
    totalWorkMin += calc.workMin;
    totalOvertimeMin += calc.overtime;
  }

  return {
    workDays,
    paidDays,
    totalWorkMin,
    totalOvertimeMin,
    avgDailyMin: workDays > 0 ? totalWorkMin / workDays : 0,
  };
}

// ─── CSVパース ──────────────────────────────────────────────────────────────────
function parseRecoruCSV(text, workRule = DEFAULT_WORK_RULE) {
  const delimiter = detectCsvDelimiter(text);
  const rows = parseCsvRows(text, delimiter).filter((r) => r.some((c) => String(c || "").trim() !== ""));
  if (!rows.length) return { byName: {}, locationByName: {}, importedCount: 0, delimiter, headerRowIndex: -1 };

  const headerScore = (row) => {
    const headers = (row || []).map((h) => String(h || "").replace(/^\uFEFF/, "").trim());
    return [
      findHeaderIndex(headers, ["名前", "氏名", "従業員名", "name"]) >= 0,
      findHeaderIndex(headers, ["年月日", "日付", "勤務日", "date"]) >= 0,
      findHeaderIndex(headers, ["開始", "始業", "出勤", "開始時刻", "start"]) >= 0,
      findHeaderIndex(headers, ["終了", "終業", "退勤", "終了時刻", "end"]) >= 0,
      findHeaderIndex(headers, ["作業場所名称", "就業場所", "就業場所名称", "勤務場所", "所属店舗", "店舗"]) >= 0,
    ].filter(Boolean).length;
  };

  let headerRowIndex = -1;
  let headerBestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const score = headerScore(rows[i]);
    if (score > headerBestScore) {
      headerBestScore = score;
      headerRowIndex = i;
    }
  }
  if (headerBestScore < 2) headerRowIndex = -1;

  const headers = headerRowIndex >= 0 ? (rows[headerRowIndex] || []).map((h) => String(h || "").replace(/^\uFEFF/, "").trim()) : [];
  const dataRows = rows.slice(headerRowIndex >= 0 ? headerRowIndex + 1 : 0);
  const maxCols = dataRows.reduce((m, r) => Math.max(m, r.length), 0);

  const stats = Array.from({ length: maxCols }, () => ({ filled: 0, date: 0, time: 0, text: 0 }));
  for (const row of dataRows.slice(0, 500)) {
    for (let i = 0; i < maxCols; i++) {
      const v = String(row[i] || "").trim();
      if (!v) continue;
      stats[i].filled++;
      const d = normalizeDateStr(v);
      const t = normalizeTimeStr(v);
      if (d) stats[i].date++;
      if (t) stats[i].time++;
      if (!d && !t) stats[i].text++;
    }
  }

  const bestIndex = (scoreFn, avoid = []) => {
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < stats.length; i++) {
      if (avoid.includes(i)) continue;
      const score = scoreFn(stats[i], i);
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : -1;
  };

  const timeCandidates = stats
    .map((s, i) => ({ i, score: s.time }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.i);

  const guessed = {
    name: bestIndex((s, i) => (i === 2 ? 0 : s.text * 2 + s.filled * 0.1)),
    date: bestIndex((s) => s.date * 2 + s.filled * 0.1),
    start: timeCandidates[0] ?? -1,
    end: timeCandidates[1] ?? -1,
    startR: timeCandidates[2] ?? -1,
    endR: timeCandidates[3] ?? -1,
    locationCode: maxCols >= 3 ? 2 : -1, // C列（作業場所コード）
    locationName: maxCols >= 4 ? 3 : (maxCols >= 3 ? 2 : -1), // D列（作業場所名称）
  };

  const idx = {
    name: findHeaderIndex(headers, ["名前", "氏名", "従業員名", "name"]),
    date: findHeaderIndex(headers, ["年月日", "日付", "勤務日", "date"]),
    start: findHeaderIndex(headers, ["開始", "始業", "出勤", "開始時刻", "start"]),
    end: findHeaderIndex(headers, ["終了", "終業", "退勤", "終了時刻", "end"]),
    startR: findHeaderIndex(headers, ["開始(丸め)", "開始丸め", "始業(丸め)", "start(rounded)"]),
    endR: findHeaderIndex(headers, ["終了(丸め)", "終了丸め", "終業(丸め)", "end(rounded)"]),
    locationCode: findHeaderIndex(headers, ["作業場所", "就業場所", "作業場所コード", "就業場所コード", "所属店舗コード"]),
    locationName: findHeaderIndex(headers, ["作業場所名称", "就業場所名称", "勤務場所", "所属店舗", "店舗"]),
  };

  Object.keys(idx).forEach((k) => {
    if (idx[k] < 0) idx[k] = guessed[k];
  });
  if (idx.startR < 0) idx.startR = idx.start;
  if (idx.endR < 0) idx.endR = idx.end;

  const byNameMap = {};
  const locationHintsByName = {};
  const codeNameCounts = {};

  for (const cols of dataRows) {
    const name = String(cols[idx.name] || "").trim();
    const dateStr = normalizeDateStr(cols[idx.date]);
    if (!name || !dateStr) continue;

    const rawStart = normalizeTimeStr(cols[idx.start]);
    const rawEnd = normalizeTimeStr(cols[idx.end]);
    const roundedStart = normalizeTimeStr(cols[idx.startR]) || rawStart;
    const roundedEnd = normalizeTimeStr(cols[idx.endR]) || rawEnd;

    if (!byNameMap[name]) byNameMap[name] = {};
    const prev = byNameMap[name][dateStr];
    const merged = prev
      ? {
          dateStr,
          rawStart: chooseEarlierTime(prev.rawStart, rawStart),
          rawEnd: chooseLaterTime(prev.rawEnd, rawEnd),
          roundedStart: chooseEarlierTime(prev.roundedStart, roundedStart),
          roundedEnd: chooseLaterTime(prev.roundedEnd, roundedEnd),
        }
      : { dateStr, rawStart, rawEnd, roundedStart, roundedEnd };
    byNameMap[name][dateStr] = merged;

    const locCode = idx.locationCode >= 0 ? normalizeLocation(cols[idx.locationCode]) : "";
    const locName = idx.locationName >= 0 ? normalizeLocation(cols[idx.locationName]) : "";
    if (locCode && locName) {
      if (!codeNameCounts[locCode]) codeNameCounts[locCode] = {};
      codeNameCounts[locCode][locName] = (codeNameCounts[locCode][locName] || 0) + 1;
    }
    if (locCode || locName) {
      if (!locationHintsByName[name]) locationHintsByName[name] = [];
      locationHintsByName[name].push({ locCode, locName });
    }
  }

  const byName = {};
  let importedCount = 0;
  Object.entries(byNameMap).forEach(([name, dateMap]) => {
    const rowsByDay = Object.values(dateMap)
      .sort((a, b) => String(a.dateStr).localeCompare(String(b.dateStr)))
      .map((r) => ({
        ...r,
        snapSt: snapStart(r.rawStart || r.roundedStart, workRule),
        snapEnd: r.roundedEnd,
      }));
    byName[name] = rowsByDay;
    importedCount += rowsByDay.length;
  });

  const locationByName = {};
  const codeToName = {};
  Object.entries(codeNameCounts).forEach(([code, counts]) => {
    const bestName = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (bestName) codeToName[code] = bestName;
  });

  Object.entries(locationHintsByName).forEach(([name, hints]) => {
    const counts = {};
    for (const h of hints) {
      const resolved = h.locName || codeToName[h.locCode] || "";
      if (!resolved) continue;
      counts[resolved] = (counts[resolved] || 0) + 1;
    }
    const loc = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (loc) locationByName[name] = loc;
  });

  return { byName, locationByName, importedCount, delimiter, headerRowIndex, columns: idx };
}

// ─── 施設名からアプリの店舗名を推定する ───────────────────────────────────────
// 例: "施設名：就労継続支援B型事業所Ties" → locationNames の中から "Ties" を探す
function detectLocationFromFacility(facilityRaw, locationNames) {
  if (!facilityRaw) return null;
  const facility = String(facilityRaw).replace(/^施設名[：:]\s*/, "").trim();

  // 1. 完全一致
  if (locationNames.includes(facility)) return facility;

  // 2. 店舗名が施設名に含まれる（最長一致優先）
  const sorted = [...locationNames].sort((a, b) => b.length - a.length);
  for (const loc of sorted) {
    if (facility.includes(loc)) return loc;
  }

  // 3. 施設名が店舗名に含まれる
  for (const loc of sorted) {
    if (loc.includes(facility)) return loc;
  }

  return null; // 判定不能
}

// ─── れこるCSVの作業場所名称 → アプリ店舗名へ変換 ──────────────────────────────
// 例: "鶏の店とりここ" → "とりここ"、"Ties" → "Ties"、"Lien" → "Lien"
function matchStoreFromCSVLocation(csvLoc, locationNames) {
  if (!csvLoc) return null;
  const norm = (s) =>
    String(s || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/^施設名[：:]\s*/g, "")
      .replace(/就労継続支援[ab]型事業所/g, "")
      .replace(/[\s　]/g, "")
      .replace(/[()（）「」『』【】<>＜＞・/\\_-]/g, "");
  const normCsv = norm(csvLoc);

  // 1. 完全一致（大文字小文字無視）
  const exact = locationNames.find((l) => norm(l) === normCsv);
  if (exact) return exact;

  // 2. アプリ店舗名が作業場所名称に含まれる（最長一致優先）
  const sorted = [...locationNames].sort((a, b) => b.length - a.length);
  const contains = sorted.find((l) => normCsv.includes(norm(l)));
  if (contains) return contains;

  // 3. 作業場所名称がアプリ店舗名に含まれる
  const contained = sorted.find((l) => norm(l).includes(normCsv));
  if (contained) return contained;

  return null;
}

// 形式：行1に施設名、行3に開始日・単価、行5に日付ヘッダー、行6〜に氏名＋✔️
// シート選択：「Ties2026年3月」「Lien2026年3月」「とりここ2026年３月」など
//   → 年・月が含まれるシートを探す（大文字小文字・全角半角数字を区別しない）
function parseBentoXLSX(arrayBuffer, year, month) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });

  function normalizeSheetName(s) {
    return String(s)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\s/g, "")
      .toLowerCase();
  }
  function toDateStr(v) {
    if (!v) return null;
    // Dateオブジェクトはローカル日付をそのまま採用（タイムゾーンで前日化させない）
    if (v instanceof Date && !isNaN(v.getTime())) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
    }
    // Excelシリアル値はxlsxのparse_date_codeで日付成分を直接取得
    const n = Number(v);
    if (!isNaN(n) && n > 0) {
      const parsed = XLSX.SSF.parse_date_code(n);
      if (parsed && parsed.y && parsed.m && parsed.d) {
        return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
      }
    }
    return normalizeDateStr(v) || null;
  }
  function isBentoMark(v) {
    if (v === true) return true;
    if (typeof v === "number") return Number(v) > 0;
    const s = String(v ?? "").trim();
    if (!s) return false;
    const key = s.replace(/\s+/g, "");
    return new Set(["✔️", "✔", "☑", "☑️", "✓", "○", "〇", "◯", "●", "◎", "レ", "v", "V", "1", "1.0"]).has(key);
  }
  function detectHeaderRowIndex(rows) {
    let headerRowIndex = 4;
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const row = rows[r] || [];
      const head = String(row[0] ?? "").trim();
      const dateCols = row.slice(1).filter((v) => !!toDateStr(v)).length;
      if ((/氏名|名前/.test(head) || dateCols >= 6) && dateCols >= 3) {
        headerRowIndex = r;
        break;
      }
    }
    return headerRowIndex;
  }
  function extractDateKeys(headerRow) {
    const dateKeys = {};
    for (let col = 1; col < headerRow.length; col++) {
      const ds = toDateStr(headerRow[col]);
      if (ds) dateKeys[col] = ds;
    }
    return dateKeys;
  }

  const allSheets = wb.SheetNames || [];
  const periodRange = (year && month) ? getPeriodRange(year, month) : null;
  const monthOnly = month ? [normalizeSheetName(`${month}月`), normalizeSheetName(`${String(month).padStart(2, "0")}月`)] : [];
  const yearMonth = (year && month)
    ? [
        normalizeSheetName(`${year}年${month}月`),
        normalizeSheetName(`${year}年${String(month).padStart(2, "0")}月`),
      ]
    : [];
  const isHolidaySheet = (s) => normalizeSheetName(s).includes(normalizeSheetName("祝日"));
  const sheetInfos = allSheets
    .filter((s) => !isHolidaySheet(s))
    .map((sheetName) => {
      const ws = wb.Sheets[sheetName];
      if (!ws) return null;
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      const headerRowIndex = detectHeaderRowIndex(rows);
      const dateKeys = extractDateKeys(rows[headerRowIndex] || []);
      const dates = Object.values(dateKeys);
      return {
        sheetName,
        ws,
        rows,
        headerRowIndex,
        dateKeys,
        minDate: dates[0] || null,
        maxDate: dates[dates.length - 1] || null,
      };
    })
    .filter(Boolean);

  let targetSheetInfos = periodRange
    ? sheetInfos.filter((info) => info.minDate && info.maxDate && info.minDate <= periodRange.end && info.maxDate >= periodRange.start)
    : [];
  if (!targetSheetInfos.length) {
    targetSheetInfos = sheetInfos.filter((info) => yearMonth.some((p) => normalizeSheetName(info.sheetName).includes(p)));
  }
  if (!targetSheetInfos.length) {
    targetSheetInfos = sheetInfos.filter((info) => monthOnly.some((p) => normalizeSheetName(info.sheetName).includes(p)));
  }
  if (!targetSheetInfos.length) {
    targetSheetInfos = sheetInfos.filter((info) => /弁当|bento|ties|lien|とりここ/i.test(String(info.sheetName)));
  }
  if (!targetSheetInfos.length) targetSheetInfos = sheetInfos.slice(0, 1);

  const byName = {};
  const locationByName = {};
  const usedSheets = [];
  let facilityRaw = "";
  let pricePerMeal = 0;

  for (const info of targetSheetInfos) {
    const { sheetName: usedSheet, rows, headerRowIndex, dateKeys } = info;
    usedSheets.push(usedSheet);

    let sheetFacility = "";
    for (let r = 0; r < Math.min(rows.length, 5); r++) {
      const row = rows[r] || [];
      for (let c = 0; c < Math.min(row.length, 6); c++) {
        const cell = String(row[c] ?? "").trim();
        if (!cell) continue;
        if (/施設名/.test(cell)) {
          const right = String(row[c + 1] ?? "").trim();
          const cleaned = cell.replace(/^施設名[：:]\s*/, "").trim();
          sheetFacility = cleaned || right || sheetFacility;
        }
      }
    }
    if (!sheetFacility) sheetFacility = usedSheet;
    if (!facilityRaw) facilityRaw = sheetFacility;

    if (!pricePerMeal) {
      for (let r = 0; r < Math.min(rows.length, 8); r++) {
        const row = rows[r] || [];
        for (let c = 0; c < row.length; c++) {
          if (String(row[c] || "").includes("単価")) {
            const p = Number(row[c + 1]) || 0;
            if (p > 0) pricePerMeal = p;
          }
        }
      }
    }

    let currentName = "";
    for (let r = headerRowIndex + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const first = String(row[0] ?? "").trim();
      if (first && !/^(合計|計|小計|備考)$/.test(first)) currentName = first;
      if (!currentName) continue;
      for (let col = 1; col < row.length; col++) {
        if (!isBentoMark(row[col])) continue;
        const dateStr = dateKeys[col];
        if (!dateStr) continue;
        if (!byName[currentName]) byName[currentName] = {};
        byName[currentName][dateStr] = true;
        if (!locationByName[currentName]) locationByName[currentName] = sheetFacility;
      }
    }
  }

  return { byName, locationByName, pricePerMeal, facilityRaw, usedSheet: usedSheets[0] || "", usedSheets };
}

function getErrText(error) {
  return `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
}

function formatImportError(error) {
  if (!error) return "不明なエラー";
  const parts = [
    error.message,
    error.details,
    error.hint,
    error.code ? `code: ${error.code}` : "",
  ].filter(Boolean);
  return parts.join(" / ") || "不明なエラー";
}

function isMissingColumnErr(error, column) {
  const t = getErrText(error);
  return (
    (t.includes("does not exist") && t.includes(`column "${column}"`)) ||
    (t.includes("does not exist") && t.includes(`column ${column}`))
  );
}

function isOnConflictTargetErr(error) {
  const t = getErrText(error);
  return t.includes("on conflict") && (t.includes("constraint") || t.includes("exclusion"));
}

function isNullColumnErr(error, column) {
  const t = getErrText(error);
  return t.includes("null value in column") && (t.includes(`"${column}"`) || t.includes(` ${column} `) || t.includes(column));
}

function isMissingRelationErr(error, relation) {
  const t = getErrText(error).toLowerCase();
  const rel = String(relation || "").toLowerCase();
  return (
    (t.includes("does not exist") && t.includes(rel)) ||
    (t.includes("could not find the table") && (t.includes(`public.${rel}`) || t.includes(`'${rel}'`) || t.includes(rel))) ||
    (t.includes("schema cache") && (t.includes(`public.${rel}`) || t.includes(rel)))
  );
}

async function dbLoadAttendance(userId, year, month) {
  const { start, end } = getPeriodRange(year, month);
  let { data, error } = await supabase.from("attendance").select("*")
    .gte("date_str", start).lte("date_str", end);
  if (error) throw error;

  const all = {};
  for (const row of data || []) {
    if (!all[row.name]) all[row.name] = {};
    all[row.name][row.date_str] = normalizeAttendanceEntry({
      status:   row.status     || "",
      shiftType: row.shift_type || "",
      start:    row.start_time || "",
      end:      row.end_time   || "",
      rawStart: row.raw_start  || "",
      rawEnd:   row.raw_end    || "",
      modified: !!row.modified,
    });
  }
  return all;
}

async function dbLoadBentoChecks(userId, year, month) {
  const { start, end } = getPeriodRange(year, month);
  let { data, error } = await supabase.from("bento_checks").select("*")
    .gte("date_str", start).lte("date_str", end);
  if (error) throw error;

  const all = {};
  for (const row of data || []) {
    if (!row?.checked) continue;
    if (!all[row.name]) all[row.name] = {};
    const unitPrice = Math.max(0, Number(row.unit_price) || 0);
    all[row.name][row.date_str] = unitPrice > 0 ? unitPrice : true;
  }
  return all;
}

async function dbLoadSettings(userId) {
  let { data, error } = await supabase.from("employee_settings").select("*");
  if (error) throw error;

  const fare = {}, paid = {}, employment = {}, monthly = {}, location = {};
  const fareConfig = {}, employeeOverrides = {};
  const contractStart = {}, contractEnd = {};
  const retired = {}; // { name: { isRetired, retiredAt } }
  const registeredNames = []; // 登録済み全スタッフ（退職者含む）
  const extras = {}; // { name: [{ id, label, amount, periodKey }] }

  for (const r of data || []) {
    fare[r.name]       = r.fare ?? 0;
    paid[r.name]       = r.paid_leave_wage ?? 0;
    employment[r.name] = normalizeEmployment(r.employment_type);
    monthly[r.name]    = r.monthly_wage ?? 0;
    retired[r.name]    = { isRetired: !!r.is_retired, retiredAt: r.retired_at || "" };
    if (r.location) location[r.name] = r.location;
    if (r.contract_start) contractStart[r.name] = r.contract_start;
    if (r.contract_end) contractEnd[r.name] = r.contract_end;
    if (r.fare_config_json) {
      try { fareConfig[r.name] = JSON.parse(r.fare_config_json); } catch {}
    }
    if (r.override_rule_json) {
      try {
        const parsed = JSON.parse(r.override_rule_json);
        if (parsed && typeof parsed === "object") employeeOverrides[r.name] = parsed;
      } catch {}
    }
    if (r.extras_json) {
      try { extras[r.name] = JSON.parse(r.extras_json); } catch {}
    }
    registeredNames.push(r.name);
  }
  return {
    fare, paid, employment, monthly, retired, registeredNames, location,
    contractStart, contractEnd, fareConfig, employeeOverrides, extras
  };
}

async function dbLoadWorkRules(userId) {
  let { data, error } = await supabase.from("workplace_rules").select("*");
  if (error) {
    return {
      rulesByLocation: defaultRulesMap(),
      ruleModesByLocation: {},
      warning: `DBエラー[${error.code}]: ${error.message}`
    };
  }

  const rulesByLocation = {};
  const ruleModesByLocation = {};
  for (const row of data || []) {
    const locationName = normalizeLocation(row.location_name);
    if (!locationName) continue;
    ruleModesByLocation[locationName] = normalizeRuleMode(row.rule_mode);
    rulesByLocation[locationName] = sanitizeRule({
      locationName,
      businessStart: row.business_start, businessEnd: row.business_end,
      snapEarlyThreshold: row.snap_early_threshold, snapEarlyTo: row.snap_early_to,
      snapRangeStart: row.snap_range_start, snapRangeEnd: row.snap_range_end, snapRangeTo: row.snap_range_to,
      breakMinutesFullTime: row.break_minutes_full_time, breakThresholdMinutesFullTime: row.break_threshold_minutes_full_time,
      breakMinutesPartTime: row.break_minutes_part_time, breakThresholdMinutesPartTime: row.break_threshold_minutes_part_time,
      hourlyNormal: row.hourly_normal, hourlyWeekend: row.hourly_weekend,
    });
  }
  return {
    rulesByLocation: Object.keys(rulesByLocation).length ? rulesByLocation : defaultRulesMap(),
    ruleModesByLocation,
    warning: ""
  };
}

async function dbUpsertWorkRule(userId, rule) {
  const r = sanitizeRule(rule);
  const base = {
    location_name: r.locationName,
    rule_mode: normalizeRuleMode(rule?.ruleMode),
    business_start: r.businessStart, business_end: r.businessEnd,
    snap_early_threshold: r.snapEarlyThreshold, snap_early_to: r.snapEarlyTo,
    snap_range_start: r.snapRangeStart, snap_range_end: r.snapRangeEnd, snap_range_to: r.snapRangeTo,
    break_minutes_full_time: r.breakMinutesFullTime, break_threshold_minutes_full_time: r.breakThresholdMinutesFullTime,
    break_minutes_part_time: r.breakMinutesPartTime, break_threshold_minutes_part_time: r.breakThresholdMinutesPartTime,
    hourly_normal: r.hourlyNormal, hourly_weekend: r.hourlyWeekend,
  };
  const attempts = [
    { payload: base, onConflict: "location_name" },
    { payload: Object.fromEntries(Object.entries(base).filter(([key]) => key !== "rule_mode")), onConflict: "location_name" },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const { error } = await supabase.from("workplace_rules").upsert(attempt.payload, { onConflict: attempt.onConflict });
      if (!error) return;
      lastError = error;
      if (isMissingColumnErr(error, "rule_mode")) continue;
  }
  throw lastError;
}

async function dbLoadAppSettings(userId) {
  let { data, error } = await supabase.from("app_settings").select("*");
  if (error) {
    if (isMissingRelationErr(error, "app_settings")) return { bentoPriceByLocation: {} };
    throw error;
  }

  const bentoPriceByLocation = {};
  for (const row of data || []) {
    const appKey = String(row?.app_key || "");
    const price = Math.max(0, Math.round(Number(row?.bento_price_per_meal) || 0));
    if (appKey === "shared") {
      bentoPriceByLocation[LEGACY_SHARED_BENTO_PRICE_KEY] = price;
      continue;
    }
    if (!appKey.startsWith(BENTO_PRICE_APP_KEY_PREFIX)) continue;
    const locationName = normalizeLocation(appKey.slice(BENTO_PRICE_APP_KEY_PREFIX.length));
    if (!locationName) continue;
    bentoPriceByLocation[locationName] = price;
  }
  return { bentoPriceByLocation };
}

async function dbUpsertAppSettings(userId, locationName, patch = {}) {
  const base = {
    app_key: getBentoAppKey(locationName),
    ...("bentoPricePerMeal" in patch ? { bento_price_per_meal: Math.max(0, Number(patch.bentoPricePerMeal) || 0) } : {}),
  };
  const variants = [
    base,
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== "bento_price_per_meal")),
  ];
  let lastError = null;
  for (const variant of variants) {
    const attempts = [{ payload: variant, onConflict: "app_key" }];
    if (userId) {
      attempts.push({ payload: { ...variant, user_id: userId }, onConflict: "user_id,app_key" });
      attempts.push({ payload: { ...variant, user_id: userId }, onConflict: "app_key" });
    }
    for (const attempt of attempts) {
      const { error } = await supabase.from("app_settings").upsert(attempt.payload, { onConflict: attempt.onConflict });
      if (!error) return;
      lastError = error;
      if (isMissingRelationErr(error, "app_settings")) return;
      if (isMissingColumnErr(error, "bento_price_per_meal")) break;
      if (attempt.payload.user_id == null && userId && isNullColumnErr(error, "user_id")) continue;
      if (attempt.payload.user_id != null && isMissingColumnErr(error, "user_id")) continue;
      if (attempt.onConflict.includes("user_id") && isOnConflictTargetErr(error)) continue;
    }
  }
  if (lastError) throw lastError;
}

async function dbUpsertPersonExtras(userId, name, extrasList) {
  const json = JSON.stringify(extrasList || []);
  const attempts = [{ payload: { name, extras_json: json }, onConflict: "name" }];
  if (userId) {
    attempts.push({ payload: { user_id: userId, name, extras_json: json }, onConflict: "user_id,name" });
    attempts.push({ payload: { user_id: userId, name, extras_json: json }, onConflict: "name" });
  }
  for (const attempt of attempts) {
    const { error } = await supabase.from("employee_settings").upsert(attempt.payload, { onConflict: attempt.onConflict });
    if (!error) return;
    // extras_json列が未作成の場合は無視（localStorage fallbackで動作継続）
    if (isMissingColumnErr(error, "extras_json")) return;
    if (attempt.payload.user_id == null && userId && isNullColumnErr(error, "user_id")) continue;
    if (attempt.payload.user_id != null && isMissingColumnErr(error, "user_id")) continue;
    if (attempt.onConflict.includes("user_id") && isOnConflictTargetErr(error)) continue;
  }
}

async function dbDeleteWorkRule(userId, locationName) {
  const { error } = await supabase.from("workplace_rules").delete().eq("location_name", normalizeLocation(locationName));
  if (error) throw error;
}

async function dbUpsertAttendance(userId, name, dateStr, entry) {
  const base = {
    name, date_str: dateStr,
    status: entry.status ?? "",
    shift_type: normalizeShiftType(entry.shiftType),
    start_time: entry.start ?? "",
    end_time: entry.end ?? "",
    raw_start: entry.rawStart ?? "",
    raw_end: entry.rawEnd ?? "",
    modified: !!entry.modified,
  };
  const variants = [
    base,
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== "shift_type")),
  ];
  const attempts = [];
  let lastError = null;
  for (const variant of variants) {
    attempts.length = 0;
    attempts.push({ payload: variant, onConflict: "name,date_str" });
    if (userId) {
      attempts.push({ payload: { ...variant, user_id: userId }, onConflict: "user_id,name,date_str" });
      attempts.push({ payload: { ...variant, user_id: userId }, onConflict: "name,date_str" });
    }

    for (const attempt of attempts) {
      const { error } = await supabase.from("attendance").upsert(attempt.payload, { onConflict: attempt.onConflict });
      if (!error) return;
      lastError = error;
      if (isMissingColumnErr(error, "shift_type")) break;
      if (attempt.payload.user_id == null && userId && isNullColumnErr(error, "user_id")) continue;
      if (attempt.payload.user_id != null && isMissingColumnErr(error, "user_id")) continue;
      if (attempt.onConflict.includes("user_id") && isOnConflictTargetErr(error)) continue;
      if (attempt.onConflict === "name,date_str" && isOnConflictTargetErr(error) && userId) continue;
    }
  }
  throw lastError;
}

async function dbDeleteAttendance(userId, name, dateStr) {
  let { error } = await supabase.from("attendance").delete().eq("name", name).eq("date_str", dateStr);
  if (error) throw error;
}

async function dbUpsertBentoCheck(userId, name, dateStr, unitPrice = 0) {
  const base = {
    name,
    date_str: dateStr,
    checked: true,
    unit_price: Math.max(0, Math.round(Number(unitPrice) || 0)),
  };
  let lastError = null;
  const variants = [
    base,
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== "unit_price")),
  ];
  for (const payloadBase of variants) {
    const attempts = [{ payload: payloadBase, onConflict: "name,date_str" }];
    if (userId) {
      attempts.push({ payload: { ...payloadBase, user_id: userId }, onConflict: "user_id,name,date_str" });
      attempts.push({ payload: { ...payloadBase, user_id: userId }, onConflict: "name,date_str" });
    }
    for (const attempt of attempts) {
      const { error } = await supabase.from("bento_checks").upsert(attempt.payload, { onConflict: attempt.onConflict });
      if (!error) return;
      lastError = error;
      if (isMissingColumnErr(error, "unit_price")) break;
      if (attempt.payload.user_id == null && userId && isNullColumnErr(error, "user_id")) continue;
      if (attempt.payload.user_id != null && isMissingColumnErr(error, "user_id")) continue;
      if (attempt.onConflict.includes("user_id") && isOnConflictTargetErr(error)) continue;
      if (attempt.onConflict === "name,date_str" && isOnConflictTargetErr(error) && userId) continue;
    }
  }
  throw lastError;
}

async function dbDeleteBentoCheck(userId, name, dateStr) {
  let { error } = await supabase.from("bento_checks").delete().eq("name", name).eq("date_str", dateStr);
  if (error) throw error;
}

async function dbUpsertSettings(userId, name, fare, paidLeaveWage, employmentType = DEFAULT_EMPLOYMENT_TYPE, monthlyWage = 0, locationOrOptions = "") {
  const options = typeof locationOrOptions === "string"
    ? { location: locationOrOptions }
    : (locationOrOptions || {});
  const base = {
    name, fare: fare ?? 0, paid_leave_wage: paidLeaveWage ?? 0,
    employment_type: normalizeEmployment(employmentType),
    monthly_wage: monthlyWage ?? 0,
    ...(options.location ? { location: options.location } : {}),
    ...("contractStart" in options ? { contract_start: options.contractStart || "" } : {}),
    ...("contractEnd" in options ? { contract_end: options.contractEnd || "" } : {}),
    ...("fareConfig" in options ? { fare_config_json: JSON.stringify(options.fareConfig || {}) } : {}),
    ...("overrideRule" in options ? { override_rule_json: options.overrideRule ? JSON.stringify(options.overrideRule) : "" } : {}),
  };

  let lastError = null;
  const variants = [base];

  // 旧スキーマ互換: 新しい列が無い環境向けに段階的に列を削って再試行
  if ("contract_end" in base) variants.push(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "contract_end")));
  if ("contract_start" in base) variants.push(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "contract_start")));
  if ("override_rule_json" in base) variants.push(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "override_rule_json")));
  if ("fare_config_json" in base) variants.push(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "fare_config_json")));
  if ("location" in base) variants.push(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "location")));
  variants.push(Object.fromEntries(Object.entries(base).filter(([k]) => !["employment_type", "monthly_wage", "location", "contract_start", "contract_end", "fare_config_json", "override_rule_json"].includes(k))));

  for (const payloadBase of variants) {
    const attempts = [{ payload: payloadBase, onConflict: "name" }];
    if (userId) {
      attempts.push({ payload: { ...payloadBase, user_id: userId }, onConflict: "user_id,name" });
      attempts.push({ payload: { ...payloadBase, user_id: userId }, onConflict: "name" });
    }

    for (const attempt of attempts) {
      const { error } = await supabase.from("employee_settings").upsert(attempt.payload, { onConflict: attempt.onConflict });
      if (!error) return;
      lastError = error;
      if (attempt.payload.user_id == null && userId && isNullColumnErr(error, "user_id")) continue;
      if (attempt.payload.user_id != null && isMissingColumnErr(error, "user_id")) continue;
      if (attempt.onConflict.includes("user_id") && isOnConflictTargetErr(error)) continue;
      if (
        isMissingColumnErr(error, "employment_type") ||
        isMissingColumnErr(error, "monthly_wage") ||
        isMissingColumnErr(error, "location") ||
        isMissingColumnErr(error, "contract_start") ||
        isMissingColumnErr(error, "contract_end") ||
        isMissingColumnErr(error, "fare_config_json") ||
        isMissingColumnErr(error, "override_rule_json")
      ) {
        break;
      }
    }
  }
  throw lastError;
}

async function dbSetRetired(userId, name, isRetired, retiredAt = "") {
  const base = { name, is_retired: isRetired, retired_at: retiredAt };
  const attempts = [{ payload: base, onConflict: "name" }];
  if (userId) {
    attempts.push({ payload: { ...base, user_id: userId }, onConflict: "user_id,name" });
    attempts.push({ payload: { ...base, user_id: userId }, onConflict: "name" });
  }
  let lastError = null;
  for (const attempt of attempts) {
    const { error } = await supabase.from("employee_settings").upsert(attempt.payload, { onConflict: attempt.onConflict });
    if (!error) return;
    lastError = error;
    if (attempt.payload.user_id == null && userId && isNullColumnErr(error, "user_id")) continue;
    if (attempt.payload.user_id != null && isMissingColumnErr(error, "user_id")) continue;
    if (attempt.onConflict.includes("user_id") && isOnConflictTargetErr(error)) continue;
    if (isMissingColumnErr(error, "is_retired") || isMissingColumnErr(error, "retired_at")) {
      throw new Error("退職管理列が未作成です。SQLを実行してください:\nALTER TABLE employee_settings ADD COLUMN IF NOT EXISTS is_retired boolean default false;\nALTER TABLE employee_settings ADD COLUMN IF NOT EXISTS retired_at text default '';");
    }
  }
  throw lastError;
}

async function dbDeleteEmployee(userId, name) {
  const runDelete = async (table) => {
    const { error } = await supabase.from(table).delete().eq("name", name);
    if (error) throw error;
  };
  await runDelete("attendance");
  await runDelete("employee_settings");
  try {
    await runDelete("bento_checks");
  } catch (e) {
    if (!isMissingRelationErr(e, "bento_checks")) throw e;
  }
}

// ─── 勤怠テーブル（一人分）────────────────────────────────────────────────────
function AttendanceTable({ name, year, month, entries, prevEntries, fare, onUpdate, onToggleBento, workRule, employmentType, bentoByDate, bentoPricePerMeal, monthlySalary, retiredAt, fareConfig, extras }) {
  const isFullTime = normalizeEmployment(employmentType) === "正社員";
  const supportsDailyShift = normalizeLocation(workRule?.locationName) === "とりここ";
  const [editing, setEditing] = useState(null);
  const [tempVal, setTempVal] = useState("");
  const { year: prevYear, month: prevMonth } = getPreviousPeriod(year, month);

  const startEdit = (dateStr, field, val) => { setEditing({ dateStr, field }); setTempVal(val || ""); };

  const commitEdit = useCallback((dateStr, field) => {
    const entry = { ...(entries[dateStr] || {}) };
    const effectiveRule = applyEntryShiftRule(workRule, entry);
    if (tempVal.trim()) {
      entry[field] = field === "start" ? snapStart(tempVal.trim(), effectiveRule) : tempVal.trim();
      entry.modified = true;
    } else {
      delete entry[field];
    }
    const isEmpty = !entry.start && !entry.end && !entry.status && !entry.rawStart && !entry.rawEnd && !entry.shiftType;
    onUpdate(name, dateStr, isEmpty ? null : entry);
    setEditing(null); setTempVal("");
  }, [tempVal, entries, name, onUpdate, workRule]);

  const setStatus = (dateStr, val) =>
    onUpdate(name, dateStr, (() => {
      const current = { ...(entries[dateStr] || {}) };
      const next = { ...current, status: val, modified: !!val || !!current.modified };
      if (!val) delete next.status;
      const isEmpty = !next.start && !next.end && !next.status && !next.rawStart && !next.rawEnd && !next.shiftType;
      return isEmpty ? null : next;
    })());

  const setShiftType = (dateStr, shiftType) =>
    {
      const nextLabel = getShiftLabel(shiftType) || "未設定";
      if (!window.confirm(`${name} の ${dateStr} のシフトを「${nextLabel}」で保存しますか？`)) return;
      onUpdate(name, dateStr, (() => {
      const current = normalizeAttendanceEntry(entries[dateStr] || {});
      const normalizedShift = normalizeShiftType(shiftType);
      const next = { ...current, shiftType: normalizedShift };
      if (!normalizedShift) delete next.shiftType;
      const isEmpty = !next.start && !next.end && !next.status && !next.rawStart && !next.rawEnd && !next.shiftType;
      return isEmpty ? null : next;
      })());
    };

  const clearEntry = (dateStr) => onUpdate(name, dateStr, null);

  const days = getPeriodDays(year, month);

  const totals = useMemo(() =>
    days.reduce((a, { key }) => {
      const e = entries[key];
      const bentoPrice = getBentoUnitPrice(bentoByDate?.[key], bentoPricePerMeal);
      const nextA = {
        ...a,
        bentoCount: a.bentoCount + (bentoPrice > 0 ? 1 : 0),
        bentoTotal: a.bentoTotal + bentoPrice,
        paidDays: a.paidDays + getPaidLeaveUnits(e?.status),
      };
      if (e?.status === "有給休暇") return nextA;
      const { effectiveStart, effectiveEnd } = resolveEntryTimes(e || {}, workRule);
      if (!effectiveStart || !effectiveEnd) return nextA;
      const c = calcWork(key, effectiveStart, effectiveEnd, workRule, employmentType, e || {});
      if (!c) return nextA;
      return { ...nextA, workMin: nextA.workMin + c.workMin, overtime: nextA.overtime + c.overtime,
        wage: nextA.wage + c.wage,
        overtimeWage: nextA.overtimeWage + Math.floor((c.overtime / 60) * c.rate),
        days: nextA.days + 1 };
    }, { workMin: 0, overtime: 0, wage: 0, overtimeWage: 0, days: 0, paidDays: 0, bentoCount: 0, bentoTotal: 0 }),
    [days, entries, workRule, employmentType, bentoByDate, bentoPricePerMeal]
  );
  const prevSummary = useMemo(
    () => summarizeAttendanceMetrics(prevEntries || {}, getPeriodDays(prevYear, prevMonth), workRule, employmentType),
    [prevEntries, prevYear, prevMonth, workRule, employmentType]
  );
  const weekdayRate = sanitizeRule(workRule).hourlyNormal;
  const paidUnitAmount = Math.round((prevSummary.avgDailyMin / 60) * weekdayRate);

  return (
    <div>
      {/* ── 退職者バナー ── */}
      {retiredAt && (
        <div style={{ margin: "10px 16px 0", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>📋</span>
          <div>
            <span style={{ fontWeight: 800, color: "#c2410c", fontSize: 13 }}>退職済みスタッフ</span>
            <span style={{ marginLeft: 10, fontSize: 12, color: "#92400e" }}>退職日：<b>{retiredAt}</b>　退職日以降の行は非表示（印刷・CSV出力も除外済み）</span>
          </div>
        </div>
      )}
      {/* ── 勤怠テーブル ── */}
      <div style={S.tableWrap}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#1a2e1a", color: "#e8f5e8" }}>
              <th style={S.thBig} rowSpan={2}>日付</th>
              <th style={S.thBig} rowSpan={2}>曜</th>
              <th style={S.thBig} rowSpan={2}>勤怠</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} colSpan={2}>始業時刻</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} colSpan={2}>終業時刻</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} colSpan={2}>勤務時間</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>普通残業</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>休憩</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>時給</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #3d5c3d" }} rowSpan={2}>日給</th>
              <th style={{ ...S.thBig, borderLeft: "1px solid #2d6a2d", background: "#1e3a1a" }} rowSpan={2}>🍱</th>
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
            {days.map(({ mo, d, key, dow, wdJP }) => {
              const isSat = dow === 6, isSun = dow === 0, isHol = !!HOLIDAYS[key], isWeekend = isSat || isSun || isHol;
              const entry = normalizeAttendanceEntry(entries[key] || {});
              const selectedShift = normalizeShiftType(entry.shiftType);
              const shiftLabel = getShiftLabel(selectedShift);
              const { effectiveStart, effectiveEnd } = resolveEntryTimes(entry, workRule);
              const calc = calcWork(key, effectiveStart, effectiveEnd, workRule, employmentType, entry);
              const actualWorkMin = (entry.rawStart && entry.rawEnd)
                ? calcActualWork(entry.rawStart, entry.rawEnd, workRule, employmentType) : null;
              const isES = editing?.dateStr === key && editing?.field === "start";
              const isEE = editing?.dateStr === key && editing?.field === "end";
              const startSnapped = entry.rawStart && effectiveStart && entry.rawStart !== effectiveStart;
              const endSnapped   = entry.rawEnd   && effectiveEnd   && entry.rawEnd   !== effectiveEnd;
              const bentoPrice = getBentoUnitPrice(bentoByDate?.[key], bentoPricePerMeal);
              const hasBento = bentoPrice > 0;

              const isAfterRetirement = retiredAt && key > retiredAt;
              return (
                <tr key={key} style={{
                  background: isAfterRetirement ? "#f3f3f0" : isWeekend ? (isSat ? "rgba(37,99,235,0.05)" : "rgba(220,38,38,0.05)") : "transparent",
                  borderBottom: "1px solid #ede8e0",
                  opacity: isAfterRetirement ? 0.35 : 1,
                  pointerEvents: isAfterRetirement ? "none" : "auto",
                }}>
                  {/* 日付 */}
                  <td style={S.td}>
                    <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{mo}/{d}</span>
                    {HOLIDAYS[key] && <div style={S.htag}>{HOLIDAYS[key]}</div>}
                  </td>
                  {/* 曜日 */}
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <span style={{ fontWeight: 700, color: isSun || isHol ? "#dc2626" : isSat ? "#2563eb" : "#6b5e4c" }}>{wdJP}</span>
                  </td>
                  {/* 勤怠区分 */}
                  <td style={S.td}>
                    <div style={{ display: "grid", gap: 4, justifyItems: "start" }}>
                      <select
                        value={entry.status || ""}
                        onChange={(e) => setStatus(key, e.target.value)}
                        style={{
                          fontSize: 11, border: "1px solid #ddd", borderRadius: 5, padding: "3px 4px",
                          color: entry.status ? "#1a1209" : "#aaa",
                          background:
                            entry.status === "出勤" ? "#f0faf0"
                              : entry.status === "半有給" ? "#eff6ff"
                              : entry.status ? "#fffbe6" : "#fafafa",
                          cursor: "pointer", outline: "none", maxWidth: 78,
                        }}
                      >
                        <option value="">—</option>
                        {KINMU_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                      {supportsDailyShift && (
                        <select
                          value={selectedShift}
                          onChange={(e) => setShiftType(key, e.target.value)}
                          style={{
                            fontSize: 10,
                            border: selectedShift ? "1px solid #c7d2fe" : "1px solid #d6d3d1",
                            borderRadius: 999,
                            padding: "3px 8px",
                            color: selectedShift ? "#4338ca" : "#94a3b8",
                            background: selectedShift ? "#eef2ff" : "#fff",
                            cursor: "pointer",
                            outline: "none",
                            minWidth: 72,
                            fontWeight: selectedShift ? 700 : 500,
                          }}
                          title={shiftLabel ? `${shiftLabel}シフト` : "とりここの日別シフト"}
                        >
                          <option value="">シフト</option>
                          <option value="morning">午前</option>
                          <option value="afternoon">午後</option>
                        </select>
                      )}
                    </div>
                  </td>
                  {/* 始業：実際 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4" }}>
                    <span style={{ fontSize: 11, color: startSnapped ? "#aaa" : "#6b5e4c",
                      fontVariantNumeric: "tabular-nums", textDecoration: startSnapped ? "line-through" : "none" }}>
                      {entry.rawStart || entry.start || <span style={{ color: "#ddd" }}>—</span>}
                    </span>
                  </td>
                  {/* 始業：丸め（クリックで編集） */}
                  <td style={S.td}>
                    {isES ? (
                      <input autoFocus type="time" value={tempVal}
                        onChange={(e) => setTempVal(e.target.value)}
                        onBlur={() => commitEdit(key, "start")} style={S.tinput} />
                    ) : (
                      <button style={{ ...S.tbtn,
                        color: effectiveStart ? (entry.modified ? "#b45309" : "#1a4d12") : "#b0a090",
                        borderColor: entry.modified ? "#fcd34d" : "#c8bfb2", fontWeight: effectiveStart ? 700 : 400 }}
                        onClick={() => startEdit(key, "start", effectiveStart)}>
                        {effectiveStart || "——"}
                        {entry.modified && <span style={S.modTag}>修</span>}
                      </button>
                    )}
                  </td>
                  {/* 終業：実際 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4" }}>
                    <span style={{ fontSize: 11, color: endSnapped ? "#aaa" : "#6b5e4c",
                      fontVariantNumeric: "tabular-nums", textDecoration: endSnapped ? "line-through" : "none" }}>
                      {entry.rawEnd || entry.end || <span style={{ color: "#ddd" }}>—</span>}
                    </span>
                  </td>
                  {/* 終業：丸め（クリックで編集） */}
                  <td style={S.td}>
                    {isEE ? (
                      <input autoFocus type="time" value={tempVal}
                        onChange={(e) => setTempVal(e.target.value)}
                        onBlur={() => commitEdit(key, "end")} style={S.tinput} />
                    ) : (
                      <button style={{ ...S.tbtn,
                        color: effectiveEnd ? (entry.modified ? "#b45309" : "#1a4d12") : "#b0a090",
                        borderColor: entry.modified ? "#fcd34d" : "#c8bfb2", fontWeight: effectiveEnd ? 700 : 400 }}
                        onClick={() => startEdit(key, "end", effectiveEnd)}>
                        {effectiveEnd || "——"}
                      </button>
                    )}
                  </td>
                  {/* 勤務時間：実際 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "right", paddingRight: 10 }}>
                    {(actualWorkMin != null || calc)
                      ? <span style={{ fontSize: 11, color: "#8b7355", fontVariantNumeric: "tabular-nums" }}>
                          {m2t(actualWorkMin ?? calc?.workMin)}
                        </span>
                      : <span style={{ color: "#ddd" }}>—</span>}
                  </td>
                  {/* 勤務時間：丸め */}
                  <td style={S.td}>
                    {calc
                      ? <span style={{ color: "#1a4d12", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{m2t(calc.workMin)}</span>
                      : <span style={{ color: "#ddd" }}>—</span>}
                  </td>
                  {/* 普通残業 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "center" }}>
                    {calc && calc.overtime > 0
                      ? <span style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, background: "#fee2e2", borderRadius: 4, padding: "2px 6px", fontVariantNumeric: "tabular-nums" }}>{m2t(calc.overtime)}</span>
                      : <span style={{ color: "#ddd" }}>—</span>}
                  </td>
                  {/* 休憩 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "center" }}>
                    {calc
                      ? (calc.breakMin > 0
                          ? <span style={{ fontSize: 11, background: "#f5f0e8", color: "#8b7355", borderRadius: 4, padding: "2px 5px" }}>{calc.breakMin}分</span>
                          : <span style={{ color: "#ccc", fontSize: 11 }}>なし</span>)
                      : <span style={{ color: "#ddd" }}>—</span>}
                  </td>
                  {/* 時給 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "right", paddingRight: 8 }}>
                    {calc
                      ? <span style={{ fontSize: 11, fontWeight: 600, color: isWeekend ? "#2563eb" : "#6b5e4c" }}>¥{calc.rate.toLocaleString()}</span>
                      : <span style={{ color: "#ddd" }}>—</span>}
                  </td>
                  {/* 日給 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #f0ece4", textAlign: "right", paddingRight: 10 }}>
                    {isFullTime
                      ? <span style={{ color: "#ccc", fontSize: 11 }}>月給</span>
                      : calc
                        ? <span style={{ fontWeight: 700, color: "#1a4d12", fontVariantNumeric: "tabular-nums" }}>¥{calc.wage.toLocaleString()}</span>
                        : <span style={{ color: "#ddd" }}>—</span>}
                  </td>
                  {/* お弁当 */}
                  <td style={{ ...S.td, borderLeft: "1px solid #dcfce7", textAlign: "center", background: hasBento ? "#f0fdf4" : "transparent" }}>
                    <button
                      type="button"
                      onClick={() => onToggleBento?.(name, key)}
                      style={{
                        minWidth: 42,
                        border: hasBento ? "1px solid #86efac" : "1px dashed #d1d5db",
                        background: hasBento ? "#dcfce7" : "#fff",
                        color: hasBento ? "#166534" : "#9ca3af",
                        borderRadius: 999,
                        padding: "4px 8px",
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                      title={hasBento ? `お弁当あり ¥${bentoPrice.toLocaleString()}` : "お弁当なし"}
                    >
                      {hasBento ? "🍱" : "＋"}
                    </button>
                  </td>
                  {/* クリア */}
                  <td style={{ ...S.td, textAlign: "center" }}>
                    {(entry.start || entry.end || entry.status || entry.rawStart || entry.rawEnd || entry.shiftType) &&
                      <button onClick={() => clearEntry(key)} style={{ background: "none", border: "none", cursor: "pointer", color: "#ccc", fontSize: 11, padding: "2px 4px" }}>✕</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── 月合計カード ── */}
      <div style={{ margin: "12px 14px 0", background: "linear-gradient(135deg,#1a2e1a 0%,#2d5a27 100%)", borderRadius: 12, padding: "18px 22px", boxShadow: "0 4px 20px rgba(26,46,26,0.2)" }}>
        <div style={{ fontSize: 11, color: "#8db08d", fontWeight: 700, marginBottom: 12, letterSpacing: "0.08em" }}>
          {name} ／ {getPeriodLabel(year, month)} 集計
        </div>

        {/* 上段：勤務サマリー */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0, marginBottom: 14 }}>
          {[["出勤日数", `${totals.days}日`], ["総勤務時間", m2t(totals.workMin) || "0:00"], ["普通残業", totals.overtime > 0 ? m2t(totals.overtime) : "なし"]].map(([l, v], i) => (
            <Fragment key={l}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, padding: "0 16px", minWidth: 100 }}>
                <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{l}</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: "#e8f5e8", fontVariantNumeric: "tabular-nums" }}>{v}</span>
              </div>
              {i < 2 && <div style={{ width: 1, height: 40, background: "rgba(255,255,255,0.2)" }} />}
            </Fragment>
          ))}
          <div style={{ width: 1, height: 40, background: "rgba(255,255,255,0.2)" }} />
          {isFullTime ? (
            /* 正社員：月給入力 ＋ 残業代表示 */
            <div style={{ flex: 1.6, display: "flex", flexDirection: "column", gap: 4, padding: "0 16px", minWidth: 160 }}>
              <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em" }}>月給</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, color: "#8db08d" }}>¥</span>
                <input type="number" min={0} step={1000} value={monthlySalary || 0}
                  onChange={(e) => onUpdate(name, "__monthly__", +e.target.value)}
                  style={{ width: 110, ...S.numInput, fontSize: 20, fontWeight: 800, color: "#b9f0b0" }} />
              </div>
              {totals.overtimeWage > 0 && (
                <span style={{ fontSize: 11, color: "#fbbf24", fontVariantNumeric: "tabular-nums" }}>
                  ＋残業代 ¥{totals.overtimeWage.toLocaleString()}
                </span>
              )}
            </div>
          ) : (
            /* パート：時間給合計 */
            <div style={{ flex: 1.4, display: "flex", flexDirection: "column", gap: 3, padding: "0 16px", minWidth: 130 }}>
              <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>給与合計</span>
              <span style={{ fontSize: 26, fontWeight: 800, color: "#b9f0b0", fontVariantNumeric: "tabular-nums" }}>¥{totals.wage.toLocaleString()}</span>
            </div>
          )}
        </div>

        {/* 中段：有給 */}
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12, marginBottom: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700 }}>🌿 有給休暇</span>
          <span style={{ color: "#8db08d", fontSize: 11 }}>
            前月平均 {formatAverageHours(prevSummary.avgDailyMin)} × 平日時給 ¥{weekdayRate.toLocaleString()}
          </span>
          <span style={{ color: "#8db08d", fontSize: 11 }}>× {totals.paidDays}日</span>
          <span style={{ color: "#b9f0b0", fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            = ¥{(paidUnitAmount * totals.paidDays).toLocaleString()}
          </span>
          {totals.paidDays === 0 && <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>（取得なし）</span>}
        </div>

        {/* 下段：交通費・臨時支給 ＋ お弁当差引 ＋ 総支給額 */}
        {(() => {
          const baseWage   = isFullTime ? (monthlySalary || 0) + totals.overtimeWage : totals.wage;
          const paidTotal  = paidUnitAmount * totals.paidDays;
          const fareTotal  = calcFareTotal(name, totals.days, year, month, fareConfig, { [name]: fare });
          const extrasTotal = calcExtrasTotal(name, year, month, extras);
          const bentoTotal = totals.bentoTotal;
          const grandTotal = Math.max(0, baseWage + paidTotal + fareTotal + extrasTotal - bentoTotal);
          const fareConfig_ = fareConfig?.[name] || { type: "daily" };
          const isTeiki    = fareConfig_.type === "teiki";
          const label = isFullTime ? "総支給額（月給＋残業代＋交通費＋臨時－お弁当）" : "総支給額（給与＋有給＋交通費＋臨時－お弁当）";
          return (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* 交通費 */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700, minWidth: 110 }}>🚃 交通費</span>
              {isTeiki ? (
                <span style={{ fontSize: 11, color: "#8db08d" }}>
                  {fareTotal > 0
                    ? `定期代（${fareConfig_.teikiPeriod ?? 1}ヶ月）`
                    : <span style={{ color: "rgba(255,255,255,0.3)" }}>定期代（今月請求なし）</span>}
                </span>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: "#e8f5e8", fontSize: 12 }}>¥</span>
                  <input type="number" min={0} step={10} value={fare || 0}
                    onChange={(e) => onUpdate(name, "__fare__", +e.target.value)}
                    style={{ width: 80, ...S.numInput }} />
                  <span style={{ color: "#8db08d", fontSize: 11 }}>× {totals.days}回</span>
                </div>
              )}
              <span style={{ color: "#b9f0b0", fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                ＋ ¥{fareTotal.toLocaleString()}
              </span>
            </div>
            {/* 臨時支給 */}
            {extrasTotal > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: "#fbbf24", fontWeight: 700, minWidth: 110 }}>💴 臨時支給</span>
                {(extras?.[name] || []).filter(e => e.periodKey === `${year}-${pad2(month)}`).map(e => (
                  <span key={e.id} style={{ fontSize: 11, color: "#fde68a", background: "rgba(251,191,36,0.15)", borderRadius: 4, padding: "1px 8px" }}>
                    {e.label} ¥{e.amount.toLocaleString()}
                  </span>
                ))}
                <span style={{ color: "#fde68a", fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  ＋ ¥{extrasTotal.toLocaleString()}
                </span>
              </div>
            )}
            {/* お弁当差引 */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: "#fca5a5", fontWeight: 700, minWidth: 110 }}>🍱 お弁当差引</span>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: "#fca5a5", fontSize: 12 }}>¥</span>
                <input type="number" min={0} step={10} value={bentoPricePerMeal || 0}
                  onChange={(e) => onUpdate(name, "__bento_price__", +e.target.value)}
                  style={{ width: 80, ...S.numInput, border: "1px solid rgba(252,165,165,0.5)", color: "#fca5a5" }} />
                <span style={{ color: "#fca5a5", fontSize: 11 }}>新規追加用</span>
                <span style={{ color: "#fca5a5", fontSize: 11 }}>登録済み {totals.bentoCount}食</span>
              </div>
              <span style={{ color: "#fca5a5", fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                － ¥{bentoTotal.toLocaleString()}
              </span>
              {totals.bentoCount === 0 && <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 11 }}>（なし）</span>}
            </div>
          </div>
          {/* 総支給額 */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#8db08d", fontWeight: 700 }}>{label}</span>
            <span style={{ fontSize: 26, fontWeight: 800, color: "#ffffff", fontVariantNumeric: "tabular-nums", textShadow: "0 0 20px rgba(185,240,176,0.5)" }}>
              ¥{grandTotal.toLocaleString()}
            </span>
            {totals.bentoCount > 0 && (
              <span style={{ fontSize: 10, color: "rgba(252,165,165,0.8)" }}>
                お弁当 ¥{bentoTotal.toLocaleString()} 差引済
              </span>
            )}
          </div>
        </div>
          );
        })()}
      </div>
    </div>
  );
}

// ─── スタッフ管理コンポーネント ────────────────────────────────────────────────
function StaffManager({ allData, locationNames, employeeLocation, employmentSettings,
  fareSettings, paidLeaveSettings, monthlySalarySettings, activeLocation,
  onAdd, onRemove, onUpdateLocation, onUpdateEmployment, onUpdateFare,
  onUpdatePaid, onUpdateMonthly, onSave, onRetire, onSelectStaff,
  contractStartByName, contractEndByName, employeeOverrides,
  onUpdateContractStart, onUpdateContractEnd, onUpdateEmployeeOverride, onResetEmployeeOverride }) {

  const [editingName, setEditingName] = useState(null); // 編集中の行
  const [addOpen, setAddOpen]         = useState(false);
  const [newName, setNewName]         = useState("");
  const [newLoc, setNewLoc]           = useState(locationNames[0] || "");
  const [filterLoc, setFilterLoc]     = useState(activeLocation || "all");
  const defaultLocation = locationNames.includes(DEFAULT_WORK_RULE.locationName)
    ? DEFAULT_WORK_RULE.locationName
    : (locationNames[0] || DEFAULT_WORK_RULE.locationName);

  useEffect(() => {
    setFilterLoc(activeLocation || "all");
  }, [activeLocation]);

  // 全スタッフ（全店舗）
  const allNames = useMemo(() => Object.keys(allData).sort((a, b) => {
    const la = normalizeLocation(employeeLocation[a]) || "";
    const lb = normalizeLocation(employeeLocation[b]) || "";
    if (la !== lb) return la.localeCompare(lb, "ja");
    return a.localeCompare(b, "ja");
  }), [allData, employeeLocation]);

  const filtered = filterLoc === "all" ? allNames
    : allNames.filter((n) => (normalizeLocation(employeeLocation[n]) || defaultLocation) === filterLoc);

  const handleAdd = () => {
    const n = newName.trim();
    if (!n) return;
    onAdd(n, newLoc || locationNames[0]);
    setNewName(""); setAddOpen(false);
  };

  const STORE_COLORS = {
    "とりここ": { bg: "#fff7ed", border: "#fed7aa", text: "#c2410c", dot: "#f97316" },
    "Ties":     { bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8", dot: "#3b82f6" },
    "Lien":     { bg: "#f5f3ff", border: "#ddd6fe", text: "#6d28d9", dot: "#8b5cf6" },
  };
  const storeColor = (loc) => STORE_COLORS[loc] || { bg: "#f0fdf4", border: "#bbf7d0", text: "#166534", dot: "#22c55e" };

  return (
    <div style={{ margin: "0 14px 24px" }}>
      {/* ── ツールバー ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: "#1a2e1a" }}>👥 スタッフ管理</div>
        <span style={{ fontSize: 12, color: "#8b7355" }}>{allNames.length}名登録</span>
        {/* 店舗フィルター */}
        <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {["all", ...locationNames].map((loc) => (
            <button key={loc} onClick={() => setFilterLoc(loc)} style={{
              padding: "5px 12px", fontSize: 11, fontWeight: 700, borderRadius: 999, cursor: "pointer",
              border: filterLoc === loc ? "2px solid #1a2e1a" : "1px solid #ddd5c8",
              background: filterLoc === loc ? "#1a2e1a" : "#fff",
              color: filterLoc === loc ? "#e8f5e8" : "#4b5563",
            }}>
              {loc === "all" ? "全員" : loc}
            </button>
          ))}
        </div>
        <button onClick={() => { setAddOpen(true); setNewLoc(activeLocation); }}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6,
            background: "#1a2e1a", color: "#e8f5e8", border: "none", borderRadius: 10,
            padding: "8px 16px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
          ＋ スタッフ追加
        </button>
      </div>

      {/* ── 追加フォーム ── */}
      {addOpen && (
        <div style={{ background: "#f0fdf4", border: "2px solid #86efac", borderRadius: 12, padding: "14px 18px", marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: "#166534" }}>＋ 新規スタッフ</span>
          <input placeholder="氏名を入力" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            autoFocus
            style={{ border: "2px solid #86efac", borderRadius: 8, padding: "7px 12px", fontSize: 13, outline: "none", minWidth: 160 }} />
          <select value={newLoc} onChange={(e) => setNewLoc(e.target.value)}
            style={{ border: "2px solid #86efac", borderRadius: 8, padding: "7px 10px", fontSize: 13, outline: "none", cursor: "pointer" }}>
            {locationNames.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button onClick={handleAdd} style={{ background: "#166534", color: "#fff", border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>追加</button>
          <button onClick={() => setAddOpen(false)} style={{ background: "#fff", color: "#6b7280", border: "1px solid #ddd5c8", borderRadius: 8, padding: "7px 14px", fontSize: 12, cursor: "pointer" }}>キャンセル</button>
        </div>
      )}

      {/* ── スタッフテーブル ── */}
      <div style={{ background: "#fff", border: "1px solid #eee2d8", borderRadius: 14, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#1a2e1a" }}>
              {["番号", "氏名", "所属店舗", "雇用区分", "月給 / 時給", "交通費", "有給単価", ""].map((h, i) => (
                <th key={i} style={{ padding: "11px 14px", textAlign: i > 2 ? "right" : "left", fontSize: 11, fontWeight: 800, color: "#8db08d", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((name, idx) => {
              const loc = normalizeLocation(employeeLocation[name]) || defaultLocation;
              const sc = storeColor(loc);
              const empType = normalizeEmployment(employmentSettings[name]);
              const isFullTime = empType === "正社員";
              const isEditing = editingName === name;

              const hasIndividualContract = !!employeeOverrides[name]?.enabled;
              const contractStart = contractStartByName[name] || "";
              const contractEnd = contractEndByName[name] || "";
              const contractSummary = `始め設定 ${contractStart || "未設定"} / 終了設定 ${contractEnd || "未設定"}`;

              return (
                <Fragment key={name}>
                  <tr style={{
                    background: idx % 2 === 0 ? "#fff" : "#fafaf8",
                    borderBottom: isEditing ? "none" : "1px solid #f0ece4",
                    transition: "background 0.15s",
                  }}>
                    {/* No */}
                    <td style={{ padding: "12px 14px", fontSize: 12, color: "#bbb", fontWeight: 700, width: 42 }}>{idx + 1}</td>

                    {/* 氏名 */}
                    <td style={{ padding: "12px 14px", fontWeight: 800, fontSize: 14, color: "#1a2e1a", whiteSpace: "nowrap" }}>
                      <button onClick={() => onSelectStaff(name)} style={{
                        background: "none", border: "none", padding: 0, cursor: "pointer",
                        fontSize: 14, fontWeight: 800, color: "#1a2e1a", textDecoration: "none",
                        display: "flex", alignItems: "center", gap: 6,
                      }}>
                        <span style={{ width: 28, height: 28, borderRadius: "50%", background: sc.bg, border: `1px solid ${sc.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: sc.text, fontWeight: 800 }}>
                          {name[0]}
                        </span>
                        {name}
                      </button>
                    </td>

                    {/* 所属店舗 — 常にドロップダウンで即変更可 */}
                    <td style={{ padding: "12px 14px" }}>
                      <select value={loc} onChange={(e) => onUpdateLocation(name, e.target.value)}
                        style={{ border: `2px solid ${sc.border}`, borderRadius: 8, padding: "5px 8px", fontSize: 12, cursor: "pointer", outline: "none", background: sc.bg, color: sc.text, fontWeight: 700 }}>
                        {locationNames.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </td>

                    {/* 雇用区分 */}
                    <td style={{ padding: "12px 14px" }}>
                      {isEditing ? (
                        <select value={empType} onChange={(e) => onUpdateEmployment(name, e.target.value)}
                          style={{ border: "2px solid #d1fae5", borderRadius: 8, padding: "5px 8px", fontSize: 12, cursor: "pointer", outline: "none" }}>
                          {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      ) : (
                        <span style={{ background: isFullTime ? "#eff6ff" : "#fff7ed", color: isFullTime ? "#1d4ed8" : "#c2410c", border: `1px solid ${isFullTime ? "#bfdbfe" : "#fed7aa"}`, borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 700 }}>
                          {empType}
                        </span>
                      )}
                    </td>

                    {/* 月給（正社員のみ） */}
                    <td style={{ padding: "12px 14px", textAlign: "right" }}>
                      {isFullTime ? (
                        isEditing ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                            <span style={{ fontSize: 12, color: "#6b7280" }}>¥</span>
                            <input type="number" min={0} step={1000}
                              value={monthlySalarySettings[name] ?? 0}
                              onChange={(e) => onUpdateMonthly(name, +e.target.value)}
                              style={{ width: 100, border: "2px solid #bfdbfe", borderRadius: 8, padding: "5px 8px", fontSize: 13, fontWeight: 700, textAlign: "right", outline: "none" }} />
                            <span style={{ fontSize: 11, color: "#6b7280" }}>/月</span>
                          </div>
                        ) : (
                          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, color: "#1a2e1a", fontSize: 13 }}>
                            {(monthlySalarySettings[name] ?? 0) > 0
                              ? <>{`¥${(monthlySalarySettings[name]).toLocaleString()}`}<span style={{ fontSize: 10, color: "#6b7280", marginLeft: 3 }}>/月</span></>
                              : <span style={{ color: "#ccc" }}>未設定</span>}
                          </span>
                        )
                      ) : (
                        <span style={{ color: "#9ca3af", fontSize: 11, background: "#f3f4f6", borderRadius: 6, padding: "3px 8px" }}>時給制</span>
                      )}
                    </td>

                    {/* 交通費 */}
                    <td style={{ padding: "12px 14px", textAlign: "right" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                          <span style={{ fontSize: 12, color: "#6b7280" }}>¥</span>
                          <input type="number" min={0} step={10} value={fareSettings[name] ?? 0}
                            onChange={(e) => onUpdateFare(name, +e.target.value)}
                            style={{ width: 70, border: "2px solid #d1fae5", borderRadius: 8, padding: "5px 8px", fontSize: 13, fontWeight: 700, textAlign: "right", outline: "none" }} />
                        </div>
                      ) : (
                        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, color: (fareSettings[name] ?? 0) > 0 ? "#1a2e1a" : "#ccc", fontWeight: 700 }}>
                          {(fareSettings[name] ?? 0) > 0 ? `¥${(fareSettings[name]).toLocaleString()}` : "—"}
                        </span>
                      )}
                    </td>

                    {/* 有給単価 */}
                    <td style={{ padding: "12px 14px", textAlign: "right" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                          <span style={{ fontSize: 12, color: "#6b7280" }}>¥</span>
                          <input type="number" min={0} step={100} value={paidLeaveSettings[name] ?? 0}
                            onChange={(e) => onUpdatePaid(name, +e.target.value)}
                            style={{ width: 70, border: "2px solid #d1fae5", borderRadius: 8, padding: "5px 8px", fontSize: 13, fontWeight: 700, textAlign: "right", outline: "none" }} />
                        </div>
                      ) : (
                        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, color: (paidLeaveSettings[name] ?? 0) > 0 ? "#166534" : "#ccc", fontWeight: 700 }}>
                          {(paidLeaveSettings[name] ?? 0) > 0 ? `¥${(paidLeaveSettings[name]).toLocaleString()}` : "—"}
                        </span>
                      )}
                    </td>

                    {/* アクション */}
                    <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button onClick={() => {
                            if (isEditing && onSave) onSave(name);
                            setEditingName(isEditing ? null : name);
                          }}
                          style={{ border: isEditing ? "2px solid #166534" : "1px solid #d1fae5", background: isEditing ? "#166534" : "#f0fdf4", color: isEditing ? "#fff" : "#166534",
                            borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                          {isEditing ? "✓ 保存" : "✏ 編集"}
                        </button>
                        <button onClick={() => onRetire && onRetire(name)}
                          style={{ border: "1px solid #fed7aa", background: "#fff7ed", color: "#c2410c", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}
                          title="退職登録">
                          退職
                        </button>
                        <button onClick={() => onRemove(name)}
                          style={{ border: "1px solid #fee2e2", background: "#fff", color: "#dc2626", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}
                          title="データ完全削除">
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isEditing && (
                    <tr style={{ background: idx % 2 === 0 ? "#fcfcfb" : "#f6f6f3", borderBottom: "1px solid #f0ece4" }}>
                      <td colSpan={8} style={{ padding: "0 14px 14px" }}>
                        <div style={{ marginTop: 4, border: "1px solid #dbeafe", background: "#f8fbff", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 12, fontWeight: 800, color: "#334155" }}>個別設定</span>
                              <span style={{ fontSize: 11, color: "#64748b" }}>{contractSummary}</span>
                            </div>
                            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: hasIndividualContract ? "#4338ca" : "#4b5563" }}>
                              <span>個別契約</span>
                              <select
                                value={hasIndividualContract ? "individual" : "shared"}
                                onChange={(e) => {
                                  if (e.target.value === "individual") onUpdateEmployeeOverride(name, {});
                                  else onResetEmployeeOverride(name);
                                }}
                                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "5px 8px", fontSize: 12, background: "#fff", outline: "none", cursor: "pointer" }}
                              >
                                <option value="shared">店舗共通</option>
                                <option value="individual">個別設定</option>
                              </select>
                            </label>
                          </div>
                          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#475569" }}>
                              <span>始め設定（丸め）</span>
                              <input
                                type="time"
                                value={contractStart}
                                onChange={(e) => onUpdateContractStart(name, e.target.value || "")}
                                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12, background: "#fff", width: 108 }}
                              />
                            </label>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#475569" }}>
                              <span>終了設定（丸め）</span>
                              <input
                                type="time"
                                value={contractEnd}
                                onChange={(e) => onUpdateContractEnd(name, e.target.value || "")}
                                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12, background: "#fff", width: 108 }}
                              />
                            </label>
                          </div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>始め設定は30分以内の早着だけ丸めます。終了設定はその時刻以降をその時刻に丸めます。</div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: "center", color: "#8b7355", fontSize: 13 }}>スタッフがいません</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 退職者一覧コンポーネント ──────────────────────────────────────────────────
function RetiredStaffList({ retiredNames, retiredSettings, employeeLocation, employmentSettings,
  allData, year, month, onReinstate, onRemove, onSelectHistory }) {
  if (retiredNames.length === 0) {
    return (
      <div style={{ margin: "24px", background: "#fff", border: "1px solid #eee2d8", borderRadius: 14, padding: 40, textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
        <div style={{ fontSize: 14, color: "#9ca3af" }}>退職者はいません</div>
      </div>
    );
  }

  return (
    <div style={{ margin: "16px 20px" }}>
      <div style={{ fontWeight: 800, fontSize: 15, color: "#92400e", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
        📋 退職者一覧
        <span style={{ fontSize: 12, fontWeight: 600, color: "#b45309" }}>{retiredNames.length}名</span>
      </div>
      <div style={{ background: "#fff", border: "1px solid #fed7aa", borderRadius: 14, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.05)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#78350f" }}>
              {["氏名", "所属店舗", "雇用区分", "退職日", "過去データ", ""].map((h, i) => (
                <th key={i} style={{ padding: "11px 14px", textAlign: i > 2 ? "center" : "left", fontSize: 11, fontWeight: 800, color: "#fde68a" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {retiredNames.map((name, idx) => {
              const info = retiredSettings[name] || {};
              const loc = normalizeLocation(employeeLocation[name]) || "—";
              const emp = normalizeEmployment(employmentSettings[name]);
              // 勤怠データのある月を集計
              const entries = allData[name] || {};
              const periods = new Set(Object.keys(entries).map((d) => {
                const p = getPeriodFromDateStr(d);
                if (!p) return null;
                return `${p.year}-${String(p.month).padStart(2,"0")}`;
              }).filter(Boolean));
              const periodCount = periods.size;

              return (
                <tr key={name} style={{ background: idx % 2 === 0 ? "#fffbeb" : "#fefce8", borderBottom: "1px solid #fde68a" }}>
                  <td style={{ padding: "12px 14px", fontWeight: 800, fontSize: 14, color: "#78350f" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 28, height: 28, borderRadius: "50%", background: "#fef3c7", border: "1px solid #fde68a", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#92400e", fontWeight: 800 }}>
                        {name[0]}
                      </span>
                      {name}
                    </div>
                  </td>
                  <td style={{ padding: "12px 14px", fontSize: 13, color: "#6b7280" }}>{loc}</td>
                  <td style={{ padding: "12px 14px" }}>
                    <span style={{ background: "#f3f4f6", color: "#6b7280", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{emp}</span>
                  </td>
                  <td style={{ padding: "12px 14px", textAlign: "center", fontSize: 13, color: "#92400e", fontWeight: 700 }}>
                    {info.retiredAt || "—"}
                  </td>
                  <td style={{ padding: "12px 14px", textAlign: "center" }}>
                    {periodCount > 0 ? (
                      <button onClick={() => onSelectHistory(name)}
                        style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                        📊 {periodCount}ヶ月分を確認
                      </button>
                    ) : (
                      <span style={{ color: "#d1d5db", fontSize: 12 }}>データなし</span>
                    )}
                  </td>
                  <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={() => onReinstate(name)}
                        style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#166534", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                        復職
                      </button>
                      <button onClick={() => onRemove(name)}
                        style={{ border: "1px solid #fee2e2", background: "#fff", color: "#dc2626", borderRadius: 8, padding: "6px 10px", fontSize: 11, cursor: "pointer" }}
                        title="データ完全削除">🗑</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: "#b45309", marginTop: 8 }}>
        ※「復職」ボタンで現役スタッフに戻せます。「🗑」はデータを完全削除します。
      </p>
    </div>
  );
}

// ─── 個人設定モーダル ─────────────────────────────────────────────────────────
function IndividualSettingsModal({ name, year, month, fareSettings, fareConfig, extras,
  onUpdateFare, onUpdateFareConfig, onUpdateExtras, onClose }) {

  const [tab, setTab]           = useState("fare");
  const [newLabel, setNewLabel] = useState("");
  const [newAmount, setNewAmount] = useState(""); // 文字列で管理し追加時に数値変換
  const [newPeriodKey, setNewPeriodKey] = useState(`${year}-${pad2(month)}`);
  const [addError, setAddError] = useState("");

  const config     = fareConfig[name] || { type: "daily" };
  const nameExtras = extras[name] || [];

  const handleTypeChange = (type) =>
    onUpdateFareConfig(name, { ...config, type });

  const handleTeikiPatch = (patch) =>
    onUpdateFareConfig(name, { ...config, ...patch });

  // 次回請求月を period ヶ月進める
  const advanceTeiki = () => {
    const p = config.teikiPeriod ?? 1;
    const [by, bm] = (config.teikiNextBilling ?? `${year}-${pad2(month)}`).split("-").map(Number);
    let ny = by, nm = bm + p;
    while (nm > 12) { nm -= 12; ny++; }
    handleTeikiPatch({ teikiNextBilling: `${ny}-${pad2(nm)}` });
  };

  const addExtra = () => {
    const label = newLabel.trim() || "臨時支給";
    const amount = parseInt(String(newAmount).replace(/[^0-9]/g, ""), 10) || 0;
    if (amount <= 0) { setAddError("金額を入力してください"); return; }
    setAddError("");
    const entry = { id: Date.now().toString(), label, amount, periodKey: newPeriodKey };
    onUpdateExtras(name, [...nameExtras, entry]);
    setNewLabel(""); setNewAmount("");
  };

  const removeExtra = (id) =>
    onUpdateExtras(name, nameExtras.filter(e => e.id !== id));

  // 選択肢：現在の期間前後 12 ヶ月
  const periodOptions = Array.from({ length: 15 }, (_, i) => {
    let y = year, m = month - 3 + i;
    while (m < 1)  { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return { key: `${y}-${pad2(m)}`, label: `${y}年${m}月` };
  });

  const extrasByPeriod = nameExtras.reduce((acc, e) => {
    (acc[e.periodKey] = acc[e.periodKey] || []).push(e);
    return acc;
  }, {});

  const currentPeriodKey = `${year}-${pad2(month)}`;
  const teikiBilled = config.type === "teiki" && config.teikiNextBilling === currentPeriodKey;

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...S.modal, maxWidth: 540 }} onClick={e => e.stopPropagation()}>

        {/* ヘッダー */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 900, color: "#1a2e1a" }}>⚙ {name} の個人設定</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 }}>✕</button>
        </div>

        {/* タブ */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {[["fare", "🚃 交通費"], ["extras", "💴 臨時支給"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: "8px 18px", fontSize: 12, fontWeight: 800, borderRadius: 10, cursor: "pointer",
              border: tab === key ? "2px solid #1a2e1a" : "1px solid #ddd5c8",
              background: tab === key ? "#1a2e1a" : "#fff",
              color: tab === key ? "#e8f5e8" : "#374151",
            }}>{label}</button>
          ))}
        </div>

        {/* ─── 交通費タブ ─── */}
        {tab === "fare" && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {[["daily", "🚶 日払い"], ["teiki", "🎫 定期代"]].map(([type, label]) => (
                <button key={type} onClick={() => handleTypeChange(type)} style={{
                  flex: 1, padding: "11px", fontSize: 13, fontWeight: 800, borderRadius: 10, cursor: "pointer",
                  border: config.type === type ? "2px solid #1a4d12" : "1px solid #ddd5c8",
                  background: config.type === type ? "#f0fdf4" : "#fff",
                  color: config.type === type ? "#1a4d12" : "#6b7280",
                }}>{label}</button>
              ))}
            </div>

            {(!config.type || config.type === "daily") && (
              <div style={{ background: "#fafaf8", border: "1px solid #eee2d8", borderRadius: 10, padding: "16px" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#6b7280", marginBottom: 10 }}>1回あたりの交通費（往復）</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#6b7280" }}>¥</span>
                  <input type="number" min={0} step={10} value={fareSettings[name] ?? 0}
                    onChange={e => onUpdateFare(name, "__fare__", +e.target.value)}
                    style={{ ...S.inp, width: 110, textAlign: "right", fontSize: 15, fontWeight: 700 }} />
                  <span style={{ fontSize: 12, color: "#9ca3af" }}>× 出勤日数 ＝ 交通費計</span>
                </div>
              </div>
            )}

            {config.type === "teiki" && (
              <div style={{ background: "#fafaf8", border: "1px solid #eee2d8", borderRadius: 10, padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>
                {/* 金額 */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#374151", minWidth: 72 }}>定期代</span>
                  <span style={{ color: "#6b7280" }}>¥</span>
                  <input type="number" min={0} step={100} value={config.teikiAmount ?? 0}
                    onChange={e => handleTeikiPatch({ teikiAmount: +e.target.value })}
                    style={{ ...S.inp, width: 120, textAlign: "right", fontSize: 15, fontWeight: 700 }} />
                </div>

                {/* 区間 */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#374151", minWidth: 72 }}>区間</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[1, 3, 6].map(p => (
                      <button key={p} onClick={() => handleTeikiPatch({ teikiPeriod: p })} style={{
                        padding: "6px 14px", fontSize: 12, fontWeight: 800, borderRadius: 8, cursor: "pointer",
                        border: (config.teikiPeriod ?? 1) === p ? "2px solid #4338ca" : "1px solid #ddd5c8",
                        background: (config.teikiPeriod ?? 1) === p ? "#eef2ff" : "#fff",
                        color: (config.teikiPeriod ?? 1) === p ? "#4338ca" : "#6b7280",
                      }}>{p}ヶ月</button>
                    ))}
                  </div>
                </div>

                {/* 次回請求 */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#374151", minWidth: 72 }}>次回請求</span>
                  <select value={config.teikiNextBilling ?? currentPeriodKey}
                    onChange={e => handleTeikiPatch({ teikiNextBilling: e.target.value })}
                    style={{ ...S.inp, width: "auto", fontSize: 13 }}>
                    {periodOptions.map(({ key, label }) =>
                      <option key={key} value={key}>{label}</option>
                    )}
                  </select>
                  {teikiBilled && (
                    <button onClick={advanceTeiki} style={{
                      background: "#4338ca", color: "#fff", border: "none", borderRadius: 8,
                      padding: "6px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer",
                    }}>
                      ✓ 今月請求済み → 次回へ進める
                    </button>
                  )}
                </div>

                <div style={{ ...S.noteBox, fontSize: 11, marginBottom: 0 }}>
                  「次回請求」の月の給与に定期代が加算されます。請求後は「次回へ進める」で更新してください。
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── 臨時支給タブ ─── */}
        {tab === "extras" && (
          <div>
            {/* 追加フォーム */}
            <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#166534", marginBottom: 8 }}>＋ 追加</div>
              {addError && <div style={{ color: "#dc2626", fontSize: 11, marginBottom: 6 }}>⚠ {addError}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input placeholder="名称（例：健康診断）" value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addExtra()}
                  style={{ ...S.inp, width: 170, fontSize: 12 }} />
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: "#6b7280", fontSize: 13 }}>¥</span>
                  <input type="number" min={1} step={100} value={newAmount}
                    onChange={e => setNewAmount(e.target.value)}
                    placeholder="金額"
                    style={{ ...S.inp, width: 100, textAlign: "right", fontSize: 13 }} />
                </div>
                <select value={newPeriodKey} onChange={e => setNewPeriodKey(e.target.value)}
                  style={{ ...S.inp, width: "auto", fontSize: 12 }}>
                  {periodOptions.map(({ key, label }) =>
                    <option key={key} value={key}>{label}支給</option>
                  )}
                </select>
                <button onClick={addExtra} style={S.btnP}>追加</button>
              </div>
            </div>

            {/* 一覧 */}
            {nameExtras.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>臨時支給の登録はありません</div>
            ) : (
              <div>
                {Object.entries(extrasByPeriod)
                  .sort((a, b) => b[0].localeCompare(a[0]))
                  .map(([pkey, items]) => {
                    const [py, pm] = pkey.split("-").map(Number);
                    const isCurrent = pkey === currentPeriodKey;
                    return (
                      <div key={pkey} style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: isCurrent ? "#166534" : "#6b7280", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                          {py}年{pm}月 支給
                          {isCurrent && <span style={{ background: "#dcfce7", color: "#166534", fontSize: 10, borderRadius: 4, padding: "1px 6px" }}>今月</span>}
                        </div>
                        {items.map(item => (
                          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#fafaf8", borderRadius: 8, marginBottom: 4, border: "1px solid #eee2d8" }}>
                            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{item.label}</span>
                            <span style={{ fontSize: 14, fontWeight: 800, color: "#1a4d12" }}>＋¥{item.amount.toLocaleString()}</span>
                            <button onClick={() => removeExtra(item.id)}
                              style={{ background: "none", border: "none", cursor: "pointer", color: "#dc2626", fontSize: 14, lineHeight: 1 }}>✕</button>
                          </div>
                        ))}
                      </div>
                    );
                  })
                }
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// ─── 給与一覧コンポーネント ────────────────────────────────────────────────────
function SalarySummary({ names, year, month, allData, fareSettings, fareConfig, extras,
  employmentSettings, getEffectiveRule, bentoChecksByName, getBentoPriceForName, prevAllData,
  monthlySalarySettings, retiredSettings, onClickName }) {

  const rows = useMemo(() => names.map((name) => {
    const entries = allData[name] || {};
    const rule = getEffectiveRule(name);
    const empType = normalizeEmployment(employmentSettings[name]);
    const isFullTime = empType === "正社員";
    const monthly = monthlySalarySettings[name] ?? 0;

    const retiredAt = retiredSettings?.[name]?.isRetired ? (retiredSettings[name]?.retiredAt || null) : null;
    const periodDays = getPeriodDays(year, month).filter(({ key }) => !retiredAt || key <= retiredAt);
    const currentSummary = summarizeAttendanceMetrics(entries, periodDays, rule, empType);
    const prevPeriod = getPreviousPeriod(year, month);
    const prevSummary = summarizeAttendanceMetrics(prevAllData?.[name] || {}, getPeriodDays(prevPeriod.year, prevPeriod.month), rule, empType);
    let workMin = currentSummary.totalWorkMin;
    let overtime = currentSummary.totalOvertimeMin;
    let wage = 0;
    let overtimeWage = 0;
    let days = currentSummary.workDays;
    let paidDays = currentSummary.paidDays;
    const bentoByDate = bentoChecksByName[name] || {};
    const bentoPricePerMeal = getBentoPriceForName(name);
    const bentoCount = countBentoEntries(bentoByDate, (dateStr) => periodDays.some((d) => d.key === dateStr));
    const bentoTotal = sumBentoEntries(bentoByDate, bentoPricePerMeal, (dateStr) => periodDays.some((d) => d.key === dateStr));
    for (const { key: dateStr } of periodDays) {
      const e = normalizeAttendanceEntry(entries[dateStr]);
      const { effectiveStart, effectiveEnd } = resolveEntryTimes(e || {}, rule);
      if (!effectiveStart || !effectiveEnd) continue;
      const c = calcWork(dateStr, effectiveStart, effectiveEnd, rule, empType, e || {});
      if (!c) continue;
      wage += c.wage;
      overtimeWage += Math.floor((c.overtime / 60) * c.rate);
    }
    const fareTotal   = calcFareTotal(name, days, year, month, fareConfig, fareSettings);
    const extrasTotal = calcExtrasTotal(name, year, month, extras);
    const paidTotal   = Math.round((prevSummary.avgDailyMin / 60) * rule.hourlyNormal * paidDays);
    const baseWage    = isFullTime ? monthly + overtimeWage : wage;
    const total       = baseWage + fareTotal + extrasTotal + paidTotal - bentoTotal;
    return { name, isFullTime, days, paidDays, workMin, overtime, wage: baseWage, overtimeWage, fareTotal, extrasTotal, paidTotal, bentoCount, bentoTotal, total, retiredAt };
  }), [names, year, month, allData, fareSettings, fareConfig, extras,
       employmentSettings, getEffectiveRule, bentoChecksByName, getBentoPriceForName, prevAllData, monthlySalarySettings, retiredSettings]);

  const grand = useMemo(() => rows.reduce((a, r) => ({
    days:       a.days       + r.days,
    paidDays:   a.paidDays   + r.paidDays,
    workMin:    a.workMin    + r.workMin,
    overtime:   a.overtime   + r.overtime,
    wage:       a.wage       + r.wage,
    fareTotal:  a.fareTotal  + r.fareTotal,
    extrasTotal:a.extrasTotal+ r.extrasTotal,
    paidTotal:  a.paidTotal  + r.paidTotal,
    bentoTotal: a.bentoTotal + r.bentoTotal,
    total:      a.total      + r.total,
  }), { days:0, paidDays:0, workMin:0, overtime:0, wage:0, fareTotal:0, extrasTotal:0, paidTotal:0, bentoTotal:0, total:0 }), [rows]);

  if (names.length === 0) return (
    <div style={{ padding: 32, color: "#8b7355", fontSize: 13, textAlign: "center" }}>
      この店舗にスタッフがいません
    </div>
  );

  const col = { padding: "10px 12px", textAlign: "right", fontSize: 12, whiteSpace: "nowrap" };
  const colL = { ...col, textAlign: "left" };
  const colC = { ...col, textAlign: "center" };
  const num = (v) => v.toLocaleString();

  return (
    <div style={{ margin: "0 14px 24px" }}>
      <div style={{ background: "#fff", border: "1px solid #eee2d8", borderRadius: 12, overflow: "hidden", boxShadow: "0 3px 16px rgba(0,0,0,0.04)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#1a2e1a", color: "#e8f5e8" }}>
              <th style={{ ...colL, fontSize: 11, fontWeight: 800 }}>氏名</th>
              <th style={{ ...colC, fontSize: 11, fontWeight: 800 }}>出勤</th>
              <th style={{ ...colC, fontSize: 11, fontWeight: 800 }}>有給</th>
              <th style={{ ...colC, fontSize: 11, fontWeight: 800 }}>勤務時間</th>
              <th style={{ ...colC, fontSize: 11, fontWeight: 800 }}>残業</th>
              <th style={{ ...col,  fontSize: 11, fontWeight: 800, borderLeft: "1px solid #3d5c3d" }}>給与</th>
              <th style={{ ...col,  fontSize: 11, fontWeight: 800 }}>交通費</th>
              <th style={{ ...col,  fontSize: 11, fontWeight: 800 }}>有給分</th>
              <th style={{ ...col,  fontSize: 11, fontWeight: 800, color: "#fbbf24" }}>臨時</th>
              <th style={{ ...col,  fontSize: 11, fontWeight: 800, color: "#fca5a5" }}>お弁当</th>
              <th style={{ ...col,  fontSize: 11, fontWeight: 800, borderLeft: "1px solid #3d5c3d", background: "#243424" }}>総支給額</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name} style={{ background: i % 2 === 0 ? "#fff" : "#fafaf8", borderBottom: "1px solid #f0ece4", cursor: "pointer" }}
                onClick={() => onClickName(r.name)}>
                <td style={{ ...colL, fontWeight: 700, color: r.retiredAt ? "#92400e" : "#1a2e1a" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {r.name}
                    {r.retiredAt && (
                      <span style={{ fontSize: 9, background: "#fed7aa", color: "#c2410c", borderRadius: 4, padding: "1px 6px", fontWeight: 800 }}>
                        退職 {r.retiredAt}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: "#8b7355", fontWeight: 400 }}>→</span>
                  </div>
                </td>
                <td style={{ ...colC, color: "#4b5563" }}>{r.days}日</td>
                <td style={{ ...colC, color: r.paidDays > 0 ? "#166534" : "#ccc" }}>
                  {r.paidDays > 0 ? `${r.paidDays}日` : "—"}
                </td>
                <td style={{ ...colC, fontVariantNumeric: "tabular-nums", color: "#6b5e4c" }}>
                  {r.workMin > 0 ? m2t(r.workMin) : "—"}
                </td>
                <td style={{ ...colC }}>
                  {r.overtime > 0
                    ? <span style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, background: "#fee2e2", borderRadius: 4, padding: "1px 6px" }}>{m2t(r.overtime)}</span>
                    : <span style={{ color: "#ccc" }}>—</span>}
                </td>
                <td style={{ ...col, borderLeft: "1px solid #f0ece4", fontVariantNumeric: "tabular-nums" }}>
                  ¥{num(r.wage)}
                  {r.isFullTime && <span style={{ marginLeft: 4, fontSize: 10, background: "#dcfce7", color: "#166534", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>月給</span>}
                  {r.isFullTime && r.overtimeWage > 0 && <div style={{ fontSize: 10, color: "#fbbf24" }}>残業代込</div>}
                </td>
                <td style={{ ...col, color: "#6b5e4c", fontVariantNumeric: "tabular-nums" }}>
                  {r.fareTotal > 0 ? `¥${num(r.fareTotal)}` : <span style={{ color: "#ccc" }}>—</span>}
                </td>
                <td style={{ ...col, color: "#166534", fontVariantNumeric: "tabular-nums" }}>
                  {r.paidTotal > 0 ? `¥${num(r.paidTotal)}` : <span style={{ color: "#ccc" }}>—</span>}
                </td>
                <td style={{ ...col, color: "#d97706", fontVariantNumeric: "tabular-nums" }}>
                  {r.extrasTotal > 0 ? `¥${num(r.extrasTotal)}` : <span style={{ color: "#ccc" }}>—</span>}
                </td>
                <td style={{ ...col, color: "#dc2626", fontVariantNumeric: "tabular-nums" }}>
                  {r.bentoTotal > 0 ? `－¥${num(r.bentoTotal)}` : <span style={{ color: "#ccc" }}>—</span>}
                </td>
                <td style={{ ...col, borderLeft: "1px solid #f0ece4", fontWeight: 800, color: "#1a4d12", fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
                  ¥{num(r.total)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: "#1a2e1a", color: "#e8f5e8", borderTop: "2px solid #1a2e1a" }}>
              <td style={{ ...colL, fontWeight: 800, fontSize: 11 }}>合計 {rows.length}名</td>
              <td style={{ ...colC, fontSize: 11 }}>{grand.days}日</td>
              <td style={{ ...colC, fontSize: 11 }}>{grand.paidDays > 0 ? `${grand.paidDays}日` : "—"}</td>
              <td style={{ ...colC, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{grand.workMin > 0 ? m2t(grand.workMin) : "—"}</td>
              <td style={{ ...colC, fontSize: 11 }}>{grand.overtime > 0 ? m2t(grand.overtime) : "—"}</td>
              <td style={{ ...col, fontSize: 11, borderLeft: "1px solid #3d5c3d", fontVariantNumeric: "tabular-nums" }}>¥{num(grand.wage)}</td>
              <td style={{ ...col, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{grand.fareTotal > 0 ? `¥${num(grand.fareTotal)}` : "—"}</td>
              <td style={{ ...col, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{grand.paidTotal > 0 ? `¥${num(grand.paidTotal)}` : "—"}</td>
              <td style={{ ...col, fontSize: 11, color: "#fbbf24", fontVariantNumeric: "tabular-nums" }}>{grand.extrasTotal > 0 ? `¥${num(grand.extrasTotal)}` : "—"}</td>
              <td style={{ ...col, fontSize: 11, color: "#fca5a5", fontVariantNumeric: "tabular-nums" }}>{grand.bentoTotal > 0 ? `－¥${num(grand.bentoTotal)}` : "—"}</td>
              <td style={{ ...col, borderLeft: "1px solid #3d5c3d", fontWeight: 900, fontSize: 15, color: "#b9f0b0", fontVariantNumeric: "tabular-nums" }}>
                ¥{num(grand.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ─── ログイン画面 ──────────────────────────────────────────────────────────────
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
      <div style={{ width: "min(420px,100%)", background: "#fff", border: "1px solid #eee2d8", borderRadius: 14, padding: 24, boxShadow: "0 10px 30px rgba(0,0,0,0.08)" }}>
        <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 4, color: "#1a2e1a" }}>とりここ 勤怠管理</div>
        <div style={{ fontSize: 12, color: "#8b7355", marginBottom: 20 }}>ログインしてください</div>
        <div style={{ display: "grid", gap: 10 }}>
          <input placeholder="メールアドレス" value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            style={S.inp} />
          <input type="password" placeholder="パスワード" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            style={S.inp} />
          <button onClick={login} disabled={busy}
            style={{ ...S.btnP, width: "100%", padding: "12px", fontSize: 14, opacity: busy ? 0.7 : 1 }}>
            {busy ? "ログイン中…" : "ログイン"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 店舗ルール設定パネル ──────────────────────────────────────────────────────
function WorkRulePanel({ workRule, onUpdate }) {
  const r = workRule;
  const ftH = r.breakThresholdMinutesFullTime / 60;
  const ptH = r.breakThresholdMinutesPartTime / 60;

  // snapRangeStart === snapRangeEnd のとき「無効」扱い（削除で "00:00","00:00","00:00" にする）
  const rangeSnapEnabled = r.snapRangeStart !== r.snapRangeEnd;

  const Field = ({ label, children }) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
      <span style={{ color: "#6b7280", fontWeight: 700 }}>{label}</span>
      {children}
    </label>
  );
  const timeInput = (val, key) => (
    <input type="time" value={val}
      onChange={(e) => onUpdate({ [key]: e.target.value })}
      style={{ border: "1px solid #c9d6c8", borderRadius: 6, padding: "5px 7px", fontSize: 12, background: "#fff", width: 108 }} />
  );
  const numInput = (val, key, unit = "", w = 80, step = 1) => (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <input type="number" min={0} step={step} value={val}
        onChange={(e) => onUpdate({ [key]: Math.max(0, Number(e.target.value) || 0) })}
        style={{ border: "1px solid #c9d6c8", borderRadius: 6, padding: "5px 7px", fontSize: 12, background: "#fff", width: w, textAlign: "right" }} />
      {unit && <span style={{ fontSize: 11, color: "#6b7280" }}>{unit}</span>}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>

      {/* 営業時間 */}
      <div>
        <div style={S.sectionLabel}>⏰ 営業時間</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Field label="開始">{timeInput(r.businessStart, "businessStart")}</Field>
          <Field label="終了">{timeInput(r.businessEnd, "businessEnd")}</Field>
        </div>
      </div>

      {/* スナップ設定 */}
      <div>
        <div style={S.sectionLabel}>⚡ スナップ設定（早出・打刻丸め）</div>
        <div style={{ display: "grid", gap: 10 }}>
          {/* 早朝スナップ（常時表示） */}
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#334155", marginBottom: 6 }}>【早朝スナップ】この時刻より前に来た場合</div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <Field label="〇〇時前に来たら">{timeInput(r.snapEarlyThreshold, "snapEarlyThreshold")}</Field>
              <Field label="この時刻に丸める">{timeInput(r.snapEarlyTo, "snapEarlyTo")}</Field>
            </div>
          </div>

          {/* 範囲スナップ（任意追加） */}
          {rangeSnapEnabled ? (
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#334155" }}>【範囲スナップ】この時間帯に来た場合</span>
                <button
                  onClick={() => onUpdate({ snapRangeStart: "00:00", snapRangeEnd: "00:00", snapRangeTo: "00:00" })}
                  style={{ fontSize: 11, border: "1px solid #fca5a5", background: "#fff", color: "#dc2626", borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontWeight: 700 }}
                >削除</button>
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <Field label="範囲 開始">{timeInput(r.snapRangeStart, "snapRangeStart")}</Field>
                <Field label="範囲 終了">{timeInput(r.snapRangeEnd, "snapRangeEnd")}</Field>
                <Field label="この時刻に丸める">{timeInput(r.snapRangeTo, "snapRangeTo")}</Field>
              </div>
            </div>
          ) : (
            <button
              onClick={() => onUpdate({ snapRangeStart: "14:00", snapRangeEnd: "15:00", snapRangeTo: "15:00" })}
              style={{ display: "flex", alignItems: "center", gap: 6, border: "1px dashed #c9d6c8", background: "#f8fafc", color: "#4b5563", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700, width: "fit-content" }}
            >
              <span style={{ fontSize: 15 }}>＋</span> 範囲スナップを追加
            </button>
          )}
        </div>
      </div>

      {/* 休憩 */}
      <div>
        <div style={S.sectionLabel}>☕ 休憩設定</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 500 }}>
          <div style={{ background: "#f0faf0", border: "1px solid #d1fae5", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#065f46", marginBottom: 6 }}>正社員</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Field label="休憩時間">{numInput(r.breakMinutesFullTime, "breakMinutesFullTime", "分", 72)}</Field>
              <Field label="発生基準">
                {numInput(ftH, "breakThresholdMinutesFullTime_h", "時間以上", 72, 0.5)}
              </Field>
            </div>
          </div>
          <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9a3412", marginBottom: 6 }}>パート</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Field label="休憩時間">{numInput(r.breakMinutesPartTime, "breakMinutesPartTime", "分", 72)}</Field>
              <Field label="発生基準">
                {numInput(ptH, "breakThresholdMinutesPartTime_h", "時間以上", 72, 0.5)}
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* 時給 */}
      <div>
        <div style={S.sectionLabel}>💴 時給設定</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Field label="平日時給">{numInput(r.hourlyNormal, "hourlyNormal", "円", 96)}</Field>
          <Field label="土日祝時給">{numInput(r.hourlyWeekend, "hourlyWeekend", "円", 96)}</Field>
        </div>
      </div>
    </div>
  );
}

// ─── メインアプリ ──────────────────────────────────────────────────────────────
export default function App() {
  const [user,        setUser]        = useState(null);
  const [year,        setYear]        = useState(new Date().getFullYear());
  const [month,       setMonth]       = useState(new Date().getMonth() + 1);
  const [allData,     setAllData]     = useState({});
  const [prevAllData, setPrevAllData] = useState({});
  const [fareSettings,       setFareSettings]       = useState({});
  const [paidLeaveSettings,  setPaidLeaveSettings]  = useState({});
  const [monthlySalarySettings, setMonthlySalarySettings] = useState({});
  const [employmentSettings, setEmploymentSettings] = useState({});
  const [workRulesByLocation,setWorkRulesByLocation]= useState(defaultRulesMap());
  const [ruleModeByLocation, setRuleModeByLocation] = useState({});
  const [employeeLocation,   setEmployeeLocation]   = useState({});
  const [employeeOverrides,  setEmployeeOverrides]  = useState({});
  const [contractStartByName, setContractStartByName] = useState({}); // { name: "09:00" }
  const [contractEndByName, setContractEndByName] = useState({}); // { name: "18:30" }
  const [activeLocation,     setActiveLocation]     = useState(DEFAULT_WORK_RULE.locationName);
  const [activeName,         setActiveName]         = useState("");
  const [toast,  setToast]  = useState(null);
  const [preview,setPreview]= useState(null);
  const [importFailures, setImportFailures] = useState(null);
  const [loading,setLoading]= useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [exportScope, setExportScope] = useState("all");
  const [viewMode, setViewMode] = useState("detail"); // "detail" | "summary" | "staff" | "retired"
  const [storeSettingsOpen, setStoreSettingsOpen] = useState(false);
  const [fareConfig, setFareConfig] = useState({}); // { [name]: { type, teikiAmount, teikiPeriod, teikiNextBilling } }
  const [extras, setExtras]         = useState({}); // { [name]: [{ id, label, amount, periodKey }] }
  const extrasLoadedRef = useRef(false);
  const attendanceShiftLoadedRef = useRef(false);
  const [settingsModalName, setSettingsModalName] = useState(null);
  const [bentoChecksByName, setBentoChecksByName] = useState({});
  const [bentoPriceByLocation, setBentoPriceByLocation] = useState({
    [LEGACY_SHARED_BENTO_PRICE_KEY]: DEFAULT_BENTO_PRICE_PER_MEAL,
  });
  const [, setBentoStorageOnly] = useState(false);
  const [retiredSettings, setRetiredSettings] = useState({}); // { name: { isRetired, retiredAt } }
  const [registeredNames, setRegisteredNames] = useState([]); // employee_settings 全登録名
  const fileRef = useRef();
  const bentoFileRef = useRef();

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3500);
  };
  const saveStamp = () => {
    const now = new Date();
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  };

  // ── 派生値 ──
  const locationNames = useMemo(
    () => Object.keys(workRulesByLocation).sort((a, b) => a.localeCompare(b, "ja")),
    [workRulesByLocation]
  );
  const getBentoPriceForLocation = useCallback((locationName) => {
    const normalized = normalizeLocation(locationName);
    if (normalized && Object.prototype.hasOwnProperty.call(bentoPriceByLocation, normalized)) {
      return Math.max(0, Math.round(Number(bentoPriceByLocation[normalized]) || 0));
    }
    if (Object.prototype.hasOwnProperty.call(bentoPriceByLocation, LEGACY_SHARED_BENTO_PRICE_KEY)) {
      return Math.max(0, Math.round(Number(bentoPriceByLocation[LEGACY_SHARED_BENTO_PRICE_KEY]) || 0));
    }
    return DEFAULT_BENTO_PRICE_PER_MEAL;
  }, [bentoPriceByLocation]);

  // 現在の店舗に所属するスタッフだけ表示
  const allNames = useMemo(() => {
    // allData + registeredNames の両方を合わせて現役スタッフ一覧を作成
    const combined = new Set([
      ...Object.keys(allData),
      ...registeredNames,
    ]);
    return Array.from(combined)
      .filter((n) => !retiredSettings[n]?.isRetired)
      .sort((a, b) => a.localeCompare(b, "ja"));
  }, [allData, registeredNames, retiredSettings]);
  const retiredNames = useMemo(() => Object.keys(allData)
    .filter((n) => retiredSettings[n]?.isRetired)
    .sort((a, b) => a.localeCompare(b, "ja")), [allData, retiredSettings]);

  // 退職者のうち、選択中の期間に在籍していた人（退職日 >= 期間開始）
  const retiredInPeriod = useMemo(() => {
    const { start } = getPeriodRange(year, month);
    return retiredNames.filter((n) => {
      const retiredAt = retiredSettings[n]?.retiredAt;
      if (!retiredAt) return false; // 退職日不明は除外
      return retiredAt >= start; // 退職日が期間開始以降 → 期間中に在籍
    });
  }, [retiredNames, retiredSettings, year, month]);

  const exportableNames = useMemo(() => {
    const { start } = getPeriodRange(year, month);
    const set = new Set([
      ...Object.keys(allData || {}),
      ...Object.keys(fareSettings || {}),
      ...Object.keys(paidLeaveSettings || {}),
      ...Object.keys(monthlySalarySettings || {}),
      ...Object.keys(employmentSettings || {}),
      ...Object.keys(employeeLocation || {}),
    ]);
    return Array.from(set)
      .filter((n) => {
        const info = retiredSettings[n];
        if (!info?.isRetired) return true; // 現役は常に含む
        if (!info.retiredAt) return false;  // 退職日不明は除外
        return info.retiredAt >= start;     // 退職日が期間開始以降なら含む
      })
      .sort((a, b) => a.localeCompare(b, "ja"));
  }, [allData, fareSettings, paidLeaveSettings, monthlySalarySettings, employmentSettings, employeeLocation, retiredSettings, year, month]);
  // 表示中の期間に在籍しているスタッフ（現役 + 期間内退職者）の中から、店舗で絞り込む
  const namesForPeriod = useMemo(() => {
    const active = allNames; // 現役
    const combined = [...active, ...retiredInPeriod];
    return combined.sort((a, b) => a.localeCompare(b, "ja"));
  }, [allNames, retiredInPeriod]);

  const names = useMemo(() =>
    namesForPeriod.filter((n) => {
      const loc = normalizeLocation(employeeLocation[n]);
      // 所属店舗未設定の場合は DEFAULT_WORK_RULE.locationName（とりここ）に属する扱い
      const effective = loc || DEFAULT_WORK_RULE.locationName;
      return effective === activeLocation;
    }),
    [namesForPeriod, employeeLocation, activeLocation]
  );
  const storeScopedNames = useMemo(() =>
    exportableNames.filter((n) => {
      const loc = normalizeLocation(employeeLocation[n]) || DEFAULT_WORK_RULE.locationName;
      return loc === activeLocation;
    }),
    [exportableNames, employeeLocation, activeLocation]
  );

  const getLocationForName = useCallback((name) => {
    const assigned = normalizeLocation(employeeLocation[name]);
    if (assigned && workRulesByLocation[assigned]) return assigned;
    if (workRulesByLocation[activeLocation]) return activeLocation;
    return DEFAULT_WORK_RULE.locationName;
  }, [employeeLocation, workRulesByLocation, activeLocation]);
  const getBentoPriceForName = useCallback((name) => {
    return getBentoPriceForLocation(getLocationForName(name));
  }, [getBentoPriceForLocation, getLocationForName]);

  const getEffectiveRuleAtLocation = useCallback((name, locationHint) => {
    const hinted = normalizeLocation(locationHint);
    const loc = hinted && workRulesByLocation[hinted] ? hinted : getLocationForName(name);
    const base = sanitizeRule(workRulesByLocation[loc] || { ...DEFAULT_WORK_RULE, locationName: loc });
    let rule = base;

    // 始め設定・終了設定の丸めは設定モードに関わらず個別指定できる。
    const contractStart = contractStartByName[name];
    if (contractStart) {
      rule = {
        ...sanitizeRule({
          ...rule,
          snapEarlyThreshold: contractStart,
          snapEarlyTo: contractStart,
        }),
        startRoundWindowMinutes: 30,
      };
    }
    const contractEnd = contractEndByName[name];
    if (contractEnd) {
      rule = sanitizeRule({
        ...rule,
        businessEnd: contractEnd,
      });
    }

    return rule;
  }, [getLocationForName, workRulesByLocation, contractStartByName, contractEndByName]);
  const getEffectiveRule = useCallback((name) => {
    return getEffectiveRuleAtLocation(name, getLocationForName(name));
  }, [getEffectiveRuleAtLocation, getLocationForName]);
  const openStaffDetail = useCallback((name) => {
    const loc = getLocationForName(name);
    if (loc) setActiveLocation(loc);
    setActiveName(name);
    setViewMode("detail");
  }, [getLocationForName]);

  const activeWorkRule = sanitizeRule(workRulesByLocation[activeLocation] || DEFAULT_WORK_RULE);
  const activeEmployeeLocation = activeName ? getLocationForName(activeName) : activeLocation;
  const activeEffectiveRule = activeName ? getEffectiveRule(activeName) : activeWorkRule;
  const activeEmploymentType = normalizeEmployment(employmentSettings[activeName]);
  const activeRuleMode = normalizeRuleMode(ruleModeByLocation[activeLocation]);
  const activeBentoPricePerMeal = activeName ? getBentoPriceForName(activeName) : getBentoPriceForLocation(activeLocation);
  const buildEmployeeSettingOptions = useCallback((name, patch = {}) => ({
    location: Object.prototype.hasOwnProperty.call(patch, "location")
      ? (patch.location || DEFAULT_WORK_RULE.locationName)
      : (employeeLocation[name] || DEFAULT_WORK_RULE.locationName),
    contractStart: Object.prototype.hasOwnProperty.call(patch, "contractStart")
      ? (patch.contractStart || "")
      : (contractStartByName[name] || ""),
    contractEnd: Object.prototype.hasOwnProperty.call(patch, "contractEnd")
      ? (patch.contractEnd || "")
      : (contractEndByName[name] || ""),
    fareConfig: Object.prototype.hasOwnProperty.call(patch, "fareConfig")
      ? (patch.fareConfig || {})
      : (fareConfig[name] || {}),
    overrideRule: Object.prototype.hasOwnProperty.call(patch, "overrideRule")
      ? (patch.overrideRule || null)
      : (employeeOverrides[name] || null),
  }), [employeeLocation, contractStartByName, contractEndByName, fareConfig, employeeOverrides]);
  const activePeriodWorkDays = useMemo(() => {
    if (!activeName) return 0;
    const entries = allData[activeName] || {};
    const { start, end } = getPeriodRange(year, month);
    return Object.keys(entries).filter((dateStr) => {
      if (dateStr < start || dateStr > end) return false;
      const entry = entries[dateStr];
      return !!(entry?.start && entry?.end);
    }).length;
  }, [activeName, allData, year, month]);
  const updateEmployeeOverrideRule = useCallback(async (name, patch) => {
    let nextOverride = null;
    setEmployeeOverrides((prev) => {
      const loc = getLocationForName(name);
      const base = sanitizeRule(workRulesByLocation[loc] || { ...DEFAULT_WORK_RULE, locationName: loc });
      const current = sanitizeRule({ ...base, ...(prev[name]?.rule || {}), locationName: base.locationName });
      const converted = { ...patch };
      if ("breakThresholdMinutesFullTime_h" in patch) converted.breakThresholdMinutesFullTime = Math.max(0, Math.round((Number(patch.breakThresholdMinutesFullTime_h) || 0) * 60));
      if ("breakThresholdMinutesPartTime_h" in patch) converted.breakThresholdMinutesPartTime = Math.max(0, Math.round((Number(patch.breakThresholdMinutesPartTime_h) || 0) * 60));
      delete converted.breakThresholdMinutesFullTime_h;
      delete converted.breakThresholdMinutesPartTime_h;
      nextOverride = {
        enabled: true,
        rule: sanitizeRule({ ...current, ...converted, locationName: base.locationName }),
      };
      return {
        ...prev,
        [name]: nextOverride,
      };
    });
    if (!user) return;
    try {
      await dbUpsertSettings(
        user.id,
        name,
        fareSettings[name] ?? 0,
        paidLeaveSettings[name] ?? 0,
        employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE,
        monthlySalarySettings[name] ?? 0,
        buildEmployeeSettingOptions(name, { overrideRule: nextOverride })
      );
    } catch (e) {
      showToast(`保存エラー: ${e.message}`, "err");
    }
  }, [user, getLocationForName, workRulesByLocation, fareSettings, paidLeaveSettings, employmentSettings, monthlySalarySettings, buildEmployeeSettingOptions]);
  const resetEmployeeOverrideRule = useCallback(async (name) => {
    setEmployeeOverrides((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (!user) return;
    try {
      await dbUpsertSettings(
        user.id,
        name,
        fareSettings[name] ?? 0,
        paidLeaveSettings[name] ?? 0,
        employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE,
        monthlySalarySettings[name] ?? 0,
        buildEmployeeSettingOptions(name, { overrideRule: null })
      );
    } catch (e) {
      showToast(`保存エラー: ${e.message}`, "err");
    }
  }, [user, fareSettings, paidLeaveSettings, employmentSettings, monthlySalarySettings, buildEmployeeSettingOptions]);
  const confirmSettingSave = useCallback((message) => window.confirm(`${message}\n保存しますか？`), []);
  const saveContractSettings = useCallback(async (name, patch = {}) => {
    if (!user) return;
    const nextStart = Object.prototype.hasOwnProperty.call(patch, "contractStart")
      ? (patch.contractStart || "")
      : (contractStartByName[name] || "");
    const nextEnd = Object.prototype.hasOwnProperty.call(patch, "contractEnd")
      ? (patch.contractEnd || "")
      : (contractEndByName[name] || "");

    setContractStartByName((prev) => {
      const next = { ...prev };
      if (nextStart) next[name] = nextStart;
      else delete next[name];
      return next;
    });
    setContractEndByName((prev) => {
      const next = { ...prev };
      if (nextEnd) next[name] = nextEnd;
      else delete next[name];
      return next;
    });

    try {
      await dbUpsertSettings(
        user.id,
        name,
        fareSettings[name] ?? 0,
        paidLeaveSettings[name] ?? 0,
        employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE,
        monthlySalarySettings[name] ?? 0,
        buildEmployeeSettingOptions(name, { contractStart: nextStart, contractEnd: nextEnd })
      );
      showToast(`${name} の丸め設定を保存しました ✓`);
    } catch (e) {
      showToast(`保存エラー: ${e.message}`, "err");
    }
  }, [user, contractStartByName, contractEndByName, fareSettings, paidLeaveSettings, employmentSettings, monthlySalarySettings, buildEmployeeSettingOptions]);
  const updateContractStart = useCallback(async (name, value) => {
    const label = value || "未設定";
    if (!confirmSettingSave(`${name} の始め設定を「${label}」で保存します。`)) return;
    await saveContractSettings(name, { contractStart: value || "" });
  }, [confirmSettingSave, saveContractSettings]);
  const updateContractEnd = useCallback(async (name, value) => {
    const label = value || "未設定";
    if (!confirmSettingSave(`${name} の終了設定を「${label}」で保存します。`)) return;
    await saveContractSettings(name, { contractEnd: value || "" });
  }, [confirmSettingSave, saveContractSettings]);

  // ── ローカルストレージ（overrides・UI設定は軽量なのでlocalStorageで可） ──
  useEffect(() => {
    if (!user) return;
    try {
      const saved = localStorage.getItem(`torikoko:overrides:${user.id}`);
      if (saved) setEmployeeOverrides(JSON.parse(saved));
      const savedModes = localStorage.getItem(`torikoko:ruleModes:${user.id}`);
      if (savedModes) setRuleModeByLocation(JSON.parse(savedModes));
      const savedLoc = localStorage.getItem(`torikoko:employeeLoc:${user.id}`);
      if (savedLoc) setEmployeeLocation(JSON.parse(savedLoc));
      const savedContractStart = localStorage.getItem(`torikoko:contractStart:${user.id}`);
      if (savedContractStart) setContractStartByName(JSON.parse(savedContractStart));
      const savedContractEnd = localStorage.getItem(`torikoko:contractEnd:${user.id}`);
      if (savedContractEnd) setContractEndByName(JSON.parse(savedContractEnd));
      const savedFareConfig = localStorage.getItem(`torikoko:fareConfig:${user.id}`);
      if (savedFareConfig) setFareConfig(JSON.parse(savedFareConfig));
      const savedBentoPriceMap = loadBentoPriceMapFromStorage(user.id);
      if (Object.keys(savedBentoPriceMap).length > 0) setBentoPriceByLocation(savedBentoPriceMap);
      const savedExtras = localStorage.getItem(`torikoko:extras:${user.id}`);
      if (savedExtras) setExtras(JSON.parse(savedExtras));
      extrasLoadedRef.current = true;
    } catch { /* ignore */ }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(`torikoko:overrides:${user.id}`, JSON.stringify(employeeOverrides)); } catch { }
  }, [user, employeeOverrides]);
  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(`torikoko:ruleModes:${user.id}`, JSON.stringify(ruleModeByLocation)); } catch { }
  }, [user, ruleModeByLocation]);
  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(`torikoko:employeeLoc:${user.id}`, JSON.stringify(employeeLocation)); } catch { }
  }, [user, employeeLocation]);
  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(`torikoko:contractStart:${user.id}`, JSON.stringify(contractStartByName)); } catch { }
  }, [user, contractStartByName]);
  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(`torikoko:contractEnd:${user.id}`, JSON.stringify(contractEndByName)); } catch { }
  }, [user, contractEndByName]);
  useEffect(() => {
    if (!user) return;
    if (!attendanceShiftLoadedRef.current) return;
    replaceAttendanceShiftsPeriodInStorage(user.id, allData, year, month);
  }, [user, allData, year, month]);
  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(`torikoko:fareConfig:${user.id}`, JSON.stringify(fareConfig)); } catch { }
  }, [user, fareConfig]);
  useEffect(() => {
    if (!user) return;
    saveBentoPriceMapToStorage(user.id, bentoPriceByLocation);
  }, [user, bentoPriceByLocation]);
  useEffect(() => {
    if (!user) return;
    if (!extrasLoadedRef.current) return;
    try { localStorage.setItem(`torikoko:extras:${user.id}`, JSON.stringify(extras)); } catch { }
  }, [user, extras]);

  // ── セッション確認 ──
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (data?.user) setUser(data.user);
    })();
  }, []);

  // ── データ読み込み ──
  useEffect(() => {
    if (!user) return;
    let alive = true;
    attendanceShiftLoadedRef.current = false;
    (async () => {
      try {
        setLoading(true);
        const prevPeriod = getPreviousPeriod(year, month);
        const localBento = loadBentoChecksFromStorage(user.id);
        const localBentoPriceMap = loadBentoPriceMapFromStorage(user.id);
        const localShiftMap = loadAttendanceShiftsFromStorage(user.id);
        const [att, prevAtt, st, rulesResult, bentoResult, appSettings] = await Promise.all([
          dbLoadAttendance(user.id, year, month),
          dbLoadAttendance(user.id, prevPeriod.year, prevPeriod.month),
          dbLoadSettings(user.id),
          dbLoadWorkRules(user.id),
          dbLoadBentoChecks(user.id, year, month)
            .then((data) => ({ data, error: null }))
            .catch((error) => ({ data: null, error })),
          dbLoadAppSettings(user.id),
        ]);
        if (!alive) return;
        const mergedBentoPriceMap = normalizeBentoPriceMap({
          ...localBentoPriceMap,
          ...(appSettings?.bentoPriceByLocation || {}),
        });
        const getInitialBentoPriceForLocation = (locationName) => {
          const normalized = normalizeLocation(locationName);
          if (normalized && Object.prototype.hasOwnProperty.call(mergedBentoPriceMap, normalized)) {
            return mergedBentoPriceMap[normalized];
          }
          if (Object.prototype.hasOwnProperty.call(mergedBentoPriceMap, LEGACY_SHARED_BENTO_PRICE_KEY)) {
            return mergedBentoPriceMap[LEGACY_SHARED_BENTO_PRICE_KEY];
          }
          return DEFAULT_BENTO_PRICE_PER_MEAL;
        };
        const mergedAttendance = mergeAttendanceShiftMap(att, localShiftMap, year, month);
        const mergedPrevAttendance = mergeAttendanceShiftMap(prevAtt, localShiftMap, prevPeriod.year, prevPeriod.month);
        const mergedBento = mergeBentoChecks(
          bentoResult.data || {},
          localBento || {},
          year,
          month,
          (name) => getInitialBentoPriceForLocation(st.location?.[name] || DEFAULT_WORK_RULE.locationName)
        );
        const knownNames = Array.from(new Set([
          ...Object.keys(mergedAttendance || {}),
          ...(st.registeredNames || []),
          ...Object.keys(st.fare || {}),
          ...Object.keys(st.paid || {}),
          ...Object.keys(st.employment || {}),
          ...Object.keys(st.monthly || {}),
          ...Object.keys(st.location || {}),
          ...Object.keys(st.contractStart || {}),
          ...Object.keys(st.contractEnd || {}),
          ...Object.keys(st.fareConfig || {}),
          ...Object.keys(st.employeeOverrides || {}),
          ...Object.keys(st.extras || {}),
        ])).filter(Boolean);
        const knownLocations = Array.from(new Set([
          ...Object.keys(rulesResult.rulesByLocation || {}),
          ...DEFAULT_LOCATIONS,
        ])).filter(Boolean);
        // employee_settings登録済み全スタッフをallDataにマージ（勤怠データなしの月でも表示）
        // DBからのregisteredNames ＋ 既存のregisteredNamesステート（フォールバック）の両方を使用
        setAllData((prevAllData) => {
          const merged = { ...mergedAttendance };
          // DBから取得した登録名
          for (const n of (st.registeredNames || [])) {
            if (!merged[n]) merged[n] = {};
          }
          // 前回ロード済みのregisteredNamesも保持（月切替時のフォールバック）
          for (const n of Object.keys(prevAllData)) {
            if (!merged[n]) merged[n] = {};
          }
          return merged;
        });
        setPrevAllData(mergedPrevAttendance);
        const useStorageOnly = !!(bentoResult.error && isMissingRelationErr(bentoResult.error, "bento_checks"));
        setBentoStorageOnly(useStorageOnly);
        setBentoChecksByName(mergedBento);
        replaceBentoChecksPeriodInStorage(user.id, mergedBento, year, month);
        if (!useStorageOnly && bentoResult.data) {
          const missingFromDb = [];
          Object.entries(mergedBento).forEach(([name, byDate]) => {
            Object.entries(byDate || {}).forEach(([dateStr, unitPrice]) => {
              const currentDbValue = bentoResult.data?.[name]?.[dateStr];
              const fallbackPrice = getInitialBentoPriceForLocation(st.location?.[name] || DEFAULT_WORK_RULE.locationName);
              const needsBackfill = !isBentoCheckedValue(currentDbValue) || getBentoUnitPrice(currentDbValue, fallbackPrice) <= 0;
              if (needsBackfill) missingFromDb.push({ name, dateStr, unitPrice });
            });
          });
          if (missingFromDb.length > 0 && alive) {
            Promise.allSettled(missingFromDb.map(({ name, dateStr, unitPrice }) => dbUpsertBentoCheck(user.id, name, dateStr, unitPrice))).catch(() => {});
          }
        }
        setFareSettings(st.fare);
        setPaidLeaveSettings(st.paid);
        setEmploymentSettings(st.employment);
        setMonthlySalarySettings(st.monthly);
        setContractStartByName((prev) => ({ ...filterRecordByKeys(prev, knownNames), ...(st.contractStart || {}) }));
        setContractEndByName((prev) => ({ ...filterRecordByKeys(prev, knownNames), ...(st.contractEnd || {}) }));
        setFareConfig((prev) => ({ ...filterRecordByKeys(prev, knownNames), ...(st.fareConfig || {}) }));
        setEmployeeOverrides((prev) => ({ ...filterRecordByKeys(prev, knownNames), ...(st.employeeOverrides || {}) }));
        setBentoPriceByLocation((prev) => normalizeBentoPriceMap({
          ...filterRecordByKeys(prev, [...knownLocations, LEGACY_SHARED_BENTO_PRICE_KEY]),
          ...mergedBentoPriceMap,
        }));
        setRetiredSettings(st.retired || {});
        setRegisteredNames(st.registeredNames || []);
        // DB の extras を localStorage とマージ（DB優先）
        setExtras((prev) => ({ ...filterRecordByKeys(prev, knownNames), ...(st.extras || {}) }));
        extrasLoadedRef.current = true;
        // 所属店舗は DB を正としてマージする。
        // 以前の localStorage が残っていても、DB に保存済みの店舗で上書きする。
        setEmployeeLocation((prev) => {
          const merged = filterRecordByKeys(prev, knownNames);
          // DB の値があれば常に優先
          for (const [n, loc] of Object.entries(st.location || {})) {
            merged[n] = loc;
          }
          // localStorage にあって DB にない → DB に同期（location 列がない場合は無視）
          const toSync = (st.registeredNames || []).filter((n) => !st.location?.[n] && merged[n]);
          if (toSync.length > 0 && alive) {
            Promise.allSettled(toSync.map((n) =>
              dbUpsertSettings(
                user.id,
                n,
                st.fare?.[n] ?? 0,
                st.paid?.[n] ?? 0,
                st.employment?.[n] ?? DEFAULT_EMPLOYMENT_TYPE,
                st.monthly?.[n] ?? 0,
                {
                  location: merged[n],
                  contractStart: st.contractStart?.[n] || "",
                  contractEnd: st.contractEnd?.[n] || "",
                  fareConfig: st.fareConfig?.[n] || {},
                  overrideRule: st.employeeOverrides?.[n] || null,
                }
              )
            )).catch(() => {});
          }
          return merged;
        });
        setWorkRulesByLocation(rulesResult.rulesByLocation);
        setRuleModeByLocation((prev) => ({ ...filterRecordByKeys(prev, knownLocations), ...(rulesResult.ruleModesByLocation || {}) }));
        // DBに店舗データが無い場合は3店舗をデフォルト保存
        if (Object.keys(rulesResult.rulesByLocation).length === 0 || !rulesResult.warning) {
          const defaults = defaultRulesMap();
          const missing = Object.values(defaults).filter((r) => !rulesResult.rulesByLocation[r.locationName]);
          if (missing.length > 0) {
            await Promise.allSettled(missing.map((r) => dbUpsertWorkRule(user.id, r)));
            const merged = { ...rulesResult.rulesByLocation, ...Object.fromEntries(missing.map((r) => [r.locationName, r])) };
            if (alive) setWorkRulesByLocation(merged);
          }
        }
        const firstLoc = Object.keys(rulesResult.rulesByLocation)[0] || DEFAULT_WORK_RULE.locationName;
        setActiveLocation((prev) => rulesResult.rulesByLocation[prev] ? prev : firstLoc);
        if (rulesResult.warning) showToast(rulesResult.warning, "err");
        if (bentoResult.error && !isMissingRelationErr(bentoResult.error, "bento_checks")) {
          showToast(`お弁当保存読込エラー: ${bentoResult.error.message}`, "err");
        }
        const first = Object.keys(mergedAttendance)[0] || (st.registeredNames || [])[0] || Object.keys(st.fare)[0] || "";
        setActiveName((prev) => prev || first);
        attendanceShiftLoadedRef.current = true;
      } catch (e) {
        if (alive) showToast(`読込エラー: ${e.message}`, "err");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [user, year, month]);

  // ── 店舗切替時：その店舗のメンバーに activeName をリセット ──
  useEffect(() => {
    setActiveName((prev) => {
      const getAssignedLocation = (name) => normalizeLocation(employeeLocation[name]) || DEFAULT_WORK_RULE.locationName;
      if (prev && getAssignedLocation(prev) === activeLocation) return prev;
      const firstOfLocation = allNames.find((name) => getAssignedLocation(name) === activeLocation);
      return firstOfLocation || "";
    });
  }, [activeLocation, allNames, employeeLocation]);

  const logout = async () => {
    await supabase.auth.signOut();
    attendanceShiftLoadedRef.current = false;
    extrasLoadedRef.current = false;
    setUser(null); setAllData({}); setPrevAllData({}); setFareSettings({}); setPaidLeaveSettings({});
    setEmploymentSettings({}); setMonthlySalarySettings({}); setEmployeeOverrides({}); setActiveName("");
    setContractStartByName({}); setContractEndByName({}); setFareConfig({}); setExtras({});
    setEmployeeLocation({}); setRuleModeByLocation({}); setRetiredSettings({}); setRegisteredNames([]);
    setBentoChecksByName({}); setBentoStorageOnly(false);
    setBentoPriceByLocation({ [LEGACY_SHARED_BENTO_PRICE_KEY]: DEFAULT_BENTO_PRICE_PER_MEAL }); setSaveBusy(false); setLastSavedAt("");
    setWorkRulesByLocation(defaultRulesMap());
  };

  // ── 店舗ルール操作 ──
  const updateWorkRule = useCallback(async (patch) => {
    if (!user) return;
    const current = sanitizeRule(workRulesByLocation[activeLocation] || { ...DEFAULT_WORK_RULE, locationName: activeLocation });
    // 休憩閾値（時間単位）の変換
    const converted = { ...patch };
    if ("breakThresholdMinutesFullTime_h" in patch)
      converted.breakThresholdMinutesFullTime = Math.max(0, Math.round((Number(patch.breakThresholdMinutesFullTime_h) || 0) * 60));
    if ("breakThresholdMinutesPartTime_h" in patch)
      converted.breakThresholdMinutesPartTime = Math.max(0, Math.round((Number(patch.breakThresholdMinutesPartTime_h) || 0) * 60));
    delete converted.breakThresholdMinutesFullTime_h;
    delete converted.breakThresholdMinutesPartTime_h;

    const next = sanitizeRule({ ...current, ...converted, locationName: activeLocation });
    setWorkRulesByLocation((prev) => ({ ...prev, [activeLocation]: next }));
    try { await dbUpsertWorkRule(user.id, { ...next, ruleMode: activeRuleMode }); } catch (e) { showToast(`ルール保存エラー: ${e.message}`, "err"); }
  }, [user, activeLocation, workRulesByLocation, activeRuleMode]);

  const updateRuleMode = useCallback(async (locationName, mode) => {
    const normalizedMode = normalizeRuleMode(mode);
    setRuleModeByLocation((prev) => ({ ...prev, [locationName]: normalizedMode }));
    if (!user) return;
    try {
      const rule = sanitizeRule(workRulesByLocation[locationName] || { ...DEFAULT_WORK_RULE, locationName });
      await dbUpsertWorkRule(user.id, { ...rule, locationName, ruleMode: normalizedMode });
    } catch (e) {
      showToast(`設定保存エラー: ${e.message}`, "err");
    }
  }, [user, workRulesByLocation]);

  const addLocation = useCallback(async () => {
    if (!user) return;
    const input = prompt("店舗名を入力してください（例：天神店）");
    const loc = normalizeLocation(input);
    if (!loc) return;
    if (Object.keys(workRulesByLocation).some((l) => normalizeLocation(l).toLowerCase() === loc.toLowerCase())) {
      showToast("同じ名前の店舗が既にあります", "err"); return;
    }
    const next = sanitizeRule({ ...activeWorkRule, locationName: loc });
    setWorkRulesByLocation((prev) => ({ ...prev, [loc]: next }));
    setActiveLocation(loc);
    try { await dbUpsertWorkRule(user.id, next); } catch (e) { showToast(`店舗追加エラー: ${e.message}`, "err"); }
  }, [user, workRulesByLocation, activeWorkRule]);

  const removeLocation = useCallback(async () => {
    if (!user) return;
    if (locationNames.length <= 1) { showToast("店舗ルールは1件以上必要です", "err"); return; }
    if (!window.confirm(`「${activeLocation}」の店舗ルールを削除しますか？`)) return;
    const next = { ...workRulesByLocation }; delete next[activeLocation];
    const fallback = Object.keys(next)[0] || DEFAULT_WORK_RULE.locationName;
    const affectedNames = Array.from(new Set([...Object.keys(allData), ...registeredNames]))
      .filter((name) => (normalizeLocation(employeeLocation[name]) || DEFAULT_WORK_RULE.locationName) === activeLocation);
    setWorkRulesByLocation(next);
    setRuleModeByLocation((prev) => {
      const updated = { ...prev };
      delete updated[activeLocation];
      return updated;
    });
    setEmployeeLocation((prev) => {
      const updated = { ...prev };
      affectedNames.forEach((name) => { updated[name] = fallback; });
      return updated;
    });
    setActiveLocation(fallback);
    try {
      const locationResults = await Promise.allSettled(
        affectedNames.map((name) => dbUpsertSettings(
          user.id,
          name,
          fareSettings[name] ?? 0,
          paidLeaveSettings[name] ?? 0,
          employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE,
          monthlySalarySettings[name] ?? 0,
          buildEmployeeSettingOptions(name, { location: fallback })
        ))
      );
      await dbDeleteWorkRule(user.id, activeLocation);
      const failed = locationResults.filter((r) => r.status === "rejected").length;
      if (failed > 0) showToast(`所属店舗の再保存で${failed}件失敗しました`, "err");
    } catch (e) { showToast(`削除エラー: ${e.message}`, "err"); }
  }, [user, workRulesByLocation, locationNames, activeLocation, allData, registeredNames, employeeLocation, fareSettings, paidLeaveSettings, employmentSettings, monthlySalarySettings, buildEmployeeSettingOptions]);

  // ── 勤怠データ更新 ──
  const handleUpdate = useCallback(async (name, dateStrOrField, entryOrVal) => {
    if (!user) return;
    try {
      if (dateStrOrField === "__fare__") {
        const val = entryOrVal ?? 0;
        setFareSettings((prev) => ({ ...prev, [name]: val }));
        await dbUpsertSettings(user.id, name, val, paidLeaveSettings[name] ?? 0, employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE, monthlySalarySettings[name] ?? 0, buildEmployeeSettingOptions(name));
        return;
      }
      if (dateStrOrField === "__paid__") {
        const val = entryOrVal ?? 0;
        setPaidLeaveSettings((prev) => ({ ...prev, [name]: val }));
        await dbUpsertSettings(user.id, name, fareSettings[name] ?? 0, val, employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE, monthlySalarySettings[name] ?? 0, buildEmployeeSettingOptions(name));
        return;
      }
      if (dateStrOrField === "__monthly__") {
        const val = entryOrVal ?? 0;
        setMonthlySalarySettings((prev) => ({ ...prev, [name]: val }));
        await dbUpsertSettings(user.id, name, fareSettings[name] ?? 0, paidLeaveSettings[name] ?? 0, employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE, val, buildEmployeeSettingOptions(name));
        return;
      }
      if (dateStrOrField === "__bento_price__") {
        const nextPrice = Math.max(0, Number(entryOrVal) || 0);
        const locationName = getLocationForName(name) || activeLocation;
        setBentoPriceByLocation((prev) => ({ ...prev, [locationName]: nextPrice }));
        await dbUpsertAppSettings(user.id, locationName, { bentoPricePerMeal: nextPrice });
        return;
      }
      const dateStr = dateStrOrField;
      if (entryOrVal === null) {
        setAllData((prev) => { const n = { ...prev }; n[name] = { ...n[name] }; delete n[name][dateStr]; return n; });
        await dbDeleteAttendance(user.id, name, dateStr);
      } else {
        setAllData((prev) => ({ ...prev, [name]: { ...(prev[name] || {}), [dateStr]: entryOrVal } }));
        await dbUpsertAttendance(user.id, name, dateStr, entryOrVal);
      }
    } catch (e) {
      showToast(`保存エラー: ${e.message}`, "err");
    }
  }, [user, fareSettings, paidLeaveSettings, employmentSettings, monthlySalarySettings, buildEmployeeSettingOptions, getLocationForName, activeLocation]);

  const updateEmploymentType = useCallback(async (name, type) => {
    if (!user) return;
    const normalized = normalizeEmployment(type);
    if (!confirmSettingSave(`${name} の雇用区分を「${normalized}」で保存します。`)) return;
    setEmploymentSettings((prev) => ({ ...prev, [name]: normalized }));
    try { await dbUpsertSettings(user.id, name, fareSettings[name] ?? 0, paidLeaveSettings[name] ?? 0, normalized, monthlySalarySettings[name] ?? 0, buildEmployeeSettingOptions(name)); }
    catch (e) { showToast(`保存エラー: ${e.message}`, "err"); }
  }, [user, fareSettings, paidLeaveSettings, monthlySalarySettings, confirmSettingSave, buildEmployeeSettingOptions]);

  // ── スタッフ管理用コールバック ──
  const saveEmployeeLocation = useCallback(async (name, loc, options = {}) => {
    const normalizedLoc = normalizeLocation(loc) || DEFAULT_WORK_RULE.locationName;
    if (options.confirm !== false && !confirmSettingSave(`${name} の所属店舗を「${normalizedLoc}」で保存します。`)) return;
    setEmployeeLocation((p) => {
      const next = { ...p, [name]: normalizedLoc };
      try {
        if (user?.id) localStorage.setItem(`torikoko:employeeLoc:${user.id}`, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
    setRegisteredNames((prev) => (prev.includes(name) ? prev : [...prev, name].sort((a, b) => a.localeCompare(b, "ja"))));
    setActiveLocation(normalizedLoc);
    setActiveName(name);
    try {
      await dbUpsertSettings(
        user.id,
        name,
        fareSettings[name] ?? 0,
        paidLeaveSettings[name] ?? 0,
        employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE,
        monthlySalarySettings[name] ?? 0,
        buildEmployeeSettingOptions(name, { location: normalizedLoc })
      );
      if (options.notice !== false) showToast(`${name} → ${normalizedLoc} に変更しました ✓`);
    } catch (e) {
      showToast(e.message, "err");
    }
  }, [user, fareSettings, paidLeaveSettings, employmentSettings, monthlySalarySettings, confirmSettingSave, buildEmployeeSettingOptions]);
  const staffUpdateLocation = useCallback(async (name, loc) => {
    await saveEmployeeLocation(name, loc);
  }, [saveEmployeeLocation]);
  const staffSave = (name) => {
    showToast(`${name} を保存しました ✓`);
  };

  const updateFareConfig = useCallback((name, cfg) => {
    setFareConfig((p) => ({ ...p, [name]: cfg }));
  }, []);

  const updateExtras = useCallback((name, list) => {
    setExtras((p) => ({ ...p, [name]: list }));
    if (user) dbUpsertPersonExtras(user.id, name, list).catch(() => {});
  }, [user]);

  const saveAllNow = useCallback(async () => {
    if (!user || saveBusy) return;
    setSaveBusy(true);
    try {
      try {
        localStorage.setItem(`torikoko:overrides:${user.id}`, JSON.stringify(employeeOverrides));
        localStorage.setItem(`torikoko:ruleModes:${user.id}`, JSON.stringify(ruleModeByLocation));
        localStorage.setItem(`torikoko:employeeLoc:${user.id}`, JSON.stringify(employeeLocation));
        localStorage.setItem(`torikoko:contractStart:${user.id}`, JSON.stringify(contractStartByName));
        localStorage.setItem(`torikoko:contractEnd:${user.id}`, JSON.stringify(contractEndByName));
        localStorage.setItem(`torikoko:fareConfig:${user.id}`, JSON.stringify(fareConfig));
        saveBentoPriceMapToStorage(user.id, bentoPriceByLocation);
        localStorage.setItem(`torikoko:extras:${user.id}`, JSON.stringify(extras));
      } catch {
        // ignore browser storage issues
      }
      replaceAttendanceShiftsPeriodInStorage(user.id, allData, year, month);
      replaceBentoChecksPeriodInStorage(user.id, bentoChecksByName, year, month);

      const namesToSave = Array.from(new Set([
        ...registeredNames,
        ...Object.keys(allData || {}),
        ...Object.keys(fareSettings || {}),
        ...Object.keys(paidLeaveSettings || {}),
        ...Object.keys(monthlySalarySettings || {}),
        ...Object.keys(employmentSettings || {}),
        ...Object.keys(employeeLocation || {}),
        ...Object.keys(contractStartByName || {}),
        ...Object.keys(contractEndByName || {}),
        ...Object.keys(extras || {}),
      ])).filter(Boolean);

      const settingsOps = namesToSave.map((name) =>
        dbUpsertSettings(
          user.id,
          name,
          fareSettings[name] ?? 0,
          paidLeaveSettings[name] ?? 0,
          employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE,
          monthlySalarySettings[name] ?? 0,
          buildEmployeeSettingOptions(name, {
            location: employeeLocation[name] || DEFAULT_WORK_RULE.locationName,
            contractStart: contractStartByName[name] || "",
            contractEnd: contractEndByName[name] || "",
          })
        )
      );
      const extrasOps = namesToSave.map((name) => dbUpsertPersonExtras(user.id, name, extras[name] || []));
      const ruleOps = Object.values(workRulesByLocation || {}).map((rule) => dbUpsertWorkRule(user.id, {
        ...rule,
        ruleMode: normalizeRuleMode(ruleModeByLocation[rule.locationName]),
      }));
      const appSettingOps = locationNames.map((locationName) =>
        dbUpsertAppSettings(user.id, locationName, { bentoPricePerMeal: getBentoPriceForLocation(locationName) })
      );

      const { start, end } = getPeriodRange(year, month);
      const attendanceOps = [];
      Object.entries(allData || {}).forEach(([name, byDate]) => {
        Object.entries(byDate || {}).forEach(([dateStr, entry]) => {
          if (dateStr < start || dateStr > end) return;
          const normalized = normalizeAttendanceEntry(entry || {});
          if (!normalized.status && !normalized.start && !normalized.end && !normalized.rawStart && !normalized.rawEnd && !normalized.shiftType) return;
          attendanceOps.push(dbUpsertAttendance(user.id, name, dateStr, normalized));
        });
      });

      const bentoOps = [];
      Object.entries(bentoChecksByName || {}).forEach(([name, byDate]) => {
        Object.entries(byDate || {}).forEach(([dateStr, value]) => {
          const unitPrice = getBentoUnitPrice(value, getBentoPriceForName(name));
          if (unitPrice <= 0) return;
          if (dateStr < start || dateStr > end) return;
          bentoOps.push(dbUpsertBentoCheck(user.id, name, dateStr, unitPrice));
        });
      });

      const results = await Promise.allSettled([
        ...settingsOps,
        ...extrasOps,
        ...ruleOps,
        ...appSettingOps,
        ...attendanceOps,
        ...bentoOps,
      ]);
      const failed = results.filter((r) => r.status === "rejected").length;
      const stamp = saveStamp();
      setLastSavedAt(stamp);
      if (failed > 0) {
        showToast(`保存は完了しましたが ${failed} 件失敗しました`, "err");
      } else {
        showToast(`保存しました ✓ ${stamp}`);
      }
    } catch (e) {
      showToast(`保存エラー: ${e.message}`, "err");
    } finally {
      setSaveBusy(false);
    }
  }, [
    user, saveBusy, employeeOverrides, ruleModeByLocation, employeeLocation,
    contractStartByName, contractEndByName, fareConfig, bentoPriceByLocation, extras,
    allData, year, month, registeredNames, fareSettings, paidLeaveSettings,
    monthlySalarySettings, employmentSettings, workRulesByLocation, bentoChecksByName,
    buildEmployeeSettingOptions, locationNames, getBentoPriceForLocation, getBentoPriceForName
  ]);

  const retireStaff = async (name) => {
    const today = getLocalToday();
    if (!window.confirm(`「${name}」を退職者として登録しますか？\n退職日：${today}`)) return;
    try {
      await dbSetRetired(user.id, name, true, today);
      setRetiredSettings((p) => ({ ...p, [name]: { isRetired: true, retiredAt: today } }));
      setActiveName((prev) => prev === name ? "" : prev);
      showToast(`「${name}」を退職登録しました`);
    } catch (e) { showToast(e.message, "err"); }
  };

  const reinstateStaff = async (name) => {
    if (!window.confirm(`「${name}」を現役スタッフに戻しますか？`)) return;
    try {
      await dbSetRetired(user.id, name, false, "");
      setRetiredSettings((p) => ({ ...p, [name]: { isRetired: false, retiredAt: "" } }));
      showToast(`「${name}」を復職しました`);
    } catch (e) { showToast(e.message, "err"); }
  };
  const staffUpdateFare = useCallback(async (name, val) => {
    if (!user) return;
    setFareSettings((p) => ({ ...p, [name]: val }));
    try { await dbUpsertSettings(user.id, name, val, paidLeaveSettings[name] ?? 0, employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE, monthlySalarySettings[name] ?? 0, buildEmployeeSettingOptions(name)); }
    catch (e) { showToast(`保存エラー: ${e.message}`, "err"); }
  }, [user, paidLeaveSettings, employmentSettings, monthlySalarySettings, buildEmployeeSettingOptions]);
  const staffUpdatePaid = useCallback(async (name, val) => {
    if (!user) return;
    setPaidLeaveSettings((p) => ({ ...p, [name]: val }));
    try { await dbUpsertSettings(user.id, name, fareSettings[name] ?? 0, val, employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE, monthlySalarySettings[name] ?? 0, buildEmployeeSettingOptions(name)); }
    catch (e) { showToast(`保存エラー: ${e.message}`, "err"); }
  }, [user, fareSettings, employmentSettings, monthlySalarySettings, buildEmployeeSettingOptions]);
  const staffUpdateMonthly = useCallback(async (name, val) => {
    if (!user) return;
    setMonthlySalarySettings((p) => ({ ...p, [name]: val }));
    try { await dbUpsertSettings(user.id, name, fareSettings[name] ?? 0, paidLeaveSettings[name] ?? 0, employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE, val, buildEmployeeSettingOptions(name)); }
    catch (e) { showToast(`保存エラー: ${e.message}`, "err"); }
  }, [user, fareSettings, paidLeaveSettings, employmentSettings, buildEmployeeSettingOptions]);
  const onFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target.result;
      const decodeTry = (encoding) => {
        try {
          const txt = new TextDecoder(encoding, { fatal: false }).decode(buffer);
          const parsed = parseRecoruCSV(txt, activeWorkRule);
          const nameCount = Object.keys(parsed.byName || {}).length;
          return { encoding, ...parsed, nameCount };
        } catch {
          return null;
        }
      };
      const candidates = [decodeTry("shift-jis"), decodeTry("utf-8")].filter(Boolean);
      const best = candidates.sort((a, b) =>
        (b.importedCount || 0) - (a.importedCount || 0)
        || (b.nameCount || 0) - (a.nameCount || 0)
      )[0];
      const byName = best?.byName || {};
      const locationByName = best?.locationByName || {};
      if (!Object.keys(byName).length) { showToast("CSVにデータがありません", "err"); return; }
      const allKeys = new Set();
      Object.entries(byName).forEach(([n, rows]) => rows.forEach((r) => allKeys.add(n + "|" + r.dateStr)));
      // 店舗を自動振り分け：CSV列 > 既存設定 > 現在の店舗 の優先順
      const nameLocations = {};
      Object.keys(byName).forEach((n) => {
        const fromCSV = matchStoreFromCSVLocation(locationByName[n], locationNames);
        const fromSaved = normalizeLocation(employeeLocation[n]);

        // 基本の判定
        let detectedLoc = fromCSV || (fromSaved && locationNames.includes(fromSaved) ? fromSaved : null) || activeLocation;

        // 個別ルール
        if (byName[n] && byName[n].length > 0) {
          const firstDateStr = byName[n][0].dateStr;
          const dateObj = new Date(firstDateStr);
          const dayOfWeek = dateObj.getDay();
          const isHoliday = !!HOLIDAYS[firstDateStr];

          if (n === "吉田健志") {
            detectedLoc = (dayOfWeek === 3) ? "Lien" : "Ties";
          }
          else if (n === "古山美菜子") {
            detectedLoc = (isHoliday || dayOfWeek === 6) ? "Ties" : "Lien";
          }
        }
        nameLocations[n] = detectedLoc;
      });
      setPreview({ byName, selKeys: allKeys, nameLocations, csvLocations: locationByName, parseMeta: best });
      const delimLabel = best?.delimiter === "\t" ? "TAB" : (best?.delimiter || ",");
      showToast(`れこるCSVを解析: ${best.importedCount}件/${best.nameCount}名 (${best.encoding}, 区切り:${delimLabel})`);
    };
    reader.readAsArrayBuffer(file); e.target.value = "";
  };

  // ── お弁当Excel読み込み（XLSX/XLSM, 店舗自動判定） ──
  const onBentoFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const { byName, locationByName, pricePerMeal, facilityRaw, usedSheet, usedSheets } = parseBentoXLSX(ev.target.result, year, month);
        const importedNames = Object.keys(byName || {});
        if (!importedNames.length) { showToast("お弁当データが見つかりませんでした", "err"); return; }
        const { start: periodStart, end: periodEnd } = getPeriodRange(year, month);

        // 氏名ゆれ（空白あり/なし）を吸収して既存の氏名に寄せる
        const existingNameMap = new Map();
        allNames.forEach((n) => existingNameMap.set(normalizePersonName(n), n));
        const resolvedByName = {};
        const resolvedLocByName = {};
        importedNames.forEach((rawName) => {
          const resolvedName = existingNameMap.get(normalizePersonName(rawName)) || rawName;
          const resolvedLocation =
            detectLocationFromFacility(locationByName?.[rawName], locationNames)
            || normalizeLocation(employeeLocation[resolvedName])
            || activeLocation;
          const resolvedPrice = Math.max(0, Number(pricePerMeal) || getBentoPriceForLocation(resolvedLocation));
          const periodFiltered = {};
          Object.entries(byName[rawName] || {}).forEach(([dateStr, checked]) => {
            if (!checked) return;
            if (dateStr >= periodStart && dateStr <= periodEnd) periodFiltered[dateStr] = resolvedPrice;
          });
          if (!Object.keys(periodFiltered).length) return;
          resolvedByName[resolvedName] = { ...(resolvedByName[resolvedName] || {}), ...periodFiltered };
          const rawLoc = locationByName?.[rawName];
          if (rawLoc && !resolvedLocByName[resolvedName]) resolvedLocByName[resolvedName] = rawLoc;
        });

        const targetNames = Object.keys(resolvedByName);
        if (!targetNames.length) {
          showToast(`お弁当データは見つかりましたが、選択期間（${periodStart}〜${periodEnd}）内のチェックがありません`, "err");
          return;
        }

        const importOps = [];
        let mergedBentoChecks = {};
        setBentoChecksByName((prev) => {
          const next = { ...prev };
          targetNames.forEach((name) => {
            next[name] = { ...(next[name] || {}), ...(resolvedByName[name] || {}) };
            Object.keys(resolvedByName[name] || {}).forEach((dateStr) => {
              importOps.push({ name, dateStr });
            });
          });
          mergedBentoChecks = next;
          replaceBentoChecksPeriodInStorage(user?.id, next, year, month);
          return next;
        });

        if (importOps.length) {
          const results = await Promise.allSettled(
            importOps.map(({ name, dateStr }) => dbUpsertBentoCheck(
              user?.id,
              name,
              dateStr,
              resolvedByName?.[name]?.[dateStr] || getBentoPriceForName(name)
            ))
          );
          const hasMissingTable = results.some((r) => r.status === "rejected" && isMissingRelationErr(r.reason, "bento_checks"));
          if (hasMissingTable) {
            setBentoStorageOnly(true);
            replaceBentoChecksPeriodInStorage(user?.id, mergedBentoChecks, year, month);
          }
          const failed = results.filter((r) => r.status === "rejected" && !isMissingRelationErr(r.reason, "bento_checks")).length;
          if (failed > 0) {
            showToast(`お弁当保存で${failed}件失敗しました`, "err");
          }
        }

        if (pricePerMeal > 0) {
          const targetLocations = Array.from(new Set(
            targetNames.map((name) =>
              detectLocationFromFacility(resolvedLocByName[name], locationNames)
              || normalizeLocation(employeeLocation[name])
              || activeLocation
            ).filter(Boolean)
          ));
          setBentoPriceByLocation((prev) => {
            const next = { ...prev };
            targetLocations.forEach((locationName) => { next[locationName] = pricePerMeal; });
            return next;
          });
          if (user?.id) {
            Promise.allSettled(
              targetLocations.map((locationName) => dbUpsertAppSettings(user.id, locationName, { bentoPricePerMeal: pricePerMeal }))
            ).catch(() => {});
          }
        }

        const total = targetNames.reduce((s, n) => s + Object.keys(resolvedByName[n] || {}).length, 0);
        const sheetLabel = usedSheets?.length > 1 ? `シート${usedSheets.length}枚` : `シート「${usedSheet}」`;
        const detectedLocs = new Set(
          Object.values(resolvedLocByName)
            .map((raw) => detectLocationFromFacility(raw, locationNames))
            .filter(Boolean)
        );
        const locLabel = detectedLocs.size ? `【${Array.from(detectedLocs).join(" / ")}】` : (facilityRaw ? `【${facilityRaw}】` : "【店舗不明】");
        showToast(`🍱 ${sheetLabel} ${locLabel} ${targetNames.length}名・${total}食を取り込みました（${periodStart}〜${periodEnd}）`);
      } catch (err) {
        showToast(`お弁当読込エラー: ${err.message}`, "err");
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const toggleSelKey = (k) => setPreview((prev) => {
    const s = new Set(prev.selKeys); s.has(k) ? s.delete(k) : s.add(k);
    return { ...prev, selKeys: s };
  });

  const setPreviewLocation = (name, loc) => setPreview((prev) => ({
    ...prev,
    nameLocations: { ...prev.nameLocations, [name]: loc },
  }));

  const handleToggleBento = useCallback(async (targetName, dateStr) => {
    const fallbackPrice = getBentoPriceForName(targetName);
    const existingPrice = getBentoUnitPrice(bentoChecksByName?.[targetName]?.[dateStr], fallbackPrice);
    const nextChecked = existingPrice <= 0;
    const nextPrice = nextChecked ? Math.max(0, Number(fallbackPrice) || 0) : 0;
    let nextBentoChecks = {};
    setBentoChecksByName((prev) => {
      const next = { ...prev };
      const byDate = { ...(next[targetName] || {}) };
      if (byDate[dateStr]) delete byDate[dateStr];
      else byDate[dateStr] = nextPrice;
      if (Object.keys(byDate).length) next[targetName] = byDate;
      else delete next[targetName];
      nextBentoChecks = next;
      replaceBentoChecksPeriodInStorage(user?.id, next, year, month);
      return next;
    });
    try {
      if (nextChecked) await dbUpsertBentoCheck(user?.id, targetName, dateStr, nextPrice);
      else await dbDeleteBentoCheck(user?.id, targetName, dateStr);
    } catch (e) {
      if (isMissingRelationErr(e, "bento_checks")) {
        setBentoStorageOnly(true);
        replaceBentoChecksPeriodInStorage(user?.id, nextBentoChecks, year, month);
      } else {
        showToast(`お弁当保存エラー: ${e.message}`, "err");
      }
    }
  }, [bentoChecksByName, getBentoPriceForName, user, year, month]);

  const confirmImport = async () => {
    if (!preview || !user) return;
    try {
      setLoading(true);
      setImportFailures(null);
      let count = 0;
      let firstImportedName = "";
      const periodCounts = {};
      const next = { ...allData };
      const operations = [];
      const nextEmployeeLocation = { ...employeeLocation };

      for (const [name, rows] of Object.entries(preview.byName)) {
        if (!next[name]) next[name] = {};
        // プレビューで選択した店舗を設定（既存データがあっても上書き）
        const assignedLoc = preview.nameLocations?.[name] || activeLocation;
        nextEmployeeLocation[name] = assignedLoc;
        const isNewStaff = fareSettings[name] == null;
        // 新規・既存問わず店舗をDBに保存（既存スタッフの店舗変更も反映）
        operations.push({
          kind: "settings",
          name,
          location: assignedLoc,
          promise: dbUpsertSettings(
            user.id, name,
            isNewStaff ? 0 : (fareSettings[name] ?? 0),
            paidLeaveSettings[name] ?? 0,
            employmentSettings[name] ?? DEFAULT_EMPLOYMENT_TYPE,
            isNewStaff ? 0 : (monthlySalarySettings[name] ?? 0),
            buildEmployeeSettingOptions(name, { location: assignedLoc })
          ),
        });
        if (isNewStaff) {
          setFareSettings((p) => ({ ...p, [name]: 0 }));
          setPaidLeaveSettings((p) => ({ ...p, [name]: p[name] ?? 0 }));
          setEmploymentSettings((p) => ({ ...p, [name]: p[name] ?? DEFAULT_EMPLOYMENT_TYPE }));
        }
        for (const row of rows) {
          const k = name + "|" + row.dateStr;
          if (!preview.selKeys.has(k)) continue;
          const existing = normalizeAttendanceEntry(next[name][row.dateStr] || {});
          if (existing.modified) continue;
          const rule = getEffectiveRuleAtLocation(name, assignedLoc);
          const hasActualTime = !!(row.rawStart || row.rawEnd);
          const shouldClearAutoAttendance =
            !hasActualTime &&
            !existing.modified &&
            !existing.rawStart &&
            !existing.rawEnd &&
            !existing.shiftType &&
            (existing.status === "出勤" || existing.start || existing.end);

          if (shouldClearAutoAttendance) {
            delete next[name][row.dateStr];
            operations.push({
              kind: "attendance",
              name,
              dateStr: row.dateStr,
              location: assignedLoc,
              promise: dbDeleteAttendance(user.id, name, row.dateStr),
            });
            continue;
          }

          const nextStatus = existing.status || (hasActualTime ? "出勤" : "");
          const nextShiftType = normalizeShiftType(existing.shiftType) || guessTorikokoShiftType(assignedLoc, row);
          const effectiveRule = applyEntryShiftRule(rule, { ...row, shiftType: nextShiftType });
          const merged = {
            ...existing,
            status: nextStatus,
            shiftType: nextShiftType,
            start:    hasActualTime ? (snapStart(row.rawStart || row.roundedStart, effectiveRule) || "") : "",
            end:      hasActualTime ? (row.roundedEnd || "") : "",
            rawStart: row.rawStart || "", rawEnd: row.rawEnd || "",
          };
          if (!merged.shiftType) delete merged.shiftType;
          const isEmpty = !merged.status && !merged.start && !merged.end && !merged.rawStart && !merged.rawEnd && !merged.shiftType;
          if (isEmpty) continue;
          next[name][row.dateStr] = merged;
          operations.push({
            kind: "attendance",
            name,
            dateStr: row.dateStr,
            location: assignedLoc,
            payload: merged,
            promise: dbUpsertAttendance(user.id, name, row.dateStr, merged),
          });
          count++;
          if (!firstImportedName) firstImportedName = name;
          const p = getPeriodFromDateStr(row.dateStr);
          if (p) {
            const key = `${p.year}-${pad2(p.month)}`;
            periodCounts[key] = (periodCounts[key] || 0) + 1;
          }
        }
      }
      const saveResults = await Promise.allSettled(operations.map((op) => op.promise));
      setEmployeeLocation(nextEmployeeLocation);
      setAllData(next);
      const periodKey = Object.entries(periodCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (periodKey) {
        const [y, m] = periodKey.split("-").map(Number);
        if (y && m) { setYear(y); setMonth(m); }
      }
      if (firstImportedName) setActiveName(firstImportedName);
      setPreview(null);
      const failureItems = saveResults
        .map((result, i) => ({ result, op: operations[i] }))
        .filter(({ result }) => result.status === "rejected")
        .map(({ result, op }) => ({
          kind: op.kind,
          name: op.name,
          dateStr: op.dateStr || "",
          location: op.location || "",
          reason: formatImportError(result.reason),
        }));
      const failed = failureItems.length;
      if (failed > 0) {
        setImportFailures({
          total: failed,
          selectedCount: preview.selKeys.size,
          items: failureItems,
        });
        showToast(`取込は完了しましたが、${failed}件の保存に失敗しました`, "err");
      } else {
        setImportFailures(null);
        showToast(`${count}件を取り込みました ✓`);
      }
    } catch (e) {
      showToast(`取込エラー: ${e.message}`, "err");
    } finally { setLoading(false); }
  };

  const addName = async (n, loc) => {
    if (!user || !n) return;
    const assignLoc = loc || activeLocation;
    setAllData((prev) => prev[n] ? prev : { ...prev, [n]: {} });
    setFareSettings((p) => ({ ...p, [n]: p[n] ?? 0 }));
    setPaidLeaveSettings((p) => ({ ...p, [n]: p[n] ?? 0 }));
    setEmploymentSettings((p) => ({ ...p, [n]: p[n] ?? DEFAULT_EMPLOYMENT_TYPE }));
    setMonthlySalarySettings((p) => ({ ...p, [n]: p[n] ?? 0 }));
    setEmployeeLocation((p) => ({ ...p, [n]: p[n] || assignLoc }));
    setRegisteredNames((p) => (p.includes(n) ? p : [...p, n].sort((a, b) => a.localeCompare(b, "ja"))));
    setActiveName(n);
    try { await dbUpsertSettings(user.id, n, 0, 0, DEFAULT_EMPLOYMENT_TYPE, 0, buildEmployeeSettingOptions(n, { location: assignLoc })); }
    catch (e) { showToast(`追加エラー: ${e.message}`, "err"); }
  };

  const removeName = async (name) => {
    if (!user || !window.confirm(`「${name}」のデータを全て削除しますか？`)) return;
    try {
      setLoading(true);
      await dbDeleteEmployee(user.id, name);
      setAllData((p) => { const n = { ...p }; delete n[name]; return n; });
      setBentoChecksByName((p) => {
        const n = { ...p };
        delete n[name];
        replaceBentoChecksPeriodInStorage(user?.id, n, year, month);
        return n;
      });
      setFareSettings((p) => { const n = { ...p }; delete n[name]; return n; });
      setPaidLeaveSettings((p) => { const n = { ...p }; delete n[name]; return n; });
      setEmploymentSettings((p) => { const n = { ...p }; delete n[name]; return n; });
      setMonthlySalarySettings((p) => { const n = { ...p }; delete n[name]; return n; });
      setEmployeeOverrides((p) => { const n = { ...p }; delete n[name]; return n; });
      setContractStartByName((p) => { const n = { ...p }; delete n[name]; return n; });
      setContractEndByName((p) => { const n = { ...p }; delete n[name]; return n; });
      setFareConfig((p) => { const n = { ...p }; delete n[name]; return n; });
      setExtras((p) => { const n = { ...p }; delete n[name]; return n; });
      setEmployeeLocation((p) => { const n = { ...p }; delete n[name]; return n; });
      setRetiredSettings((p) => { const n = { ...p }; delete n[name]; return n; });
      setRegisteredNames((p) => p.filter((n) => n !== name));
      setActiveName((prev) => prev === name ? (names.find((x) => x !== name) || "") : prev);
      showToast(`「${name}」を削除しました`);
    } catch (e) {
      showToast(`削除エラー: ${e.message}`, "err");
    } finally { setLoading(false); }
  };

  // ── CSV出力 ──
  const buildExportRows = (name) => {
    const entries   = allData[name] || {};
    const rule      = getEffectiveRule(name);
    const empType   = normalizeEmployment(employmentSettings[name]);
    const retiredAt = retiredSettings[name]?.isRetired ? (retiredSettings[name]?.retiredAt || null) : null;
    return getPeriodDays(year, month)
      .filter(({ key: dateStr }) => !retiredAt || dateStr <= retiredAt)
      .map(({ key: dateStr, dow }) => {
        const entry = normalizeAttendanceEntry(entries[dateStr] || {});
        const { effectiveStart, effectiveEnd } = resolveEntryTimes(entry, rule);
        const calc = effectiveStart && effectiveEnd ? calcWork(dateStr, effectiveStart, effectiveEnd, rule, empType, entry) : null;
        const actualMin = entry.rawStart && entry.rawEnd ? calcActualWork(entry.rawStart, entry.rawEnd, rule, empType) : null;
        return { name, dateStr, weekday: WD[dow], status: entry.status || "",
          rawStart: entry.rawStart || "", roundedStart: effectiveStart || "",
          rawEnd: entry.rawEnd || "", roundedEnd: effectiveEnd || "",
          actualWork: actualMin != null ? m2t(actualMin) : "",
          roundedWork: calc ? m2t(calc.workMin) : "", overtime: calc && calc.overtime > 0 ? m2t(calc.overtime) : "",
          breakMin: calc ? String(calc.breakMin) : "", rate: calc ? String(calc.rate) : "",
          wage: calc ? String(calc.wage) : "", modified: entry.modified ? "修" : "" };
      });
  };

  const getExportTarget = () => {
    if (exportScope === "all") {
      if (!exportableNames.length) return { error: "出力できる従業員がいません" };
      return { names: exportableNames, title: `${year}年${month}月_全体`, scopeLabel: "全体" };
    }
    if (exportScope === "name") {
      if (!activeName) return { error: "氏名を選択してください" };
      return { names: [activeName], title: `${year}年${month}月_${activeName}`, scopeLabel: `個別:${activeName}` };
    }
    const storeNames = exportableNames.filter((n) => getLocationForName(n) === activeLocation);
    if (!storeNames.length) return { error: `「${activeLocation}」に従業員がいません` };
    return { names: storeNames, title: `${year}年${month}月_${activeLocation}`, scopeLabel: `店舗:${activeLocation}` };
  };

  const downloadCSV = async () => {
    const target = getExportTarget();
    if (target.error) { showToast(target.error, "err"); return; }
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    // ── ヘッダー（社労士提出用） ──
    const head = [
      "氏名", "雇用区分", "所属店舗",
      "日付", "曜", "勤怠",
      "開始実績", "開始丸め", "終了実績", "終了丸め", "勤務時間(丸め)", "備考",
      "出勤合計日数", "勤務合計時間", "平均勤務時間(1日)",
      "残業合計時間",
      "お弁当回数", "お弁当合計金額(円)",
      "有給取得日数", "有給換算時間", "有給金額(円)",
    ];

    const lines = [head.map(esc).join(",")];

    try {
      setLoading(true);
      target.names.forEach((name) => {
        const entries    = allData[name] || {};
        const rule       = getEffectiveRule(name);
        const empType    = normalizeEmployment(employmentSettings[name]);
        const retiredAt  = retiredSettings[name]?.isRetired ? (retiredSettings[name]?.retiredAt || null) : null;
        const days       = getPeriodDays(year, month).filter(({ key }) => !retiredAt || key <= retiredAt);
        const loc = normalizeLocation(employeeLocation[name]) || "";
        const currentSummary = summarizeCsvExportMetrics(entries, days, rule, empType, loc);
        const paidDays = currentSummary.paidDays;
        const isPartTime = empType === "パート";
        const paidLeaveHours = isPartTime && paidDays > 0 ? formatAverageHours(currentSummary.avgDailyMin) : "";

        let paidLeaveAmount = "";
        if (isPartTime && paidDays > 0) {
          const avgHours = currentSummary.avgDailyMin / 60;
          const rate = rule.hourlyNormal;
          paidLeaveAmount = Math.round(avgHours * rate * paidDays);
        }

        const bentoByDate = bentoChecksByName[name] || {};
        const bentoPricePerMeal = getBentoPriceForName(name);
        const bentoCount  = countBentoEntries(bentoByDate, (dateStr) => !retiredAt || dateStr <= retiredAt);
        const bentoTotal  = sumBentoEntries(bentoByDate, bentoPricePerMeal, (dateStr) => !retiredAt || dateStr <= retiredAt);

        const detailRows = days.map(({ key: dateStr, mo, d, dow }) => ({
          dateLabel: `${mo}/${d}`,
          weekday: WD[dow],
          ...getCsvDailyExportRow(entries[dateStr] || {}, dateStr, rule, empType, loc),
        })).filter((row) =>
          row.status || row.rawStart || row.roundedStart || row.rawEnd || row.roundedEnd
        );

        const rowsToWrite = detailRows.length ? detailRows : [{
          dateLabel: "",
          weekday: "",
          status: "",
          rawStart: "",
          roundedStart: "",
          rawEnd: "",
          roundedEnd: "",
          roundedWork: "",
          note: "",
        }];

        rowsToWrite.forEach((row, idx) => {
          lines.push([
            idx === 0 ? name : "",
            idx === 0 ? empType : "",
            idx === 0 ? loc : "",
            row.dateLabel,
            row.weekday,
            row.status,
            row.rawStart,
            row.roundedStart,
            row.rawEnd,
            row.roundedEnd,
            row.roundedWork,
            row.note,
            idx === 0 ? currentSummary.workDays : "",
            idx === 0 ? m2t(currentSummary.totalWorkMin) : "",
            idx === 0 ? formatAverageHours(currentSummary.avgDailyMin) : "",
            idx === 0 ? (currentSummary.totalOvertimeMin > 0 ? m2t(currentSummary.totalOvertimeMin) : "0:00") : "",
            idx === 0 ? bentoCount : "",
            idx === 0 ? bentoTotal : "",
            idx === 0 ? paidDays : "",
            idx === 0 ? paidLeaveHours : "",
            idx === 0 ? paidLeaveAmount : "",
          ].map(esc).join(","));
        });
      });

      const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement("a"), { href: url, download: `${target.title}_社労士用.csv` });
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      showToast(`CSV出力しました（${target.names.length}名）`);
    } catch (e) {
      showToast(`CSV出力エラー: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  const printSheet = () => {
    const target = getExportTarget();
    if (target.error) { showToast(target.error, "err"); return; }
    const esc = (v) => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const sections = target.names.map((name) => {
      const retiredAt = retiredSettings[name]?.isRetired ? (retiredSettings[name]?.retiredAt || null) : null;
      const retiredNote = retiredAt ? `<span style="color:#c2410c;font-size:11px;margin-left:10px">（退職：${retiredAt}）</span>` : "";
      const rows = buildExportRows(name).map((r) =>
        `<tr><td>${esc(r.dateStr)}</td><td>${esc(r.weekday)}</td><td>${esc(r.status)}</td><td>${esc(r.rawStart)}</td><td>${esc(r.roundedStart)}</td><td>${esc(r.rawEnd)}</td><td>${esc(r.roundedEnd)}</td><td>${esc(r.roundedWork)}</td><td>${r.wage ? "¥"+Number(r.wage).toLocaleString() : ""}</td></tr>`
      ).join("");
      return `<section class="sheet"><h2>${esc(name)} / ${esc(year)}年${esc(month)}月${retiredNote}</h2><table><thead><tr><th>日付</th><th>曜</th><th>勤怠</th><th>開始(実)</th><th>開始(丸)</th><th>終了(実)</th><th>終了(丸)</th><th>勤務(丸)</th><th>日給</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    });
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc || !iframe.contentWindow) {
      document.body.removeChild(iframe);
      showToast("印刷画面の準備に失敗しました", "err");
      return;
    }
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(target.title)}</title><style>body{font-family:"Hiragino Kaku Gothic ProN",sans-serif;margin:20px}h2{font-size:14px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #999;padding:4px 6px;text-align:center}th{background:#f3f4f6}.sheet{page-break-after:always}.sheet:last-child{page-break-after:auto}</style></head><body>${sections.join("")}</body></html>`);
    doc.close();
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => {
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
      }, 1000);
    }, 200);
  };

  if (!user) return <Login onLoggedIn={setUser} />;

  return (
    <div style={S.root}>

      {/* ── トースト ── */}
      {toast && <div style={{ ...S.toast, background: toast.type === "err" ? "#dc2626" : "#1a4d12" }}>{toast.msg}</div>}

      {/* ── 個人設定モーダル ── */}
      {settingsModalName && (
        <IndividualSettingsModal
          name={settingsModalName}
          year={year} month={month}
          fareSettings={fareSettings}
          fareConfig={fareConfig}
          extras={extras}
          onUpdateFare={handleUpdate}
          onUpdateFareConfig={updateFareConfig}
          onUpdateExtras={updateExtras}
          onClose={() => setSettingsModalName(null)}
        />
      )}

      {/* ── CSVプレビューモーダル ── */}
      {preview && (
        <div style={S.overlay} onClick={() => setPreview(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>📋 れこるCSV 取り込み確認</span>
              <button style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#888" }} onClick={() => setPreview(null)}>✕</button>
            </div>
            <div style={S.noteBox}>
              <b>スナップルール：</b>
              {activeWorkRule.snapEarlyThreshold}より前 → <b>{activeWorkRule.snapEarlyTo}</b>に丸め　/　
              {activeWorkRule.snapRangeStart}〜{activeWorkRule.snapRangeEnd} → <b>{activeWorkRule.snapRangeTo}</b>に丸め<br />
              ※ 手動修正済み（修）のデータは上書きしません<br />
              <span style={{ color: "#4b5563", fontSize: 11 }}>
                解析: {preview.parseMeta?.encoding || "-"} / 区切り{preview.parseMeta?.delimiter === "\t" ? "TAB" : (preview.parseMeta?.delimiter || ",")} / ヘッダー行 {preview.parseMeta?.headerRowIndex >= 0 ? preview.parseMeta.headerRowIndex + 1 : "未検出"}
              </span>
            </div>
            {/* 一括店舗割り当て */}
            {locationNames.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "8px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#166534" }}>📦 一括設定</span>
                <span style={{ fontSize: 11, color: "#4b5563" }}>全員を</span>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    const loc = e.target.value;
                    setPreview((prev) => {
                      const nl = {};
                      Object.keys(prev.byName).forEach((n) => { nl[n] = loc; });
                      return { ...prev, nameLocations: nl };
                    });
                    e.target.value = "";
                  }}
                  style={{ border: "1px solid #a7c4a7", borderRadius: 6, padding: "4px 8px", fontSize: 12, background: "#fff", cursor: "pointer" }}
                >
                  <option value="">店舗を選択…</option>
                  {locationNames.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <span style={{ fontSize: 11, color: "#4b5563" }}>に割り当て</span>
              </div>
            )}
            <div style={{ maxHeight: "48vh", overflowY: "auto", marginBottom: 14 }}>
              {Object.entries(preview.byName).map(([name, rows]) => {
                const assignedLoc = preview.nameLocations?.[name] || activeLocation;
                const isNew = !employeeLocation[name];
                return (
                <div key={name} style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 13, color: "#1a2e1a", background: "#e8f5e8", borderRadius: 7, padding: "5px 10px", marginBottom: 3, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>👤 {name}</span>
                    <span style={{ fontSize: 10, color: "#2d6a2d", fontWeight: 600 }}>{rows.length}件</span>
                    {preview.csvLocations?.[name] && (
                      <span style={{ fontSize: 10, color: "#334155", background: "#e2e8f0", borderRadius: 6, padding: "1px 6px", fontWeight: 700 }}>
                        C列: {preview.csvLocations[name]}
                      </span>
                    )}
                    {/* 店舗セレクター */}
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      {isNew && <span style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>新規</span>}
                      <span style={{ fontSize: 11, color: "#4b5563" }}>所属店舗</span>
                      <select
                        value={assignedLoc}
                        onChange={(e) => setPreviewLocation(name, e.target.value)}
                        style={{ border: "1px solid #a7c4a7", borderRadius: 6, padding: "3px 8px", fontSize: 12, background: "#fff", color: "#1a2e1a", fontWeight: 700, cursor: "pointer", outline: "none" }}
                      >
                        {locationNames.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                  </div>
                  {rows.map((row) => {
                    const k = name + "|" + row.dateStr;
                    const rule = getEffectiveRuleAtLocation(name, assignedLoc);
                    const previewShiftType = guessTorikokoShiftType(assignedLoc, row);
                    const snapped = snapStart(
                      row.rawStart || row.roundedStart,
                      applyEntryShiftRule(rule, { ...row, shiftType: previewShiftType })
                    );
                    const didSnap = row.rawStart && snapped !== row.rawStart;
                    return (
                      <label key={k} style={{ display: "flex", alignItems: "center", padding: "5px 10px", borderBottom: "1px solid #f5f0e8", cursor: "pointer", fontSize: 12, gap: 6, flexWrap: "wrap" }}>
                        <input type="checkbox" checked={preview.selKeys.has(k)} onChange={() => toggleSelKey(k)} />
                        <span style={{ minWidth: 96, color: "#6b5e4c", fontWeight: 600 }}>{row.dateStr}</span>
                        <span>
                          {row.rawStart
                            ? <><s style={{ color: "#bbb", fontSize: 11 }}>{row.rawStart}</s><span style={{ color: "#888", margin: "0 3px" }}>→</span><b style={{ color: "#1a4d12" }}>{snapped || "—"}</b></>
                            : <span style={{ color: "#aaa" }}>開始なし</span>}
                        </span>
                        <span style={{ color: "#aaa", margin: "0 2px" }}>〜</span>
                        <span style={{ color: "#1a1209" }}>{row.roundedEnd || <span style={{ color: "#aaa" }}>未退勤</span>}</span>
                        {didSnap && <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>スナップ</span>}
                      </label>
                    );
                  })}
                </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button style={S.btnG} onClick={() => setPreview(null)}>キャンセル</button>
              <button style={S.btnP} onClick={confirmImport}>取り込む（{preview.selKeys.size}件）</button>
            </div>
          </div>
        </div>
      )}

      {/* ── CSV取込失敗モーダル ── */}
      {importFailures && (
        <div style={S.overlay} onClick={() => setImportFailures(null)}>
          <div style={{ ...S.modal, maxWidth: 920 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: "#991b1b" }}>保存失敗の詳細</span>
              <button style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#888" }} onClick={() => setImportFailures(null)}>✕</button>
            </div>
            <div style={{ ...S.noteBox, background: "#fef2f2", borderColor: "#fecaca", color: "#7f1d1d" }}>
              {importFailures.total}件の保存に失敗しました。
              <br />
              <span style={{ fontSize: 11 }}>
                下の一覧で、どのデータがどの理由で落ちたか確認できます。画面上の表示は更新されていても、DB保存は失敗している可能性があります。
              </span>
            </div>
            <div style={{ maxHeight: "52vh", overflowY: "auto", border: "1px solid #fee2e2", borderRadius: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#fef2f2", position: "sticky", top: 0 }}>
                    <th style={{ ...S.thSub, textAlign: "left", color: "#7f1d1d" }}>種別</th>
                    <th style={{ ...S.thSub, textAlign: "left", color: "#7f1d1d" }}>氏名</th>
                    <th style={{ ...S.thSub, textAlign: "left", color: "#7f1d1d" }}>日付</th>
                    <th style={{ ...S.thSub, textAlign: "left", color: "#7f1d1d" }}>店舗</th>
                    <th style={{ ...S.thSub, textAlign: "left", color: "#7f1d1d" }}>理由</th>
                  </tr>
                </thead>
                <tbody>
                  {importFailures.items.map((item, idx) => (
                    <tr key={`${item.kind}-${item.name}-${item.dateStr}-${idx}`} style={{ borderTop: idx ? "1px solid #fee2e2" : "none", verticalAlign: "top" }}>
                      <td style={{ ...S.td, color: "#991b1b", fontWeight: 700 }}>{item.kind === "settings" ? "スタッフ設定" : "勤怠"}</td>
                      <td style={S.td}>{item.name || "—"}</td>
                      <td style={S.td}>{item.dateStr || "—"}</td>
                      <td style={S.td}>{item.location || "—"}</td>
                      <td style={{ ...S.td, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#7f1d1d" }}>{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button style={S.btnG} onClick={() => setImportFailures(null)}>閉じる</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ ① ヘッダーバー ══ */}
      <div style={{ background: "linear-gradient(135deg,#1a2e1a 0%,#2d5a27 100%)", padding: "0 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0 0", gap: 12, flexWrap: "wrap" }}>
          {/* ロゴ＋期間 */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 17, fontWeight: 900, color: "#e8f5e8", letterSpacing: "-0.5px", whiteSpace: "nowrap" }}>🌿 勤怠管理</span>
            {loading && <span style={{ fontSize: 10, color: "#86efac", background: "rgba(255,255,255,0.1)", padding: "3px 8px", borderRadius: 999 }}>同期中…</span>}
            <div style={{ display: "flex", gap: 4, background: "rgba(0,0,0,0.25)", borderRadius: 10, padding: "3px" }}>
              <select style={S.sel} value={year} onChange={(e) => setYear(+e.target.value)}>
                {[2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}年</option>)}
              </select>
              <select style={{ ...S.sel, minWidth: 148 }} value={month} onChange={(e) => setMonth(+e.target.value)}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                  const pm = m === 1 ? 12 : m - 1;
                  return <option key={m} value={m}>{pm}月21日〜{m}月20日</option>;
                })}
              </select>
            </div>
          </div>
          {/* 右側アクション */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={onFile} />
            <input ref={bentoFileRef} type="file" accept=".xlsx,.xls,.xlsm" style={{ display: "none" }} onChange={onBentoFile} />
            <button style={S.csvBtn} onClick={() => fileRef.current.click()}>📂 CSV取込</button>
            <button style={{ ...S.csvBtn, background: "rgba(252,165,165,0.15)", borderColor: "rgba(252,165,165,0.4)" }} onClick={() => bentoFileRef.current.click()}>🍱 お弁当取込</button>
            <div style={{ width: 1, height: 24, background: "rgba(255,255,255,0.15)", margin: "0 2px" }} />
            <select style={{ ...S.sel, fontSize: 11 }} value={exportScope} onChange={(e) => setExportScope(e.target.value)}>
              <option value="all">全体</option>
              <option value="store">店舗別</option>
              <option value="name">個人別</option>
            </select>
            <button
              onClick={saveAllNow}
              disabled={saveBusy || loading}
              style={{
                ...S.csvBtn,
                background: saveBusy ? "#166534" : "#22c55e",
                borderColor: saveBusy ? "#14532d" : "#16a34a",
                color: "#fff",
                opacity: saveBusy || loading ? 0.8 : 1,
                fontWeight: 900,
              }}
            >
              {saveBusy ? "保存中…" : "💾 設定を保存"}
            </button>
            {lastSavedAt && (
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", whiteSpace: "nowrap" }}>
                保存済み {lastSavedAt}
              </span>
            )}
            <button style={S.csvBtn} onClick={downloadCSV}>⬇ CSV</button>
            <button style={S.csvBtn} onClick={printSheet}>🖨 印刷</button>
            <div style={{ width: 1, height: 24, background: "rgba(255,255,255,0.15)", margin: "0 2px" }} />
            <button onClick={logout} style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.6)", borderRadius: 8, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>ログアウト</button>
          </div>
        </div>
        {/* ── メインタブ ── */}
        <div style={{ display: "flex", gap: 2, marginTop: 12 }}>
          {[["detail","🏪 店舗"], ["summary","💴 給料一覧"], ["staff","👥 スタッフ管理"]].map(([mode, label]) => (
            <button key={mode} onClick={() => setViewMode(mode)} style={{
              padding: "9px 20px", fontSize: 12, fontWeight: 800, cursor: "pointer",
              border: "none", borderRadius: "10px 10px 0 0",
              background: viewMode === mode ? "#fbfaf8" : "transparent",
              color: viewMode === mode ? "#1a2e1a" : "rgba(255,255,255,0.55)",
            }}>{label}</button>
          ))}
          <button onClick={() => setViewMode("retired")} style={{
            marginLeft: 8,
            padding: "8px 14px", fontSize: 11, fontWeight: 800, cursor: "pointer",
            border: "1px solid rgba(255,255,255,0.16)", borderRadius: 999,
            background: viewMode === "retired" ? "#f97316" : "rgba(255,255,255,0.06)",
            color: "#fff",
          }}>
            退職者{retiredNames.length > 0 ? ` ${retiredNames.length}` : ""}
          </button>
        </div>
      </div>

      {/* ══ ② 店舗バー（スタッフ管理以外で表示） ══ */}
      {(viewMode === "detail" || viewMode === "summary") && (
        <div style={{ background: "#fff", borderBottom: "2px solid #eae4dc", padding: "0 20px", display: "flex", alignItems: "stretch" }}>
          <div style={{ display: "flex", flex: 1, alignItems: "center" }}>
            {locationNames.map((l) => (
              <button key={l} onClick={() => setActiveLocation(l)} style={{
                padding: "13px 20px", fontSize: 13, fontWeight: 800, cursor: "pointer",
                border: "none", borderBottom: activeLocation === l ? "3px solid #1a2e1a" : "3px solid transparent",
                background: "transparent", color: activeLocation === l ? "#1a2e1a" : "#aaa",
                transition: "color 0.15s",
              }}>{l}</button>
            ))}
          </div>
          {/* 時給サマリー＋設定ボタン */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "#6b7280" }}>
            <span>平日 <b style={{ color: "#1a2e1a" }}>¥{activeWorkRule.hourlyNormal.toLocaleString()}</b></span>
            <span>土日祝 <b style={{ color: "#1a2e1a" }}>¥{activeWorkRule.hourlyWeekend.toLocaleString()}</b></span>
            <span style={{ color: "#ccc" }}>|</span>
            <span>{activeWorkRule.businessStart}〜{activeWorkRule.businessEnd}</span>
            <button onClick={() => setStoreSettingsOpen(true)}
              style={{ background: "#f0f4ff", border: "1px solid #c7d2fe", color: "#4338ca", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer", marginLeft: 4 }}>
              ⚙ 店舗設定
            </button>
          </div>
        </div>
      )}

      {/* ══ ③ 店舗設定モーダル ══ */}
      {storeSettingsOpen && (
        <div style={S.overlay} onClick={(e) => e.target === e.currentTarget && setStoreSettingsOpen(false)}>
          <div style={{ ...S.modal, maxWidth: 680 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 900, color: "#1a2e1a" }}>⚙ 店舗ルール設定</h2>
              <button onClick={() => setStoreSettingsOpen(false)}
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 }}>✕</button>
            </div>
            {/* 店舗タブ */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
              {locationNames.map((l) => (
                <button key={l} onClick={() => setActiveLocation(l)} style={{
                  padding: "7px 16px", fontSize: 13, fontWeight: 800, borderRadius: 10, cursor: "pointer",
                  border: activeLocation === l ? "2px solid #1a2e1a" : "1px solid #ddd5c8",
                  background: activeLocation === l ? "#1a2e1a" : "#fff",
                  color: activeLocation === l ? "#e8f5e8" : "#374151",
                }}>{l}</button>
              ))}
              <button style={{ ...S.addBtn, fontSize: 11, padding: "6px 12px" }} onClick={addLocation}>＋ 追加</button>
              <button style={{ ...S.addBtn, fontSize: 11, padding: "6px 12px", color: "#9f1239", borderColor: "#fecdd3" }}
                onClick={removeLocation} disabled={locationNames.length <= 1}>削除</button>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#374151", marginLeft: 4 }}>
                個別ルール：
                <select value={activeRuleMode} onChange={(e) => updateRuleMode(activeLocation, e.target.value)}
                  style={{ border: "1px solid #d6cec1", borderRadius: 6, padding: "3px 6px", fontSize: 11, background: "#fff" }}>
                  <option value={RULE_MODE_STORE}>店舗共通</option>
                  <option value={RULE_MODE_INDIVIDUAL}>個別対応</option>
                </select>
              </label>
            </div>
            <WorkRulePanel workRule={activeWorkRule} onUpdate={updateWorkRule} />
          </div>
        </div>
      )}

      {/* ══ ④ スタッフバー（個人ビューのみ） ══ */}
      {viewMode === "detail" && (
        <div style={{ background: "#fafaf8", borderBottom: "1px solid #eae4dc", padding: "10px 20px" }}>
          {activeName && (
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 10,
              padding: "12px 14px",
              borderRadius: 14,
              border: "1px solid #c7d2fe",
              background: "linear-gradient(135deg,#eef2ff 0%,#f8fafc 100%)",
              boxShadow: "0 4px 18px rgba(99,102,241,0.08)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span style={{
                  width: 12, height: 12, borderRadius: "50%",
                  background: activeEmployeeLocation === "とりここ" ? "#f97316" : activeEmployeeLocation === "Ties" ? "#3b82f6" : activeEmployeeLocation === "Lien" ? "#8b5cf6" : "#22c55e",
                  boxShadow: "0 0 0 4px rgba(99,102,241,0.10)", flexShrink: 0,
                }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#6366f1", letterSpacing: "0.08em" }}>SELECTED STAFF</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#1e1b4b", lineHeight: 1.1 }}>{activeName}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#4338ca", background: "#e0e7ff", border: "1px solid #c7d2fe", borderRadius: 999, padding: "5px 10px" }}>
                  所属 {activeEmployeeLocation}
                </span>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#0f766e", background: "#ccfbf1", border: "1px solid #99f6e4", borderRadius: 999, padding: "5px 10px" }}>
                  {activeEmploymentType}
                </span>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#6b5e4c", background: "#fff", border: "1px solid #e7e5e4", borderRadius: 999, padding: "5px 10px" }}>
                  今月 {activePeriodWorkDays}日
                </span>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {names.length === 0 && (
              <span style={{ fontSize: 12, color: "#c4b5a0" }}>↑ CSV取込 または ＋追加 でスタッフを登録してください</span>
            )}
            {names.map((n) => {
              const e = allData[n] || {};
              const { start, end } = getPeriodRange(year, month);
              const monthKeys = Object.keys(e).filter((d) => d >= start && d <= end);
              const workDays = monthKeys.filter((d) => e[d]?.start && e[d]?.end).length;
              const isActive = activeName === n;
              const loc = normalizeLocation(employeeLocation[n]);
              const dotColor = loc === "とりここ" ? "#f97316" : loc === "Ties" ? "#3b82f6" : loc === "Lien" ? "#8b5cf6" : "#22c55e";
              const isRetiredPerson = !!retiredSettings[n]?.isRetired;
              const retiredAt = retiredSettings[n]?.retiredAt || "";
              return (
                <div key={n} style={{ display: "flex", alignItems: "center", borderRadius: 10, overflow: "hidden",
                  border: isActive ? "2px solid #4338ca" : isRetiredPerson ? "1px solid #fed7aa" : "1px solid #e0dbd2",
                  background: isActive ? "linear-gradient(135deg,#312e81 0%,#4338ca 100%)" : isRetiredPerson ? "#fff7ed" : "#fff",
                  boxShadow: isActive ? "0 8px 24px rgba(67,56,202,0.22)" : "none",
                  transform: isActive ? "translateY(-1px)" : "none" }}>
                  <button onClick={() => setActiveName(n)}
                    style={{ background: "transparent", border: "none", padding: "8px 4px 8px 12px", fontSize: 13, fontWeight: 800, cursor: "pointer",
                      color: isActive ? "#e8f5e8" : isRetiredPerson ? "#92400e" : "#1a2e1a", display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: isRetiredPerson ? "#f97316" : dotColor, display: "inline-block", flexShrink: 0 }} />
                    {n}
                    {isActive && <span style={{ fontSize: 9, background: "rgba(255,255,255,0.18)", color: "#fff", borderRadius: 999, padding: "2px 6px", fontWeight: 900 }}>選択中</span>}
                    {isRetiredPerson
                      ? <span style={{ fontSize: 9, background: "#fed7aa", color: "#c2410c", borderRadius: 4, padding: "1px 5px", fontWeight: 800 }}>退職 {retiredAt}</span>
                      : workDays > 0 && <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 600 }}>{workDays}日</span>
                    }
                  </button>
                  <button onClick={() => setSettingsModalName(n)}
                    title="個人設定"
                    style={{ background: isActive ? "#fbbf24" : "#e5e7eb", border: "none",
                      color: isActive ? "#1a2e1a" : "#555",
                      padding: "5px 7px", cursor: "pointer", fontSize: 15, lineHeight: 1,
                      borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>⚙</button>
                  {!isRetiredPerson && (
                    <button onClick={() => removeName(n)}
                      style={{ background: "transparent", border: "none", color: isActive ? "rgba(255,255,255,0.4)" : "#ccc",
                        padding: "8px 8px 8px 2px", cursor: "pointer", fontSize: 12 }}>✕</button>
                  )}
                </div>
              );
            })}
            <button onClick={() => { const n = (prompt("氏名を入力してください") || "").trim(); if (n) addName(n, activeLocation); }}
              style={{ background: "transparent", border: "2px dashed #86efac", color: "#166534", borderRadius: 10,
                padding: "7px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
              ＋ 追加
            </button>
          </div>

          {/* 選択中スタッフの設定バー */}
          {activeName && (
            <div style={{ display: "grid", gap: 10, marginTop: 8, paddingTop: 8, borderTop: "1px dashed #e8e2d8" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 900, color: "#4338ca", whiteSpace: "nowrap", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 999, padding: "5px 10px" }}>
                  表示中: {activeName}
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#475569" }}>
                  詳しいスタッフ情報は下の詳細設定にまとめています
                </span>
              </div>
              <details style={{ width: "100%" }}>
                <summary style={{
                  listStyle: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 900,
                  color: employeeOverrides[activeName]?.enabled ? "#4338ca" : "#1a2e1a",
                  background: employeeOverrides[activeName]?.enabled ? "#eef2ff" : "#fff",
                  border: employeeOverrides[activeName]?.enabled ? "1px solid #c7d2fe" : "1px solid #e0dbd2",
                  borderRadius: 12,
                  padding: "10px 12px",
                  userSelect: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "wrap",
                }}>
                  <span>{employeeOverrides[activeName]?.enabled ? `${activeName}さんの個別設定` : `${activeName}さんの詳細設定`}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: employeeOverrides[activeName]?.enabled ? "#6366f1" : "#6b7280" }}>
                    {employeeOverrides[activeName]?.enabled ? "始め/終了を個別設定" : "店舗共通設定"}
                  </span>
                </summary>
                <div style={{ marginTop: 10, display: "grid", gap: 12, background: "#f8fafc", border: "1px solid #dbeafe", borderRadius: 12, padding: 12 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#475569" }}>
                      <span>雇用区分</span>
                      <select value={employmentSettings[activeName] ?? DEFAULT_EMPLOYMENT_TYPE}
                        onChange={(e) => updateEmploymentType(activeName, e.target.value)}
                        style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 10px", fontSize: 12, fontWeight: 700, color: "#1a2e1a", background: "#fff", cursor: "pointer", outline: "none", minWidth: 120 }}>
                        {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#475569" }}>
                      <span>所属店舗</span>
                      <select value={activeEmployeeLocation}
                        onChange={(e) => {
                          saveEmployeeLocation(activeName, e.target.value, { notice: false });
                        }}
                        style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 10px", fontSize: 12, fontWeight: 700, color: "#1a2e1a", background: "#fff", cursor: "pointer", outline: "none", minWidth: 120 }}>
                        {locationNames.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#475569" }}>
                      <span>始め設定（丸め）</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="time" value={contractStartByName[activeName] || ""}
                          onChange={(e) => updateContractStart(activeName, e.target.value)}
                          style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12, background: "#fff", width: 108, color: "#4338ca", fontWeight: 700, outline: "none" }} />
                        {contractStartByName[activeName] && (
                          <button type="button" onClick={() => updateContractStart(activeName, "")}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#a5b4fc", fontSize: 12, padding: "0 2px" }}>✕</button>
                        )}
                      </div>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#475569" }}>
                      <span>終了設定（丸め）</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="time" value={contractEndByName[activeName] || ""}
                          onChange={(e) => updateContractEnd(activeName, e.target.value)}
                          style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 12, background: "#fff", width: 108, color: "#4338ca", fontWeight: 700, outline: "none" }} />
                        {contractEndByName[activeName] && (
                          <button type="button" onClick={() => updateContractEnd(activeName, "")}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#a5b4fc", fontSize: 12, padding: "0 2px" }}>✕</button>
                        )}
                      </div>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#475569" }}>
                      <span>設定モード</span>
                      <select
                        value={employeeOverrides[activeName]?.enabled ? "individual" : "shared"}
                        onChange={(e) => {
                          if (e.target.value === "individual") updateEmployeeOverrideRule(activeName, {});
                          else resetEmployeeOverrideRule(activeName);
                        }}
                        style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 10px", fontSize: 12, fontWeight: 700, color: employeeOverrides[activeName]?.enabled ? "#4338ca" : "#1a2e1a", background: "#fff", cursor: "pointer", outline: "none", minWidth: 132 }}
                      >
                        <option value="shared">店舗共通</option>
                        <option value="individual">個別設定</option>
                      </select>
                    </label>
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>始め設定は30分以内の早着だけ丸めます。終了設定はその時刻以降をその時刻に丸めます。</div>
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ── メインコンテンツ ── */}
      <div style={{ paddingBottom: 24 }}>
        {viewMode === "staff" ? (
          <StaffManager
            allData={Object.fromEntries(Object.entries(allData).filter(([n]) => !retiredSettings[n]?.isRetired))}
            locationNames={locationNames}
            employeeLocation={employeeLocation}
            employmentSettings={employmentSettings}
            fareSettings={fareSettings}
            paidLeaveSettings={paidLeaveSettings}
            monthlySalarySettings={monthlySalarySettings}
            activeLocation={activeLocation}
            onAdd={addName}
            onRemove={removeName}
            onUpdateLocation={staffUpdateLocation}
            onUpdateEmployment={updateEmploymentType}
            onUpdateFare={staffUpdateFare}
            onUpdatePaid={staffUpdatePaid}
            onUpdateMonthly={staffUpdateMonthly}
            onSave={staffSave}
            onRetire={retireStaff}
            onSelectStaff={openStaffDetail}
            contractStartByName={contractStartByName}
            contractEndByName={contractEndByName}
            employeeOverrides={employeeOverrides}
            onUpdateContractStart={updateContractStart}
            onUpdateContractEnd={updateContractEnd}
            onUpdateEmployeeOverride={updateEmployeeOverrideRule}
            onResetEmployeeOverride={resetEmployeeOverrideRule}
          />
        ) : viewMode === "retired" ? (
          <RetiredStaffList
            retiredNames={retiredNames}
            retiredSettings={retiredSettings}
            employeeLocation={employeeLocation}
            employmentSettings={employmentSettings}
            allData={allData}
            year={year}
            month={month}
            onReinstate={reinstateStaff}
            onRemove={removeName}
            onSelectHistory={openStaffDetail}
          />
        ) : viewMode === "summary" ? (
          <SalarySummary
            names={storeScopedNames} year={year} month={month}
            allData={allData}
            fareSettings={fareSettings}
            fareConfig={fareConfig}
            extras={extras}
            employmentSettings={employmentSettings}
            getEffectiveRule={getEffectiveRule}
            bentoChecksByName={bentoChecksByName}
            getBentoPriceForName={getBentoPriceForName}
            prevAllData={prevAllData}
            monthlySalarySettings={monthlySalarySettings}
            retiredSettings={retiredSettings}
            onClickName={openStaffDetail}
          />
        ) : activeName ? (
          <AttendanceTable
            name={activeName} year={year} month={month}
            entries={allData[activeName] || {}}
            prevEntries={prevAllData[activeName] || {}}
            fare={fareSettings[activeName] ?? 0}
            onUpdate={handleUpdate}
            onToggleBento={handleToggleBento}
            workRule={activeEffectiveRule}
            employmentType={activeEmploymentType}
            bentoByDate={bentoChecksByName[activeName] || {}}
            bentoPricePerMeal={activeBentoPricePerMeal}
            monthlySalary={monthlySalarySettings[activeName] ?? 0}
            retiredAt={retiredSettings[activeName]?.isRetired ? retiredSettings[activeName]?.retiredAt : null}
            fareConfig={fareConfig}
            extras={extras}
          />
        ) : (
          <div style={{ padding: 24, color: "#8b7355", fontSize: 13 }}>
            従業員を選択してください（＋追加 か CSV読込 でスタッフを登録）
          </div>
        )}
      </div>
    </div>
  );
}

// ─── スタイル ─────────────────────────────────────────────────────────────────
const S = {
  root: { fontFamily: 'ui-sans-serif,system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif', background: "#fbfaf8", minHeight: "100vh" },
  header: { background: "linear-gradient(135deg,#1a2e1a 0%,#2d5a27 100%)", padding: "13px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  sel: { background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", color: "#e8f5e8", borderRadius: 10, padding: "7px 10px", fontSize: 12, outline: "none", cursor: "pointer" },
  csvBtn: { background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.3)", color: "#e8f5e8", borderRadius: 10, padding: "7px 10px", fontSize: 12, cursor: "pointer", fontWeight: 700 },
  toast: { position: "fixed", top: 12, right: 12, color: "#fff", padding: "10px 14px", borderRadius: 10, fontSize: 12, fontWeight: 700, boxShadow: "0 8px 30px rgba(0,0,0,0.2)", zIndex: 9999 },
  addBtn: { border: "1px solid #ddd5c8", background: "#fff", borderRadius: 10, padding: "7px 10px", fontSize: 12, cursor: "pointer", fontWeight: 800, color: "#1a2e1a" },
  pill: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#4b5563", border: "1px solid #ddd5c8", borderRadius: 999, padding: "6px 10px", background: "#fff" },
  pill2: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, border: "1px solid #e0dbd2", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer" },
  pillLabel: { fontSize: 10, fontWeight: 800, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginRight: 2 },
  tabBtn: { border: "1px solid #ddd5c8", background: "#fff", borderRadius: 999, padding: "7px 14px", fontSize: 12, cursor: "pointer", fontWeight: 800 },
  xBtn: { border: "1px solid #eee", background: "#fff", borderRadius: 8, padding: "5px 8px", fontSize: 11, cursor: "pointer", color: "#999" },
  tableWrap: { margin: "0 14px", background: "#fff", border: "1px solid #eee2d8", borderRadius: 12, overflow: "hidden", boxShadow: "0 3px 16px rgba(0,0,0,0.04)" },
  thBig: { padding: "10px 8px", textAlign: "center", fontSize: 11, fontWeight: 800 },
  thSub: { padding: "7px 8px", textAlign: "center", fontSize: 10, fontWeight: 800 },
  td: { padding: "8px 8px", verticalAlign: "middle", color: "#1a1209" },
  htag: { marginTop: 2, fontSize: 10, color: "#dc2626", fontWeight: 800 },
  tbtn: { width: "100%", border: "1px dashed #c8bfb2", background: "#fff", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontVariantNumeric: "tabular-nums", textAlign: "center", fontSize: 12 },
  tinput: { width: "100%", border: "2px solid #1a4d12", borderRadius: 8, padding: "6px 8px", outline: "none", fontSize: 12 },
  modTag: { marginLeft: 6, fontSize: 10, background: "#fef3c7", color: "#92400e", borderRadius: 6, padding: "1px 5px", fontWeight: 800 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9990, padding: 14 },
  modal: { width: "min(820px,100%)", background: "#fff", borderRadius: 14, padding: 18, boxShadow: "0 18px 60px rgba(0,0,0,0.25)", maxHeight: "90vh", overflowY: "auto" },
  noteBox: { background: "#fffbe6", border: "1px solid #fde68a", color: "#6b5e4c", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 10, lineHeight: 1.8 },
  btnG: { border: "1px solid #ddd5c8", background: "#fff", borderRadius: 10, padding: "9px 14px", fontSize: 12, cursor: "pointer", fontWeight: 800 },
  btnP: { border: "1px solid #1a2e1a", background: "#1a2e1a", color: "#e8f5e8", borderRadius: 10, padding: "9px 14px", fontSize: 12, cursor: "pointer", fontWeight: 900 },
  inp: { width: "100%", border: "1px solid #ddd5c8", borderRadius: 10, padding: "10px 12px", fontSize: 14, outline: "none", boxSizing: "border-box" },
  numInput: { background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, padding: "4px 8px", color: "#e8f5e8", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "right" },
  sectionLabel: { fontSize: 11, fontWeight: 800, color: "#374151", marginBottom: 8, paddingBottom: 4, borderBottom: "1px solid #e5e7eb" },
};
