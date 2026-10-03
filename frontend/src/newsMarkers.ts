/**
 * News-Punkte fürs Chart (Rückkehr 29.07., Owner: „bitte nur die, die auch
 * genutzt werden — nicht extra nach News suchen").
 *
 * Quelle ist ausschließlich `market/{sym}.news` — die Schlagzeilen, die der
 * Scan ohnehin für das Einstiegs-Veto lädt und auf denen die Engine
 * entscheidet. Hier wird NICHTS nachgeladen; der Mapper ist pur und rechnet
 * nur Zeitstempel auf sichtbare Bar-Zeiten um.
 */

import type { ChartMarker } from './chart.js';
import { SENT_LABEL_MIN, newsVeto, type NewsSnapshot } from '@autotrd/shared';

export const NEWS_BULL = '#26cf9d';
export const NEWS_BEAR = '#f06a6a';
export const NEWS_NEUT = '#7f8ba3';
export const NEWS_VETO_COLOR = '#d9a441';

/**
 * Schlagzeilen auf Chart-Marker abbilden.
 *
 * `times` sind die SICHTBAREN Bar-Zeiten aufsteigend — ISO-Tage in der
 * Tages-Sicht, UNIX-Sekunden in der Intraday-Sicht. Jede Schlagzeile landet
 * am ersten Bar ab ihrer Veröffentlichung (nach Handelsschluss: am letzten).
 * Liegt sie VOR dem Fenster, entfällt sie — alte News am linken Rand zu
 * stapeln wäre Rauschen. Mehrere Schlagzeilen am selben Bar werden zu einem
 * Punkt (die mit der stärksten Wortwahl bestimmt die Farbe).
 *
 * Läuft gerade das Einstiegs-Veto, markiert ein gelber Pfeil den Bar des
 * auslösenden Ereignisses — dieselbe Information, die die Engine zum
 * Aussetzen bewegt, am selben Ort sichtbar.
 */
export function newsChartMarkers(
  snap: Pick<NewsSnapshot, 'top' | 'hardEvent'> | null | undefined,
  times: ReadonlyArray<string | number>,
  nowSec: number,
  /**
   * signals.newsVeto des Users. Hat er das Veto abgeschaltet, setzt SEINE
   * Engine nicht aus — dann darf das Chart auch keinen Veto-Pfeil zeigen
   * (Owner-Fund 29.07.: „kann Veto nicht zurücknehmen!?" — die Anzeige
   * ignorierte den Schalter und behauptete ein Aussetzen, das nicht stattfand).
   */
  vetoEnabled = true,
): ChartMarker[] {
  if (!snap || times.length === 0) return [];

  const barFor = (published: number): string | number | null => {
    const key: string | number =
      typeof times[0] === 'number' ? published : new Date(published * 1000).toISOString().slice(0, 10);
    if (key < times[0]!) return null; // vor dem Fenster
    for (const t of times) {
      if (t >= key) return t;
    }
    return times[times.length - 1]!; // nach dem letzten Bar (Handelsschluss)
  };

  // Je Bar der Punkt mit der stärksten Wortwahl
  const byBar = new Map<string | number, { sentiment: number; magnitude: number }>();
  for (const h of snap.top ?? []) {
    if (!(h.published > 0)) continue;
    const bar = barFor(h.published);
    if (bar === null) continue;
    const prev = byBar.get(bar);
    if (!prev || h.magnitude > prev.magnitude) {
      byBar.set(bar, { sentiment: h.sentiment, magnitude: h.magnitude });
    }
  }

  const markers: ChartMarker[] = [...byBar.entries()].map(([time, v]) => ({
    time,
    position: 'belowBar',
    color: v.sentiment > SENT_LABEL_MIN ? NEWS_BULL : v.sentiment < -SENT_LABEL_MIN ? NEWS_BEAR : NEWS_NEUT,
    shape: 'circle',
  }));

  // Aktives Veto: gelber Pfeil am Ereignis-Bar. DIESELBE Entscheidung wie im
  // Scan (newsVeto aus shared) — hier nur Anzeige; zwei eigene Fenster-Logiken
  // würden irgendwann auseinanderlaufen und das Chart etwas anderes zeigen,
  // als die Engine tut.
  if (vetoEnabled && newsVeto(snap, nowSec).blocked && snap.hardEvent) {
    const bar = barFor(snap.hardEvent.published);
    if (bar !== null) {
      markers.push({ time: bar, position: 'aboveBar', color: NEWS_VETO_COLOR, shape: 'arrowDown', text: 'Veto' });
    }
  }

  return markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** Inhalt des News-Overlays für einen Handelstag unterm Crosshair. */
export interface NewsTipData {
  date: string;
  /** Magnitude-gewichteter Schnitt der Tages-Schlagzeilen (−1..1). */
  sentiment: number;
  /** Einstiegs-Veto läuft UND sein Ereignis stammt von diesem Tag. */
  veto: boolean;
  items: Array<{ title: string; source: string; published: number; sentiment: number }>;
}

const utcDay = (published: number): string => new Date(published * 1000).toISOString().slice(0, 10);

/**
 * Schlagzeilen eines Tages fürs Crosshair-Overlay („den News bitte lesbar
 * machen", Owner 29.07.). Gleiche Quelle wie die Punkte — null, wenn der Tag
 * weder Schlagzeilen noch das Veto-Ereignis trägt (Overlay bleibt dann zu).
 */
export function newsForDay(
  snap: Pick<NewsSnapshot, 'top' | 'hardEvent'> | null | undefined,
  isoDate: string | null,
  nowSec: number,
  /** signals.newsVeto des Users — abgeschaltet ⇒ kein Veto-Hinweis (s. newsChartMarkers). */
  vetoEnabled = true,
): NewsTipData | null {
  if (!snap || !isoDate) return null;
  const items = (snap.top ?? [])
    .filter((h) => h.published > 0 && utcDay(h.published) === isoDate)
    .sort((a, b) => b.published - a.published)
    .map((h) => ({ title: h.title, source: h.source, published: h.published, sentiment: h.sentiment }));
  const veto =
    vetoEnabled
    && newsVeto(snap, nowSec).blocked
    && snap.hardEvent !== null
    && utcDay(snap.hardEvent.published) === isoDate;
  if (items.length === 0 && !veto) return null;
  let num = 0;
  let den = 0;
  for (const h of snap.top ?? []) {
    if (!(h.published > 0) || utcDay(h.published) !== isoDate) continue;
    const w = 0.4 + h.magnitude;
    num += h.sentiment * w;
    den += w;
  }
  return { date: isoDate, sentiment: den > 0 ? Math.round((num / den) * 1000) / 1000 : 0, veto, items };
}
