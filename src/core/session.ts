/**
 * Sitzungs-Sicht je geschlossener Bar — EINE Funktion für Backtest und
 * Live. Sie beantwortet: Wie viele Minuten bis zum Schluss? Ist das die
 * letzte Bar des Tages? Wie viele Bars seit Open?
 *
 * Zeitpunkt der Betrachtung ist immer das Bucket-ENDE der Bar (die Bar
 * ist geschlossen), nicht ihr Beginn.
 */
import type { AssetClass, BarSeriesLike, SessionInfo, TimeframeMin } from './types.ts';
import { bucketEnd, dayKey, sessionBounds, type Calendar, MIN } from './time.ts';

export function buildSessionInfo(
  bars: BarSeriesLike,
  i: number,
  tf: TimeframeMin,
  assetClass: AssetClass,
  calendar?: Calendar,
): SessionInfo {
  const t = bars.t[i]!;
  const day = dayKey(t);
  // Bars seit Open (inkl. aktueller): rückwärts zählen, solange derselbe ET-Tag.
  let barsSinceOpen = 1;
  for (let k = i - 1; k >= 0; k--) {
    if (dayKey(bars.t[k]!) !== day) break;
    barsSinceOpen++;
  }
  if (assetClass === 'crypto') {
    return {
      isRegularSession: true,
      minutesToClose: null,
      minutesSinceOpen: null,
      barsSinceOpen,
      isLastBarOfDay: false,
      day,
    };
  }
  const bounds = sessionBounds(day, assetClass, calendar);
  if (!bounds) {
    return { isRegularSession: false, minutesToClose: null, minutesSinceOpen: null, barsSinceOpen, isLastBarOfDay: false, day };
  }
  const inSession = t >= bounds.open && t < bounds.close;
  const end = inSession ? bucketEnd(t, tf, bounds) : t + tf * MIN;
  const minutesToClose = Math.max(0, Math.round((bounds.close - end) / MIN));
  const minutesSinceOpen = Math.max(0, Math.round((end - bounds.open) / MIN));
  const nextIsOtherDay = i + 1 < bars.length ? dayKey(bars.t[i + 1]!) !== day : true;
  const isLastBarOfDay = tf === 1440 || end >= bounds.close || (nextIsOtherDay && i + 1 < bars.length);
  return {
    isRegularSession: inSession,
    minutesToClose,
    minutesSinceOpen,
    barsSinceOpen,
    isLastBarOfDay,
    day,
  };
}
