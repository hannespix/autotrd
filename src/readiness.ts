/**
 * Live-Reife: Darf der Schalter auf Echtgeld umgelegt werden?
 *
 * Owner-Regel: „bis man sicher nur noch Gewinn schreibt, dann erst den
 * Schalter umlegen." Sicher ist nie — messbar ist aber, ob das Paper-
 * Journal groß und gut genug ist, um eine Kante nach Kosten überhaupt
 * zeigen zu können. Diese Datei rechnet das aus einem Trade-Verlauf
 * (Journal, `trade_closed`-Ereignisse) — dieselben Kennzahlen wie im
 * Backtest, nur aus echten Fills.
 *
 * Die Schwellen sind Mindestwerte, keine Garantie: 200 Trades über 30
 * Kalendertage mit Profit-Faktor ≥ 1,2 und Gebührenanteil ≤ 0,5 sind das
 * Minimum, ab dem man anfängt zu glauben — nicht der Beweis. Der
 * Vorgänger hatte bei 514 Trades einen Gebührenanteil von 0,57 und war
 * brutto positiv, netto negativ; genau dieser Fall soll hier durchfallen.
 *
 * Kein Lookahead: Trades, deren Exit nach `now` liegt, werden nicht
 * bewertet (sie sind nicht realisiert) und als `ignored` gezählt.
 */
import { DAY, dayKey, parseDay } from './core/time.ts';
import type { Ms, Trade } from './core/types.ts';

export interface ReadinessThresholds {
  /** Mindestanzahl abgeschlossener Trades (≥). */
  minTrades: number;
  /** Mindestspanne in Kalendertagen zwischen erstem Einstieg und letztem Ausstieg (≥). */
  minDays: number;
  /** Σ Netto-Gewinne / Σ |Netto-Verluste| (≥). */
  minProfitFactor: number;
  /** Σ Kosten / Σ Brutto-Gewinne (≤). */
  maxFeeShare: number;
  /** Σ Netto-PnL (>, strikt). */
  minNetProfit: number;
}

export const DEFAULT_READINESS_THRESHOLDS: Readonly<ReadinessThresholds> = {
  minTrades: 200,
  minDays: 30,
  minProfitFactor: 1.2,
  maxFeeShare: 0.5,
  minNetProfit: 0,
};

export type ReadinessCheckName = 'trades' | 'days' | 'profitFactor' | 'feeShare' | 'netProfit';

export interface ReadinessCheck {
  name: ReadinessCheckName;
  /** Lesbare Beschreibung inkl. Vergleich, z. B. „Profit-Faktor ≥ 1.2". */
  label: string;
  pass: boolean;
  /** null = nicht berechenbar (z. B. Gebührenanteil ohne Brutto-Gewinne) ⇒ fällt durch. */
  value: number | null;
  threshold: number;
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheck[];
  summary: string;
  /** Informativ, kein Kriterium: größter Rückgang der kumulierten Netto-PnL (Kontowährung, ≥ 0). */
  maxDrawdown: number;
  /** Trades, die nicht bewertet wurden (unvollständig, Exit vor Entry oder Exit nach `now`). */
  ignored: number;
  /** Bewertete Trades. */
  evaluated: number;
}

function isUsable(t: Trade | undefined, now: Ms): t is Trade {
  return (
    !!t &&
    typeof t === 'object' &&
    Number.isFinite(t.netPnl) &&
    Number.isFinite(t.grossPnl) &&
    Number.isFinite(t.fees) &&
    Number.isFinite(t.entryTime) &&
    Number.isFinite(t.exitTime) &&
    t.exitTime >= t.entryTime &&
    t.exitTime <= now
  );
}

/** Kalendertage (ET) zwischen zwei Zeitstempeln, tagesgenau: gleicher Tag ⇒ 0. */
export function calendarDaysBetween(from: Ms, to: Ms): number {
  const a = parseDay(dayKey(from));
  const b = parseDay(dayKey(to));
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY);
}

/**
 * Größter Rückgang der Equity-Kurve, die aus den kumulierten Netto-PnL
 * (Reihenfolge nach Exit-Zeit, Start bei 0) entsteht. Absolut in
 * Kontowährung — ohne Startkapital gibt es keinen sinnvollen Prozentwert.
 */
export function maxDrawdownFromTrades(trades: readonly Trade[]): number {
  const sorted = [...trades].sort((x, y) => x.exitTime - y.exitTime);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.netPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function fmt(v: number | null): string {
  if (v === null || Number.isNaN(v)) return '–';
  if (v === Number.POSITIVE_INFINITY) return '∞';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function assessReadiness(trades: readonly Trade[], now: Ms, thresholds: Partial<ReadinessThresholds> = {}): ReadinessReport {
  const th: ReadinessThresholds = { ...DEFAULT_READINESS_THRESHOLDS, ...thresholds };
  const usable: Trade[] = [];
  for (const t of trades as readonly (Trade | undefined)[]) {
    if (isUsable(t, now)) usable.push(t);
  }
  const ignored = trades.length - usable.length;

  let grossWins = 0; // Σ grossPnl > 0
  let netWins = 0; // Σ netPnl > 0
  let netLosses = 0; // Σ |netPnl < 0|
  let fees = 0;
  let net = 0;
  let firstEntry = Number.POSITIVE_INFINITY;
  let lastExit = Number.NEGATIVE_INFINITY;
  for (const t of usable) {
    if (t.grossPnl > 0) grossWins += t.grossPnl;
    if (t.netPnl > 0) netWins += t.netPnl;
    else if (t.netPnl < 0) netLosses += -t.netPnl;
    fees += t.fees;
    net += t.netPnl;
    if (t.entryTime < firstEntry) firstEntry = t.entryTime;
    if (t.exitTime > lastExit) lastExit = t.exitTime;
  }

  const days = usable.length > 0 ? calendarDaysBetween(firstEntry, lastExit) : null;
  let profitFactor: number | null;
  if (netLosses > 0) profitFactor = netWins / netLosses;
  else if (netWins > 0) profitFactor = Number.POSITIVE_INFINITY;
  else profitFactor = null;
  const feeShare = grossWins > 0 ? fees / grossWins : null;

  const checks: ReadinessCheck[] = [
    {
      name: 'trades',
      label: `Trades ≥ ${th.minTrades}`,
      pass: usable.length >= th.minTrades,
      value: usable.length,
      threshold: th.minTrades,
    },
    {
      name: 'days',
      label: `Kalendertage (erster Einstieg → letzter Ausstieg) ≥ ${th.minDays}`,
      pass: days !== null && days >= th.minDays,
      value: days,
      threshold: th.minDays,
    },
    {
      name: 'profitFactor',
      label: `Profit-Faktor (netto) ≥ ${th.minProfitFactor}`,
      pass: profitFactor !== null && profitFactor >= th.minProfitFactor,
      value: profitFactor,
      threshold: th.minProfitFactor,
    },
    {
      name: 'feeShare',
      // Live stehen in `fees` nur explizite Gebühren (SEC/TAF, Krypto-Taker); Slippage und Spread stecken im
      // Fill-Kurs und damit schon in brutto/netto. Der Simulator bucht Slippage getrennt — die Zahl ist
      // deshalb nicht 1:1 mit dem Optimierer-Gate vergleichbar; Profit-Faktor und Netto tragen die Kosten.
      label: `Gebührenanteil (Σ explizite Gebühren SEC/TAF bzw. Krypto-Taker / Σ Brutto-Gewinne; Slippage steckt im Kurs) ≤ ${th.maxFeeShare}`,
      pass: feeShare !== null && feeShare <= th.maxFeeShare,
      value: feeShare,
      threshold: th.maxFeeShare,
    },
    {
      name: 'netProfit',
      label: `Netto-Ergebnis > ${th.minNetProfit}`,
      pass: usable.length > 0 && net > th.minNetProfit,
      value: net,
      threshold: th.minNetProfit,
    },
  ];

  const ready = checks.every((c) => c.pass);
  const passed = checks.filter((c) => c.pass).length;
  const maxDrawdown = maxDrawdownFromTrades(usable);

  const lines: string[] = [
    `Live-Reife: ${ready ? 'ERREICHT' : 'NICHT ERREICHT'} (${passed}/${checks.length} Kriterien) — Stand ${dayKey(now)}, ${usable.length} Trades bewertet${
      ignored > 0 ? `, ${ignored} ignoriert` : ''
    }`,
  ];
  for (const c of checks) lines.push(`  ${c.pass ? '✔' : '✘'} ${c.label}: ${fmt(c.value)}`);
  lines.push(`  ℹ Max. Drawdown der kumulierten Netto-PnL: ${fmt(maxDrawdown)}`);
  if (!ready) lines.push('  Echtgeld bleibt gesperrt: broker.mode=live NICHT setzen, bis alle Kriterien erfüllt sind.');

  return { ready, checks, summary: lines.join('\n'), maxDrawdown, ignored, evaluated: usable.length };
}
