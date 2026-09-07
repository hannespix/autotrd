/**
 * Handelskalender-Datei: der Broker-Kalender (`/v2/calendar`) als JSON-Array
 * auf Platte, damit Backtest und Engine ohne Netz dieselben Sitzungsgrenzen
 * (Feiertage, Frühschluss) kennen. Fehlt die Datei oder reicht sie nicht
 * bis `toDay`, wird nachgeladen; scheitert das, gilt der vorhandene Stand —
 * und ohne Stand der algorithmische Fallback in core/time.ts (leere Map).
 */
import { existsSync } from 'node:fs';
import type { AlpacaClient } from '../alpaca/types.ts';
import { readJson, writeJsonAtomic } from '../core/journal.ts';
import { errMsg, logger } from '../core/log.ts';
import { compareDay, type Calendar, type CalendarDay } from '../core/time.ts';
import type { Ms } from '../core/types.ts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^\d{2}:\d{2}$/;

function isCalendarDay(x: unknown): x is CalendarDay {
  if (!x || typeof x !== 'object') return false;
  const d = x as Record<string, unknown>;
  return typeof d.date === 'string' && DAY_RE.test(d.date) && typeof d.open === 'string' && HHMM_RE.test(d.open) && typeof d.close === 'string' && HHMM_RE.test(d.close);
}

/** Datei lesen → Map date → CalendarDay; null, wenn sie fehlt oder unbrauchbar ist. */
export function loadCalendarFile(path: string): Calendar | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readJson<unknown>(path);
    if (!Array.isArray(raw)) return null;
    const map = new Map<string, CalendarDay>();
    for (const d of raw) if (isCalendarDay(d)) map.set(d.date, { date: d.date, open: d.open, close: d.close });
    return map;
  } catch (e) {
    logger.warn('Kalender-Datei unlesbar', { path, error: errMsg(e) });
    return null;
  }
}

export function saveCalendarFile(path: string, days: Iterable<CalendarDay>): void {
  const sorted = [...days].sort((a, b) => compareDay(a.date, b.date));
  writeJsonAtomic(path, sorted);
}

function lastDay(cal: Calendar): string | null {
  let last: string | null = null;
  for (const d of cal.keys()) if (last === null || compareDay(d, last) > 0) last = d;
  return last;
}

function firstDay(cal: Calendar): string | null {
  let first: string | null = null;
  for (const d of cal.keys()) if (first === null || compareDay(d, first) < 0) first = d;
  return first;
}

/**
 * Kalender für [fromDay, toDay] sicherstellen. `now` dient nur der
 * Plausibilität: Ein Bereich, der vor heute endet, wird bis heute gezogen,
 * damit die Engine nie mit einem Kalender arbeitet, der den laufenden Tag
 * nicht kennt.
 */
export async function ensureCalendar(client: AlpacaClient, path: string, fromDay: string, toDay: string, now: Ms): Promise<Calendar> {
  const today = new Date(now).toISOString().slice(0, 10);
  const wantTo = compareDay(toDay, today) < 0 ? today : toDay;
  const existing = loadCalendarFile(path);
  if (existing && existing.size > 0) {
    const last = lastDay(existing);
    const first = firstDay(existing);
    if (last !== null && first !== null && compareDay(last, wantTo) >= 0 && compareDay(first, fromDay) <= 0) return existing;
  }
  try {
    const days = await client.getCalendar(fromDay, wantTo);
    const merged = new Map<string, CalendarDay>(existing ?? []);
    for (const d of days) if (isCalendarDay(d)) merged.set(d.date, d);
    if (merged.size > 0) saveCalendarFile(path, merged.values());
    else logger.warn('Broker-Kalender leer — algorithmischer Fallback gilt', { fromDay, toDay: wantTo });
    return merged;
  } catch (e) {
    logger.warn('Broker-Kalender nicht ladbar — vorhandener Stand bzw. Fallback gilt', { error: errMsg(e), fromDay, toDay: wantTo });
    return existing ?? new Map<string, CalendarDay>();
  }
}
