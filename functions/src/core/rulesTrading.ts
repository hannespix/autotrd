/**
 * Regelbaum-Trading (M10): pure Bausteine für die scanMarket-Integration.
 *
 * RISIKO-HÜLLE — lebt bewusst AUSSERHALB des Baums und ist von keinem Knoten
 * überschreibbar (MILESTONES M10):
 *   - maxPositionPct wird hart auf ≤ 25 % geklemmt
 *   - Pflicht-Stop-Loss: ohne (oder mit unsinnigem) Stop greift der Default
 *   - maxOpenPositions je User, Cooldown je (Strategie, Symbol)
 *   - Cooldown blockt nur ENTRIES — Exits (Stop/TP/Sell-Signal) nie
 *   - Stop/TP werden VOR jeder Regel-Auswertung geprüft (Risk-Exit-Pfad)
 */

import type {
  IndicatorSnapshot,
  RuleContext,
  SignalDirection,
  Strategy,
  StrategySpec,
} from '../../../shared/src/index.js';
import { evaluate } from '../../../shared/src/index.js';

export const RISK_LIMITS = {
  /** Harte Obergrenze je Position — auch wenn die Config mehr will. */
  maxPositionPct: 25,
  /** Pflicht-Stop-Loss: greift, wenn die Config keinen (>0) definiert. */
  fallbackStopLossPct: 2,
  /** Offene Positionen je User (Entries darüber hinaus werden verweigert). */
  maxOpenPositions: 10,
  /** Mindestabstand zwischen ENTRIES je (Strategie, Symbol) in Minuten. */
  cooldownMin: 30,
} as const;

/** Klemmt die Engine-Parameter einer Strategie in die Risiko-Hülle. */
export function clampStrategyRisk(strategy: Strategy): Strategy {
  const s = structuredClone(strategy);
  s.engine.maxPositionPct = Math.min(s.engine.maxPositionPct, RISK_LIMITS.maxPositionPct);
  if (!(s.engine.stopLossPct > 0)) {
    s.engine.stopLossPct = RISK_LIMITS.fallbackStopLossPct;
  }
  return s;
}

/** true, solange der Entry-Cooldown seit dem letzten Trade noch läuft. */
export function cooldownActive(lastTradeAt: string | undefined, now: Date): boolean {
  if (!lastTradeAt) return false;
  const last = Date.parse(lastTradeAt);
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last < RISK_LIMITS.cooldownMin * 60_000;
}

export interface RuleContextArgs {
  price: number;
  snapshot: IndicatorSnapshot;
  /** Snapshot des Vor-Bars (für crossover-Blätter); null wenn nicht berechenbar. */
  prevSnapshot?: IndicatorSnapshot | null;
  prevPrice?: number | null;
  closes: number[];
  minuteOfDayEt: number | null;
  sentiment?: number | null;
  forecastPct?: number | null;
  position: { open: boolean; unrealizedPct?: number | null } | null;
}

function snapshotValues(price: number, s: IndicatorSnapshot): RuleContext['values'] {
  return {
    price,
    rsi: s.rsi,
    macdLine: s.macd?.line,
    macdSignal: s.macd?.signal,
    macdHistogram: s.macd?.histogram,
    bbUpper: s.bollinger?.upper,
    bbMiddle: s.bollinger?.middle,
    bbLower: s.bollinger?.lower,
    pctB: s.bollinger?.pctB,
  };
}

/** Baut den RuleContext eines Symbols aus dem In-Memory-Scan (keine Fetches). */
export function buildRuleContext(args: RuleContextArgs): RuleContext {
  return {
    values: snapshotValues(args.price, args.snapshot),
    ...(args.prevSnapshot && args.prevPrice != null
      ? { prevValues: snapshotValues(args.prevPrice, args.prevSnapshot) }
      : {}),
    closes: args.closes,
    minuteOfDay: args.minuteOfDayEt,
    sentiment: args.sentiment ?? null,
    forecastPct: args.forecastPct ?? null,
    position: args.position,
  };
}

/**
 * Richtungsentscheidung einer kompilierten Spec. Beide Bäume strikt (unbekannt
 * ⇒ kein Trade); melden beide true — bei Custom-Bäumen möglich — gewinnt
 * bewusst NIEMAND (hold), statt zufällig eine Seite zu bevorzugen.
 */
export function decideTree(spec: StrategySpec, ctx: RuleContext): SignalDirection {
  const buy = evaluate(spec.buy, ctx);
  const sell = evaluate(spec.sell, ctx);
  if (buy && !sell) return 'buy';
  if (sell && !buy) return 'sell';
  return 'hold';
}

/* ── Shadow-Konto (M11): pure Buchführung des virtuellen Kontos ──────────────
   Kauf-Sizing wie der Paper-Broker (maxPositionPct der Balance, ganze Stücke),
   Verkauf stellt die Position komplett glatt. Kein echtes Wallet involviert. */

export interface ShadowBook {
  balance: number;
  positions: Record<string, { qty: number; avgEntry: number }>;
}

export function shadowTrade(
  book: ShadowBook,
  symbol: string,
  side: 'buy' | 'sell',
  price: number,
  maxPositionPct: number,
): { book: ShadowBook; executed: boolean } {
  const positions = { ...book.positions };
  if (side === 'buy') {
    if (positions[symbol]) return { book, executed: false }; // nie nachkaufen
    const qty = Math.floor((book.balance * (maxPositionPct / 100)) / price);
    if (qty <= 0) return { book, executed: false };
    positions[symbol] = { qty, avgEntry: price };
    return { book: { balance: book.balance - qty * price, positions }, executed: true };
  }
  const pos = positions[symbol];
  if (!pos) return { book, executed: false };
  delete positions[symbol];
  return { book: { balance: book.balance + pos.qty * price, positions }, executed: true };
}

/** Balance + Positionswert zu aktuellen Preisen (fehlender Preis → Einstand). */
export function shadowEquity(book: ShadowBook, prices: Map<string, number>): number {
  let equity = book.balance;
  for (const [sym, pos] of Object.entries(book.positions)) {
    equity += pos.qty * (prices.get(sym) ?? pos.avgEntry);
  }
  return Math.round(equity * 100) / 100;
}

/** Minuten seit Mitternacht in America/New_York (für timeWindow-Blätter). */
export function minuteOfDayEt(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string): number =>
    parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  return (get('hour') % 24) * 60 + get('minute');
}
