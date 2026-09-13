/**
 * Order-Ausführung gegen den Broker-Vertrag (AlpacaClient).
 *
 * Die Regeln, die hier Geld schützen (jede hat beim Vorgänger gekostet):
 *  1. Idempotenz an der logischen Einheit: vor jedem Senden per
 *     `getOrderByClientId` nachsehen; gibt es die Order, wird sie NICHT
 *     erneut gesendet (Einstieg je Bucket, Exit/Stop je Position).
 *  2. Nichts buchen ohne bestätigten Fill — Positionen entstehen nur aus
 *     Fill-Ereignissen (trade_updates) oder per REST gelesenen Fills.
 *     Stream und REST laufen über dieselben idempotenten Buchungspfade
 *     (`applyEntryFill`/`applyExitFill`), gemessen an der kumulierten
 *     Füllmenge — egal, wer zuerst kommt.
 *  3. Storno VOR jedem eigenen Exit; Cancel-422 ⇒ Order-Stand abfragen:
 *     hat das Bein gefüllt, hat ES die Position geschlossen ⇒ kein
 *     Nachverkauf (sonst: 10 Stück verkauft UND 10 leerverkauft).
 *  4. Jede Position hat einen Schutz-Stop beim Broker; fehlt er, wird er
 *     gesetzt. Rundung: Stops VOM Kurs WEG, Limits ZUM Kurs HIN.
 *
 * Gebühren: Das Live-Buch bucht regulatorische Gebühren nach Kostenmodell (SEC/TAF, Krypto-Taker). Alpaca weist Aktien-Gebühren
 * (SEC/TAF) und Krypto-Gebühren erst in der Konto-Historie aus — sie
 * werden später aus dem Konto nachgetragen, nicht hier geschätzt; der
 * Simulator rechnet sie über das Kostenmodell.
 */
import { AlpacaError, isOpenStatus, type AlpacaClient, type AlpacaOrder, type NewOrder, type TradeUpdate } from '../alpaca/types.ts';
import type { CostConfig } from '../core/config.ts';
import type { JournalLike } from '../core/journal.ts';
import { errMsg, logger } from '../core/log.ts';
import { regulatoryFees } from '../backtest/costs.ts';
import { openPosition } from '../core/logic.ts';
import { DAY, dayKeyFor, type Calendar } from '../core/time.ts';
import type { AssetClass, ExitReason, Ms, OrderIntent, ParkIntent, PositionState, Side, TimeframeMin } from '../core/types.ts';
import { PARK_STRATEGY_ID, PARK_STUFE } from '../risk/parken.ts';
import type { Book, EnterIntent, ExitIntent, MoveStopIntent, PendingExit } from './book.ts';
import { decisionBucketStart, entryClientId, exitClientId, parseClientId, stopClientId } from './ids.ts';

export interface ExecResult {
  symbol: string;
  /** `park`: Umschichtung der Treasury (risk/parken.ts) — kein Handelssignal, nie ein Trade. */
  kind: OrderIntent['kind'] | 'park';
  ok: boolean;
  orderId?: string;
  clientId?: string;
  note: string;
}

export type NotifyFn = (level: 'info' | 'warn' | 'error', text: string) => Promise<void>;

/**
 * Offene Order der Treasury. Sie liegt NICHT in `Book.pendingEntries`: Eine
 * Park-Order ist kein Einstieg — sie darf weder storniert werden, wenn
 * Einstiege gesperrt sind (ein Verkauf finanziert einen Einstieg), noch über
 * `applyEntryFill` zu einer Position mit Schutz-Stop werden.
 */
export interface ParkOrderRef {
  clientId: string;
  orderId: string | null;
  side: 'buy' | 'sell';
  qty: number;
  /** Bereits gebuchte Füllmenge — macht Teilfills über Ticks und Neustarts idempotent. */
  booked: number;
  submittedAt: Ms;
}

export interface OrderExecutorArgs {
  client: AlpacaClient;
  book: Book;
  journal: JournalLike;
  mode: 'paper' | 'live';
  assetClass: AssetClass;
  timeframe: TimeframeMin;
  holdsOvernightFor: (symbol: string) => boolean;
  now?: (() => Ms) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  calendar?: Calendar | undefined;
  /** Strategie-ID für Positionen, deren Intent nach einem Neustart fehlt. */
  strategyIdFor?: ((symbol: string) => string | undefined) | undefined;
  /**
   * Stufe der Wahl (champion/basis/config), die ein Symbol mit DIESER Strategie führt — wird beim Einstiegs-Fill
   * in der Position festgehalten (`PositionState.stufe`), damit Trade-Docs sie auch nach einem Wechsel oder bei
   * der Zwangs-Liquidation tragen (Prüfbefund G14). undefined ⇒ Feld bleibt weg.
   */
  stufeFor?: ((symbol: string, strategyId: string) => string | undefined) | undefined;
  notify?: NotifyFn | undefined;
  log?: typeof logger | undefined;
  /**
   * Parksymbol der Treasury (`risk.cashParking.symbol`), auch wenn das Parken
   * gerade AUS ist — der Executor muss eine bestehende Parkposition weiter
   * erkennen, um sie abzubauen statt sie als Strategie-Position zu behandeln.
   *
   * Erkannt wird am SYMBOL, nicht an der Order-Kennung: Das Parksymbol gehört
   * der Treasury allein (risk/parken.ts), also ist JEDE Order und jeder Fill
   * darin ihrer — und nie ein Trade, nie eine Position mit Schutz-Stop, nie
   * Teil einer Glattstellung.
   */
  parkSymbol?: string | null | undefined;
  /** Offene Park-Order aus dem State (überlebt Neustart und Functions-Takt). */
  parkOrder?: ParkOrderRef | null | undefined;
  /**
   * Kostenmodell für `Trade.fees` (Secreview 2, M10): Alpaca-Aktien sind kommissionsfrei, aber Verkäufe
   * tragen SEC-Gebühr und FINRA TAF, Krypto zahlt Taker-Gebühr auf beiden Seiten — dieselbe Rechnung wie
   * im Simulator. Ohne Modell stand `fees = 0`, und das Reife-Gate „Gebührenanteil" maß nichts.
   * Slippage steckt live bereits im Fill-Kurs und wird hier NICHT noch einmal berechnet.
   */
  costs?: CostConfig | undefined;
}

/* ───────────────────────── Rundung & Mengen ───────────────────────── */

/** Erlaubte Nachkommastellen: ≥ 1 $ zwei, darunter vier (Sub-Penny-Regel). */
export function priceDecimalsFor(price: number): number {
  return price >= 1 ? 2 : 4;
}

export function roundDirected(price: number, dir: 'down' | 'up'): number {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Preis ungültig: ${price}`);
  const decimals = priceDecimalsFor(price);
  const factor = 10 ** decimals;
  const scaled = price * factor;
  const nearest = Math.round(scaled);
  // Gleitkomma-Rauschen (98.36 × 100 = 9835.999…) darf keinen Cent kosten.
  const onGrid = Math.abs(scaled - nearest) < 1e-6;
  const units = onGrid ? nearest : dir === 'down' ? Math.floor(scaled) : Math.ceil(scaled);
  return Number((units / factor).toFixed(decimals));
}

/** Stop VOM Kurs WEG: Long-Stop (unter dem Kurs) abrunden, Short-Stop aufrunden. */
export function roundStopFor(stop: number, side: Side): number {
  return roundDirected(stop, side === 'long' ? 'down' : 'up');
}

/** Ziel ZUM Kurs HIN: Long-Ziel (über dem Kurs) abrunden, Short-Ziel aufrunden. */
export function roundTargetFor(target: number, side: Side): number {
  return roundDirected(target, side === 'long' ? 'down' : 'up');
}

/** Aktien: ganze Stücke (Brackets brauchen sie); Krypto: 4 Dezimalen. */
export function roundQtyFor(qty: number, assetClass: AssetClass): number {
  if (assetClass === 'crypto') return Math.floor(qty * 1e4 + 1e-9) / 1e4;
  return Math.floor(qty + 1e-9);
}

/** Krypto-Stop-Limit: Limit 1 % hinter dem Stop, damit der Stop auch im Rutsch ausführt. */
export const CRYPTO_STOP_LIMIT_GAP = 0.01;

export function cryptoStopLimitFor(stop: number, side: Side): number {
  const raw = side === 'long' ? stop * (1 - CRYPTO_STOP_LIMIT_GAP) : stop * (1 + CRYPTO_STOP_LIMIT_GAP);
  return roundDirected(raw, side === 'long' ? 'down' : 'up');
}

/** 3 % vom Kurs weg — Schutz-Stop für übernommene Positionen und Positionen ohne bekannte Marke. */
export const FALLBACK_STOP_PCT = 3;

export function fallbackStopFor(price: number, side: Side): number {
  return roundStopFor(side === 'long' ? price * (1 - FALLBACK_STOP_PCT / 100) : price * (1 + FALLBACK_STOP_PCT / 100), side);
}

/* ───────────────────────── Hilfen ───────────────────────── */

export function exitSideOf(pos: PositionState): 'buy' | 'sell' {
  return pos.side === 'long' ? 'sell' : 'buy';
}

function isStopType(o: AlpacaOrder): boolean {
  return o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop';
}

/** Ausstiegsgrund aus dem Order-Typ: Stop-Bein ⇒ 'stop', Limit-Bein ⇒ 'target', sonst der Vorschlag. */
export function reasonForOrder(o: AlpacaOrder, fallback: ExitReason): ExitReason {
  if (isStopType(o)) return 'stop';
  if (o.type === 'limit') return 'target';
  return fallback;
}

/** Top-Level-Orders und ihre Beine als flache Liste (ohne Doppel) — egal, wie der Broker verschachtelt. */
export function flattenOrders(list: readonly AlpacaOrder[]): AlpacaOrder[] {
  const seen = new Set<string>();
  const out: AlpacaOrder[] = [];
  const push = (o: AlpacaOrder) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    out.push(o);
  };
  for (const o of list) {
    push(o);
    for (const leg of o.legs) push(leg);
  }
  return out;
}

function isDuplicateError(e: unknown): boolean {
  return e instanceof AlpacaError && e.status === 422 && /unique|duplicate/i.test(e.message);
}

function is422(e: unknown): boolean {
  return e instanceof AlpacaError && e.status === 422;
}

function isDead(o: AlpacaOrder): boolean {
  return !isOpenStatus(o.status) && o.status !== 'filled';
}

/* ───────────────────────── Executor ───────────────────────── */

export class OrderExecutor {
  static readonly WAIT_ROUNDS = 10;
  static readonly WAIT_MS = 300;
  static readonly CRYPTO_FILL_POLLS = 5;
  static readonly EXIT_RETRY_MS = 5_000;
  static readonly EXIT_SEQ_MAX = 8;
  static readonly PENDING_ENTRY_TTL_MS = 10 * 60_000;

  private readonly client: AlpacaClient;
  private readonly book: Book;
  private readonly journal: JournalLike;
  private readonly mode: 'paper' | 'live';
  private readonly assetClass: AssetClass;
  private readonly timeframe: TimeframeMin;
  private readonly holdsOvernightFor: (symbol: string) => boolean;
  private readonly now: () => Ms;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly calendar: Calendar | undefined;
  private readonly strategyIdFor: (symbol: string) => string | undefined;
  private readonly stufeFor: (symbol: string, strategyId: string) => string | undefined;
  private readonly notify: NotifyFn | null;
  private readonly log: typeof logger;
  private readonly costs: CostConfig | null;
  private readonly parkSymbol: string | null;
  /** Offene Park-Order (persistiert im State, siehe `parkOrderRef`). */
  private parkOrder: ParkOrderRef | null;
  /** Symbole, deren Position zu ist und deren Rest-Orders (Ziel-/Stop-Bein) noch abzuräumen sind. */
  private readonly cleanupQueue = new Set<string>();

  constructor(a: OrderExecutorArgs) {
    this.client = a.client;
    this.book = a.book;
    this.journal = a.journal;
    this.mode = a.mode;
    this.assetClass = a.assetClass;
    this.timeframe = a.timeframe;
    this.holdsOvernightFor = a.holdsOvernightFor;
    this.now = a.now ?? (() => Date.now());
    this.sleep = a.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.calendar = a.calendar;
    this.strategyIdFor = a.strategyIdFor ?? (() => undefined);
    this.stufeFor = a.stufeFor ?? (() => undefined);
    this.notify = a.notify ?? null;
    this.log = a.log ?? logger;
    this.costs = a.costs ?? null;
    this.parkSymbol = a.parkSymbol ?? null;
    this.parkOrder = a.parkOrder ?? null;
  }

  /** Gehört dieses Symbol der Treasury? Dann nie Trade, nie Schutz-Stop, nie Glattstellung. */
  private istPark(symbol: string): boolean {
    return this.parkSymbol !== null && symbol === this.parkSymbol;
  }

  /** Symbole des Strategie-Buchs (ohne Parksymbol). */
  private strategieSymbole(): string[] {
    return [...this.book.positions.keys()].filter((s) => !this.istPark(s));
  }

  /** Offene Park-Order für den State (null = keine). */
  parkOrderRef(): ParkOrderRef | null {
    return this.parkOrder;
  }

  /** Regulatorische Gebühren beider Seiten eines (Teil-)Trades nach Kostenmodell; 0 ohne Modell. */
  private tradeFees(pos: PositionState, qty: number, exitPrice: number): number {
    if (!this.costs) return 0;
    const entrySide = pos.side === 'long' ? 'buy' : 'sell';
    const exitSide = pos.side === 'long' ? 'sell' : 'buy';
    const base = { qty, assetClass: this.assetClass, costs: this.costs, multiplier: 1 };
    return regulatoryFees({ ...base, side: entrySide, price: pos.entryPrice }) + regulatoryFees({ ...base, side: exitSide, price: exitPrice });
  }

  /* ── öffentliche API ── */

  async execute(intents: readonly OrderIntent[]): Promise<ExecResult[]> {
    const out: ExecResult[] = [];
    for (const intent of intents) {
      try {
        if (intent.kind === 'enter') out.push(await this.enter(intent));
        else if (intent.kind === 'exit') out.push(await this.exit(intent));
        else out.push(await this.moveStop(intent));
      } catch (e) {
        const note = errMsg(e);
        this.journal.append('error', { where: `execute:${intent.kind}`, symbol: intent.symbol, error: note }, this.now());
        this.log.error(`Order-Ausführung ${intent.kind} ${intent.symbol} fehlgeschlagen`, { error: note });
        out.push({ symbol: intent.symbol, kind: intent.kind, ok: false, note });
      }
    }
    return out;
  }

  /** Gescheiterte Exits erneut versuchen (vom Tick aufgerufen; gedrosselt). Gibt die Ergebnisse zurück. */
  async retryPendingExits(): Promise<ExecResult[]> {
    const now = this.now();
    const due: ExitIntent[] = [];
    for (const [sym, pe] of this.book.pendingExits) {
      if (!pe.intent || pe.lastError === null) continue;
      if (now - pe.lastAttemptAt < OrderExecutor.EXIT_RETRY_MS) continue;
      if (!this.book.positions.has(sym)) {
        this.book.pendingExits.delete(sym);
        continue;
      }
      due.push(pe.intent);
    }
    return due.length ? this.execute(due) : [];
  }

  /* ── Einstieg ── */

  private async enter(intent: EnterIntent): Promise<ExecResult> {
    const sym = intent.symbol;
    const r = (ok: boolean, note: string, ids?: { orderId?: string | null; clientId?: string }): ExecResult => {
      const res: ExecResult = { symbol: sym, kind: 'enter', ok, note };
      if (ids?.orderId) res.orderId = ids.orderId;
      if (ids?.clientId) res.clientId = ids.clientId;
      return res;
    };
    if (this.book.positions.has(sym)) return r(true, 'Position bereits im Buch — kein Einstieg');
    const already = this.book.pendingEntries.get(sym);
    if (already) return r(true, 'Einstiegs-Order bereits offen', { clientId: already.clientId, orderId: already.orderId });

    const anchor = decisionBucketStart(intent.decidedAt, this.timeframe, this.assetClass, this.calendar);
    const clientId = entryClientId(this.mode, sym, anchor);
    const qty = roundQtyFor(intent.qty, this.assetClass);
    if (!(qty > 0)) return r(true, `Stückzahl nach Rundung 0 (${intent.qty}) — kein Einstieg`);
    // Das Buch spiegelt, was beim Broker liegt: gerundete Marken in den Intent.
    const stop = roundStopFor(intent.stop, intent.side);
    const target = intent.target === null ? null : roundTargetFor(intent.target, intent.side);
    const rounded: EnterIntent = { ...intent, qty, stop, target };

    const existing = await this.client.getOrderByClientId(clientId);
    if (existing) return this.adoptExistingEntry(await this.withLegs(existing), rounded, clientId);

    const holdsOvernight = this.holdsOvernightFor(sym);
    const order = this.buildEntryOrder(rounded, clientId, holdsOvernight);
    const submittedAt = this.now();
    // Vor dem Senden markieren: Der Fill kann über den Stream ankommen, bevor der POST zurück ist.
    this.book.markPending(sym, { clientId, orderId: null, intent: rounded, submittedAt });
    let submitted: AlpacaOrder;
    try {
      submitted = await this.client.submitOrder(order);
    } catch (e) {
      if (isDuplicateError(e)) {
        const again = await this.client.getOrderByClientId(clientId);
        if (again) return this.adoptExistingEntry(again, rounded, clientId);
      }
      this.book.clearPending(sym);
      throw e;
    }
    const pe = this.book.pendingEntries.get(sym);
    if (pe) pe.orderId = submitted.id;
    this.journal.append(
      'order_submitted',
      {
        purpose: 'entry',
        symbol: sym,
        clientId,
        orderId: submitted.id,
        side: order.side,
        qty: order.qty,
        type: order.type,
        tif: order.timeInForce,
        orderClass: order.orderClass ?? 'simple',
        stop,
        target,
        refPrice: intent.refPrice,
        reason: intent.reason,
        strategy: intent.strategy,
      },
      submittedAt,
    );
    this.log.info(`Einstieg gesendet ${sym} ${order.side} ${order.qty}`, { clientId, orderId: submitted.id, stop, target });
    if (submitted.filledQty > 0) await this.applyEntryFill(submitted, submittedAt);
    if (this.assetClass === 'crypto' && this.book.pendingEntries.has(sym)) await this.pollEntryFill(sym, submitted.id);
    return r(true, `Einstieg gesendet (${order.orderClass ?? 'simple'})`, { orderId: submitted.id, clientId });
  }

  /**
   * Einstiegs-Order für Aktien: Marktorder mit Stop-Bein beim Broker (§0.4).
   * Mit Ziel `bracket` (Alpaca verlangt dafür BEIDE Beine, take_profit UND
   * stop_loss); ohne Ziel `oto` (one-triggers-other: genau EIN abhängiges
   * Bein). Ein `bracket` mit nur einem Bein lehnt Alpaca mit 422 ab — die
   * Basis-Stufe (regime_allocation, ohne Kursziel) hätte dann still nie
   * gehandelt (Prüfbefund K3, 09.09.2026). Beide Klassen kommen mit
   * `nested=true` als Beine zurück; der Abgleich behandelt sie gleich.
   */
  private buildEntryOrder(intent: EnterIntent, clientId: string, holdsOvernight: boolean): NewOrder {
    const side = intent.side === 'long' ? 'buy' : 'sell';
    if (this.assetClass === 'crypto') {
      // Alpaca-Krypto: kein Bracket, nur gtc/ioc — der Schutz-Stop folgt als eigene stop_limit-Order nach dem Fill.
      return { symbol: intent.symbol, side, qty: intent.qty, type: 'market', timeInForce: 'gtc', clientOrderId: clientId };
    }
    const order: NewOrder = {
      symbol: intent.symbol,
      side,
      qty: intent.qty,
      type: 'market',
      timeInForce: holdsOvernight ? 'gtc' : 'day',
      clientOrderId: clientId,
      orderClass: intent.target !== null ? 'bracket' : 'oto',
      stopLoss: { stopPrice: intent.stop },
    };
    if (intent.target !== null) order.takeProfit = { limitPrice: intent.target };
    return order;
  }

  /** Eine Order zur Einstiegs-Kennung existiert schon: übernehmen statt erneut senden. */
  private async adoptExistingEntry(order: AlpacaOrder, intent: EnterIntent, clientId: string): Promise<ExecResult> {
    const sym = intent.symbol;
    const base: ExecResult = { symbol: sym, kind: 'enter', ok: true, orderId: order.id, clientId, note: '' };
    if (isOpenStatus(order.status)) {
      this.book.markPending(sym, { clientId, orderId: order.id, intent, submittedAt: order.submittedAt ?? this.now() });
      if (order.filledQty > 0) await this.applyEntryFill(order, this.now());
      return { ...base, note: `Einstiegs-Order existiert bereits (${order.status}) — nicht erneut gesendet` };
    }
    if (order.status === 'filled') {
      this.book.markPending(sym, { clientId, orderId: order.id, intent, submittedAt: order.submittedAt ?? this.now() });
      await this.applyEntryFill(order, this.now());
      return { ...base, note: 'Einstiegs-Order war bereits gefüllt — Position aus dem Fill gebucht' };
    }
    return { ...base, note: `Order zur Kennung bereits ${order.status} — kein zweiter Versuch im selben Bucket` };
  }

  /** `by_client_order_id` liefert bei Alpaca keine Beine — für Bracket-/OTO-Orders per ID (nested) nachladen. */
  private async withLegs(o: AlpacaOrder): Promise<AlpacaOrder> {
    if ((o.orderClass !== 'bracket' && o.orderClass !== 'oto') || o.legs.length > 0) return o;
    return (await this.client.getOrder(o.id)) ?? o;
  }

  /** Krypto: kurz auf den Fill der Marktorder warten, damit der Schutz-Stop sofort folgt. */
  private async pollEntryFill(symbol: string, orderId: string): Promise<void> {
    for (let i = 0; i < OrderExecutor.CRYPTO_FILL_POLLS; i++) {
      const o = await this.client.getOrder(orderId);
      if (!o) return;
      if (o.filledQty > 0) await this.applyEntryFill(o, this.now());
      if (!isOpenStatus(o.status)) {
        if (o.status !== 'filled') this.book.clearPending(symbol);
        return;
      }
      await this.sleep(OrderExecutor.WAIT_MS);
    }
  }

  /**
   * Einstiegs-Fill buchen (idempotent über die kumulierte Füllmenge):
   * Position eröffnen bzw. auf die gefüllte Menge nachziehen; Pending erst
   * bei Vollständigkeit löschen; Bracket-Bein als Schutz-Stop vermerken.
   */
  async applyEntryFill(order: AlpacaOrder, ts: Ms): Promise<void> {
    const sym = order.symbol;
    const filled = order.filledQty;
    if (!(filled > 0)) return;
    const pe = this.book.pendingEntries.get(sym);
    const intent = pe?.intent ?? null;
    const side: Side = order.side === 'buy' ? 'long' : 'short';
    const existing = this.book.positions.get(sym);
    if (existing && existing.side !== side) {
      // Eine „Einstiegs"-Order auf der Gegenseite schließt in Wahrheit — über den Exit-Pfad buchen.
      this.applyExitFill(order, { ts, reason: 'signal' });
      return;
    }
    const avg = order.filledAvgPrice ?? intent?.refPrice ?? existing?.entryPrice ?? null;
    if (avg === null || !(avg > 0)) {
      this.log.warn('Fill ohne Preis — Buchung vertagt bis zum nächsten Nachsehen', { symbol: sym, orderId: order.id });
      return;
    }
    const fillTime = order.filledAt ?? ts;
    const stopLeg = order.legs.find(isStopType) ?? null;
    const targetLeg = order.legs.find((l) => l.type === 'limit') ?? null;
    let grew = false;
    if (!existing) {
      const stop = intent?.stop ?? stopLeg?.stopPrice ?? null;
      const target = intent?.target ?? targetLeg?.limitPrice ?? null;
      const strategy = intent?.strategy ?? this.strategyIdFor(sym) ?? 'unknown';
      const entryDay = dayKeyFor(fillTime, this.assetClass);
      const stufe = this.stufeFor(sym, strategy);
      const pos: PositionState =
        stop === null
          ? { ...openPosition({ symbol: sym, side, qty: filled, fillPrice: avg, fillTime, stop: 0, target, strategy, entryDay, stufe }), stop: null, initialStop: null }
          : openPosition({ symbol: sym, side, qty: filled, fillPrice: avg, fillTime, stop, target, strategy, entryDay, stufe });
      this.book.open(pos);
      this.journal.append(
        'fill',
        { purpose: 'entry', symbol: sym, orderId: order.id, clientId: order.clientOrderId, side: order.side, qty: filled, price: avg, cumQty: filled, status: order.status, note: 'Position eröffnet' },
        fillTime,
      );
      this.log.info(`Fill Einstieg ${sym} ${side} ${filled} @ ${avg}`, { orderId: order.id, stop, target });
    } else if (filled > existing.qty + 1e-9) {
      grew = true;
      this.book.positions.set(sym, { ...existing, qty: filled, entryPrice: avg });
      this.journal.append(
        'fill',
        { purpose: 'entry', symbol: sym, orderId: order.id, clientId: order.clientOrderId, side: order.side, qty: filled - existing.qty, price: avg, cumQty: filled, status: order.status, note: 'Teilfill nachgezogen' },
        fillTime,
      );
    }
    if (stopLeg) {
      const pos = this.book.positions.get(sym);
      this.book.protectiveOrders.set(sym, { orderId: stopLeg.id, clientId: stopLeg.clientOrderId, stop: stopLeg.stopPrice ?? pos?.stop ?? 0 });
    }
    const complete = order.status === 'filled' || (order.qty !== null && filled >= order.qty - 1e-9);
    if (complete) this.book.clearPending(sym);
    if (this.assetClass === 'crypto' && !this.book.protectiveOrders.has(sym) && this.book.positions.has(sym)) {
      await this.placeProtectiveStop(sym, 'Krypto: Schutz-Stop nach Einstiegs-Fill');
    } else if (grew) {
      // Ein eigener Stop (Krypto, Nachsetzer) deckt sonst nur die Menge des ersten Teilfills — Bracket-Beine passt Alpaca selbst an.
      await this.alignOwnStopQty(sym);
    }
  }

  /** Eigenen Schutz-Stop (Kennung `-s`) auf die Positionsmenge bringen, falls bekannt und offen. */
  private async alignOwnStopQty(symbol: string): Promise<void> {
    const prot = this.book.protectiveOrders.get(symbol);
    if (!prot?.orderId || parseClientId(prot.clientId)?.kind !== 'stop') return;
    const o = await this.client.getOrder(prot.orderId);
    if (o && isOpenStatus(o.status)) await this.alignStopQty(symbol, o);
  }

  /**
   * Stop-Menge ≠ Positionsmenge ⇒ `replaceOrder({ qty })`; scheitert das, Storno + neuer Stop über die
   * volle Menge. Nach Teilfills (Krypto) oder einer vom Abgleich übernommenen größeren Broker-Menge
   * muss der Stop die GANZE Position decken — ein Rest ohne Stop ist nacktes Risiko.
   */
  private async alignStopQty(symbol: string, o: AlpacaOrder): Promise<boolean> {
    const pos = this.book.positions.get(symbol);
    if (!pos) return false;
    const want = roundQtyFor(pos.qty, this.assetClass);
    const remaining = (o.qty ?? 0) - o.filledQty;
    if (!(want > 0) || Math.abs(remaining - want) < 1e-9) return false;
    try {
      const replaced = await this.client.replaceOrder(o.id, { qty: want });
      this.book.protectiveOrders.set(symbol, { orderId: replaced.id, clientId: replaced.clientOrderId, stop: replaced.stopPrice ?? pos.stop ?? 0 });
      this.journal.append('order_update', { purpose: 'stop', symbol, event: 'replaced', orderId: replaced.id, replaces: o.id, qtyFrom: remaining, qtyTo: want, note: 'Stop-Menge an Position angepasst' }, this.now());
      this.log.warn(`Stop-Menge angepasst ${symbol}: ${remaining} → ${want}`, { orderId: replaced.id });
      return true;
    } catch (e) {
      this.log.warn('Stop-Menge nicht ersetzbar — Storno + neuer Stop', { symbol, orderId: o.id, error: errMsg(e) });
      const outcome = await this.cancelStopOrder(symbol, o.id);
      if (outcome === 'filled' || !this.book.positions.has(symbol)) return true;
      const placed = await this.placeProtectiveStop(symbol, 'Stop-Menge angepasst: Ersatz nach gescheitertem Replace');
      return placed !== null;
    }
  }

  /**
   * Stop-Order stornieren; ist sie inzwischen (teil-)gefüllt, wird der Fill gebucht statt weiter zu
   * stornieren. 'filled' ⇒ die Order hat die Position (teilweise) geschlossen — nicht nachsetzen.
   */
  private async cancelStopOrder(symbol: string, orderId: string): Promise<'gone' | 'filled'> {
    const pos = this.book.positions.get(symbol);
    const cur = await this.client.getOrder(orderId);
    if (cur && cur.filledQty > 0 && pos && cur.side === exitSideOf(pos)) {
      this.applyExitFill(cur, { ts: this.now(), reason: 'stop' });
      return 'filled';
    }
    if (cur && isOpenStatus(cur.status)) {
      try {
        await this.client.cancelOrder(orderId);
      } catch (ce) {
        if (!is422(ce)) throw ce;
        const again = await this.client.getOrder(orderId);
        if (again && again.filledQty > 0 && pos && again.side === exitSideOf(pos)) {
          this.applyExitFill(again, { ts: this.now(), reason: 'stop' });
          return 'filled';
        }
      }
      await this.waitUntilOrderGone(orderId);
    }
    this.book.protectiveOrders.delete(symbol);
    return 'gone';
  }

  /* ── Exit ── */

  private async exit(intent: ExitIntent): Promise<ExecResult> {
    const sym = intent.symbol;
    const r = (ok: boolean, note: string, ids?: { orderId?: string | null; clientId?: string | null }): ExecResult => {
      const res: ExecResult = { symbol: sym, kind: 'exit', ok, note };
      if (ids?.orderId) res.orderId = ids.orderId;
      if (ids?.clientId) res.clientId = ids.clientId;
      return res;
    };
    const pos = this.book.positions.get(sym);
    if (!pos) return r(true, 'Keine Position im Buch — nichts zu schließen');
    const now = this.now();
    const prev = this.book.pendingExits.get(sym);
    if (prev && (prev.orderId || prev.clientId)) {
      const o = prev.orderId ? await this.client.getOrder(prev.orderId) : await this.client.getOrderByClientId(prev.clientId!);
      if (o && isOpenStatus(o.status)) return r(true, `Exit-Order bereits offen (${o.status})`, { orderId: o.id, clientId: o.clientOrderId });
      if (o && o.filledQty > 0) {
        this.applyExitFill(o, { ts: now, reason: prev.reason });
        if (!this.book.positions.has(sym)) return r(true, 'Exit-Order war bereits gefüllt — Trade gebucht', { orderId: o.id, clientId: o.clientOrderId });
      }
    }
    const pe: PendingExit = {
      clientId: null,
      orderId: null,
      reason: intent.reason,
      since: prev?.since ?? now,
      attempts: (prev?.attempts ?? 0) + 1,
      lastAttemptAt: now,
      lastError: null,
      intent,
    };
    this.book.pendingExits.set(sym, pe);
    try {
      // 1. Alle offenen Orders des Symbols stornieren (Alpaca reserviert die Stücke für Stop-/Ziel-Beine).
      const closedByLeg = await this.cancelOpenOrdersFor(sym, pos);
      if (closedByLeg || !this.book.positions.has(sym)) {
        return r(true, 'Position wurde durch ein gefülltes Bein geschlossen — kein Verkauf');
      }
      // 2. Warten, bis nichts mehr offen ist.
      const remaining = await this.waitUntilNoOpenOrders(sym, pos);
      if (!this.book.positions.has(sym)) return r(true, 'Position während des Wartens geschlossen — kein Verkauf');
      if (remaining.length > 0) {
        pe.lastError = `Offene Orders nicht abgeräumt (${remaining.map((o) => o.id).join(',')}) — Exit wird wiederholt`;
        this.journal.append('note', { symbol: sym, text: pe.lastError }, this.now());
        return r(false, pe.lastError);
      }
      // 3. Letzter Blick ins geschlossene Orderbuch: Ein Bein, das VOR dem Listen gefüllt hat, war nie „offen" —
      //    ohne diese Prüfung würde die Marktorder eine Position verkaufen, die es nicht mehr gibt (Leerverkauf).
      await this.syncExitFillsFor([sym]);
      if (!this.book.positions.has(sym)) return r(true, 'Position war bereits durch ein gefülltes Bein geschlossen — kein Verkauf');
      // 4. Eigene Marktorder mit positionsstabiler Kennung — nie closePosition (keine client_order_id möglich).
      const cur = this.book.positions.get(sym)!;
      const chosen = await this.nextExitClientId(sym, cur, pe);
      if (chosen.done) return r(true, chosen.note, { orderId: chosen.orderId, clientId: chosen.clientId });
      const clientId = chosen.clientId;
      const qty = roundQtyFor(cur.qty, this.assetClass);
      if (!(qty > 0)) return r(true, `Restmenge ${cur.qty} nicht handelbar — kein Verkauf`);
      const order: NewOrder = {
        symbol: sym,
        side: exitSideOf(cur),
        qty,
        type: 'market',
        timeInForce: this.assetClass === 'crypto' ? 'gtc' : 'day',
        clientOrderId: clientId,
      };
      pe.clientId = clientId;
      let submitted: AlpacaOrder;
      try {
        submitted = await this.client.submitOrder(order);
      } catch (e) {
        if (!isDuplicateError(e)) throw e;
        const again = await this.client.getOrderByClientId(clientId);
        if (!again) throw e;
        submitted = again;
      }
      pe.orderId = submitted.id;
      this.journal.append(
        'order_submitted',
        { purpose: 'exit', symbol: sym, clientId, orderId: submitted.id, side: order.side, qty, type: order.type, tif: order.timeInForce, reason: intent.reason },
        this.now(),
      );
      this.log.info(`Exit gesendet ${sym} ${order.side} ${qty} (${intent.reason})`, { clientId, orderId: submitted.id });
      if (submitted.filledQty > 0) this.applyExitFill(submitted, { ts: this.now(), reason: intent.reason });
      return r(true, `Exit gesendet (${intent.reason})`, { orderId: submitted.id, clientId });
    } catch (e) {
      pe.lastError = errMsg(e);
      throw e;
    }
  }

  /**
   * Offene Orders eines Symbols stornieren. 422 („nicht stornierbar") ⇒
   * Order-Stand abfragen: Ein gefülltes Bein hat die Position (teilweise)
   * geschlossen — das wird gebucht, nicht nachverkauft. Rückgabe: true,
   * wenn die Position dadurch vollständig geschlossen wurde.
   */
  private async cancelOpenOrdersFor(symbol: string, pos: PositionState): Promise<boolean> {
    const open = flattenOrders(await this.client.listOrders({ status: 'open', symbols: [symbol], nested: true })).filter((o) => o.symbol === symbol && isOpenStatus(o.status));
    for (const o of open) {
      const own = parseClientId(o.clientOrderId);
      if (own && own.kind === 'exit' && own.mode === this.mode && o.side === exitSideOf(pos)) {
        // Eine eigene, noch offene Exit-Order (z. B. aus der Zeit vor einem Neustart) tut bereits, was wir wollen.
        const pe = this.book.pendingExits.get(symbol);
        if (pe) {
          pe.clientId = o.clientOrderId;
          pe.orderId = o.id;
        }
        continue;
      }
      try {
        await this.client.cancelOrder(o.id);
        this.journal.append('order_update', { symbol, orderId: o.id, clientId: o.clientOrderId, type: o.type, event: 'cancel_requested', note: 'Storno vor eigenem Exit' }, this.now());
      } catch (e) {
        if (!is422(e)) throw e;
        const cur = await this.client.getOrder(o.id);
        if (cur && cur.filledQty > 0 && cur.side === exitSideOf(pos)) {
          this.journal.append('note', { symbol, text: `Storno 422 — Bein ${cur.type} ${cur.status} mit ${cur.filledQty} gefüllt: Fill wird gebucht, kein Nachverkauf` }, this.now());
          this.applyExitFill(cur, { ts: this.now(), reason: reasonForOrder(cur, 'signal') });
          if (!this.book.positions.has(symbol)) return true;
        } else {
          this.log.warn('Storno 422 ohne Fill — Order wird als erledigt betrachtet', { symbol, orderId: o.id, status: cur?.status ?? 'unbekannt' });
        }
      }
    }
    return false;
  }

  /** Bis zu WAIT_ROUNDS × WAIT_MS warten, bis keine fremde offene Order mehr liegt; gefüllte Beine dabei buchen. */
  private async waitUntilNoOpenOrders(symbol: string, pos: PositionState): Promise<AlpacaOrder[]> {
    let remaining: AlpacaOrder[] = [];
    for (let round = 0; round < OrderExecutor.WAIT_ROUNDS; round++) {
      const all = flattenOrders(await this.client.listOrders({ status: 'open', symbols: [symbol], nested: true })).filter((o) => o.symbol === symbol);
      remaining = all.filter((o) => {
        const own = parseClientId(o.clientOrderId);
        const ownExit = own !== null && own.kind === 'exit' && own.mode === this.mode;
        return isOpenStatus(o.status) && !ownExit;
      });
      for (const o of all) {
        if (o.filledQty > 0 && o.side === exitSideOf(pos)) this.applyExitFill(o, { ts: this.now(), reason: reasonForOrder(o, 'signal') });
      }
      if (!this.book.positions.has(symbol) || remaining.length === 0) break;
      await this.sleep(OrderExecutor.WAIT_MS);
    }
    return remaining;
  }

  /** Freie Exit-Kennung finden; existiert schon eine offene/gefüllte, ist der Exit damit erledigt. */
  private async nextExitClientId(
    symbol: string,
    pos: PositionState,
    pe: PendingExit,
  ): Promise<{ done: true; note: string; orderId: string; clientId: string } | { done: false; clientId: string }> {
    for (let seq = 0; seq < OrderExecutor.EXIT_SEQ_MAX; seq++) {
      const clientId = exitClientId(this.mode, symbol, pos.entryTime, seq);
      const o = await this.client.getOrderByClientId(clientId);
      if (!o) return { done: false, clientId };
      if (isOpenStatus(o.status)) {
        pe.clientId = clientId;
        pe.orderId = o.id;
        return { done: true, note: `Exit-Order existiert bereits (${o.status}) — nicht erneut gesendet`, orderId: o.id, clientId };
      }
      if (o.filledQty > 0) {
        pe.clientId = clientId;
        pe.orderId = o.id;
        this.applyExitFill(o, { ts: this.now(), reason: pe.reason });
        if (!this.book.positions.has(symbol)) return { done: true, note: 'Exit-Order war bereits gefüllt — Trade gebucht', orderId: o.id, clientId };
      }
      // tot (canceled/expired/rejected): nächste Sequenz
    }
    throw new Error(`Keine freie Exit-Kennung für ${symbol} (${OrderExecutor.EXIT_SEQ_MAX} Versuche)`);
  }

  /**
   * Exit-Fill buchen (idempotent über die kumulierte Füllmenge je Order).
   * Grund: Stop-Bein ⇒ 'stop', Limit-Bein ⇒ 'target', sonst der Intent-Grund.
   */
  applyExitFill(order: AlpacaOrder, o: { ts: Ms; reason?: ExitReason | undefined; price?: number | null | undefined }): boolean {
    const sym = order.symbol;
    const pos = this.book.positions.get(sym);
    if (!pos || order.side !== exitSideOf(pos)) return false;
    // Gebuchte Menge je Order lebt im Buch (persistiert): Stream- und REST-Pfad, Neustart und Takt sind
    // gegeneinander idempotent — ein Teilfill wird nie ein zweites Mal gebucht (Secreview 3, #3).
    const booked = this.book.bookedExit(sym, order.id);
    const delta = order.filledQty - booked;
    if (!(delta > 1e-9)) return false;
    this.book.markBookedExit(sym, order.id, order.filledQty);
    const price = o.price ?? order.filledAvgPrice;
    if (price === null || price === undefined || !(price > 0)) {
      this.log.warn('Exit-Fill ohne Preis — nicht gebucht', { symbol: sym, orderId: order.id });
      this.book.markBookedExit(sym, order.id, booked);
      return false;
    }
    const pending = this.book.pendingExits.get(sym);
    const reason = reasonForOrder(order, o.reason ?? pending?.reason ?? 'signal');
    const exitTime = order.filledAt ?? o.ts;
    const fees = this.tradeFees(pos, Math.min(delta, pos.qty), price);
    const closed = this.book.closeTrade(sym, delta, price, exitTime, reason, this.assetClass, fees);
    if (!closed) return false;
    this.journal.append(
      'fill',
      { purpose: 'exit', symbol: sym, orderId: order.id, clientId: order.clientOrderId, side: order.side, qty: closed.trade.qty, price, cumQty: order.filledQty, status: order.status, reason },
      exitTime,
    );
    this.journal.append(
      'trade_closed',
      { trade: closed.trade, partial: !closed.fullyClosed, dayTrade: closed.dayTrade, orderId: order.id, feesModel: this.costs ? 'regulatory' : 'none' },
      exitTime,
    );
    this.log.info(`Trade ${sym} ${closed.trade.side} ${closed.trade.qty} @ ${price} (${reason}) netto ${closed.trade.netPnl.toFixed(2)}`, {
      orderId: order.id,
      partial: !closed.fullyClosed,
      rMultiple: closed.trade.rMultiple,
    });
    if (closed.fullyClosed) this.cleanupQueue.add(sym); // die Buchungs-Merker gehen mit der Position aus dem Buch
    return true;
  }

  /* ── Stop nachziehen ── */

  private async moveStop(intent: MoveStopIntent): Promise<ExecResult> {
    const sym = intent.symbol;
    const pos = this.book.positions.get(sym);
    const r = (ok: boolean, note: string, orderId?: string | null): ExecResult => {
      const res: ExecResult = { symbol: sym, kind: 'move_stop', ok, note };
      if (orderId) res.orderId = orderId;
      return res;
    };
    if (!pos) return r(true, 'Keine Position im Buch — kein Stop');
    const stop = roundStopFor(intent.stop, pos.side);
    const prot = await this.findProtectiveOrder(sym, pos);
    if (!prot) {
      const placed = await this.placeProtectiveStop(sym, `Stop nachziehen: kein Bein gefunden — neu gesetzt (${intent.reason})`, stop);
      return placed ? r(true, 'Kein Stop-Bein gefunden — neue Stop-Order gesetzt', placed.orderId) : r(false, 'Stop-Order konnte nicht gesetzt werden');
    }
    if (prot.stopPrice !== null && Math.abs(prot.stopPrice - stop) < 1e-9) {
      this.book.positions.set(sym, { ...pos, stop });
      return r(true, 'Stop liegt bereits auf der Marke', prot.id);
    }
    const patch: { stopPrice: number; limitPrice?: number } = { stopPrice: stop };
    if (this.assetClass === 'crypto') patch.limitPrice = cryptoStopLimitFor(stop, pos.side);
    try {
      const replaced = await this.client.replaceOrder(prot.id, patch);
      this.book.protectiveOrders.set(sym, { orderId: replaced.id, clientId: replaced.clientOrderId, stop });
      this.book.positions.set(sym, { ...pos, stop });
      this.journal.append('order_update', { purpose: 'stop', symbol: sym, event: 'replaced', orderId: replaced.id, replaces: prot.id, stop, reason: intent.reason }, this.now());
      this.log.info(`Stop nachgezogen ${sym} → ${stop}`, { orderId: replaced.id, reason: intent.reason });
      return r(true, `Stop → ${stop} (replace)`, replaced.id);
    } catch (e) {
      this.log.warn('replaceOrder fehlgeschlagen — Storno + neue Stop-Order', { symbol: sym, orderId: prot.id, error: errMsg(e) });
      const outcome = await this.cancelStopOrder(sym, prot.id);
      if (outcome === 'filled') return r(true, 'Stop-Bein war bereits gefüllt — Trade gebucht', prot.id);
      if (!this.book.positions.has(sym)) return r(true, 'Position inzwischen geschlossen');
      const placed = await this.placeProtectiveStop(sym, `Stop nachziehen: Ersatz nach gescheitertem Replace (${intent.reason})`, stop);
      return placed ? r(true, `Stop → ${stop} (cancel + neu)`, placed.orderId) : r(false, 'Ersatz-Stop konnte nicht gesetzt werden');
    }
  }

  private async waitUntilOrderGone(orderId: string): Promise<void> {
    for (let round = 0; round < OrderExecutor.WAIT_ROUNDS; round++) {
      const o = await this.client.getOrder(orderId);
      if (!o || !isOpenStatus(o.status)) return;
      await this.sleep(OrderExecutor.WAIT_MS);
    }
  }

  /** Schutz-Stop-Order der Position beim Broker finden (Buch-Verweis zuerst, dann offene Orders). */
  private async findProtectiveOrder(symbol: string, pos: PositionState): Promise<AlpacaOrder | null> {
    const prot = this.book.protectiveOrders.get(symbol);
    if (prot?.orderId) {
      const o = await this.client.getOrder(prot.orderId);
      if (o && isOpenStatus(o.status)) return o;
    } else if (prot?.clientId) {
      const o = await this.client.getOrderByClientId(prot.clientId);
      if (o && isOpenStatus(o.status)) {
        prot.orderId = o.id;
        return o;
      }
    }
    const open = flattenOrders(await this.client.listOrders({ status: 'open', symbols: [symbol], nested: true }));
    const found = open.find((o) => o.symbol === symbol && isOpenStatus(o.status) && isStopType(o) && o.side === exitSideOf(pos)) ?? null;
    if (found) this.book.protectiveOrders.set(symbol, { orderId: found.id, clientId: found.clientOrderId, stop: found.stopPrice ?? pos.stop ?? 0 });
    else this.book.protectiveOrders.delete(symbol);
    return found;
  }

  /** Eigene Stop-Order (Aktien: stop gtc; Krypto: stop_limit gtc) mit freier Stop-Kennung setzen. */
  private async placeProtectiveStop(symbol: string, note: string, stopOverride?: number): Promise<{ orderId: string; clientId: string } | null> {
    const pos = this.book.positions.get(symbol);
    if (!pos) return null;
    let stop = stopOverride ?? pos.stop;
    if (stop === null) stop = fallbackStopFor(pos.entryPrice, pos.side);
    stop = roundStopFor(stop, pos.side);
    const qty = roundQtyFor(pos.qty, this.assetClass);
    if (!(qty > 0)) {
      this.log.warn('Schutz-Stop: Menge nicht handelbar', { symbol, qty: pos.qty });
      return null;
    }
    let clientId: string | null = null;
    for (let seq = 0; seq < OrderExecutor.EXIT_SEQ_MAX; seq++) {
      const candidate = stopClientId(this.mode, symbol, pos.entryTime, seq);
      const existing = await this.client.getOrderByClientId(candidate);
      if (!existing) {
        clientId = candidate;
        break;
      }
      if (isOpenStatus(existing.status) && existing.side === exitSideOf(pos)) {
        // Der Stop liegt schon — nur der Buch-Verweis fehlte.
        this.book.protectiveOrders.set(symbol, { orderId: existing.id, clientId: candidate, stop: existing.stopPrice ?? stop });
        return { orderId: existing.id, clientId: candidate };
      }
    }
    if (!clientId) throw new Error(`Keine freie Stop-Kennung für ${symbol}`);
    const order: NewOrder =
      this.assetClass === 'crypto'
        ? { symbol, side: exitSideOf(pos), qty, type: 'stop_limit', timeInForce: 'gtc', clientOrderId: clientId, stopPrice: stop, limitPrice: cryptoStopLimitFor(stop, pos.side) }
        : { symbol, side: exitSideOf(pos), qty, type: 'stop', timeInForce: 'gtc', clientOrderId: clientId, stopPrice: stop };
    let submitted: AlpacaOrder;
    try {
      submitted = await this.client.submitOrder(order);
    } catch (e) {
      if (!isDuplicateError(e)) throw e;
      const again = await this.client.getOrderByClientId(clientId);
      if (!again) throw e;
      submitted = again;
    }
    this.book.protectiveOrders.set(symbol, { orderId: submitted.id, clientId, stop });
    const cur = this.book.positions.get(symbol);
    if (cur) this.book.positions.set(symbol, { ...cur, stop, initialStop: cur.initialStop ?? (cur.barsHeld === 0 ? stop : cur.initialStop) });
    this.journal.append(
      'order_submitted',
      { purpose: 'stop', symbol, clientId, orderId: submitted.id, side: order.side, qty, type: order.type, tif: order.timeInForce, stop, limit: order.limitPrice ?? null, note },
      this.now(),
    );
    this.log.warn(`Schutz-Stop gesetzt ${symbol} @ ${stop}`, { orderId: submitted.id, note });
    return { orderId: submitted.id, clientId };
  }

  /* ── Schutz-Stops sicherstellen ── */

  /**
   * Für jede Buch-Position ohne offene Stop-Order beim Broker eine setzen.
   * Positionen mit noch laufendem Einstieg werden übersprungen (das
   * Bracket-Bein wird mit dem Fill aktiv); Positionen, die der Broker gar
   * nicht kennt, klärt der Abgleich — hier wird nichts gesetzt, was eine
   * Leerposition eröffnen könnte. Gibt die Symbole mit neu gesetztem Stop zurück.
   */
  async ensureProtectiveStops(): Promise<string[]> {
    const fixed: string[] = [];
    // Die Parkposition bekommt NIE einen Schutz-Stop (Eigenschaft 3): Ein
    // Katastrophen-Stop auf einem Geldmarktpapier wäre sinnlos und im Crash
    // schädlich — er verkaufte die Kasse im schlechtesten Moment.
    const symbols = this.strategieSymbole().filter((s) => !this.book.pendingEntries.has(s));
    if (symbols.length === 0) return fixed;
    const broker = new Map((await this.client.listPositions()).map((p) => [p.symbol, p]));
    const open = flattenOrders(await this.client.listOrders({ status: 'open', symbols, nested: true }));
    for (const sym of symbols) {
      const pos = this.book.positions.get(sym);
      if (!pos) continue;
      const bp = broker.get(sym);
      if (!bp || bp.side !== pos.side) {
        this.log.warn('Schutz-Stop: Position beim Broker nicht (so) vorhanden — Abgleich klärt', { symbol: sym });
        continue;
      }
      const stops = open.filter((o) => o.symbol === sym && isOpenStatus(o.status) && isStopType(o) && o.side === exitSideOf(pos));
      if (stops.length > 0) {
        const known = this.book.protectiveOrders.get(sym);
        const pick = stops.find((o) => o.id === known?.orderId || o.clientOrderId === known?.clientId) ?? stops[0]!;
        this.book.protectiveOrders.set(sym, { orderId: pick.id, clientId: pick.clientOrderId, stop: pick.stopPrice ?? pos.stop ?? 0 });
        if (pos.stop === null && pick.stopPrice !== null) this.book.positions.set(sym, { ...pos, stop: pick.stopPrice, initialStop: pick.stopPrice });
        // Existenz reicht nicht: Der Stop muss die ganze Position decken (Teilfills, Hand-Nachkauf).
        if (await this.alignStopQty(sym, pick)) fixed.push(sym);
        continue;
      }
      this.book.protectiveOrders.delete(sym);
      const qtyPos = Math.min(pos.qty, bp.qty);
      if (qtyPos < pos.qty) this.book.positions.set(sym, { ...pos, qty: qtyPos });
      const fallback = pos.stop === null ? fallbackStopFor(bp.currentPrice > 0 ? bp.currentPrice : pos.entryPrice, pos.side) : undefined;
      const placed = await this.placeProtectiveStop(sym, 'Schutz-Stop fehlte beim Broker — nachgesetzt', fallback);
      if (placed) {
        fixed.push(sym);
        await this.say('warn', `Schutz-Stop für ${sym} fehlte beim Broker — nachgesetzt @ ${this.book.positions.get(sym)?.stop ?? '?'}`);
      }
    }
    return fixed;
  }

  /* ── Alles glatt ── */

  /**
   * Eigene offene Einstiegs-Orders stornieren (Pending bleibt, bis syncOrders den Endstand bucht — ein
   * Storno kann mit einem Fill rennen). Rückgabe: Symbole, für die ein Storno angefordert wurde.
   */
  async cancelOwnEntryOrders(): Promise<string[]> {
    const out: string[] = [];
    let touched = 0;
    for (const [sym, pe] of [...this.book.pendingEntries]) {
      const o = pe.orderId ? await this.client.getOrder(pe.orderId) : await this.client.getOrderByClientId(pe.clientId);
      if (!o || !isOpenStatus(o.status)) {
        touched++; // Endstand (gefüllt/tot) bucht syncOrders
        continue;
      }
      touched++;
      try {
        await this.client.cancelOrder(o.id);
        this.journal.append('order_update', { purpose: 'entry', symbol: sym, orderId: o.id, clientId: o.clientOrderId, event: 'cancel_requested', note: 'Eigene Einstiegs-Order storniert' }, this.now());
        out.push(sym);
      } catch (e) {
        if (!is422(e)) throw e; // 422: nicht mehr stornierbar (gefüllt) — syncOrders bucht den Fill
      }
    }
    if (touched > 0) await this.syncOrders();
    return out;
  }

  /**
   * Alles glatt — aber nur das EIGENE Buch: eigene Einstiegs-Orders stornieren, jede Buch-Position über den
   * regulären Exit-Pfad schließen (Beine stornieren, Marktorder mit positionsstabiler Kennung). Fremdbestand
   * und fremde Orders im selben Konto bleiben unangetastet (Secreview 2, G4: `closeAllPositions` hätte auch
   * die Handpositionen eines Live-Kontos verkauft).
   */
  async flattenAll(reason: ExitReason): Promise<ExecResult[]> {
    const cancelled = await this.cancelOwnEntryOrders();
    const intents = this.prepareFlatten(reason, cancelled);
    return intents.length ? this.execute(intents) : [];
  }

  /**
   * Glattstellung VORMERKEN: je Buch-Position ein laufender Exit mit Intent, sofort wiederholbar. Der Aufrufer
   * speichert den State, BEVOR er ausführt — ein Zeitbudget oder Absturz mitten in der Sequenz verliert dann
   * keine Position: der nächste Tick/Takt holt die restlichen Exits über `retryPendingExits` nach (Secreview 3, #8).
   */
  prepareFlatten(reason: ExitReason, cancelledEntries: readonly string[] = []): ExitIntent[] {
    const now = this.now();
    // ENTSCHEIDUNG (Vorregistrierung, Punkt „flatten"): Die Parkposition
    // bleibt STEHEN. `flatten` beendet Marktrisiko; ein Geldmarktpapier mit
    // Duration unter drei Monaten trägt keins, es ist Kasse in anderer Form.
    // Sie zu verkaufen und im nächsten Takt wieder zu kaufen wäre genau die
    // Hyperaktivität, gegen die das Band gebaut ist. Wer sie los sein will,
    // schaltet `risk.cashParking.enabled` aus — dann räumt die Treasury sie
    // im nächsten Zyklus selbst (Rückzug, risk/parken.ts).
    const park = this.parkSymbol !== null && this.book.positions.has(this.parkSymbol) ? this.parkSymbol : null;
    if (park !== null) {
      this.journal.append(
        'note',
        { symbol: park, text: `flatten (${reason}): Parkposition bleibt stehen (Kasse im Geldmarkt, kein Marktrisiko) — risk.cashParking.enabled: false räumt sie` },
        now,
      );
    }
    const intents: ExitIntent[] = this.strategieSymbole().map((symbol) => ({ kind: 'exit', symbol, reason, decidedAt: now }));
    for (const it of intents) {
      const pos = this.book.positions.get(it.symbol)!;
      const prev = this.book.pendingExits.get(it.symbol);
      this.book.pendingExits.set(it.symbol, {
        clientId: prev?.clientId ?? null,
        orderId: prev?.orderId ?? null,
        reason,
        since: prev?.since ?? now,
        attempts: prev?.attempts ?? 0,
        lastAttemptAt: 0, // sofort fällig
        lastError: 'flatten vorgemerkt — Ausführung folgt',
        intent: it,
      });
      this.log.warn(`Flatten ${it.symbol} ${pos.side} ${pos.qty} (${reason})`);
    }
    this.journal.append('note', { text: `flatten (${reason}): eigene Einstiege storniert, Buch-Positionen vorgemerkt und werden geschlossen`, cancelledEntries: [...cancelledEntries], positions: intents.map((i) => i.symbol) }, now);
    return intents;
  }


  /* ── Treasury: Geldmarkt-Parken (risk/parken.ts) ── */

  /**
   * Eine Umschichtung der Treasury ausführen: schlichte Marktorder, kein
   * Bracket, kein Stop-Bein, kein Ziel (Eigenschaft 3 der Vorregistrierung).
   *
   * Idempotenz wie überall an der LOGISCHEN Einheit (§0.6): Die Kennung
   * kommt aus (Modus, Parksymbol, Bucket der Entscheidung, Seite) — Kauf über
   * `entryClientId`, Verkauf über `exitClientId`, also verschiedene Kennungen
   * für verschiedene Seiten desselben Buckets. Vor dem Senden wird nachgesehen;
   * existiert die Order, wird sie übernommen statt erneut geschickt.
   *
   * `day` als Gültigkeit: Eine Park-Order, die heute nicht füllt, soll morgen
   * neu entschieden und nicht über Nacht in einem anderen Markt ausgeführt
   * werden. (Krypto handelt durch, dort `gtc`.)
   */
  async park(intent: ParkIntent): Promise<ExecResult> {
    const sym = intent.symbol;
    const r = (ok: boolean, note: string, ids?: { orderId?: string | null; clientId?: string }): ExecResult => {
      const res: ExecResult = { symbol: sym, kind: 'park', ok, note };
      if (ids?.orderId) res.orderId = ids.orderId;
      if (ids?.clientId) res.clientId = ids.clientId;
      return res;
    };
    if (!this.istPark(sym)) return r(false, `Parken: ${sym} ist nicht das Parksymbol dieser Engine`);
    if (this.parkOrder) return r(true, 'Park-Order bereits offen — keine zweite');
    const qty = roundQtyFor(intent.qty, this.assetClass);
    if (!(qty > 0)) return r(true, `Parken: Stückzahl nach Rundung 0 (${intent.qty})`);
    if (intent.side === 'sell') {
      const held = this.book.positions.get(sym)?.qty ?? 0;
      if (!(held > 0)) return r(true, 'Parken: nichts zu verkaufen');
    }

    const anchor = decisionBucketStart(intent.decidedAt, this.timeframe, this.assetClass, this.calendar);
    const clientId = intent.side === 'buy' ? entryClientId(this.mode, sym, anchor) : exitClientId(this.mode, sym, anchor);
    const existing = await this.client.getOrderByClientId(clientId);
    if (existing) {
      this.parkOrder = { clientId, orderId: existing.id, side: intent.side, qty, booked: 0, submittedAt: existing.submittedAt ?? this.now() };
      await this.syncParkOrder();
      return r(true, `Park-Order zur Kennung existiert bereits (${existing.status}) — nicht erneut gesendet`, { orderId: existing.id, clientId });
    }
    const order: NewOrder = {
      symbol: sym,
      side: intent.side,
      qty,
      type: 'market',
      timeInForce: this.assetClass === 'crypto' ? 'gtc' : 'day',
      clientOrderId: clientId,
    };
    const submittedAt = this.now();
    // Vor dem Senden merken: Der Fill kann über den Stream ankommen, bevor der POST zurück ist.
    this.parkOrder = { clientId, orderId: null, side: intent.side, qty, booked: 0, submittedAt };
    let submitted: AlpacaOrder;
    try {
      submitted = await this.client.submitOrder(order);
    } catch (e) {
      if (isDuplicateError(e)) {
        const again = await this.client.getOrderByClientId(clientId);
        if (again) {
          this.parkOrder = { clientId, orderId: again.id, side: intent.side, qty, booked: 0, submittedAt };
          await this.syncParkOrder();
          return r(true, `Park-Order existierte bereits (${again.status})`, { orderId: again.id, clientId });
        }
      }
      this.parkOrder = null;
      throw e;
    }
    this.parkOrder.orderId = submitted.id;
    this.journal.append(
      'order_submitted',
      { purpose: 'park', symbol: sym, clientId, orderId: submitted.id, side: order.side, qty: order.qty, type: order.type, tif: order.timeInForce, refPrice: intent.refPrice, reason: intent.reason, pflicht: intent.pflicht },
      submittedAt,
    );
    this.log.info(`Geldmarkt ${order.side} ${sym} ${order.qty}`, { clientId, orderId: submitted.id, reason: intent.reason });
    if (submitted.filledQty > 0) this.applyParkFill(submitted, submittedAt);
    if (!isOpenStatus(submitted.status)) this.parkOrder = null;
    return r(true, `Park-Order gesendet (${intent.reason})`, { orderId: submitted.id, clientId });
  }

  /**
   * Stand der offenen Park-Order nachsehen und Fills buchen. Wird je Tick
   * aufgerufen, BEVOR `decide()` läuft: Solange eine Order offen ist, plant
   * die Treasury keine zweite (`LogicContext.parkPending`).
   */
  async syncParkOrder(): Promise<void> {
    const ref = this.parkOrder;
    if (!ref) return;
    const now = this.now();
    const o = ref.orderId ? await this.client.getOrder(ref.orderId) : await this.client.getOrderByClientId(ref.clientId);
    if (!o) {
      if (now - ref.submittedAt > OrderExecutor.PENDING_ENTRY_TTL_MS) {
        this.parkOrder = null;
        this.journal.append('order_update', { purpose: 'park', symbol: this.parkSymbol, clientId: ref.clientId, event: 'vanished', note: 'Park-Order beim Broker unbekannt — vergessen' }, now);
      }
      return;
    }
    ref.orderId = o.id;
    if (o.filledQty > 0) this.applyParkFill(o, now);
    if (!isOpenStatus(o.status)) {
      this.parkOrder = null;
      if (o.status !== 'filled') {
        this.journal.append('order_update', { purpose: 'park', symbol: o.symbol, orderId: o.id, clientId: o.clientOrderId, event: o.status, filledQty: o.filledQty }, now);
      }
    }
  }

  /** Offene Park-Order stornieren (flatten, Abbau). Gibt true zurück, wenn ein Storno angefordert wurde. */
  async cancelParkOrder(): Promise<boolean> {
    const ref = this.parkOrder;
    if (!ref?.orderId) return false;
    const o = await this.client.getOrder(ref.orderId);
    if (!o || !isOpenStatus(o.status)) {
      await this.syncParkOrder();
      return false;
    }
    try {
      await this.client.cancelOrder(o.id);
      this.journal.append('order_update', { purpose: 'park', symbol: o.symbol, orderId: o.id, clientId: o.clientOrderId, event: 'cancel_requested', note: 'Park-Order storniert' }, this.now());
      return true;
    } catch (e) {
      if (!is422(e)) throw e;
      await this.syncParkOrder();
      return false;
    }
  }

  /**
   * Fill einer Park-Order buchen — idempotent über die kumulierte Füllmenge,
   * und ausdrücklich OHNE Trade: Trades tragen `oos_trades`, `feeShare`,
   * Profitfaktor und die Live-Reife; eine Treasury-Umschichtung gehört dort
   * nicht hinein (sie ist Kasse, die die Form wechselt). Ihre Kosten stecken
   * live im Fill-Kurs.
   */
  applyParkFill(order: AlpacaOrder, ts: Ms): void {
    const ref = this.parkOrder;
    const sym = order.symbol;
    if (!this.istPark(sym)) return;
    const neu = Number(((order.filledQty ?? 0) - (ref?.clientId === order.clientOrderId || ref?.orderId === order.id ? ref.booked : 0)).toFixed(8));
    if (!(neu > 0)) return;
    const price = order.filledAvgPrice ?? 0;
    if (!(price > 0)) return;
    if (ref && (ref.clientId === order.clientOrderId || ref.orderId === order.id)) ref.booked = order.filledQty;
    const alt = this.book.positions.get(sym) ?? null;
    if (order.side === 'buy') {
      const qty = Number(((alt?.qty ?? 0) + neu).toFixed(8));
      const einstand = alt ? (alt.qty * alt.entryPrice + neu * price) / qty : price;
      // Keine Strategie-Position: kein Stop, kein Ziel, keine Stufe mit Latte.
      this.book.positions.set(sym, {
        symbol: sym,
        side: 'long',
        qty,
        entryPrice: einstand,
        entryTime: alt?.entryTime ?? ts,
        stop: null,
        target: null,
        initialStop: null,
        highWater: einstand,
        strategy: PARK_STRATEGY_ID,
        barsHeld: alt?.barsHeld ?? 0,
        entryDay: dayKeyFor(alt?.entryTime ?? ts, this.assetClass),
        stufe: PARK_STUFE,
      });
    } else {
      const rest = Number(((alt?.qty ?? 0) - neu).toFixed(8));
      if (alt && rest > 1e-9) this.book.positions.set(sym, { ...alt, qty: rest });
      else this.book.positions.delete(sym);
    }
    this.journal.append(
      'fill',
      { purpose: 'park', symbol: sym, orderId: order.id, clientId: order.clientOrderId, side: order.side, qty: neu, price, cumQty: order.filledQty, status: order.status, note: 'Geldmarkt-Parken — kein Trade' },
      ts,
    );
    this.log.info(`Geldmarkt-Fill ${order.side} ${sym} ${neu} @ ${price}`, { orderId: order.id });
  }

  /* ── REST-Fallback zu trade_updates ── */

  /**
   * Buch mit dem Broker-Orderbuch abgleichen: offene Einstiege nachsehen
   * (Fill ⇒ Position; tot ⇒ Pending weg), Exit-Fills der Positionen buchen
   * (Stop-/Ziel-Bein, eigene Exits, Flatten-Schlüsse), Schutz-Stop-Verweise
   * auffrischen, Rest-Orders geschlossener Positionen abräumen.
   */
  async syncOrders(): Promise<void> {
    const now = this.now();
    // (a) Offene Einstiege
    for (const [sym, pe] of [...this.book.pendingEntries]) {
      let o = pe.orderId ? await this.client.getOrder(pe.orderId) : await this.client.getOrderByClientId(pe.clientId);
      if (o) o = await this.withLegs(o);
      if (!o) {
        if (now - pe.submittedAt > OrderExecutor.PENDING_ENTRY_TTL_MS) {
          this.book.clearPending(sym);
          this.journal.append('order_update', { symbol: sym, clientId: pe.clientId, event: 'vanished', note: 'Einstiegs-Order beim Broker unbekannt — Pending gelöscht' }, now);
          this.log.warn('Einstiegs-Order beim Broker unbekannt — Pending gelöscht', { symbol: sym, clientId: pe.clientId });
        }
        continue;
      }
      pe.orderId = o.id;
      if (o.filledQty > 0) await this.applyEntryFill(o, now);
      if (!isOpenStatus(o.status)) {
        this.book.clearPending(sym);
        if (o.status !== 'filled') {
          this.journal.append('order_update', { purpose: 'entry', symbol: sym, orderId: o.id, clientId: o.clientOrderId, event: o.status, filledQty: o.filledQty }, now);
        }
      }
    }
    // (b) Exit-Fills aller Positionen (Beine, eigene Exits, Flatten) — ohne das
    // Parksymbol: Dessen Verkäufe bucht `applyParkFill`, nie der Trade-Pfad.
    await this.syncExitFillsFor(this.strategieSymbole());
    await this.syncParkOrder();
    // (c) Eigene Exit-Orders: tote Orders für den Wiederholversuch freigeben
    for (const [sym, pe] of [...this.book.pendingExits]) {
      if (!this.book.positions.has(sym)) {
        this.book.pendingExits.delete(sym);
        continue;
      }
      if (!pe.orderId && !pe.clientId) continue;
      const o = pe.orderId ? await this.client.getOrder(pe.orderId) : await this.client.getOrderByClientId(pe.clientId!);
      if (!o) continue;
      if (o.filledQty > 0) this.applyExitFill(o, { ts: now, reason: pe.reason });
      if (isDead(o) && pe.intent) {
        pe.orderId = null;
        pe.clientId = null;
        pe.lastError = `Exit-Order ${o.status} — Wiederholung`;
      }
    }
    // (d) Schutz-Stop-Verweise: Broker-ID nachtragen, tote Verweise löschen (ensureProtectiveStops setzt nach)
    for (const [sym, prot] of [...this.book.protectiveOrders]) {
      const pos = this.book.positions.get(sym);
      if (!pos) {
        this.book.protectiveOrders.delete(sym);
        continue;
      }
      const o = prot.orderId ? await this.client.getOrder(prot.orderId) : await this.client.getOrderByClientId(prot.clientId);
      if (!o) {
        this.book.protectiveOrders.delete(sym);
        continue;
      }
      prot.orderId = o.id;
      if (o.filledQty > 0 && o.side === exitSideOf(pos)) this.applyExitFill(o, { ts: now, reason: 'stop' });
      if (!isOpenStatus(o.status)) this.book.protectiveOrders.delete(sym);
    }
    // (e) Rest-Orders geschlossener Positionen abräumen
    await this.cleanupClosed();
  }

  /** Gefüllte Orders auf der Exit-Seite seit Einstieg buchen (Beine, eigene Exits, Flatten-Schlüsse, Fremdverkäufe). */
  private async syncExitFillsFor(symbols: readonly string[]): Promise<void> {
    const list = symbols.filter((s) => this.book.positions.has(s));
    if (list.length === 0) return;
    let minEntry = Number.POSITIVE_INFINITY;
    for (const s of list) minEntry = Math.min(minEntry, this.book.positions.get(s)!.entryTime);
    const closed = flattenOrders(await this.client.listOrders({ status: 'closed', symbols: list, after: minEntry - 3 * DAY, nested: true, limit: 500 }));
    for (const o of closed) {
      const pos = this.book.positions.get(o.symbol);
      if (!pos || o.filledQty <= 0 || o.side !== exitSideOf(pos)) continue;
      if (o.filledAt !== null && o.filledAt < pos.entryTime) continue; // Fill aus einer früheren Runde desselben Symbols
      const pending = this.book.pendingExits.get(o.symbol);
      this.applyExitFill(o, { ts: this.now(), reason: pending?.reason ?? 'signal' });
    }
  }

  /** Offene Exit-artige Orders (Stop/Limit auf der Gegenseite) für Symbole ohne Position stornieren. */
  private async cleanupClosed(): Promise<void> {
    if (this.cleanupQueue.size === 0) return;
    const symbols = [...this.cleanupQueue].filter((s) => !this.book.positions.has(s));
    this.cleanupQueue.clear();
    if (symbols.length === 0) return;
    let open: AlpacaOrder[];
    try {
      open = flattenOrders(await this.client.listOrders({ status: 'open', symbols, nested: true }));
    } catch (e) {
      for (const s of symbols) this.cleanupQueue.add(s);
      this.log.warn('Aufräumen: offene Orders nicht abrufbar — später erneut', { error: errMsg(e) });
      return;
    }
    for (const o of open) {
      if (!symbols.includes(o.symbol) || !isOpenStatus(o.status)) continue;
      const own = parseClientId(o.clientOrderId);
      const exitLike = isStopType(o) || o.type === 'limit' || (own !== null && own.mode === this.mode);
      if (!exitLike) continue;
      try {
        await this.client.cancelOrder(o.id);
        this.journal.append('order_update', { symbol: o.symbol, orderId: o.id, clientId: o.clientOrderId, type: o.type, event: 'cancel_requested', note: 'Rest-Order nach Positionsschluss abgeräumt' }, this.now());
      } catch (e) {
        if (!is422(e)) {
          this.cleanupQueue.add(o.symbol);
          this.log.warn('Aufräumen: Storno fehlgeschlagen — später erneut', { symbol: o.symbol, orderId: o.id, error: errMsg(e) });
        }
      }
    }
  }

  /* ── trade_updates ── */

  /**
   * Ereignis aus dem Trade-Stream verarbeiten. Zuordnung über die eigene
   * Kennung (Einstieg/Exit/Stop) oder über Symbol + Seite (Bracket-Beine,
   * Flatten-Schlüsse, Fremdeingriffe im Alpaca-Dashboard).
   */
  async handleTradeUpdate(u: TradeUpdate): Promise<void> {
    const o = u.order;
    const sym = o.symbol;
    // Treasury zuerst: Im Parksymbol gibt es nur Park-Orders (es gehört ihr
    // allein). Ohne diesen Zweig liefe ein Park-Kauf als „entry-artig" durch
    // `applyEntryFill` (Position mit Schutz-Stop) und ein Park-Verkauf als
    // Exit durch `applyExitFill` (ein Trade, der Gates verschiebt).
    if (this.istPark(sym)) {
      const laut = u.event === 'fill' || u.event === 'partial_fill' || u.event === 'canceled' || u.event === 'expired' || u.event === 'rejected';
      if (laut) {
        this.journal.append('order_update', { purpose: 'park', symbol: sym, event: u.event, orderId: o.id, clientId: o.clientOrderId, side: o.side, status: o.status, filledQty: o.filledQty }, u.timestamp);
      }
      if (o.filledQty > 0) this.applyParkFill(o, u.timestamp);
      if (!isOpenStatus(o.status) && (this.parkOrder?.orderId === o.id || this.parkOrder?.clientId === o.clientOrderId)) this.parkOrder = null;
      return;
    }
    const pos = this.book.positions.get(sym);
    const pe = this.book.pendingEntries.get(sym);
    const own = parseClientId(o.clientOrderId);
    const isPendingEntry = pe !== undefined && (pe.clientId === o.clientOrderId || (pe.orderId !== null && pe.orderId === o.id));
    const isEntryLike = isPendingEntry || (own !== null && own.kind === 'entry' && own.mode === this.mode && !pos);
    const loud = u.event === 'fill' || u.event === 'partial_fill' || u.event === 'canceled' || u.event === 'expired' || u.event === 'rejected' || u.event === 'replaced' || u.event === 'done_for_day';
    if (loud) {
      this.journal.append('order_update', { symbol: sym, event: u.event, orderId: o.id, clientId: o.clientOrderId, type: o.type, side: o.side, status: o.status, filledQty: o.filledQty, price: u.price, qty: u.qty }, u.timestamp);
    }
    switch (u.event) {
      case 'fill':
      case 'partial_fill': {
        if (isEntryLike) {
          if (pe && pe.orderId === null) pe.orderId = o.id;
          await this.applyEntryFill(o, u.timestamp);
          return;
        }
        if (pos && o.side === exitSideOf(pos)) {
          const pending = this.book.pendingExits.get(sym);
          const isOwnStop = this.book.protectiveOrders.get(sym)?.orderId === o.id || (own !== null && own.kind === 'stop');
          const hint: ExitReason = isOwnStop ? 'stop' : (pending?.reason ?? 'signal');
          // Preis dieses Fills, nicht der kumulierte Durchschnitt: Nach einem Teilfill wäre der Rest sonst falsch bewertet.
          this.applyExitFill(o, { ts: u.timestamp, reason: hint, price: u.price });
          return;
        }
        if (pos && o.side !== exitSideOf(pos)) {
          this.log.warn('Fill auf der Positionsseite ohne eigenen Einstieg — Menge klärt der Abgleich', { symbol: sym, orderId: o.id });
          return;
        }
        this.log.info('Fill einer fremden Order — Abgleich übernimmt ggf.', { symbol: sym, orderId: o.id, clientId: o.clientOrderId });
        return;
      }
      case 'canceled':
      case 'expired':
      case 'rejected':
      case 'done_for_day': {
        if (isPendingEntry && pe) {
          if (o.filledQty > 0) await this.applyEntryFill(o, u.timestamp);
          this.book.clearPending(sym);
          this.log.warn(`Einstiegs-Order ${u.event}`, { symbol: sym, orderId: o.id, filledQty: o.filledQty });
        }
        const pex = this.book.pendingExits.get(sym);
        if (pex && (pex.orderId === o.id || (pex.clientId !== null && pex.clientId === o.clientOrderId))) {
          if (o.filledQty > 0) this.applyExitFill(o, { ts: u.timestamp, reason: pex.reason });
          if (this.book.positions.has(sym)) {
            pex.orderId = null;
            pex.clientId = null;
            pex.lastError = `Exit-Order ${u.event} — Wiederholung`;
            this.log.warn(`Exit-Order ${u.event} — wird wiederholt`, { symbol: sym, orderId: o.id });
          }
        }
        const prot = this.book.protectiveOrders.get(sym);
        if (prot && (prot.orderId === o.id || prot.clientId === o.clientOrderId)) {
          this.book.protectiveOrders.delete(sym);
          if (this.book.positions.has(sym) && u.event !== 'canceled') {
            // Ein abgelehnter/abgelaufener Schutz-Stop lässt die Position nackt — laut sagen; ensureProtectiveStops setzt nach.
            this.log.error(`Schutz-Stop ${u.event} — Position ${sym} ohne Broker-Stop bis zum nächsten Abgleich`, { orderId: o.id });
            await this.say('error', `Schutz-Stop für ${sym} ${u.event} — wird beim nächsten Abgleich nachgesetzt`);
          }
        }
        return;
      }
      case 'replaced': {
        const prot = this.book.protectiveOrders.get(sym);
        if (prot && prot.orderId === o.id) this.book.protectiveOrders.delete(sym); // neue ID kommt über findProtectiveOrder/ensureProtectiveStops
        return;
      }
      default: {
        if (isPendingEntry && pe && pe.orderId === null) pe.orderId = o.id;
        return;
      }
    }
  }

  private async say(level: 'info' | 'warn' | 'error', text: string): Promise<void> {
    if (!this.notify) return;
    try {
      await this.notify(level, text);
    } catch (e) {
      this.log.warn('Benachrichtigung fehlgeschlagen', { error: errMsg(e) });
    }
  }
}
