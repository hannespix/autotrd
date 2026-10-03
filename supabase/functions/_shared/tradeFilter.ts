/**
 * Selbstlernender Trade-Filter („Meta-Labeling", Performance-Plan 31.07.).
 *
 * Die Idee in einem Satz: Die Maschine lernt aus ihren EIGENEN
 * abgeschlossenen Trades, welche Sorte Einstieg Geld verdient — und blockt
 * die Sorten, die es nachweislich nicht tun. Das ist die Fortsetzung der
 * Beweislast-Umkehr auf Trade-Ebene: Nicht der Filter muss beweisen, dass
 * eine Signalsorte schlecht ist — die Sorte verliert ihr Handelsrecht,
 * sobald genügend realisierte Trades sie überführen.
 *
 * Jeder geschlossene Trade wird in einen STECKBRIEF (Bucket) einsortiert:
 * Anlageklasse × Zeitrahmen × Signal-Signatur × Seite (× Regime, sobald die
 * Regime-Ampel existiert — der Slot ist von Anfang an im Schlüssel, damit
 * die Statistik dann nicht neu beginnen muss). Je Steckbrief zählen n,
 * Gewinner, P&L-Summe und P&L-Quadratsumme — Letztere macht eine
 * t-Statistik des Erwartungswerts möglich, ohne Einzeltrades zu speichern.
 *
 * KEIN LOOKAHEAD: Die Statistik wird ausschließlich von GESCHLOSSENEN
 * Trades gefüttert (der Steckbrief wird beim ÖFFNEN gestempelt, gezählt
 * wird beim Schließen). Ein Steckbrief blockt erst ab FILTER_MIN_SAMPLES
 * realisierten Trades UND signifikant negativem Erwartungswert — ein
 * Filter, der auf 5 Verlierern basiert, wäre nur Rauschen mit Meinung.
 *
 * Alles hier ist pur; Firestore-Verdrahtung (meta/tradeFilter, Stempel am
 * Positions-Doc, Schatten-Zähler im Heartbeat) liegt in functions/.
 */

/** Realisierte Statistik eines Steckbriefs. */
export interface BucketStat {
  n: number;
  wins: number;
  pnlSum: number;
  /** Summe der P&L-Quadrate — für die Standardabweichung ohne Einzeldaten. */
  pnlSqSum: number;
}

/**
 * Ab wie vielen realisierten Trades ein Steckbrief überhaupt urteilen darf.
 * 30 ist bewusst konservativ: Bei ~50–100 Trades/Woche über alle Konten
 * füllen sich die großen Steckbriefe in Tagen, die exotischen nie — und
 * genau die sollen auch nie blocken.
 */
export const FILTER_MIN_SAMPLES = 30;

/**
 * t-Schwelle, unter der ein Steckbrief blockt (Erwartungswert signifikant
 * negativ). −1,5 entspricht einseitig ungefähr p ≈ 0,07 — bewusst nicht
 * −2, denn der Preis eines falschen Blocks ist nur eine verpasste Chance,
 * der Preis eines falschen Durchlasses ist realisierter Verlust plus
 * Gebühren. Die Asymmetrie gehört in die Schwelle.
 */
export const FILTER_T_BLOCK = -1.5;

/**
 * Signal-Signatur: WELCHE Stimmen den Einstieg getragen haben — sortiert,
 * damit 'bb+rsi' und 'rsi+bb' derselbe Steckbrief sind. Ohne Kauf-Stimmen
 * (z. B. Regelbaum-Pfad ohne Vote-Karte) 'keine'.
 */
export function signalSignature(
  votes: Record<string, 'buy' | 'sell' | 'hold'> | null | undefined,
  side: 'buy' | 'sell' = 'buy',
): string {
  const traeger = Object.entries(votes ?? {})
    .filter(([, v]) => v === side)
    .map(([k]) => k)
    .sort();
  return traeger.length > 0 ? traeger.join('+') : 'keine';
}

/**
 * Steckbrief-Schlüssel. Der Regime-Slot steht ab Tag 1 im Schlüssel
 * (Default 'alle'): Kommt die Regime-Ampel, bekommen neue Trades echte
 * Regime-Werte und sammeln FRISCHE Evidenz je Regime, statt die alte
 * Statistik umzudeuten.
 */
export function bucketKey(parts: {
  assetClass: string;
  timeframe: 'daily' | 'intraday';
  signature: string;
  side: 'long' | 'short';
  regime?: string;
}): string {
  return [
    parts.assetClass,
    parts.timeframe,
    parts.signature,
    parts.side,
    parts.regime ?? 'alle',
  ].join('|');
}

/** Statistik-Update aus EINEM geschlossenen Trade (pur, neues Objekt). */
export function updateBucket(stat: BucketStat | null | undefined, pnl: number): BucketStat {
  const s = stat ?? { n: 0, wins: 0, pnlSum: 0, pnlSqSum: 0 };
  return {
    n: s.n + 1,
    wins: s.wins + (pnl > 0 ? 1 : 0),
    pnlSum: s.pnlSum + pnl,
    pnlSqSum: s.pnlSqSum + pnl * pnl,
  };
}

/**
 * t-Statistik des Erwartungswerts: mean / (sd / √n). null, wenn zu wenige
 * Trades oder keine Streuung vorliegt (sd 0 wäre eine Division durch 0 —
 * und ein Steckbrief, in dem jeder Trade identisch ausging, ist ohnehin
 * verdächtig, nicht beweiskräftig).
 */
export function bucketTStat(stat: BucketStat | null | undefined): number | null {
  if (!stat || stat.n < 2) return null;
  const mean = stat.pnlSum / stat.n;
  const variance = Math.max(0, (stat.pnlSqSum - stat.n * mean * mean) / (stat.n - 1));
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return mean / (sd / Math.sqrt(stat.n));
}

export interface FilterVerdict {
  blocked: boolean;
  /** t-Statistik (null = nicht berechenbar) — Transparenz für Heartbeat/UI. */
  t: number | null;
  n: number;
}

/**
 * Das Urteil eines Steckbriefs. Blockt NUR bei genügend Evidenz UND
 * signifikant negativem Erwartungswert. Fehlender/junger Steckbrief ⇒
 * handeln wie bisher — der Filter kann Trades nur verhindern, nie erzeugen,
 * und er beginnt stumm (dieselbe Schule wie News-Veto und Forecast-Vote).
 */
export function bucketVerdict(stat: BucketStat | null | undefined): FilterVerdict {
  const n = stat?.n ?? 0;
  const t = bucketTStat(stat);
  const blocked = n >= FILTER_MIN_SAMPLES && t !== null && t < FILTER_T_BLOCK;
  return { blocked, t, n };
}
