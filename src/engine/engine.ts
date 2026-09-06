/**
 * Die Schleife. Ein Prozess, ein Buch, ein Journal:
 *
 *   Stream-Bars → Puffer → je Tick (1 s) lokale Aggregation auf den
 *   Strategie-Zeitrahmen (mit Karenz nach Bucket-Ende) → neue geschlossene
 *   Bar? → Snapshot → `decide()` (derselbe Pfad wie im Backtest) → Intents
 *   → OrderExecutor → Buch nur aus Fills → State atomar speichern.
 *
 * Daneben: Abgleich Buch ↔ Broker alle `reconcileEverySec`, Broker-Uhr
 * alle 60 s, Kill-Switch-Datei `HALT` jede Sekunde. Fail-closed: Nach
 * `maxConsecutiveErrors` Fehlern in Folge Halt 'errors' (keine Einstiege,
 * Exits weiter) — ein Broker-Ausfall tötet die Schleife nie.
 *
 * Alles, was Buch oder State anfasst (Tick, Abgleich, Trade-Updates),
 * läuft hintereinander durch eine Warteschlange: Ein Fill, der während
 * eines Ticks eintrifft, wird nach dem Tick verarbeitet — nie mittendrin.
 */
import { existsSync } from 'node:fs';
import type { AlpacaClient, DataStream, StreamStatus, TradeStream, TradeUpdate } from '../alpaca/types.ts';
import type { Config } from '../core/config.ts';
import { aggregate, BarSeries, normalizeBars } from '../core/bars.ts';
import { emptyState, ensureDir, homePaths, Journal, StateStore, type EngineState, type HomePaths } from '../core/journal.ts';
import { errMsg, logger } from '../core/log.ts';
import { decide, type AssetFacts, type LogicContext, type SymbolInput } from '../core/logic.ts';
import { buildSessionInfo } from '../core/session.ts';
import { DAY, HOUR, MIN, addDays, dayKeyFor, isTradingDay, prevTradingDay, sessionBounds, type Calendar } from '../core/time.ts';
import type { AccountView, AssetClass, Bar, ExitReason, HaltState, IndicatorSet, Ms, Params, PositionState, Strategy, TimeframeMin } from '../core/types.ts';
import { resumeHalt } from '../risk/limits.ts';
import { backfill } from '../data/backfill.ts';
import { ensureCalendar } from '../data/calendar.ts';
import { BarStore, barStoreRoot, mergeBars, type BaseTimeframe } from '../data/store.ts';
import { Book } from './book.ts';
import { MarketClock, type ClockSnapshot } from './clock.ts';
import { parseClientId } from './ids.ts';
import { OrderExecutor, type NotifyFn } from './orders.ts';
import { reconcile } from './reconcile.ts';

export interface EngineTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface EngineDeps {
  config: Config;
  mode: 'paper' | 'live';
  home: string;
  client: AlpacaClient;
  dataStream: DataStream;
  tradeStream: TradeStream;
  strategyFor: (symbol: string) => { strategy: Strategy; params: Params } | null;
  benchmarkSymbol?: string | undefined;
  calendar?: Calendar | undefined;
  notify?: NotifyFn | undefined;
  now?: (() => Ms) | undefined;
  timers?: EngineTimers | undefined;
  log?: typeof logger | undefined;
  /** Injizierbar für Tests (Warteschleifen des Executors). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Bars-Cache; Default: `<home>/bars/<assetClass>/<feed>` (siehe data/store.ts). */
  store?: BarStore | undefined;
}

export interface EngineStatus {
  mode: 'paper' | 'live';
  running: boolean;
  halt: HaltState;
  positions: PositionState[];
  pendingEntries: string[];
  pendingExits: string[];
  protectiveOrders: Record<string, string>;
  lastBarAt: Record<string, Ms>;
  equity: number;
  cash: number;
  dayStartEquity: number;
  peakEquity: number;
  day: string;
  dayTradeCount: number;
  localDayTrades: number;
  patternDayTrader: boolean;
  streamStatus: { data: StreamStatus | null; trade: StreamStatus | null; dataLastMessageAt: Ms | null; tradeLastMessageAt: Ms | null };
  clock: ClockSnapshot | null;
  consecutiveErrors: number;
  startedAt: Ms | null;
  uptimeMs: number;
  lastTickAt: Ms | null;
  lastReconcileAt: Ms | null;
}

interface AccountInfo {
  equity: number;
  cash: number;
  dayTradeCount: number;
  patternDayTrader: boolean;
}

/** Hintereinander statt gleichzeitig: Tick, Abgleich und Trade-Updates teilen sich Buch und State. */
class Serial {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

/**
 * Backfill-Fenster: Warmup-Bars × Zeitrahmen × 1,5 + 3 Tage — bei Aktien
 * in Sitzungen gerechnet (390 min/Tag, 5 Handelstage je 7), sonst
 * unterschätzt die Minutenrechnung das Fenster um den Faktor 3,7.
 */
export function warmupWindowMs(bars: number, tf: TimeframeMin, assetClass: AssetClass): number {
  const need = Math.max(1, bars);
  if (assetClass === 'crypto') return need * tf * MIN * 1.5 + 3 * DAY;
  if (tf === 1440) return need * 1.5 * (7 / 5) * DAY + 3 * DAY;
  const sessions = Math.ceil((need * tf) / 390);
  return sessions * 1.5 * (7 / 5) * DAY + 3 * DAY;
}

const defaultTimers: EngineTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export class Engine {
  private readonly deps: EngineDeps;
  private readonly cfg: Config;
  private readonly mode: 'paper' | 'live';
  private readonly tf: TimeframeMin;
  private readonly baseTf: BaseTimeframe;
  private readonly assetClass: AssetClass;
  private readonly paths: HomePaths;
  private readonly journal: Journal;
  private readonly stateStore: StateStore;
  private readonly store: BarStore;
  private readonly log: typeof logger;
  private readonly now: () => Ms;
  private readonly timers: EngineTimers;
  private readonly serial = new Serial();

  private calendar: Calendar | undefined;
  private clock: MarketClock;
  private book = new Book();
  private executor: OrderExecutor | null = null;
  private state: EngineState | null = null;
  private account: AccountInfo = { equity: 0, cash: 0, dayTradeCount: 0, patternDayTrader: false };

  /** Basis-Bars je Symbol (1Min bzw. 1Day) — Backfill + Stream. */
  private readonly base = new Map<string, Bar[]>();
  /** Stream-Minutenbars bei Tages-Zeitrahmen (werden nicht gespeichert; der Tages-Backfill ersetzt sie). */
  private readonly streamMinute = new Map<string, Bar[]>();
  private readonly incoming = new Map<string, Bar[]>();
  private readonly dirtyStore = new Set<string>();
  private readonly aggDirty = new Set<string>();
  private readonly aggCache = new Map<string, { gridKey: number; series: BarSeries }>();
  private readonly indCache = new Map<string, { barT: Ms; strategyId: string; paramsKey: string; ind: IndicatorSet }>();
  private readonly assets = new Map<string, AssetFacts>();
  private readonly streamStatus: { data: StreamStatus | null; trade: StreamStatus | null } = { data: null, trade: null };
  private timerHandles: unknown[] = [];
  private tickQueued = false;
  private running = false;
  private startedAt: Ms | null = null;
  private lastTickAt: Ms | null = null;
  private lastReconcileAt: Ms | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.cfg = deps.config;
    this.mode = deps.mode;
    this.tf = deps.config.timeframe;
    this.baseTf = this.tf === 1440 ? '1Day' : '1Min';
    this.assetClass = deps.config.universe.assetClass;
    this.paths = homePaths(deps.home);
    this.journal = new Journal(this.paths.journal);
    this.stateStore = new StateStore(this.paths.state);
    this.store = deps.store ?? new BarStore(barStoreRoot(this.paths.bars, this.assetClass, deps.config.broker.feed));
    this.log = deps.log ?? logger;
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? defaultTimers;
    this.calendar = deps.calendar;
    this.clock = new MarketClock({ assetClass: this.assetClass, calendar: this.calendar, client: deps.client, now: this.now });
  }

  /* ───────────────────────── Lebenszyklus ───────────────────────── */

  async start(): Promise<void> {
    const now = this.now();
    ensureDir(this.paths.home);
    const acc = await this.deps.client.getAccount();
    this.account = { equity: acc.equity, cash: acc.cash, dayTradeCount: acc.daytradeCount, patternDayTrader: acc.patternDayTrader };
    const today = dayKeyFor(now, this.assetClass);
    const loaded = this.stateStore.load();
    if (loaded && loaded.mode !== this.mode) {
      throw new Error(`state.json gehört zum Modus '${loaded.mode}', die Engine läuft '${this.mode}' — getrenntes Home verwenden`);
    }
    const st = loaded ?? emptyState(this.mode, today, acc.equity);
    st.consecutiveErrors = 0;
    st.peakEquity = Math.max(st.peakEquity, acc.equity);
    this.state = st;
    this.book = Book.fromState(st);
    if (acc.tradingBlocked || acc.accountBlocked) {
      this.setHalt('errors', 'Konto gesperrt (trading_blocked/account_blocked)', now);
    }

    // Kalender: Datei/Broker, sonst der mitgegebene Stand, sonst der algorithmische Fallback.
    try {
      const cal = await ensureCalendar(this.deps.client, this.paths.calendar, addDays(today, -45), addDays(today, 45), now);
      if (cal.size > 0) this.calendar = cal;
    } catch (e) {
      this.log.warn('Kalender nicht ladbar — Fallback gilt', { error: errMsg(e) });
    }
    this.clock = new MarketClock({ assetClass: this.assetClass, calendar: this.calendar, client: this.deps.client, now: this.now });
    await this.clock.refresh();
    this.rollover(now);

    for (const sym of this.cfg.universe.symbols) {
      try {
        const a = await this.deps.client.getAsset(sym);
        if (a) this.assets.set(sym, { tradable: a.tradable, shortable: a.shortable });
        else this.log.warn('Asset bei Alpaca unbekannt', { symbol: sym });
      } catch (e) {
        this.log.warn('Asset nicht abfragbar', { symbol: sym, error: errMsg(e) });
      }
    }

    this.executor = new OrderExecutor({
      client: this.deps.client,
      book: this.book,
      journal: this.journal,
      mode: this.mode,
      assetClass: this.assetClass,
      timeframe: this.tf,
      holdsOvernightFor: (s) => this.deps.strategyFor(s)?.strategy.holdsOvernight ?? true,
      now: this.now,
      sleep: this.deps.sleep,
      calendar: this.calendar,
      strategyIdFor: (s) => this.deps.strategyFor(s)?.strategy.id,
      notify: this.deps.notify,
      log: this.log,
    });

    await this.backfillAll(now);
    await this.executor.syncOrders();
    await this.reconcileInner(now);
    await this.adoptOpenEntryOrders();

    this.deps.dataStream.onBar((s, b) => this.onBar(s, b));
    this.deps.dataStream.onStatus((ev) => {
      this.streamStatus.data = ev.status;
      if (ev.status === 'disconnected' || ev.status === 'error') this.log.warn('DataStream', { status: ev.status, detail: ev.detail });
    });
    this.deps.tradeStream.onUpdate((u) => {
      void this.onTradeUpdate(u);
    });
    this.deps.tradeStream.onStatus((ev) => {
      this.streamStatus.trade = ev.status;
      if (ev.status === 'disconnected' || ev.status === 'error') this.log.warn('TradeStream', { status: ev.status, detail: ev.detail });
    });
    try {
      await this.deps.dataStream.connect();
      await this.deps.dataStream.subscribeBars(this.allSymbols());
    } catch (e) {
      this.log.error('DataStream: Verbindung fehlgeschlagen — Reconnect läuft, Einstiege bleiben bis dahin gesperrt (Datenfrische)', { error: errMsg(e) });
    }
    try {
      await this.deps.tradeStream.connect();
    } catch (e) {
      this.log.error('TradeStream: Verbindung fehlgeschlagen — REST-Abgleich übernimmt Fills', { error: errMsg(e) });
    }

    this.running = true;
    this.startedAt = now;
    this.timerHandles.push(this.timers.setInterval(() => this.scheduleTick(), 1000));
    this.timerHandles.push(this.timers.setInterval(() => void this.reconcileNow(), this.cfg.engine.reconcileEverySec * 1000));
    this.timerHandles.push(this.timers.setInterval(() => void this.clock.refresh(), 60_000));
    this.journal.append(
      'start',
      { mode: this.mode, symbols: this.cfg.universe.symbols, timeframe: this.tf, assetClass: this.assetClass, equity: acc.equity, halt: st.halt, positions: [...this.book.positions.keys()] },
      now,
    );
    this.log.info(`Engine gestartet (${this.mode})`, { symbols: this.cfg.universe.symbols, timeframe: this.tf, equity: acc.equity });
    this.saveState();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const h of this.timerHandles) this.timers.clearInterval(h);
    this.timerHandles = [];
    await this.serial.run(async () => {
      try {
        await this.deps.dataStream.close();
      } catch (e) {
        this.log.warn('DataStream schließen fehlgeschlagen', { error: errMsg(e) });
      }
      try {
        await this.deps.tradeStream.close();
      } catch (e) {
        this.log.warn('TradeStream schließen fehlgeschlagen', { error: errMsg(e) });
      }
      this.flushStore(true);
      if (this.state) {
        this.saveState();
        this.journal.append('stop', { positions: [...this.book.positions.keys()], halt: this.state.halt }, this.now());
      }
      this.log.info('Engine gestoppt — Positionen bleiben, Stops liegen beim Broker');
    });
  }

  /** Ein Zyklus — für Tests direkt aufrufbar. */
  tick(now: Ms = this.now()): Promise<void> {
    return this.serial.run(() => this.tickInner(now));
  }

  /** Auflösen, sobald alle bis jetzt eingereihten Arbeiten (Ticks, Trade-Updates, Abgleiche) verarbeitet sind. */
  idle(): Promise<void> {
    return this.serial.run(async () => undefined);
  }

  /** Abgleich jetzt (Timer und Tests). */
  reconcileNow(now: Ms = this.now()): Promise<void> {
    return this.serial.run(async () => {
      try {
        await this.requireExecutor().syncOrders();
        await this.reconcileInner(now);
        this.st().consecutiveErrors = 0;
      } catch (e) {
        await this.onError('reconcile', e, now);
      }
      this.saveState();
    });
  }

  /** Alles glatt (kill_switch/manual) — Fills bucht der Abgleich. */
  flatten(reason: ExitReason): Promise<void> {
    return this.serial.run(async () => {
      await this.requireExecutor().flattenAll(reason);
      this.saveState();
    });
  }

  /** Halt bewusst aufheben (setzt den Peak auf die aktuelle Equity, steht im Journal). */
  resume(note: string): Promise<void> {
    return this.serial.run(async () => {
      const st = this.st();
      const now = this.now();
      const r = resumeHalt(st.halt, this.accountView(), now, note);
      st.halt = r.halt;
      st.peakEquity = r.account.peakEquity;
      this.journal.append('resume', { note: r.halt.note }, now);
      this.saveState();
    });
  }

  status(): EngineStatus {
    const st = this.state;
    const now = this.now();
    const today = dayKeyFor(now, this.assetClass);
    const prot: Record<string, string> = {};
    for (const [s, p] of this.book.protectiveOrders) prot[s] = p.clientId;
    return {
      mode: this.mode,
      running: this.running,
      halt: st?.halt ?? { halted: false, reason: null, since: null, until: null, note: null },
      positions: [...this.book.positions.values()],
      pendingEntries: [...this.book.pendingEntries.keys()],
      pendingExits: [...this.book.pendingExits.keys()],
      protectiveOrders: prot,
      lastBarAt: { ...(st?.lastBarAt ?? {}) },
      equity: this.account.equity,
      cash: this.account.cash,
      dayStartEquity: st?.dayStartEquity ?? 0,
      peakEquity: st?.peakEquity ?? 0,
      day: st?.day ?? today,
      dayTradeCount: this.account.dayTradeCount,
      localDayTrades: this.localDayTrades(today),
      patternDayTrader: this.account.patternDayTrader,
      streamStatus: {
        data: this.streamStatus.data,
        trade: this.streamStatus.trade,
        dataLastMessageAt: this.deps.dataStream.lastMessageAt(),
        tradeLastMessageAt: this.deps.tradeStream.lastMessageAt(),
      },
      clock: this.clock.snapshot(),
      consecutiveErrors: st?.consecutiveErrors ?? 0,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === null ? 0 : now - this.startedAt,
      lastTickAt: this.lastTickAt,
      lastReconcileAt: this.lastReconcileAt,
    };
  }

  /* ───────────────────────── Tick ───────────────────────── */

  private scheduleTick(): void {
    if (this.tickQueued || !this.running) return;
    this.tickQueued = true;
    void this.serial.run(async () => {
      this.tickQueued = false;
      await this.tickInner(this.now());
    });
  }

  private async tickInner(now: Ms): Promise<void> {
    const st = this.st();
    const executor = this.requireExecutor();
    this.lastTickAt = now;
    try {
      this.checkHaltFile(now);
      this.rollover(now);
      this.ingestStreamBars();
      st.peakEquity = Math.max(st.peakEquity, this.account.equity);

      const closedBefore = now - this.cfg.engine.barGraceSec * 1000;
      const benchSym = this.deps.benchmarkSymbol;
      const bench = benchSym ? this.closedSeries(benchSym, closedBefore) : null;
      const inputs: SymbolInput[] = [];
      const newBars = new Map<string, Bar>();
      for (const sym of this.cfg.universe.symbols) {
        const series = this.closedSeries(sym, closedBefore);
        if (series.length === 0) continue;
        const i = series.length - 1;
        const t = series.t[i]!;
        if (t <= (st.lastBarAt[sym] ?? Number.NEGATIVE_INFINITY)) continue;
        newBars.set(sym, series.at(i));
        const choice = this.deps.strategyFor(sym);
        if (!choice) continue;
        const ind = this.indicators(sym, series, choice.strategy, choice.params);
        const bi = bench && bench.length ? bench.indexAtOrBefore(t) : -1;
        inputs.push({
          snap: {
            symbol: sym,
            bars: series,
            i,
            position: this.book.positions.get(sym) ?? null,
            session: buildSessionInfo(series, i, this.tf, this.assetClass, this.calendar),
            benchmark: bench && bi >= 0 ? { bars: bench, i: bi } : undefined,
          },
          strategy: choice.strategy,
          params: choice.params,
          ind,
        });
      }

      let failures = 0;
      if (inputs.length > 0) {
        const today = this.clock.today(now);
        const ctx: LogicContext = {
          now,
          today,
          nextTradingDay: this.clock.nextTradingDay(now),
          account: this.accountView(),
          positions: this.book.positions,
          pendingEntries: new Set(this.book.pendingEntries.keys()),
          halt: st.halt,
          risk: this.cfg.risk,
          session: this.cfg.session,
          assetClass: this.assetClass,
          timeframe: this.tf,
          dataFresh: this.dataFresh(now),
          localDayTrades: this.localDayTrades(today),
          assetFacts: (s) => this.assets.get(s),
        };
        const res = decide(ctx, inputs);
        const before = st.halt;
        st.halt = res.halt;
        if (res.haltTriggered) {
          this.journal.append('halt', { reason: res.halt.reason, note: res.halt.note, equity: this.account.equity }, now);
          this.log.error(`Halt ausgelöst: ${res.halt.note ?? res.halt.reason ?? ''}`);
          await this.say('error', `Halt: ${res.halt.note ?? res.halt.reason ?? ''}`);
        } else if (before.halted && !res.halt.halted) {
          this.journal.append('resume', { note: res.halt.note }, now);
          this.log.info(`Halt geendet: ${res.halt.note ?? ''}`);
        }
        for (const n of res.notes) {
          if (n.kind === 'info') continue;
          // Feld heißt `note`, nicht `kind`: `kind` ist der Event-Typ des Journals und würde überschrieben.
          this.journal.append('decision', { symbol: n.symbol, note: n.kind, text: n.text, bar: newBars.get(n.symbol)?.t ?? null }, now);
        }
        for (const it of res.intents) this.journal.append('intent', { ...it }, now);
        if (res.intents.length > 0) {
          const results = await executor.execute(res.intents);
          for (const r of results) {
            if (!r.ok) failures++;
            this.log.info(`Intent ${r.kind} ${r.symbol}: ${r.note}`, { ok: r.ok, orderId: r.orderId ?? null });
          }
        }
      }

      const closes = new Map<string, number>();
      for (const [sym, bar] of newBars) {
        closes.set(sym, bar.c);
        st.lastBarAt[sym] = bar.t;
      }
      this.book.advanceAll(closes);
      for (const r of await executor.retryPendingExits()) if (!r.ok) failures++;
      if (newBars.size > 0) this.flushStore(false);
      if (failures > 0) throw new Error(`${failures} Order-Ausführung(en) fehlgeschlagen`);
      st.consecutiveErrors = 0;
    } catch (e) {
      await this.onError('tick', e, now);
    }
    this.saveState();
  }

  /* ───────────────────────── Bausteine ───────────────────────── */

  private st(): EngineState {
    if (!this.state) throw new Error('Engine nicht gestartet');
    return this.state;
  }

  private requireExecutor(): OrderExecutor {
    if (!this.executor) throw new Error('Engine nicht gestartet');
    return this.executor;
  }

  private allSymbols(): string[] {
    const set = new Set(this.cfg.universe.symbols);
    if (this.deps.benchmarkSymbol) set.add(this.deps.benchmarkSymbol);
    return [...set];
  }

  private accountView(): AccountView {
    const st = this.st();
    return {
      equity: this.account.equity,
      cash: this.account.cash,
      dayStartEquity: st.dayStartEquity,
      peakEquity: st.peakEquity,
      dayTradeCount: this.account.dayTradeCount,
      patternDayTrader: this.account.patternDayTrader,
    };
  }

  private dataFresh(now: Ms): boolean {
    const last = this.deps.dataStream.lastMessageAt();
    return last !== null && now - last <= this.cfg.engine.maxDataAgeSec * 1000;
  }

  /** Lokal gezählte Daytrades der letzten fünf Handelstage (inkl. heute). */
  private localDayTrades(today: string): number {
    const days = [today];
    let d = today;
    for (let i = 0; i < 4; i++) {
      try {
        d = prevTradingDay(d, this.assetClass, this.calendar);
      } catch {
        break;
      }
      days.push(d);
    }
    return this.book.dayTradesIn(days);
  }

  private checkHaltFile(now: Ms): void {
    const st = this.st();
    const present = existsSync(this.paths.haltFlag);
    if (present && !st.halt.halted) {
      this.setHalt('manual', 'HALT-Datei gesetzt — keine Einstiege, Exits laufen', now);
    } else if (!present && st.halt.halted && st.halt.reason === 'manual') {
      st.halt = { halted: false, reason: null, until: null, since: null, note: 'HALT-Datei entfernt' };
      this.journal.append('resume', { note: 'HALT-Datei entfernt' }, now);
      this.log.info('HALT-Datei entfernt — Einstiege wieder erlaubt');
    }
  }

  private setHalt(reason: HaltState['reason'] & string, note: string, now: Ms): void {
    const st = this.st();
    st.halt = { halted: true, reason, since: now, until: null, note };
    this.journal.append('halt', { reason, note }, now);
    this.log.warn(`Halt (${reason}): ${note}`);
  }

  /** Neuer Handelstag ⇒ Tagesstart-Equity neu, alte Daytrade-Tage (> 7 Handelstage) vergessen. */
  private rollover(now: Ms): void {
    const st = this.st();
    const today = dayKeyFor(now, this.assetClass);
    if (today === st.day || !isTradingDay(today, this.assetClass, this.calendar)) return;
    st.day = today;
    if (this.account.equity > 0) st.dayStartEquity = this.account.equity;
    let keep = today;
    try {
      for (let i = 0; i < 7; i++) keep = prevTradingDay(keep, this.assetClass, this.calendar);
      this.book.pruneDayTrades(keep);
    } catch (e) {
      this.log.warn('Daytrade-Fenster nicht bereinigt', { error: errMsg(e) });
    }
    this.journal.append('note', { text: 'Tagesrollover', day: today, dayStartEquity: st.dayStartEquity }, now);
    this.log.info('Neuer Handelstag', { day: today, dayStartEquity: st.dayStartEquity });
  }

  private async backfillAll(now: Ms): Promise<void> {
    let warm = 0;
    for (const sym of this.cfg.universe.symbols) {
      const c = this.deps.strategyFor(sym);
      if (c) warm = Math.max(warm, c.strategy.warmupBars(c.params));
    }
    const from = now - warmupWindowMs(warm || 50, this.tf, this.assetClass);
    const res = await backfill({
      client: this.deps.client,
      store: this.store,
      symbols: this.allSymbols(),
      tf: this.baseTf,
      from,
      to: now,
      feed: this.cfg.broker.feed,
      log: (m) => this.log.info(m),
    });
    for (const [sym, bars] of res) {
      this.base.set(sym, bars);
      this.aggDirty.add(sym);
    }
  }

  /** Offene eigene Einstiegs-Orders (z. B. aus der Zeit vor einem Neustart) als Pending übernehmen. */
  private async adoptOpenEntryOrders(): Promise<void> {
    const open = await this.deps.client.listOrders({ status: 'open', symbols: this.cfg.universe.symbols, nested: true });
    for (const o of open) {
      const p = parseClientId(o.clientOrderId);
      if (!p || p.kind !== 'entry' || p.mode !== this.mode) continue;
      if (this.book.positions.has(o.symbol) || this.book.pendingEntries.has(o.symbol)) continue;
      this.book.markPending(o.symbol, { clientId: o.clientOrderId, orderId: o.id, intent: null, submittedAt: o.submittedAt ?? this.now() });
      this.log.warn('Offene Einstiegs-Order übernommen', { symbol: o.symbol, clientId: o.clientOrderId });
    }
  }

  private onBar(symbol: string, bar: Bar): void {
    const list = this.incoming.get(symbol) ?? [];
    list.push(bar);
    this.incoming.set(symbol, list);
  }

  private onTradeUpdate(u: TradeUpdate): Promise<void> {
    return this.serial.run(async () => {
      if (!this.executor || !this.state) return;
      try {
        await this.executor.handleTradeUpdate(u);
        this.saveState();
      } catch (e) {
        await this.onError('trade_update', e, this.now());
        this.saveState();
      }
    });
  }

  private ingestStreamBars(): void {
    if (this.incoming.size === 0) return;
    for (const [sym, list] of this.incoming) {
      const fresh = normalizeBars(list);
      if (this.tf === 1440) {
        // Tages-Zeitrahmen: Minutenbars nur im Speicher (heutige Bar), Cache bleibt Tagesbars.
        const cutoff = this.now() - 3 * DAY;
        const merged = mergeBars(this.streamMinute.get(sym) ?? [], fresh).filter((b) => b.t >= cutoff);
        this.streamMinute.set(sym, merged);
      } else {
        this.base.set(sym, mergeBars(this.base.get(sym) ?? [], fresh));
        this.dirtyStore.add(sym);
      }
      this.aggDirty.add(sym);
    }
    this.incoming.clear();
  }

  /** Neue Stream-Bars in den Cache schreiben (je geschlossener Strategie-Bar bzw. beim Stopp). */
  private flushStore(force: boolean): void {
    if (this.dirtyStore.size === 0) return;
    for (const sym of [...this.dirtyStore]) {
      const bars = this.base.get(sym);
      if (!bars) continue;
      try {
        this.store.upsert(sym, this.baseTf, bars);
        this.dirtyStore.delete(sym);
      } catch (e) {
        this.log.warn('Bars-Cache nicht schreibbar', { symbol: sym, error: errMsg(e) });
        if (!force) return;
      }
    }
  }

  /** Geschlossene Bars des Strategie-Zeitrahmens (gecacht je Bucket bzw. bis neue Basis-Bars kommen). */
  private closedSeries(symbol: string, closedBefore: Ms): BarSeries {
    const gridKey = this.tf === 1440 ? Math.floor(closedBefore / HOUR) : Math.floor(closedBefore / (this.tf * MIN));
    const hit = this.aggCache.get(symbol);
    if (hit && hit.gridKey === gridKey && !this.aggDirty.has(symbol)) return hit.series;
    const base = this.base.get(symbol) ?? [];
    let bars: Bar[];
    if (this.tf === 1440) {
      // Tagesbars vom Broker (Zeitstempel = Tagesbeginn) auf die Sitzungseröffnung normieren — wie app.ts/seriesForTimeframe.
      const daily = new Map<number, Bar>();
      for (const b of base) {
        const bounds = sessionBounds(dayKeyFor(b.t, this.assetClass), this.assetClass, this.calendar);
        if (!bounds || bounds.close > closedBefore) continue;
        daily.set(bounds.open, { ...b, t: bounds.open });
      }
      // Heutige Bar aus Stream-Minuten, solange der Tages-Backfill sie noch nicht liefert.
      const fromStream = aggregate(this.streamMinute.get(symbol) ?? [], { tf: 1440, assetClass: this.assetClass, calendar: this.calendar, closedBefore });
      for (const b of fromStream) if (!daily.has(b.t)) daily.set(b.t, b);
      bars = [...daily.values()].sort((x, y) => x.t - y.t);
    } else {
      bars = aggregate(base, { tf: this.tf, assetClass: this.assetClass, calendar: this.calendar, closedBefore });
    }
    const series = BarSeries.from(bars);
    this.aggCache.set(symbol, { gridKey, series });
    this.aggDirty.delete(symbol);
    return series;
  }

  /** Indikatoren einmal je (Symbol, neue Bar, Strategie, Parameter). */
  private indicators(symbol: string, series: BarSeries, strategy: Strategy, params: Params): IndicatorSet {
    const barT = series.t[series.length - 1]!;
    const paramsKey = JSON.stringify(params);
    const hit = this.indCache.get(symbol);
    if (hit && hit.barT === barT && hit.strategyId === strategy.id && hit.paramsKey === paramsKey) return hit.ind;
    const ind = strategy.precompute(series, params);
    this.indCache.set(symbol, { barT, strategyId: strategy.id, paramsKey, ind });
    return ind;
  }

  private async reconcileInner(now: Ms): Promise<void> {
    const st = this.st();
    const executor = this.requireExecutor();
    const r = await reconcile({
      client: this.deps.client,
      book: this.book,
      journal: this.journal,
      config: this.cfg,
      state: st,
      now,
      notify: this.deps.notify,
      log: this.log,
      lastPriceOf: (s) => {
        const bars = this.base.get(s);
        return bars && bars.length ? bars[bars.length - 1]!.c : undefined;
      },
      ensureStops: () => executor.ensureProtectiveStops(),
    });
    this.account = { equity: r.account.equity, cash: r.account.cash, dayTradeCount: r.account.daytradeCount, patternDayTrader: r.account.patternDayTrader };
    st.peakEquity = Math.max(st.peakEquity, r.account.equity);
    this.lastReconcileAt = now;
  }

  private async onError(where: string, e: unknown, now: Ms): Promise<void> {
    const st = this.st();
    st.consecutiveErrors++;
    const msg = errMsg(e);
    this.journal.append('error', { where, error: msg, consecutive: st.consecutiveErrors }, now);
    this.log.error(`Fehler in ${where} (${st.consecutiveErrors} in Folge)`, { error: msg });
    if (st.consecutiveErrors >= this.cfg.engine.maxConsecutiveErrors && !st.halt.halted) {
      const note = `${st.consecutiveErrors} Fehler in Folge (${where}): ${msg}`;
      this.setHalt('errors', note, now);
      await this.say('error', `Halt (errors): ${note}`);
    }
  }

  private async say(level: 'info' | 'warn' | 'error', text: string): Promise<void> {
    this.journal.append('notify', { level, text }, this.now());
    if (!this.deps.notify) return;
    try {
      await this.deps.notify(level, text);
    } catch (e) {
      this.log.warn('Benachrichtigung fehlgeschlagen', { error: errMsg(e) });
    }
  }

  private saveState(): void {
    if (!this.state) return;
    Object.assign(this.state, this.book.toState());
    try {
      this.stateStore.save(this.state);
    } catch (e) {
      this.log.error('State nicht speicherbar', { error: errMsg(e) });
    }
  }
}
