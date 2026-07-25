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
  UserPrediction,
} from '../../../shared/src/index.js';
import { PREDICTION_MIN_EDGE_PCT, evaluate } from '../../../shared/src/index.js';

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

/* ── Befördern (M11 A/B): purer Rollentausch-Plan ────────────────────── */

export interface PromotionCandidate {
  id: string;
  status: string;
  mode: 'paper' | 'shadow';
  symbols: string[];
}

/**
 * Plant den Rollentausch: Die Shadow-Strategie `targetId` wird paper; jede
 * publizierte PAPER-Strategie mit Symbol-Überlappung wird shadow (sonst
 * würden zwei Bäume dasselbe Wallet auf demselben Symbol handeln).
 * Nicht überlappende Paper-Strategien bleiben unberührt. Wirft bei
 * ungültigem Ziel — das Wallet selbst wird hier NIE angefasst (pure).
 */
export function planPromotion(
  list: PromotionCandidate[],
  targetId: string,
): { demote: string[] } {
  const target = list.find((s) => s.id === targetId);
  if (!target) throw new Error('Strategie existiert nicht');
  if (target.status !== 'published') throw new Error('Erst publizieren — nur publizierte Strategien handeln');
  if (target.mode !== 'shadow') throw new Error('Nur eine Shadow-Strategie lässt sich befördern');
  if (target.symbols.length === 0) throw new Error('Erst Symbole zuordnen, dann befördern');
  const targetSyms = new Set(target.symbols);
  const demote = list
    .filter(
      (s) =>
        s.id !== targetId &&
        s.status === 'published' &&
        s.mode === 'paper' &&
        s.symbols.some((sym) => targetSyms.has(sym)),
    )
    .map((s) => s.id);
  return { demote };
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

/* ── User-Prognose-Stimme (Chart-Vision 24.07.) ──────────────────────────────
   Der gezeichnete Pfeil wird zur gewichteten Richtungsstimme im Classic-Pfad:
   Ziel deutlich über dem Kurs → buy-Votes +confidence (analog sell).
   Abgelaufene oder richtungslose Prognosen zählen nicht. */

export function predictionVote(
  pred: UserPrediction | undefined,
  price: number,
  todayIso: string,
): { dir: 'buy' | 'sell'; weight: number } | null {
  if (!pred || !(price > 0)) return null;
  if (pred.targetDate < todayIso.slice(0, 10)) return null; // abgelaufen
  const edgePct = ((pred.targetPrice - price) / price) * 100;
  if (edgePct >= PREDICTION_MIN_EDGE_PCT) return { dir: 'buy', weight: pred.confidence };
  if (edgePct <= -PREDICTION_MIN_EDGE_PCT) return { dir: 'sell', weight: pred.confidence };
  return null; // Ziel ≈ Kurs → keine Richtung
}

/**
 * Konfluenz-Entscheidung mit Prognose-Stimme neu fällen — gleiche Regel wie
 * die Engine (votes ≥ required ∧ votes > Gegenseite), pure.
 */
export function applyPredictionVote(
  sig: { direction: SignalDirection; buyVotes: number; sellVotes: number; requiredConfluence: number },
  vote: { dir: 'buy' | 'sell'; weight: number } | null,
): SignalDirection {
  if (!vote) return sig.direction;
  const buy = sig.buyVotes + (vote.dir === 'buy' ? vote.weight : 0);
  const sell = sig.sellVotes + (vote.dir === 'sell' ? vote.weight : 0);
  if (buy >= sig.requiredConfluence && buy > sell) return 'buy';
  if (sell >= sig.requiredConfluence && sell > buy) return 'sell';
  return 'hold';
}
