/**
 * News-Gate — die Rückkehr der News als PERFORMANCE-Werkzeug (Owner 29.07.).
 *
 * Beim ersten Anlauf (bis 28.07.) waren News eine Anzeige plus ein
 * Prognose-Tilt, der nie handelte. Diesmal ist die Rolle umgekehrt und
 * bewusst NEGATIV: Ein frisches hartes Ereignis (Earnings, Klage, Guidance …)
 * blockiert NEUE Einstiege in das Symbol. Um solche Ereignisse herum springen
 * Kurse (Gap-Risiko), und die technische Analyse, auf der die Konfluenz
 * beruht, ist genau dann am wenigsten wert. Ein Veto reduziert Trades — es
 * kann Gebühren also nur senken, nie erhöhen. Ausstiege bleiben IMMER frei.
 *
 * Alles hier ist pur und ohne Netz; das Abrufen und Scoren der Feeds liegt in
 * functions/src/core/news.ts (gratis RSS + Lexikon — kein einziger KI-Token).
 */

import type { SentimentScore } from './sentiment.ts';

/** Refresh-Takt je Symbol — schneller fragt der Scan die Feeds nicht. */
export const NEWS_TTL_SEC = 45 * 60;
/** Items älter als das fließen nicht mehr ins Aggregat ein. */
export const NEWS_FRESH_SEC = 24 * 3600;
/** Nur innerhalb dieses Fensters nach Veröffentlichung blockt ein Hard-Event. */
export const NEWS_VETO_WINDOW_SEC = 12 * 3600;
/**
 * Mindest-Magnitude (0..1) eines Hard-Events fürs Veto. 0.5 entspricht
 * Lexikon-Gewicht ≥ 3 — „TSLA misses estimates, shares plunge" (5) liegt
 * darüber, Routine-Berichterstattung („What to expect from Q3 earnings")
 * ohne wertende Wörter bei 0. Der Deckel gegen Dauer-Vetos bei viel
 * beschriebenen Symbolen wie AAPL ist genau diese Schwelle.
 */
export const NEWS_VETO_MIN_MAGNITUDE = 0.5;
/**
 * Ereignistypen mit Gap-Risiko (aus EVENT_PATTERNS in sentiment.ts).
 * 'analyst', 'product', 'capital', 'macro' bleiben draußen: Sie begleiten
 * normale Kursbewegung, statt sie zu zerreißen — ein Veto darauf würde die
 * Engine praktisch dauerhaft stilllegen.
 */
export const HARD_EVENT_TYPES = ['earnings', 'guidance', 'legal', 'm&a', 'leadership'] as const;

/** Eine Schlagzeile, wie sie am market-Doc gespeichert wird (Anzeige + Beleg). */
export interface NewsHeadline {
  title: string;
  source: string;
  url: string;
  ts: string; // ISO oder ''
  published: number; // Epoch-Sekunden oder 0
  sentiment: number;
  magnitude: number;
  eventTypes: string[];
}

/** Schärfstes frisches Hard-Event — der Beleg, auf dem ein Veto beruht. */
export interface HardEvent {
  type: string;
  magnitude: number;
  published: number;
  title: string;
}

/** Kompakte News-Lage eines Symbols (market/{sym}.news). */
export interface NewsSnapshot {
  /** Abruf-Zeitpunkt (Epoch-Sekunden) — steuert den Refresh-Takt. */
  fetchedT: number;
  at: string;
  /** Anzahl frischer Items (≤ NEWS_FRESH_SEC alt). */
  n: number;
  /** Magnitude-gewichteter Sentiment-Schnitt der frischen Items (−1..1). */
  sentiment: number;
  /** Höchste Magnitude unter den frischen Items (0..1). */
  magnitude: number;
  eventTypes: string[];
  hardEvent: HardEvent | null;
  /** Bis zu 5 frischeste Schlagzeilen für die Anzeige. */
  top: NewsHeadline[];
}

export interface ScoredNewsItem {
  title: string;
  source: string;
  url: string;
  ts: string;
  published: number;
  /** Score über Titel + Zusammenfassung (Sentiment, Magnitude, Events). */
  sent: SentimentScore;
  /**
   * Event-Typen NUR aus dem Titel. Der Live-Test vom 29.07. zeigte, warum
   * das eigene Feld nötig ist: Die Earnings-Wortliste ist breit (revenue,
   * eps, results …) und schlägt in fast jeder Artikel-ZUSAMMENFASSUNG über
   * einen Großkonzern an — AAPL stand damit im ersten Anlauf dauerhaft
   * unter Veto, wegen eines Kommentars über 52-Wochen-Hochs. Echte
   * Ereignisse stehen in der Schlagzeile. Fehlt das Feld, fällt die
   * Erkennung auf sent.eventTypes zurück (großzügiger, aber funktionsfähig).
   */
  titleEvents?: string[];
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Aggregiert ge-scorte Feed-Items zur gespeicherten News-Lage.
 *
 * Items ohne Zeitstempel (published 0) zählen NICHT: Was sich nicht datieren
 * lässt, kann kein zeitlich begrenztes Veto begründen — und ein Veto ohne
 * Ablaufdatum wäre eine Dauerabschaltung des Symbols.
 */
export function buildNewsSnapshot(items: ScoredNewsItem[], nowSec: number): NewsSnapshot {
  const fresh = items.filter(
    (it) => it.published > 0 && nowSec - it.published <= NEWS_FRESH_SEC && it.published <= nowSec + 300,
  );

  let num = 0;
  let den = 0;
  let maxMag = 0;
  const events = new Set<string>();
  let hard: HardEvent | null = null;
  for (const it of fresh) {
    const w = 0.4 + it.sent.magnitude; // gleiche Gewichtung wie aggregateSentiment
    num += it.sent.sentiment * w;
    den += w;
    maxMag = Math.max(maxMag, it.sent.magnitude);
    for (const et of it.sent.eventTypes) events.add(et);
    const hardType = (it.titleEvents ?? it.sent.eventTypes).find((et) =>
      (HARD_EVENT_TYPES as readonly string[]).includes(et),
    );
    if (hardType !== undefined && it.sent.magnitude >= NEWS_VETO_MIN_MAGNITUDE) {
      // Das SCHÄRFSTE Event gewinnt; bei Gleichstand das frischeste — es
      // bestimmt, wann das Veto abläuft.
      if (
        !hard
        || it.sent.magnitude > hard.magnitude
        || (it.sent.magnitude === hard.magnitude && it.published > hard.published)
      ) {
        hard = {
          type: hardType,
          magnitude: it.sent.magnitude,
          published: it.published,
          title: it.title.slice(0, 160),
        };
      }
    }
  }

  const top = [...fresh]
    .sort((a, b) => b.published - a.published)
    .slice(0, 5)
    .map((it) => ({
      title: it.title.slice(0, 200),
      source: it.source,
      url: it.url,
      ts: it.ts,
      published: it.published,
      sentiment: it.sent.sentiment,
      magnitude: it.sent.magnitude,
      eventTypes: it.sent.eventTypes,
    }));

  return {
    fetchedT: nowSec,
    at: new Date(nowSec * 1000).toISOString(),
    n: fresh.length,
    sentiment: den > 0 ? round3(num / den) : 0,
    magnitude: round3(maxMag),
    eventTypes: [...events],
    hardEvent: hard,
    top,
  };
}

/** Gleiche Neutral-Zone wie das Label in aggregateSentiment. */
export const SENT_LABEL_MIN = 0.12;
/** Älter als das gilt die News-Lage für den Sentiment-Schatten als abgestanden. */
export const NEWS_STAMP_MAX_AGE_SEC = 2 * 3600;

/**
 * Sentiment-Stempel für Shadow-Prognosen (−1/0/1 + Rohwert) — oder null,
 * wenn es keine frische News-Lage gibt. Der Unterschied ist gewollt:
 * „neutral bei vorhandenen News" (0) ist eine Beobachtung, „keine Daten"
 * (null) ist keine — nur Erstere landet als Feld am Prognose-Doc.
 */
export function shadowSentSign(
  snap: Pick<NewsSnapshot, 'fetchedT' | 'n' | 'sentiment'> | null | undefined,
  nowSec: number,
): { sign: -1 | 0 | 1; val: number } | null {
  if (!snap || snap.n <= 0) return null;
  if (nowSec - snap.fetchedT > NEWS_STAMP_MAX_AGE_SEC) return null;
  const s = snap.sentiment;
  const sign = s > SENT_LABEL_MIN ? 1 : s < -SENT_LABEL_MIN ? -1 : 0;
  return { sign, val: s };
}

export interface NewsVetoResult {
  blocked: boolean;
  /** Ereignistyp, der blockt — nur gesetzt wenn blocked. */
  type?: string;
}

/**
 * Das Einstiegs-Veto: blockt, wenn das gespeicherte Hard-Event zum
 * Prüfzeitpunkt noch im Veto-Fenster liegt. Bewusste Asymmetrie: Kein
 * Snapshot / kein Hard-Event / abgelaufenes Fenster ⇒ normal handeln.
 * Ein kaputter Feed schaltet also nie die Engine ab — er schaltet nur das
 * Veto ab (fails open; die Telemetrie im Heartbeat macht das sichtbar).
 */
export function newsVeto(
  snap: Pick<NewsSnapshot, 'hardEvent'> | null | undefined,
  nowSec: number,
): NewsVetoResult {
  const ev = snap?.hardEvent;
  if (!ev || ev.published <= 0) return { blocked: false };
  if (nowSec - ev.published > NEWS_VETO_WINDOW_SEC) return { blocked: false };
  if (ev.magnitude < NEWS_VETO_MIN_MAGNITUDE) return { blocked: false };
  return { blocked: true, type: ev.type };
}
