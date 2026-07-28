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
import { PREDICTION_MIN_EDGE_PCT, evaluate, paperEffectivePrice } from '../../../shared/src/index.js';

export const RISK_LIMITS = {
  /** Harte Obergrenze je Position — auch wenn die Config mehr will. */
  maxPositionPct: 25,
  /**
   * NOTBREMSE, kein Ersatz-Stop (26.07.): Wer stopLossPct auf 0 setzt, will
   * bewusst keine enge Reißleine — eine Auto-Engine ganz ohne Verlust-
   * begrenzung kann ein Konto aber ruinieren. Deshalb bleibt ein WEITER
   * Katastrophen-Stop stehen. Vorher standen hier 2 %, was „aus" faktisch
   * unmöglich machte und bei volatilen Werten dauernd auslöste.
   */
  emergencyStopPct: 25,
  /** Offene Positionen je User (Entries darüber hinaus werden verweigert). */
  maxOpenPositions: 10,
  /** Default-Kauf-Pause je Symbol in Minuten — engine.cooldownMin
   *  überschreibt sie (Klemme 5–1440 in clampStrategyRisk). */
  cooldownMin: 30,
} as const;

/** Klemmt die Engine-Parameter einer Strategie in die Risiko-Hülle. */
export function clampStrategyRisk(strategy: Strategy): Strategy {
  const s = structuredClone(strategy);
  s.engine.maxPositionPct = Math.min(s.engine.maxPositionPct, RISK_LIMITS.maxPositionPct);
  if (!(s.engine.stopLossPct >= 0) || !Number.isFinite(s.engine.stopLossPct)) {
    s.engine.stopLossPct = RISK_LIMITS.emergencyStopPct;
  } else if (s.engine.stopLossPct === 0) {
    // „Aus" heißt: kein regulärer Stop — die Notbremse bleibt.
    s.engine.stopLossPct = RISK_LIMITS.emergencyStopPct;
  }
  // Kauf-Pause konfigurierbar (Owner 26.07.: „Tradefrequenz erhöhen"), aber
  // in der Hülle: unter 5 min ist sie gegen den 5-min-Scan-Takt wirkungslos,
  // über 1 Tag wäre sie ein verstecktes Handelsverbot.
  const cd = s.engine.cooldownMin;
  s.engine.cooldownMin = Number.isFinite(cd) ? Math.min(1440, Math.max(5, cd as number)) : 60;
  // Mindest-Haltedauer in derselben Hülle: 0 heißt bewusst „aus" (Verhalten
  // wie bisher), mehr als ein Tag wäre eine versteckte Positions-Sperre.
  const mh = s.engine.minHoldMin;
  s.engine.minHoldMin = Number.isFinite(mh) ? Math.min(1440, Math.max(0, mh as number)) : 60;
  return s;
}

/**
 * true, solange die Mindest-Haltedauer seit Eröffnung noch läuft.
 *
 * Warum es das gibt (Owner-Screenshots 27.07.): Zwei Testkonten zeigten
 * Ø-Gewinne von 0,49 % und Ø-Verluste von 0,36 % — beide weit unter Stop
 * (1,5 %) und Take-Profit (3 %). Praktisch KEIN Trade erreichte also seine
 * Risiko-Marken; sie starben alle am Signal-Ausstieg, der bei einer einzigen
 * Gegenstimme feuert. Auf 5-min-Bars kippt permanent eine von drei Stimmen,
 * und bei 0,30 % Roundtrip-Kosten fraß die Reibung 54 % bzw. 86 % des
 * Verlusts. Die Mindest-Haltedauer gibt einer Position Zeit, sich zu
 * entwickeln, statt sie im nächsten Rauschen wieder auszuspucken.
 *
 * WICHTIG: Sie bremst NUR den Signal-Ausstieg. Stop-Loss, Trailing-Stop und
 * Take-Profit laufen unverändert bei jedem Scan — das Sicherheitsnetz darf
 * eine Haltefrist niemals aushebeln.
 */
export function minHoldActive(
  openedAt: string | undefined,
  now: Date,
  minutes: number,
): boolean {
  if (!openedAt || !Number.isFinite(minutes) || minutes <= 0) return false;
  const opened = Date.parse(openedAt);
  if (!Number.isFinite(opened)) return false;
  return now.getTime() - opened < minutes * 60_000;
}

/** true, solange der Entry-Cooldown seit dem letzten Trade noch läuft. */
export function cooldownActive(
  lastTradeAt: string | undefined,
  now: Date,
  minutes: number = RISK_LIMITS.cooldownMin,
): boolean {
  if (!lastTradeAt) return false;
  const last = Date.parse(lastTradeAt);
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last < minutes * 60_000;
}

export interface RuleContextArgs {
  price: number;
  snapshot: IndicatorSnapshot;
  /** Snapshot des Vor-Bars (für crossover-Blätter); null wenn nicht berechenbar. */
  prevSnapshot?: IndicatorSnapshot | null;
  prevPrice?: number | null;
  closes: number[];
  minuteOfDayEt: number | null;
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
   Kauf-Sizing wie der Paper-Broker (Duell-Parität: gleiche Sizing-Basis,
   gleiche Gebühren, ganze Stücke), Verkauf stellt die Position komplett
   glatt. Kein echtes Wallet involviert. */

export interface ShadowPosition {
  qty: number;
  avgEntry: number;
  /** Höchstkurs seit Einstieg — Basis des nachziehenden Stops (MA4-Parität). */
  highWater?: number;
  /** ISO-Einstiegszeit — Basis der Zeitgrenze maxHoldDays (MA4-Parität). */
  openedAt?: string;
  /** Leerverkauf (Short R2): fehlend = 'long' — Parität zum echten Broker. */
  side?: 'long' | 'short';
  /** Tiefstkurs seit Short-Einstieg (Basis des gespiegelten Trailings). */
  lowWater?: number;
}

export interface ShadowBook {
  balance: number;
  positions: Record<string, ShadowPosition>;
}

export function shadowTrade(
  book: ShadowBook,
  symbol: string,
  side: 'buy' | 'sell',
  price: number,
  maxPositionPct: number,
  opts?: {
    /**
     * Sizing-Basis des Kaufs (MA4-Duell-Parität zu broker.sizingBase):
     * ohne Angabe der verfügbare Shadow-Cash ('balance'-Verhalten); mit
     * Angabe z. B. das Startkapital ('initial'). Die DECKUNG prüft immer
     * der Shadow-Cash — wie beim echten Broker ('zu_wenig_cash').
     */
    capital?: number;
    /** Einstiegszeit für maxHoldDays (Default: nicht gesetzt). */
    now?: Date;
    /** Krypto handelt in Bruchteilen (µ-Einheiten) — Parität zu sizeOrder. */
    fractional?: boolean;
    /** sell ohne Position eröffnet einen Short (Parität zu TradeRequest). */
    openShort?: boolean;
  },
): { book: ShadowBook; executed: boolean } {
  const positions = { ...book.positions };
  // Gleiche Ausführungskosten wie das echte Paper-Buch (Duell-Parität)
  const eff = Math.round(paperEffectivePrice(price, side) * 10_000) / 10_000;
  const sizedQty = (): number => {
    const capital = Math.max(0, opts?.capital ?? book.balance);
    const raw = (capital * (maxPositionPct / 100)) / eff;
    return opts?.fractional ? Math.floor(raw * 1e6) / 1e6 : Math.floor(raw);
  };
  if (side === 'buy') {
    const existing = positions[symbol];
    if (existing?.side === 'short') {
      // Eindecken (Cover): Margin + P&L zurück — wie der echte Broker
      const pnl = (existing.avgEntry - eff) * existing.qty;
      delete positions[symbol];
      return { book: { balance: book.balance + existing.qty * existing.avgEntry + pnl, positions }, executed: true };
    }
    if (existing) return { book, executed: false }; // nie nachkaufen
    const qty = sizedQty();
    if (qty < (opts?.fractional ? 1e-6 : 1)) return { book, executed: false };
    if (qty * eff > book.balance) return { book, executed: false }; // Deckung wie beim Broker
    positions[symbol] = {
      qty,
      avgEntry: eff,
      highWater: eff,
      ...(opts?.now ? { openedAt: opts.now.toISOString() } : {}),
    };
    return { book: { balance: book.balance - qty * eff, positions }, executed: true };
  }
  const pos = positions[symbol];
  if (!pos) {
    // Leerverkauf (Short R2): 100-%-Margin vom Shadow-Cash, Level-Logik
    // übernimmt riskExitReason über die gespiegelte Pseudo-Position.
    if (!opts?.openShort) return { book, executed: false };
    const qty = sizedQty();
    if (qty < (opts?.fractional ? 1e-6 : 1)) return { book, executed: false };
    if (qty * eff > book.balance) return { book, executed: false };
    positions[symbol] = {
      qty,
      avgEntry: eff,
      side: 'short',
      lowWater: eff,
      ...(opts?.now ? { openedAt: opts.now.toISOString() } : {}),
    };
    return { book: { balance: book.balance - qty * eff, positions }, executed: true };
  }
  if (pos.side === 'short') return { book, executed: false }; // kein Nachverkauf auf Shorts
  delete positions[symbol];
  return { book: { balance: book.balance + pos.qty * eff, positions }, executed: true };
}

/** Balance + Positionswert zu aktuellen Preisen (fehlender Preis → Einstand).
 *  Shorts stecken mit Margin + unrealisiertem P&L im Depotwert. */
export function shadowEquity(book: ShadowBook, prices: Map<string, number>): number {
  let equity = book.balance;
  for (const [sym, pos] of Object.entries(book.positions)) {
    const live = prices.get(sym) ?? pos.avgEntry;
    equity += pos.side === 'short'
      ? pos.qty * pos.avgEntry + (pos.avgEntry - live) * pos.qty
      : pos.qty * live;
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
