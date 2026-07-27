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
  /** Ergebnis NACH Gebühren — der Broker rechnet sie in den Ausführungspreis. */
  pnl: number;
  assetClass?: string | null;
  /**
   * Warum die Position geschlossen wurde: `stop_loss` · `take_profit` ·
   * `trailing_stop` · … Fehlend heißt: durch ein SIGNAL geschlossen, nicht
   * durch eine Risiko-Marke.
   */
  riskExit?: string | null;
  /** Positionswert beim Schließen (Stück × Preis) — Basis der Gebührenschätzung. */
  notional?: number | null;
  /** Gebührensatz JE SEITE (Kommission + Slippage), z. B. 0,0015. */
  feeRate?: number | null;
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


/* ── Ausstiegsgründe & Kostenprofil (MT1) ────────────────────────────────────
 *
 * Warum es das gibt: Die Auswertung zweier Testkonten am 27.07. brauchte
 * einen Menschen mit Taschenrechner. Aus „Win Rate 12 %, Profit-Faktor 0,04"
 * musste von Hand zurückgerechnet werden, dass praktisch ALLE Trades am
 * Signal-Ausstieg sterben (nie an Stop oder Take) und die Gebühren 54–86 %
 * des Verlusts ausmachen. Beides war nirgends ablesbar. Ein System, das sich
 * selbst verbessern soll, muss das selbst sehen. */

/** Sammelschlüssel für Trades, die kein Risiko-Exit geschlossen hat. */
export const EXIT_SIGNAL = 'signal';

export interface ExitBucket {
  n: number;
  pnl: number;
  wins: number;
}

/**
 * Trades nach Ausstiegsgrund gruppieren.
 *
 * Die entscheidende Frage, die das beantwortet: Erreichen die Trades ihre
 * Risiko-Marken überhaupt? Steht fast alles unter `signal`, sind Stop und
 * Take reine Dekoration — dann entscheidet nicht die Risikosteuerung über
 * das Ergebnis, sondern das Kippen einer Indikator-Stimme.
 */
export function exitBreakdown(closed: ClosedTrade[]): Record<string, ExitBucket> {
  const out: Record<string, ExitBucket> = {};
  for (const t of closed) {
    if (typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) continue;
    // Punkte im Schlüssel würden in Firestore eine Verschachtelung erzeugen.
    const key = (t.riskExit || EXIT_SIGNAL).replace(/\./g, '_');
    const b = out[key] ?? { n: 0, pnl: 0, wins: 0 };
    b.n += 1;
    b.pnl = Math.round((b.pnl + t.pnl) * 100) / 100;
    if (t.pnl > 0) b.wins += 1;
    out[key] = b;
  }
  return out;
}

export interface CostProfile {
  /** Trades, bei denen Positionswert und Gebührensatz bekannt sind. */
  n: number;
  /** Geschätzte Gebühren insgesamt (beide Seiten). */
  fees: number;
  /** Ergebnis VOR Gebühren = Netto-Ergebnis + Gebühren. */
  grossPnl: number;
  /** Anteil der Gebühren am Betrag des Netto-Ergebnisses, in Prozent. */
  feeSharePct: number | null;
  /** Ø Gewinnbewegung vor Gebühren, in Prozent des Positionswerts. */
  avgWinGrossPct: number | null;
  /** Ø Verlustbewegung vor Gebühren, in Prozent des Positionswerts. */
  avgLossGrossPct: number | null;
  /** Roundtrip-Kosten in Prozent (beide Seiten). */
  roundTripPct: number | null;
  /**
   * Ø Gewinnbewegung geteilt durch die Roundtrip-Kosten — die EINE Zahl, die
   * sagt, ob eine Strategie überhaupt Luft über der Reibung hat. Unter 2
   * verdient überwiegend der Broker; die Testkonten lagen bei 1,6 und 1,9.
   */
  edgeOverCost: number | null;
}

const LEER: CostProfile = {
  n: 0, fees: 0, grossPnl: 0, feeSharePct: null, avgWinGrossPct: null,
  avgLossGrossPct: null, roundTripPct: null, edgeOverCost: null,
};

/**
 * Kostenprofil der geschlossenen Trades.
 *
 * Die Gebühr wird geschätzt, nicht gespeichert: Der Broker rechnet sie in den
 * Ausführungspreis (`paperEffectivePrice`), also steckt sie bereits im `pnl`.
 * Beide Seiten zusammen sind `Positionswert × Satz × 2` — dieselbe Rechnung,
 * mit der die Ursache am 27.07. gefunden wurde.
 */
export function costProfile(closed: ClosedTrade[]): CostProfile {
  const valid = closed.filter(
    (t) =>
      typeof t.pnl === 'number' && Number.isFinite(t.pnl) &&
      typeof t.notional === 'number' && t.notional > 0 &&
      typeof t.feeRate === 'number' && t.feeRate >= 0,
  );
  if (valid.length === 0) return { ...LEER };

  let fees = 0;
  let netto = 0;
  let rtSum = 0;
  const winPcts: number[] = [];
  const lossPcts: number[] = [];
  for (const t of valid) {
    const notional = t.notional as number;
    const fee = notional * (t.feeRate as number) * 2;
    fees += fee;
    netto += t.pnl;
    rtSum += (t.feeRate as number) * 2 * 100;
    const grossPct = ((t.pnl + fee) / notional) * 100;
    if (t.pnl > 0) winPcts.push(grossPct);
    else if (t.pnl < 0) lossPcts.push(Math.abs(grossPct));
  }
  const mittel = (xs: number[]): number | null =>
    xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000;

  const avgWinGrossPct = mittel(winPcts);
  const roundTripPct = Math.round((rtSum / valid.length) * 10000) / 10000;
  return {
    n: valid.length,
    fees: Math.round(fees * 100) / 100,
    grossPnl: Math.round((netto + fees) * 100) / 100,
    // Bei einem Netto-Ergebnis nahe 0 wäre der Anteil beliebig groß — dann
    // sagt die Zahl nichts, also lieber null als eine Scheinpräzision.
    feeSharePct:
      Math.abs(netto) > 0.005 ? Math.round((fees / Math.abs(netto)) * 1000) / 10 : null,
    avgWinGrossPct,
    avgLossGrossPct: mittel(lossPcts),
    roundTripPct,
    edgeOverCost:
      avgWinGrossPct !== null && roundTripPct > 0
        ? Math.round((avgWinGrossPct / roundTripPct) * 100) / 100
        : null,
  };
}
