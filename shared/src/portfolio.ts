/**
 * portfolio.ts — pure Portfolio-Kennzahlen (M12 Teil 1).
 *
 * Alles hier ist frei von IO und deterministisch testbar. Die Datei lag
 * zuerst unter `functions/src/core/`, gehört aber nach `shared/`: Seit der
 * Supabase-Migration gibt es ZWEI Aufrufer — den täglichen
 * `snapshotEquity`-Scheduler, der das Ergebnis nach users/{uid}/stats/main
 * schreibt, und die Supabase-Datenschicht, die dieselben Kennzahlen im
 * Browser aus equity_snapshots und trades rechnet. Zweimal implementiert
 * würden sie früher oder später verschiedene Zahlen zeigen; so bleibt es
 * eine Quelle mit einer Testreihe.
 *
 * Datums-Konvention: Kalendertage als ISO-Strings (YYYY-MM-DD) — bewusst OHNE
 * Zeitzonen-Arithmetik. Wochenend-/Feiertagslücken und DST-Wechsel sind damit
 * schlicht fehlende Tage in der Serie; eine Tagesrendite entsteht immer
 * zwischen zwei BENACHBARTEN Snapshots, egal wie viele Kalendertage dazwischen
 * liegen (Fr→Mo ist EINE Rendite, kein annualisierungs-verzerrendes Trio).
 */

export interface EquityPoint {
  date: string; // YYYY-MM-DD
  equity: number;
}

/** Geldbeträge/Prozente auf 2 Nachkommastellen. */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Serie säubern: ungültige Punkte raus, je Datum gewinnt der LETZTE Wert
 * (Doppel-Snapshot am selben Tag = Überschreiben, nie Doppelzählung),
 * aufsteigend sortiert.
 */
export function normalizeSeries(points: EquityPoint[]): EquityPoint[] {
  const byDate = new Map<string, number>();
  for (const p of points) {
    if (!p || typeof p.date !== 'string' || p.date.length !== 10) continue;
    if (typeof p.equity !== 'number' || !Number.isFinite(p.equity)) continue;
    byDate.set(p.date, p.equity);
  }
  return [...byDate.entries()]
    .map(([date, equity]) => ({ date, equity }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Tagesrenditen zwischen benachbarten Snapshots; Punkte mit Basis ≤ 0 tragen keine Rendite. */
export function dailyReturns(points: EquityPoint[]): number[] {
  const s = normalizeSeries(points);
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1]!.equity;
    if (prev > 0) out.push((s[i]!.equity - prev) / prev);
  }
  return out;
}

/**
 * Annualisierte Sharpe-Ratio (rf = 0) über Tagesrenditen. `null`, wenn die
 * Serie zu kurz ist (< 2 Renditen) oder flach (Streuung 0) — ein „Sharpe 0"
 * wäre in beiden Fällen eine Falschaussage.
 */
export function sharpe(returns: number[], periodsPerYear = 252): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return r2((mean / std) * Math.sqrt(periodsPerYear));
}

/** High-Water-Mark + maximaler und aktueller Drawdown (in %). */
export function drawdown(points: EquityPoint[]): {
  hwm: number | null;
  maxDDPct: number | null;
  currentDDPct: number | null;
} {
  const s = normalizeSeries(points);
  if (s.length === 0) return { hwm: null, maxDDPct: null, currentDDPct: null };
  let hwm = -Infinity;
  let maxDD = 0;
  for (const p of s) {
    hwm = Math.max(hwm, p.equity);
    if (hwm > 0) maxDD = Math.max(maxDD, (hwm - p.equity) / hwm);
  }
  const last = s[s.length - 1]!.equity;
  const current = hwm > 0 ? (hwm - last) / hwm : 0;
  return { hwm: r2(hwm), maxDDPct: r2(maxDD * 100), currentDDPct: r2(current * 100) };
}

/** Ein GESCHLOSSENER Trade (Verkauf bzw. Short-Cover mit realisiertem P&L). */
export interface ClosedTrade {
  symbol: string;
  pnl: number;
  assetClass?: string | null;
}

export interface TradeStats {
  n: number;
  wins: number;
  winRatePct: number | null;
  /** Bruttogewinn / Bruttoverlust; `null` ohne Verluste (statt Infinity). */
  profitFactor: number | null;
  /** Erwartungswert je Trade in Kontowährung. Expectancy-R folgt mit core/risk.ts (R-Multiples). */
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
}

export function tradeStats(closed: ClosedTrade[]): TradeStats {
  const valid = closed.filter((t) => typeof t.pnl === 'number' && Number.isFinite(t.pnl));
  const n = valid.length;
  if (n === 0) {
    return { n: 0, wins: 0, winRatePct: null, profitFactor: null, expectancy: null, avgWin: null, avgLoss: null };
  }
  const winners = valid.filter((t) => t.pnl > 0);
  const losers = valid.filter((t) => t.pnl < 0);
  const grossWin = winners.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((a, t) => a + t.pnl, 0));
  const total = valid.reduce((a, t) => a + t.pnl, 0);
  return {
    n,
    wins: winners.length,
    winRatePct: r2((winners.length / n) * 100),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    expectancy: r2(total / n),
    avgWin: winners.length > 0 ? r2(grossWin / winners.length) : null,
    avgLoss: losers.length > 0 ? r2(-grossLoss / losers.length) : null,
  };
}

/** Firestore-Map-Keys dürfen keine Punkte enthalten (würden Pfade verschachteln). */
function safeKey(raw: string): string {
  return raw.replace(/\./g, '_');
}

export interface AttributionSlice {
  pnl: number;
  n: number;
}

/** P&L-Attribution je Symbol und je Asset-Klasse (nur geschlossene Trades). */
export function attribution(closed: ClosedTrade[]): {
  bySymbol: Record<string, AttributionSlice>;
  byClass: Record<string, AttributionSlice>;
} {
  const bySymbol: Record<string, AttributionSlice> = {};
  const byClass: Record<string, AttributionSlice> = {};
  for (const t of closed) {
    if (typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) continue;
    const sym = safeKey(t.symbol);
    const cls = safeKey(t.assetClass ?? 'unbekannt');
    bySymbol[sym] = { pnl: r2((bySymbol[sym]?.pnl ?? 0) + t.pnl), n: (bySymbol[sym]?.n ?? 0) + 1 };
    byClass[cls] = { pnl: r2((byClass[cls]?.pnl ?? 0) + t.pnl), n: (byClass[cls]?.n ?? 0) + 1 };
  }
  return { bySymbol, byClass };
}

export interface PositionLike {
  qty: number;
  avgEntry: number;
  side?: 'long' | 'short';
}

/**
 * Bewertung einer offenen Position zum letzten Kurs — Long ist Marktwert,
 * Short ist Margin + unrealisierter P&L (dieselbe Spiegelung wie im
 * Shadow-Buch/Portfolio-UI: verdient, wenn der Kurs seit Einstieg fiel).
 * Ohne Kurs (null) wird konservativ zum Einstand bewertet.
 */
export function positionValue(pos: PositionLike, price: number | null): number {
  const p = typeof price === 'number' && price > 0 ? price : pos.avgEntry;
  if (pos.side === 'short') return pos.qty * pos.avgEntry + (pos.avgEntry - p) * pos.qty;
  return pos.qty * p;
}
