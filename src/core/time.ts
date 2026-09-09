/**
 * Zeitlogik in America/New_York — DST-sicher über Intl, ohne Abhängigkeit.
 *
 * Alle Zeitstempel im System sind Epoch-Millisekunden (UTC). ET wird nur
 * zum Rechnen mit Sitzungen (09:30–16:00) und Handelstagen gebraucht.
 * Die Offsets werden je UTC-Stunde gecacht: DST-Wechsel liegen in den USA
 * immer auf einer vollen UTC-Stunde (06:00/07:00 UTC), daher ist der
 * Offset innerhalb einer UTC-Stunde konstant.
 */
import type { AssetClass, Ms, TimeframeMin } from './types.ts';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Reguläre NYSE-Sitzung in Minuten seit ET-Mitternacht. */
export const SESSION_OPEN_MIN = 9 * 60 + 30; // 570
export const SESSION_CLOSE_MIN = 16 * 60; // 960
export const EARLY_CLOSE_MIN = 13 * 60; // 780

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const offsetCache = new Map<number, number>();

/** ET-Offset zu UTC in Minuten (EST −300, EDT −240) zum Zeitpunkt `ms`. */
export function etOffsetMin(ms: Ms): number {
  const key = Math.floor(ms / HOUR);
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MIN);
  if (offsetCache.size > 200_000) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

export interface EtParts {
  y: number;
  m: number; // 1–12
  d: number; // 1–31
  hh: number;
  mm: number;
  ss: number;
  /** 0 = Sonntag … 6 = Samstag */
  weekday: number;
  /** YYYY-MM-DD */
  day: string;
  /** Minuten seit ET-Mitternacht. */
  minuteOfDay: number;
}

export function toET(ms: Ms): EtParts {
  const shifted = new Date(ms + etOffsetMin(ms) * MIN);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const hh = shifted.getUTCHours();
  const mm = shifted.getUTCMinutes();
  const ss = shifted.getUTCSeconds();
  return {
    y,
    m,
    d,
    hh,
    mm,
    ss,
    weekday: shifted.getUTCDay(),
    day: `${y}-${pad2(m)}-${pad2(d)}`,
    minuteOfDay: hh * 60 + mm,
  };
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ET-Handelstag (YYYY-MM-DD) eines Zeitstempels. */
export function dayKey(ms: Ms): string {
  return toET(ms).day;
}

/** UTC-Tag (YYYY-MM-DD) — Krypto handelt in UTC-Tagen. */
export function utcDayKey(ms: Ms): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Handelstag je Assetklasse: Aktien ET, Krypto UTC. */
export function dayKeyFor(ms: Ms, assetClass: AssetClass): string {
  return assetClass === 'crypto' ? utcDayKey(ms) : dayKey(ms);
}

/** Epoch-ms für eine ET-Wanduhrzeit. Um DST-Wechsel korrekt (zweiter Durchlauf). */
export function msFromET(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): Ms {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = naive - etOffsetMin(naive) * MIN;
  const off2 = etOffsetMin(guess);
  guess = naive - off2 * MIN;
  return guess;
}

export function parseDay(day: string): { y: number; m: number; d: number } {
  const [ys, ms, ds] = day.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new Error(`Ungültiger Tag: ${day}`);
  }
  return { y, m, d };
}

/** Kalendertag + n Tage (ET-Datum als String). */
export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  const t = Date.UTC(y, m - 1, d) + n * DAY;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function compareDay(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ───────────────────────── Kalender ───────────────────────── */

/** Ein Handelstag laut Alpaca `/v2/calendar` (Zeiten "HH:MM" ET). */
export interface CalendarDay {
  date: string;
  open: string;
  close: string;
}

export type Calendar = ReadonlyMap<string, CalendarDay>;

function nthWeekdayOfMonth(y: number, m: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const delta = (weekday - first + 7) % 7;
  return 1 + delta + (n - 1) * 7;
}

function lastWeekdayOfMonth(y: number, m: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const wd = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return lastDay - ((wd - weekday + 7) % 7);
}

function easterSunday(y: number): { m: number; d: number } {
  // Anonymer Gregorianischer Algorithmus
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

function observed(y: number, m: number, d: number): string | null {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 6) {
    // Samstag → Freitag davor; Ausnahme: Neujahr am Samstag wird nicht am 31.12. nachgeholt.
    if (m === 1 && d === 1) return null;
    return addDays(`${y}-${pad2(m)}-${pad2(d)}`, -1);
  }
  if (wd === 0) return addDays(`${y}-${pad2(m)}-${pad2(d)}`, 1);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** NYSE-Feiertage eines Jahres (algorithmischer Fallback ohne Broker-Kalender). */
export function nyseHolidays(y: number): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null) => {
    if (s) out.add(s);
  };
  add(observed(y, 1, 1));
  add(`${y}-01-${pad2(nthWeekdayOfMonth(y, 1, 1, 3))}`); // MLK
  add(`${y}-02-${pad2(nthWeekdayOfMonth(y, 2, 1, 3))}`); // Presidents' Day
  const easter = easterSunday(y);
  add(addDays(`${y}-${pad2(easter.m)}-${pad2(easter.d)}`, -2)); // Karfreitag
  add(`${y}-05-${pad2(lastWeekdayOfMonth(y, 5, 1))}`); // Memorial Day
  if (y >= 2022) add(observed(y, 6, 19)); // Juneteenth
  add(observed(y, 7, 4));
  add(`${y}-09-${pad2(nthWeekdayOfMonth(y, 9, 1, 1))}`); // Labor Day
  add(`${y}-11-${pad2(nthWeekdayOfMonth(y, 11, 4, 4))}`); // Thanksgiving
  add(observed(y, 12, 25));
  return out;
}

const holidayCache = new Map<number, Set<string>>();

function isHolidayFallback(day: string): boolean {
  const { y } = parseDay(day);
  let set = holidayCache.get(y);
  if (!set) {
    set = nyseHolidays(y);
    holidayCache.set(y, set);
  }
  return set.has(day);
}

/** Frühschluss-Tage (13:00 ET) im Fallback: Tag nach Thanksgiving, 24.12. und 3.7., wenn Werktag und kein Feiertag. */
function isEarlyCloseFallback(day: string): boolean {
  const { y, m, d } = parseDay(day);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const thanksgiving = nthWeekdayOfMonth(y, 11, 4, 4);
  if (m === 11 && d === thanksgiving + 1) return true;
  if (m === 12 && d === 24) return true;
  if (m === 7 && d === 3 && !isHolidayFallback(day)) return true;
  return false;
}

export interface SessionBounds {
  day: string;
  open: Ms;
  close: Ms;
  /** Sitzungsdauer in Minuten. */
  minutes: number;
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Ist `day` ein Handelstag? Mit Broker-Kalender exakt, sonst Werktag +
 * NYSE-Feiertage. Krypto: jeder Tag.
 */
export function isTradingDay(day: string, assetClass: AssetClass, calendar?: Calendar): boolean {
  if (assetClass === 'crypto') return true;
  if (calendar && calendar.size > 0) return calendar.has(day);
  const { y, m, d } = parseDay(day);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !isHolidayFallback(day);
}

/** Sitzungsgrenzen eines Handelstags; null, wenn kein Handelstag. Krypto: UTC-Tag. */
export function sessionBounds(day: string, assetClass: AssetClass, calendar?: Calendar): SessionBounds | null {
  const { y, m, d } = parseDay(day);
  if (assetClass === 'crypto') {
    const open = Date.UTC(y, m - 1, d);
    return { day, open, close: open + DAY, minutes: 1440 };
  }
  if (!isTradingDay(day, assetClass, calendar)) return null;
  let openMin = SESSION_OPEN_MIN;
  let closeMin = SESSION_CLOSE_MIN;
  const cal = calendar?.get(day);
  if (cal) {
    openMin = hhmmToMin(cal.open);
    closeMin = hhmmToMin(cal.close);
  } else if (isEarlyCloseFallback(day)) {
    closeMin = EARLY_CLOSE_MIN;
  }
  const open = msFromET(y, m, d, Math.floor(openMin / 60), openMin % 60);
  const close = msFromET(y, m, d, Math.floor(closeMin / 60), closeMin % 60);
  return { day, open, close, minutes: closeMin - openMin };
}

/** Nächster Handelstag NACH `day`. */
export function nextTradingDay(day: string, assetClass: AssetClass, calendar?: Calendar): string {
  let cur = addDays(day, 1);
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cur, assetClass, calendar)) return cur;
    cur = addDays(cur, 1);
  }
  throw new Error(`Kein Handelstag in 30 Tagen nach ${day}`);
}

/**
 * Vorheriger Handelstag VOR `day` — oder null, wenn es in 30 Tagen keinen
 * gibt. Mit Kalender heißt das meist: Der Kalender beginnt hier. Wer ein
 * Fenster „fünf Handelstage zurück" baut, macht es dann kürzer, statt
 * abzubrechen (Lauf 27 am 09.09.2026: Die erste Bar lag auf dem ersten
 * Kalendertag, und der Simulator warf für alle vier Strategien).
 */
export function prevTradingDayOrNull(day: string, assetClass: AssetClass, calendar?: Calendar): string | null {
  let cur = addDays(day, -1);
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cur, assetClass, calendar)) return cur;
    cur = addDays(cur, -1);
  }
  return null;
}

/** Vorheriger Handelstag VOR `day`; wirft, wenn es keinen gibt. */
export function prevTradingDay(day: string, assetClass: AssetClass, calendar?: Calendar): string {
  const prev = prevTradingDayOrNull(day, assetClass, calendar);
  if (prev === null) throw new Error(`Kein Handelstag in 30 Tagen vor ${day}`);
  return prev;
}

/* ───────────────────────── Buckets ───────────────────────── */

/**
 * Bucket-Beginn eines Zeitstempels im Zeitrahmen `tf`, ausgerichtet an der
 * Sitzungseröffnung (Aktien) bzw. UTC-Mitternacht (Krypto). Tagesbars
 * (1440) beginnen an der Sitzungseröffnung. Für Zeitstempel außerhalb der
 * Sitzung wird `null` geliefert (Aktien) — Pre-/After-Market fließt nicht ein.
 */
export function bucketStart(ms: Ms, tf: TimeframeMin, bounds: SessionBounds | null): Ms | null {
  if (!bounds) return null;
  if (ms < bounds.open || ms >= bounds.close) return null;
  if (tf === 1440) return bounds.open;
  const size = tf * MIN;
  return bounds.open + Math.floor((ms - bounds.open) / size) * size;
}

/** Bucket-Ende (exklusiv). Der letzte Bucket eines Tages endet spätestens am Sitzungsschluss. */
export function bucketEnd(start: Ms, tf: TimeframeMin, bounds: SessionBounds): Ms {
  if (tf === 1440) return bounds.close;
  return Math.min(start + tf * MIN, bounds.close);
}

/** Anzahl Bars je Sitzung im Zeitrahmen (letzte ggf. verkürzt). */
export function barsPerSession(tf: TimeframeMin, bounds: SessionBounds): number {
  if (tf === 1440) return 1;
  return Math.ceil(bounds.minutes / tf);
}

/** Erwartete Bars je Jahr (für Annualisierung von Bar-Renditen). */
export function barsPerYear(tf: TimeframeMin, assetClass: AssetClass): number {
  if (assetClass === 'crypto') return (365 * 1440) / tf;
  if (tf === 1440) return 252;
  return 252 * Math.ceil(390 / tf);
}
