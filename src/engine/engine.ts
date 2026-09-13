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
 *
 * ── Wann die Tages-Notbremse greift (Prüfbefund K1, 09.09.2026) ──────────
 *
 * Die Bremse (`risk.maxDailyLossPct`, risk/limits.ts) misst
 * `equity − dayStartEquity`. `dayStartEquity` ist seit K1 die SCHLUSS-Equity
 * des Vortags — Alpacas `last_equity` (Rückfall: aktuelle Equity, wenn es
 * fehlt) — gesetzt beim Tagesrollover UND beim ersten State. Vorher war es
 * die Equity beim ersten Tick nach dem Gap: Auf der Plattform (erster Takt
 * 09:30, dann `decide()` mit derselben Equity) maß die Bremse bei Tagesbars
 * damit immer 0 % — ein Placebo. Der Simulator setzt die Tagesstart-Equity
 * am Tageswechsel auf die Schluss-Equity des Vortags (simulator.ts); jetzt
 * rechnen beide von derselben Marke.
 *
 * Geprüft wird die Bremse in `decide()`, also je GESCHLOSSENER Bar — bei
 * Tagesbars einmal je Handelstag, nicht davor:
 *   - Dauerprozess (`run`): erster Tick nach Schluss + Karenz (≈ 16:00:04
 *     ET), Equity aus dem letzten Abgleich ≈ Schluss ⇒ Schluss-zu-Schluss
 *     wie der Simulator; der Exit ist bis zur Eröffnung zurückgestellt und
 *     füllt am nächsten Open — wie im Simulator.
 *   - Plattform-Takt: Der Takt läuft nur bei offenem Markt; die Tagesbar
 *     wird deshalb erst im ERSTEN Takt des Folgetags (≈ 09:30:20 ET)
 *     entschieden, mit der Equity NACH dem Gap gegen den Vortagesschluss.
 *     Das fängt den Übernacht-Gap (der Fall des Befunds) — den Verlauf
 *     innerhalb des laufenden Handelstags sieht die Bremse dort erst mit der
 *     nächsten Tagesbar, also am nächsten Morgen wieder gegen den Schluss.
 *     Nur Nutzer mit zurückgestellter Arbeit oder Kommando werden auch nach
 *     Schluss getaktet und entscheiden um 16:00 — für sie gilt exakt die
 *     Simulator-Marke. Eine Prüfung je Takt (ohne neue Bar) wäre strenger
 *     als gemessen und ist eine Owner-Entscheidung (siehe Bericht).
 * Der Drawdown-Halt sieht dagegen den Peak je Tick (Intraday), der Simulator
 * nur Schlusskurse — benannt in core/logic.ts.
 */
import { existsSync, readFileSync, statSync as fsStatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isOpenStatus, type AlpacaClient, type DataStream, type StreamStatus, type TradeStream, type TradeUpdate } from '../alpaca/types.ts';
import type { Config } from '../core/config.ts';
import { aggregate, BarSeries, normalizeBars } from '../core/bars.ts';
import {
  emptyState,
  ensureDir,
  equityHistorieAnhaengen,
  homePaths,
  Journal,
  StateStore,
  type EngineState,
  type HomePaths,
  type JournalLike,
  type StateStoreLike,
} from '../core/journal.ts';
import { errMsg, logger } from '../core/log.ts';
import { decide, type AssetFacts, type LogicContext, type SymbolInput } from '../core/logic.ts';
import { buildSessionInfo } from '../core/session.ts';
import { DAY, HOUR, MIN, addDays, dayKeyFor, isTradingDay, prevTradingDay, sessionBounds, type Calendar } from '../core/time.ts';
import type { AccountView, AssetClass, Bar, ExitReason, HaltState, IndicatorSet, Ms, OrderIntent, Params, PositionState, SizingSpec, Strategy, TimeframeMin } from '../core/types.ts';
import { resumeHalt } from '../risk/limits.ts';
import { tagesRenditen, type VolZielResult } from '../risk/volziel.ts';
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
  /**
   * Strategie je Symbol; `sizing` (Basis-Stufe: Allokation) und das Einstiegsrecht (`entriesAllowed`, Basis ohne
   * Freigabe) gehen unverändert in `decide()` — wie im Simulator. `source` (champion/basis/config) wird beim Fill in
   * der Position festgehalten (`stufe`).
   */
  strategyFor: (symbol: string) => {
    strategy: Strategy;
    params: Params;
    sizing?: SizingSpec | undefined;
    source?: string | undefined;
    entriesAllowed?: boolean | undefined;
    entryLockReason?: string | undefined;
  } | null;
  benchmarkSymbol?: string | undefined;
  calendar?: Calendar | undefined;
  notify?: NotifyFn | undefined;
  now?: (() => Ms) | undefined;
  timers?: EngineTimers | undefined;
  log?: typeof logger | undefined;
  /** Injizierbar für Tests (Warteschleifen des Executors). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Bars-Cache; Default: `<home>/bars/<assetClass>/<feed>[-adj-<bereinigung>]` (siehe data/store.ts). */
  store?: BarStore | undefined;
  /** Injizierbar für Tests: Prüfung der HALT-Datei (jeder Fehler außer ENOENT ⇒ Halt, fail-closed). */
  statSync?: ((path: string) => unknown) | undefined;
  /** Injizierbar für Tests: Quelle von unhandledRejection/uncaughtException (Default: process). */
  processEvents?: ProcessEvents | undefined;
  /** State-Speicher; Default `<home>/state.json`. Der Functions-Takt injiziert Firestore (load/save asynchron). */
  stateStore?: StateStoreLike | undefined;
  /** Journal; Default `<home>/journal.jsonl` (append-only). */
  journal?: JournalLike | undefined;
  /**
   * Einstiegs-Sperre von außen (Grund oder null), je Tick neu abgefragt und NICHT persistiert: Der
   * Functions-Takt setzt sie, wenn die Echtgeld-Kette nicht geschlossen ist. Exits, Stop-Nachzüge,
   * Abgleich und Glattstellungen laufen weiter (Exits werden nie gesperrt); eigene offene Einstiegs-
   * Orders werden beim Start storniert.
   */
  entryLock?: (() => string | null) | undefined;
}

export interface ProcessEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Der geladene State gehört nicht zu dieser Engine: anderes Alpaca-Konto (`kind: 'account'`) oder anderer
 * Modus (`kind: 'mode'`, z. B. Paper-State nach Wechsel auf einen Live-Schlüssel). Fail-closed — der
 * Functions-Takt archiviert den State und startet neu; der Dauerprozess braucht ein getrenntes Home.
 */
export class StateMismatchError extends Error {
  readonly kind: 'account' | 'mode';
  readonly stateValue: string;
  readonly engineValue: string;
  constructor(kind: 'account' | 'mode', stateValue: string, engineValue: string) {
    super(
      kind === 'account'
        ? `State gehört zum Alpaca-Konto ${stateValue}, verbunden ist ${engineValue} — State archivieren statt weiterhandeln`
        : `State gehört zum Modus '${stateValue}', die Engine läuft '${engineValue}' — State archivieren bzw. getrenntes Home verwenden`,
    );
    this.name = 'StateMismatchError';
    this.kind = kind;
    this.stateValue = stateValue;
    this.engineValue = engineValue;
  }
}

/** state.json trägt zusätzlich zurückgestellte Exits/Stop-Nachzüge (Symbol → Intent) — überlebt Neustarts. */
export type PersistedState = EngineState & { deferredIntents: Record<string, OrderIntent> };

/** Pfad der RESUME-Datei: Inhalt = Notiz; hebt einen stehenden Halt (drawdown/manual/errors/reconcile) auf. */
export function resumeFlagPath(home: string): string {
  return join(home, 'RESUME');
}

export interface EngineStatus {
  mode: 'paper' | 'live';
  running: boolean;
  halt: HaltState;
  positions: PositionState[];
  pendingEntries: string[];
  pendingExits: string[];
  /** Nach Sitzungsschluss entschiedene Exits/Stop-Nachzüge, die bei der nächsten Eröffnung laufen. */
  deferredIntents: string[];
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
  /** Halt-Zustand je Stufe (`risk.tiers`) — leer, solange keine Stufen-Latten konfiguriert sind. */
  stufenHalt: Record<string, HaltState>;
  /** Ergebnis des Vola-Ziels im letzten Zyklus (null = aus oder noch kein Zyklus). */
  volZiel: VolZielResult | null;
  /** Grund der Einstiegs-Sperre von außen (Functions-Takt: Echtgeld-Kette), sonst null. */
  entryLock: string | null;
  startedAt: Ms | null;
  uptimeMs: number;
  lastTickAt: Ms | null;
  lastReconcileAt: Ms | null;
  lastFlushAt: Ms | null;
}

interface AccountInfo {
  equity: number;
  /** Alpaca `last_equity` — Schluss-Equity des Vortags (0, wenn unbekannt). */
  lastEquity: number;
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
  private readonly journal: JournalLike;
  private readonly stateStore: StateStoreLike;
  private readonly store: BarStore;
  private readonly log: typeof logger;
  private readonly now: () => Ms;
  private readonly timers: EngineTimers;
  private readonly serial = new Serial();

  private calendar: Calendar | undefined;
  private clock: MarketClock;
  private book = new Book();
  private executor: OrderExecutor | null = null;
  private state: PersistedState | null = null;
  private account: AccountInfo = { equity: 0, lastEquity: 0, cash: 0, dayTradeCount: 0, patternDayTrader: false };

  /** Basis-Bars je Symbol (1Min bzw. 1Day) — Backfill + Stream. */
  private readonly base = new Map<string, Bar[]>();
  /** Stream-Minutenbars bei Tages-Zeitrahmen (werden nicht gespeichert; der Tages-Backfill ersetzt sie). */
  private readonly streamMinute = new Map<string, Bar[]>();
  private readonly incoming = new Map<string, Bar[]>();
  /** Stream-Bars seit dem letzten Cache-Flush (nur Neues anhängen, nie die ganze Datei je Bar). */
  private readonly pendingFlush = new Map<string, Bar[]>();
  private lastFlushAt: Ms | null = null;
  /** Stream-Abriss: ab letzter Nachricht − 2 min nachladen, sobald wieder abonniert. */
  private reconnectFrom: Ms | null = null;
  private reconnectDue = false;
  private readonly resumeFlag: string;
  private readonly statSync: (path: string) => unknown;
  private readonly processEvents: ProcessEvents;
  private processHandlersOn = false;
  private readonly aggDirty = new Set<string>();
  private readonly aggCache = new Map<string, { gridKey: number; series: BarSeries }>();
  private readonly indCache = new Map<string, { barT: Ms; strategyId: string; paramsKey: string; ind: IndicatorSet }>();
  private readonly assets = new Map<string, AssetFacts>();
  private readonly streamStatus: { data: StreamStatus | null; trade: StreamStatus | null } = { data: null, trade: null };
  private timerHandles: unknown[] = [];
  /** Kalendertag, für den der Kalender zuletzt nachgezogen wurde (ein Aufruf je Tag, auch am Wochenende). */
  private calendarDay = '';
  private tickQueued = false;
  private running = false;
  private startedAt: Ms | null = null;
  private lastTickAt: Ms | null = null;
  /** Symbole, deren Glattstellung mangels Strategie schon im Journal steht — nicht je Takt neu melden. */
  private readonly ohneFuehrungGemeldet = new Set<string>();
  /** Positionen (Symbol|Einstiegszeit), deren fremde Führung schon im Journal steht. */
  private readonly fremdeFuehrungGemeldet = new Set<string>();
  /** Zuletzt ins Journal geschriebener Faktor des Vola-Ziels (auf 2 Nachkommastellen) — gegen Wiederholungen. */
  private volFaktorGemeldet: string | null = null;
  /** Letztes Ergebnis des Vola-Ziels (nur Anzeige/Status; null = aus). */
  private volZiel: VolZielResult | null = null;
  private lastReconcileAt: Ms | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.cfg = deps.config;
    this.mode = deps.mode;
    this.tf = deps.config.timeframe;
    this.baseTf = this.tf === 1440 ? '1Day' : '1Min';
    this.assetClass = deps.config.universe.assetClass;
    this.paths = homePaths(deps.home);
    this.journal = deps.journal ?? new Journal(this.paths.journal);
    this.stateStore = deps.stateStore ?? new StateStore(this.paths.state);
    this.store =
      deps.store ??
      new BarStore(barStoreRoot(this.paths.bars, this.assetClass, deps.config.broker.feed, deps.config.broker.adjustment), deps.config.broker.adjustment);
    this.log = deps.log ?? logger;
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? defaultTimers;
    this.resumeFlag = resumeFlagPath(deps.home);
    this.statSync = deps.statSync ?? ((p) => fsStatSync(p));
    this.processEvents = deps.processEvents ?? (process as unknown as ProcessEvents);
    this.calendar = deps.calendar;
    this.clock = new MarketClock({ assetClass: this.assetClass, calendar: this.calendar, client: deps.client, now: this.now });
  }

  /* ───────────────────────── Lebenszyklus ───────────────────────── */

  async start(): Promise<void> {
    const now = this.now();
    ensureDir(this.paths.home);
    const acc = await this.deps.client.getAccount();
    this.account = { equity: acc.equity, lastEquity: acc.lastEquity, cash: acc.cash, dayTradeCount: acc.daytradeCount, patternDayTrader: acc.patternDayTrader };
    const today = dayKeyFor(now, this.assetClass);
    const loaded = await this.stateStore.load();
    if (loaded && loaded.mode !== this.mode) throw new StateMismatchError('mode', loaded.mode, this.mode);
    // Fremdes Konto (Nutzer hat andere Schlüssel hinterlegt): Das Buch gehört zu einem anderen Depot — ein Abgleich
    // würde dessen Positionen als „fehlt beim Broker" mit geschätztem Kurs ausbuchen (Phantom-Trades). Fail-closed;
    // der Functions-Takt fängt den Fehler und archiviert den State (Secreview 2, M9).
    if (loaded?.accountId && acc.id && loaded.accountId !== acc.id) throw new StateMismatchError('account', loaded.accountId, acc.id);
    // Erster State: Tagesstart = Vortagesschluss (Kopfkommentar, K1), nicht die Equity nach dem Gap.
    const base = loaded ?? emptyState(this.mode, today, this.dayStartMark());
    const st: PersistedState = { ...base, deferredIntents: (base as Partial<PersistedState>).deferredIntents ?? {} };
    if (acc.id) st.accountId = acc.id;
    // `consecutiveErrors` bleibt, wie er gespeichert wurde: Ein Neustart (oder der nächste Functions-Takt) ist
    // kein Beweis, dass der Fehler weg ist — erst ein fehlerfreier Tick setzt den Zähler zurück (Secreview 2, M4).
    st.peakEquity = Math.max(st.peakEquity, acc.equity);
    this.state = st;
    this.book = Book.fromState(st);
    this.processResumeFlag(now);
    if (acc.tradingBlocked || acc.accountBlocked) {
      this.setHalt('errors', 'Konto gesperrt (trading_blocked/account_blocked)', now);
    }

    await this.refreshCalendar(today, now);
    await this.clock.refresh();
    await this.rollover(now);

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
      // Stufe der Wahl nur, wenn sie zur Strategie der Position passt — sonst unbekannt (Prüfbefund G14).
      stufeFor: (s, id) => {
        const c = this.deps.strategyFor(s);
        return c && c.strategy.id === id ? c.source : undefined;
      },
      notify: this.deps.notify,
      log: this.log,
      costs: this.cfg.costs,
    });

    await this.backfillAll(now);
    await this.executor.syncOrders();
    // Eigene Einstiegs-Orders aus der Zeit vor dem Neustart/Absturz übernehmen — VOR dem Abgleich, damit eine
    // gefüllte eigene Order nicht als Fremdbestand gilt (Secreview 2, M6).
    await this.adoptOwnEntryOrders(now);
    const lock = this.deps.entryLock?.() ?? null;
    if (lock) {
      const cancelled = await this.executor.cancelOwnEntryOrders();
      if (cancelled.length > 0) {
        this.journal.append('note', { text: `Einstiege gesperrt (${lock}) — eigene offene Einstiegs-Orders storniert`, symbols: cancelled }, now);
        this.log.warn('Einstiege gesperrt — eigene offene Einstiegs-Orders storniert', { lock, symbols: cancelled });
      }
    }
    await this.reconcileInner(now);

    this.deps.dataStream.onBar((s, b) => this.onBar(s, b));
    this.deps.dataStream.onStatus((ev) => {
      this.streamStatus.data = ev.status;
      if (ev.status === 'disconnected' || ev.status === 'error') {
        this.log.warn('DataStream', { status: ev.status, detail: ev.detail });
        if (this.reconnectFrom === null) this.reconnectFrom = (this.deps.dataStream.lastMessageAt() ?? this.now()) - 2 * MIN;
      } else if (ev.status === 'subscribed' && this.reconnectFrom !== null) {
        this.reconnectDue = true;
      }
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
    if (!this.processHandlersOn) {
      this.processEvents.on('unhandledRejection', this.onUnhandledRejection);
      this.processEvents.on('uncaughtException', this.onUncaughtException);
      this.processHandlersOn = true;
    }
    this.timerHandles.push(this.timers.setInterval(() => this.scheduleTick(), 1000));
    this.timerHandles.push(this.timers.setInterval(() => void this.reconcileNow(), this.cfg.engine.reconcileEverySec * 1000));
    this.timerHandles.push(this.timers.setInterval(() => void this.clock.refresh(), 60_000));
    this.journal.append(
      'start',
      { mode: this.mode, symbols: this.cfg.universe.symbols, timeframe: this.tf, assetClass: this.assetClass, equity: acc.equity, halt: st.halt, positions: [...this.book.positions.keys()] },
      now,
    );
    this.log.info(`Engine gestartet (${this.mode})`, { symbols: this.cfg.universe.symbols, timeframe: this.tf, equity: acc.equity });
    await this.saveState();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const h of this.timerHandles) this.timers.clearInterval(h);
    this.timerHandles = [];
    if (this.processHandlersOn) {
      this.processEvents.off('unhandledRejection', this.onUnhandledRejection);
      this.processEvents.off('uncaughtException', this.onUncaughtException);
      this.processHandlersOn = false;
    }
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
      this.flushStore(true, this.now());
      if (this.state) {
        await this.saveState();
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
      await this.saveState();
    });
  }

  /** Alles glatt (kill_switch/manual) — Fills bucht der Abgleich. */
  flatten(reason: ExitReason): Promise<void> {
    return this.serial.run(async () => {
      const now = this.now();
      if (this.exitsAllowed(now)) {
        const executor = this.requireExecutor();
        const cancelled = await executor.cancelOwnEntryOrders();
        const intents = executor.prepareFlatten(reason, cancelled);
        await this.saveState(); // vorgemerkt: Zeitbudget/Absturz mitten in der Sequenz verliert keine Position
        for (const r of intents.length ? await executor.execute(intents) : []) {
          this.log.info(`flatten ${r.symbol}: ${r.note}`, { ok: r.ok, orderId: r.orderId ?? null });
        }
      } else {
        // Nach Schluss würde flattenAll die Schutz-Stops abräumen und Marktorders in die Nacht legen —
        // stattdessen je Position einen Exit zurückstellen; die Stops bleiben aktiv.
        const st = this.st();
        for (const sym of this.book.positions.keys()) st.deferredIntents[sym] = { kind: 'exit', symbol: sym, reason, decidedAt: now };
        this.journal.append('note', { text: `flatten (${reason}) außerhalb der Sitzung — bis zur Eröffnung zurückgestellt, Schutz-Stops bleiben liegen`, positions: [...this.book.positions.keys()] }, now);
        this.log.warn(`flatten (${reason}) außerhalb der Sitzung — zurückgestellt`, { positions: [...this.book.positions.keys()] });
      }
      await this.saveState();
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
      const stufen = this.resumeStufen(now, note);
      this.journal.append('resume', { note: r.halt.note, ...(stufen.length ? { stufen } : {}) }, now);
      await this.saveState();
    });
  }

  /**
   * Drawdown-Sperren der Stufen mit aufheben (`risk.tiers`, core/logic.ts).
   *
   * Warum das hier stehen MUSS: Eine Stufen-Bremse mit Grund `drawdown` endet
   * wie die des Kontos nur über ein bewusstes `resume` (§0.5). Ohne diese
   * Zeile bliebe eine Stufe nach einem aufgehobenen Konto-Halt für immer
   * gesperrt — eine Sperre ohne Ursache und ohne Ausweg. Tages-Halts werden
   * NICHT angefasst: Sie enden am nächsten Handelstag von selbst.
   */
  private resumeStufen(now: Ms, note: string): string[] {
    const st = this.st();
    const raus: string[] = [];
    for (const [stufe, halt] of Object.entries(st.stufenHalt ?? {})) {
      if (!halt.halted || halt.reason === 'daily_loss') continue;
      st.stufenHalt = { ...(st.stufenHalt ?? {}), [stufe]: { halted: false, reason: null, since: null, until: null, note: `resume ${new Date(now).toISOString()}: ${note}` } };
      raus.push(stufe);
    }
    return raus;
  }

  /**
   * Manueller Halt per Kommando (Functions-Takt, API): keine Einstiege, Exits laufen weiter.
   * Steht bereits ein Halt, bleibt er — Sperren eskalieren nur, sie werden nicht ersetzt.
   */
  halt(note: string): Promise<void> {
    return this.serial.run(async () => {
      const st = this.st();
      const now = this.now();
      if (st.halt.halted) this.journal.append('note', { text: `halt: bereits gesperrt (${st.halt.reason ?? '?'}) — Kommando ohne Wirkung`, note }, now);
      else this.setHalt('manual', note, now);
      await this.saveState();
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
      deferredIntents: Object.keys(st?.deferredIntents ?? {}),
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
      stufenHalt: { ...(st?.stufenHalt ?? {}) },
      volZiel: this.volZiel,
      entryLock: this.deps.entryLock?.() ?? null,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === null ? 0 : now - this.startedAt,
      lastTickAt: this.lastTickAt,
      lastReconcileAt: this.lastReconcileAt,
      lastFlushAt: this.lastFlushAt,
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
      this.processResumeFlag(now);
      this.checkHaltFile(now);
      await this.rollover(now);
      this.ingestStreamBars();
      await this.backfillAfterReconnect(now);
      st.peakEquity = Math.max(st.peakEquity, this.account.equity);
      // Zuerst, was seit Sitzungsschluss wartet — mit derselben Idempotenz wie jeder andere Intent.
      let failures = await this.runDeferred(now);

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
        const position = this.book.positions.get(sym) ?? null;
        // Fremde Führung (Prüfbefund M4): Die Position hat eine andere Strategie eröffnet als die, die das Symbol
        // heute führt. `decide()` hält sie ohne Signal-Exit und ohne Stop-Nachzug (core/logic.ts); hier nur die
        // Notiz — einmal je Position, nicht je Bar.
        if (position && position.strategy !== choice.strategy.id) {
          const key = `${sym}|${position.entryTime}`;
          if (!this.fremdeFuehrungGemeldet.has(key)) {
            this.fremdeFuehrungGemeldet.add(key);
            const text = `Position der Strategie ${position.strategy} — ${choice.strategy.id} führt das Symbol jetzt und diese Position nicht: kein Signal-Exit, kein Stop-Nachzug, Broker-Stop bleibt (Notbremsen und flatten gelten weiter)`;
            this.journal.append('note', { symbol: sym, text, positionStrategy: position.strategy, strategy: choice.strategy.id }, now);
            this.log.warn(`${sym}: ${text}`);
          }
        }
        inputs.push({
          snap: {
            symbol: sym,
            bars: series,
            i,
            position,
            session: buildSessionInfo(series, i, this.tf, this.assetClass, this.calendar),
            benchmark: bench && bi >= 0 ? { bars: bench, i: bi } : undefined,
          },
          strategy: choice.strategy,
          params: choice.params,
          ind,
          sizing: choice.sizing,
          entriesAllowed: choice.entriesAllowed,
          entryLockReason: choice.entryLockReason,
          // Stufe der Wahl (champion/basis/config) — sie entscheidet, welche Latte
          // der Notbremse für dieses Symbol gilt (`risk.tiers`, risk/limits.ts).
          stufe: choice.source,
        });
      }

      const exitsAllowed = this.exitsAllowed(now);

      /*
       * Regel 4, zu Ende gedacht: Was wir HALTEN, wird bewirtschaftet.
       *
       * `inputs` entsteht aus `universe.symbols` und braucht eine Strategie.
       * Fällt beides weg — Symbol aus dem Universum gefallen (die nächtliche
       * Auswahl kann das), Champion über Nacht auf `noTrade`, adoptierter
       * Fremdbestand ohne Strategie —, bekam die offene Position bisher gar
       * nichts mehr: keinen Signal-Exit, keinen Trailing-Nachzug, kein
       * EOD-Flatten. Sie lag nur noch am Broker-Stop, zählte aber weiter gegen
       * `maxPositions` und ins Exposure. Bei `holdsOvernight: false` wäre sie
       * unbegrenzt über Nacht gehalten worden — die Intraday-Position, die
       * niemand mehr schließt.
       *
       * Ohne Strategie gibt es keine gemessene Regel mehr, nach der die
       * Position zu führen wäre. Sie weiterzuhalten hieße, etwas zu halten,
       * das niemand mehr bewirtschaftet — genau der Fehler des
       * Vorgängersystems. Also: schließen, beim nächsten möglichen Zeitpunkt.
       * Der Exit geht durch denselben Pfad wie jeder andere (idempotente
       * Kennung, Zurückstellung außerhalb der Sitzung).
       *
       * Was NICHT hierher fällt (seit Prüfbefund M4/M6, 09.09.2026): Eine
       * Basis-Position, deren Block das Einstiegsrecht verloren hat (pass
       * gefallen, Schalter aus) — sie hat weiterhin ihre Strategie
       * (`strategyFor` liefert die Basis mit `entriesAllowed: false`) und
       * läuft nach deren eigenen Exits aus. Und eine Position, die eine
       * ANDERE Strategie eröffnet hat als die heutige — sie wird gehalten,
       * nicht liquidiert (core/logic.ts). Liquidiert wird nur, was gar keine
       * Strategie mehr hat: Block geräumt oder unlesbar, Symbol aus dem
       * Universum, Champion auf noTrade.
       */
      const fuehrbar = new Set<string>();
      for (const sym of this.cfg.universe.symbols) if (this.deps.strategyFor(sym)) fuehrbar.add(sym);
      const ohneFuehrung: OrderIntent[] = [];
      for (const sym of this.book.positions.keys()) {
        if (fuehrbar.has(sym)) continue;
        ohneFuehrung.push({ kind: 'exit', symbol: sym, reason: 'unmanaged', decidedAt: now });
      }

      const intents: OrderIntent[] = [];
      if (inputs.length > 0) {
        const today = this.clock.today(now);
        const ctx: LogicContext = {
          now,
          today,
          nextTradingDay: this.clock.nextTradingDay(now),
          account: this.accountView(),
          positions: this.book.positions,
          pendingEntries: new Set(this.book.pendingEntries.keys()),
          // Offene Einstiegs-Orders belegen Exposure-Budget, sobald sie füllen (Red-Team-Befund 10).
          pendingNotional: this.pendingNotional(),
          halt: st.halt,
          risk: this.cfg.risk,
          session: this.cfg.session,
          assetClass: this.assetClass,
          timeframe: this.tf,
          dataFresh: this.dataFresh(now),
          localDayTrades: this.localDayTrades(today),
          assetFacts: (s) => this.assets.get(s),
          entryLock: this.deps.entryLock?.() ?? null,
          // Vola-Ziel: Die Engine liefert nur die Reihe, gerechnet wird der Faktor in
          // `decide()` — einmal, für beide Welten (core/logic.ts).
          equityReturns: tagesRenditen(st.equityHistory ?? []),
          stufenHalt: st.stufenHalt,
          wiederaufbau: st.wiederaufbau,
        };
        const res = decide(ctx, inputs);
        const before = st.halt;
        st.halt = res.halt;
        // Nur schreiben, wenn es etwas zu schreiben gibt (oder schon etwas steht):
        // Sonst trüge jeder State — und jedes Firestore-Doc — zwei leere Objekte,
        // obwohl die Schalter aus sind. Additiv heißt auch: unsichtbar, solange aus.
        if (res.stufenHalt && (Object.keys(res.stufenHalt).length > 0 || st.stufenHalt)) st.stufenHalt = res.stufenHalt;
        if (res.wiederaufbau && (Object.keys(res.wiederaufbau).length > 0 || st.wiederaufbau)) st.wiederaufbau = res.wiederaufbau;
        // Der Faktor des Vola-Ziels verdoppelt oder halbiert Positionsgrößen — er darf
        // nicht unsichtbar sein. Ins Journal, sobald er sich messbar ändert (2 Nachkommastellen),
        // nicht je Bar: sonst wäre das Journal voll davon und niemand liest es mehr.
        if (res.volZiel) {
          const key = res.volZiel.faktor.toFixed(2);
          if (key !== this.volFaktorGemeldet) {
            this.volFaktorGemeldet = key;
            this.journal.append(
              'note',
              { text: `Vola-Ziel: ${res.volZiel.grund}`, volFaktor: res.volZiel.faktor, realisiertVolPct: res.volZiel.realisiertVolPct, beobachtungen: res.volZiel.beobachtungen },
              now,
            );
            this.log.info(`Vola-Ziel: ${res.volZiel.grund}`);
          }
        }
        this.volZiel = res.volZiel ?? null;
        for (const stufe of res.stufenHaltTriggered ?? []) {
          const h = res.stufenHalt?.[stufe];
          this.journal.append('halt', { stufe, reason: h?.reason ?? null, note: h?.note ?? null, equity: this.account.equity }, now);
          this.log.error(`Halt der Stufe ${stufe}: ${h?.note ?? h?.reason ?? ''}`);
          await this.say('error', `Halt (${stufe}): ${h?.note ?? h?.reason ?? ''}`);
        }
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
        intents.push(...res.intents);
      }

      // Die Notbremse in `decide()` läuft über `ctx.positions` und kann dieselbe
      // Position bereits glattstellen — dann nicht doppelt anfordern.
      for (const it of ohneFuehrung) {
        if (intents.some((x) => x.kind === 'exit' && x.symbol === it.symbol)) continue;
        if (!this.ohneFuehrungGemeldet.has(it.symbol)) {
          this.ohneFuehrungGemeldet.add(it.symbol);
          this.journal.append('note', { symbol: it.symbol, text: 'Position ohne führende Strategie (nicht mehr im Universum oder Champion auf noTrade) — wird glattgestellt' }, now);
          this.log.warn(`${it.symbol}: keine führende Strategie mehr — Position wird glattgestellt`);
        }
        intents.push(it);
      }

      if (intents.length > 0) {
        const dueNow: OrderIntent[] = [];
        for (const it of intents) {
          this.journal.append('intent', { symbol: it.symbol, intent: it }, now);
          if (it.kind !== 'enter' && !exitsAllowed) {
            // Nach Schluss entschieden (letzte Tagesbar, Halt-Exit): Der Exit würde die Schutz-Stops stornieren und
            // eine day-Marktorder in die Nacht legen ⇒ zurückstellen; die Beine bleiben liegen. Ein Exit verdrängt
            // einen zurückgestellten Stop-Nachzug, nie umgekehrt.
            const prev = st.deferredIntents[it.symbol];
            if (!(prev?.kind === 'exit' && it.kind === 'move_stop')) st.deferredIntents[it.symbol] = it;
            this.journal.append('note', { symbol: it.symbol, text: `${it.kind} außerhalb der Sitzung entschieden — bis zur nächsten Eröffnung zurückgestellt (Schutz-Stops bleiben liegen)` }, now);
            this.log.warn(`${it.kind} ${it.symbol} außerhalb der Sitzung — zurückgestellt`);
          } else dueNow.push(it);
        }
        if (dueNow.length > 0) {
          const results = await executor.execute(dueNow);
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
      if (exitsAllowed) for (const r of await executor.retryPendingExits()) if (!r.ok) failures++;
      this.flushStore(false, now);
      if (failures > 0) throw new Error(`${failures} Order-Ausführung(en) fehlgeschlagen`);
      st.consecutiveErrors = 0;
    } catch (e) {
      await this.onError('tick', e, now);
    }
    await this.saveState();
  }

  /* ───────────────────────── Bausteine ───────────────────────── */

  private st(): PersistedState {
    if (!this.state) throw new Error('Engine nicht gestartet');
    return this.state;
  }

  /** Aktien: eigene Exits nur in der regulären Sitzung (ab Eröffnung + Karenz, vor Schluss); Krypto: immer. */
  private exitsAllowed(now: Ms): boolean {
    if (this.assetClass === 'crypto') return true;
    const b = this.clock.sessionBoundsToday(now);
    return b !== null && now >= b.open + this.cfg.engine.barGraceSec * 1000 && now < b.close;
  }

  /** Zurückgestellte Exits/Stop-Nachzüge ausführen, sobald die Sitzung offen ist. Gibt die Zahl der Fehlschläge zurück. */
  private async runDeferred(now: Ms): Promise<number> {
    const st = this.st();
    const list = Object.values(st.deferredIntents);
    if (list.length === 0 || !this.exitsAllowed(now)) return 0;
    let failures = 0;
    const results = await this.requireExecutor().execute(list);
    for (const r of results) {
      if (r.ok) delete st.deferredIntents[r.symbol];
      else failures++;
      this.journal.append('note', { symbol: r.symbol, text: `Zurückgestellter ${r.kind} ausgeführt: ${r.note}`, ok: r.ok }, now);
      this.log.info(`Zurückgestellter ${r.kind} ${r.symbol}: ${r.note}`, { ok: r.ok });
    }
    return failures;
  }

  /**
   * RESUME-Datei (Inhalt = Notiz): hebt einen stehenden Halt (drawdown/manual/errors/reconcile) auf und setzt
   * den Peak auf die aktuelle Equity. Läuft im Tick UND beim Start — kein Rennen mehr zwischen CLI und Engine
   * um state.json. Ein Tages-Halt endet von selbst und wird nicht angefasst.
   */
  private processResumeFlag(now: Ms): void {
    let note: string;
    try {
      if (!existsSync(this.resumeFlag)) return;
      note = readFileSync(this.resumeFlag, 'utf8').trim() || 'RESUME-Datei';
    } catch (e) {
      this.log.warn('RESUME-Datei nicht lesbar', { error: errMsg(e) });
      return;
    }
    const st = this.st();
    const kontoOffen = st.halt.halted && st.halt.reason !== 'daily_loss';
    // Auch eine Stufen-Sperre (drawdown) braucht einen Ausweg — sie steht sonst
    // für immer, während der Konto-Halt längst weg ist (§0.5: über die Ursache,
    // nicht per Override; `resume` IST die Ursache-Aufhebung).
    const stufenOffen = Object.values(st.stufenHalt ?? {}).some((h) => h.halted && h.reason !== 'daily_loss');
    if (kontoOffen || stufenOffen) {
      const r = kontoOffen ? resumeHalt(st.halt, this.accountView(), now, `RESUME-Datei: ${note}`) : null;
      if (r) {
        st.halt = r.halt;
        st.peakEquity = r.account.peakEquity;
      }
      const stufen = this.resumeStufen(now, `RESUME-Datei: ${note}`);
      this.journal.append('resume', { note: r?.halt.note ?? `RESUME-Datei: ${note}`, peakEquity: st.peakEquity, ...(stufen.length ? { stufen } : {}) }, now);
      this.log.warn('Halt per RESUME-Datei aufgehoben', { note, peakEquity: st.peakEquity, stufen });
    } else {
      const text = st.halt.halted ? 'RESUME ignoriert: Tages-Halt endet von selbst am nächsten Handelstag' : 'RESUME ohne aktiven Halt — nichts aufzuheben';
      this.journal.append('note', { text, resume: note }, now);
      this.log.info(text);
    }
    try {
      unlinkSync(this.resumeFlag);
    } catch (e) {
      this.log.warn('RESUME-Datei nicht löschbar', { error: errMsg(e) });
    }
  }

  private readonly onUnhandledRejection = (reason: unknown): void => {
    const msg = errMsg(reason);
    this.log.error('unhandledRejection — Halt (errors)', { error: msg });
    void this.serial.run(async () => {
      if (!this.state) return;
      const now = this.now();
      this.journal.append('error', { where: 'unhandledRejection', error: msg }, now);
      if (!this.state.halt.halted) this.setHalt('errors', `unhandledRejection: ${msg}`, now);
      await this.say('error', `unhandledRejection: ${msg}`);
      await this.saveState();
    });
  };

  private readonly onUncaughtException = (err: unknown): void => {
    const msg = errMsg(err);
    this.log.error('uncaughtException — Halt (errors), Engine wird gestoppt', { error: msg });
    if (this.state) {
      const now = this.now();
      this.journal.append('error', { where: 'uncaughtException', error: msg }, now);
      if (!this.state.halt.halted) this.setHalt('errors', `uncaughtException: ${msg}`, now);
      void this.saveState();
    }
    void this.stop().catch((e) => this.log.error('Stop nach uncaughtException fehlgeschlagen', { error: errMsg(e) }));
  };

  private requireExecutor(): OrderExecutor {
    if (!this.executor) throw new Error('Engine nicht gestartet');
    return this.executor;
  }

  private allSymbols(): string[] {
    const set = new Set(this.cfg.universe.symbols);
    if (this.deps.benchmarkSymbol) set.add(this.deps.benchmarkSymbol);
    return [...set];
  }

  /**
   * Marke des Tagesbeginns für die Tages-Notbremse: Alpacas `last_equity`
   * (Schluss-Equity des Vortags, Kopfkommentar K1); fehlt sie oder ist sie
   * ≤ 0 (neues Konto), die aktuelle Equity.
   */
  private dayStartMark(): number {
    return this.account.lastEquity > 0 ? this.account.lastEquity : this.account.equity;
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

  /** Nominalwert (qty × Referenzkurs) je offener Einstiegs-Order; nach Neustart ohne Intent unbekannt ⇒ nicht gezählt. */
  private pendingNotional(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const [sym, pe] of this.book.pendingEntries) if (pe.intent) out.set(sym, pe.intent.qty * pe.intent.refPrice);
    return out;
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

  /** HALT-Datei prüfen — fail-closed: Jeder Fehler außer ENOENT gilt als gesetzt (mit Notiz). */
  private haltFlag(): { present: boolean; error: string | null } {
    try {
      this.statSync(this.paths.haltFlag);
      return { present: true, error: null };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return { present: false, error: null };
      return { present: true, error: errMsg(e) };
    }
  }

  private checkHaltFile(now: Ms): void {
    const st = this.st();
    const { present, error } = this.haltFlag();
    if (present && !st.halt.halted) {
      this.setHalt('manual', error ? `HALT-Datei nicht prüfbar (${error}) — fail-closed: keine Einstiege` : 'HALT-Datei gesetzt — keine Einstiege, Exits laufen', now);
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

  /**
   * Kalender: Datei/Broker für ±45 Tage um `today`, sonst der mitgegebene Stand, sonst der
   * algorithmische Fallback. Wird beim Start und an jedem neuen Handelstag aufgerufen — ein
   * Kalender, der nur 45 Tage über den Start hinausreicht, ließe `nextTradingDay` nach
   * sechs Wochen Laufzeit ins Leere laufen.
   */
  private async refreshCalendar(today: string, now: Ms): Promise<void> {
    if (today === this.calendarDay) return;
    this.calendarDay = today;
    // Reicht der bekannte Kalender 45 Tage in beide Richtungen, ist nichts zu tun; sonst gleich 120 Tage
    // voraus holen, damit nicht jeder neue Tag einen Broker-Aufruf auslöst.
    const need = { from: addDays(today, -45), to: addDays(today, 45) };
    let first: string | null = null;
    let last: string | null = null;
    for (const d of this.calendar?.keys() ?? []) {
      if (first === null || d < first) first = d;
      if (last === null || d > last) last = d;
    }
    if (first !== null && last !== null && first <= need.from && last >= need.to) return;
    try {
      const cal = await ensureCalendar(this.deps.client, this.paths.calendar, need.from, addDays(today, 120), now);
      if (cal.size > 0) this.calendar = cal;
    } catch (e) {
      this.log.warn('Kalender nicht ladbar — vorhandener Stand bzw. Fallback gilt', { error: errMsg(e) });
    }
    this.clock = new MarketClock({ assetClass: this.assetClass, calendar: this.calendar, client: this.deps.client, now: this.now });
  }

  /**
   * Neuer Handelstag ⇒ Tagesstart-Equity = Vortagesschluss (`last_equity`,
   * Kopfkommentar K1), alte Daytrade-Tage (> 7 Handelstage) vergessen,
   * Kalender nachziehen.
   */
  private async rollover(now: Ms): Promise<void> {
    const st = this.st();
    const today = dayKeyFor(now, this.assetClass);
    if (today === st.day) return;
    await this.refreshCalendar(today, now);
    if (!isTradingDay(today, this.assetClass, this.calendar)) return;
    st.day = today;
    const mark = this.dayStartMark();
    if (mark > 0) st.dayStartEquity = mark;
    /*
     * Equity-Historie für das Vola-Ziel (risk/volziel.ts): EINE Marke je
     * Handelstag, und zwar dieselbe, mit der der Simulator seine Tagesrendite
     * bildet — die SCHLUSS-Equity des Vortags (`last_equity`). Der Rollover
     * läuft genau einmal je neuem Handelstag, die Reihe kann also nicht
     * doppeln; ohne brauchbare Marke wird nichts angehängt (lieber eine
     * Beobachtung weniger als eine erfundene).
     *
     * Bekannter Unterschied zum Simulator, klein und benannt: Dessen erste
     * Rendite misst gegen die Start-Equity, die Engine kennt die Marke vor
     * ihrem ersten Handelstag nicht — die Reihe beginnt einen Tag später. Nach
     * der Aufwärmphase (Vorgabe 60 Beobachtungen) trägt die älteste
     * Beobachtung unter einem halben Prozent der Gewichtssumme.
     */
    if (mark > 0) st.equityHistory = equityHistorieAnhaengen(st.equityHistory, mark);
    this.flushStore(true, now);
    this.pruneCaches(now);
    let keep = today;
    try {
      for (let i = 0; i < 7; i++) keep = prevTradingDay(keep, this.assetClass, this.calendar);
      this.book.pruneDayTrades(keep);
    } catch (e) {
      this.log.warn('Daytrade-Fenster nicht bereinigt', { error: errMsg(e) });
    }
    this.journal.append('note', { text: 'Tagesrollover', day: today, dayStartEquity: st.dayStartEquity, equityMarken: st.equityHistory?.length ?? 0 }, now);
    this.log.info('Neuer Handelstag', { day: today, dayStartEquity: st.dayStartEquity });
  }

  /** Tagesbeginn: Cache auf optimizer.lookbackDays + 30 Tage kürzen, In-Memory-Basis auf das Warmup-Fenster. */
  private pruneCaches(now: Ms): void {
    const keepFrom = now - (this.cfg.optimizer.lookbackDays + 30) * DAY;
    for (const sym of this.allSymbols()) {
      try {
        this.store.prune(sym, this.baseTf, keepFrom);
      } catch (e) {
        this.log.warn('Bars-Cache nicht gekürzt', { symbol: sym, error: errMsg(e) });
      }
    }
    const trimFrom = now - this.warmupMs();
    for (const [sym, bars] of this.base) {
      if (bars.length > 0 && bars[0]!.t < trimFrom) {
        this.base.set(sym, bars.filter((b) => b.t >= trimFrom));
        this.aggDirty.add(sym);
      }
    }
  }

  private warmupMs(): number {
    let warm = 0;
    for (const sym of this.cfg.universe.symbols) {
      const c = this.deps.strategyFor(sym);
      if (c) warm = Math.max(warm, c.strategy.warmupBars(c.params));
    }
    return warmupWindowMs(warm || 50, this.tf, this.assetClass);
  }

  private async backfillRange(from: Ms, to: Ms, exact: boolean): Promise<Map<string, Bar[]>> {
    return backfill({
      client: this.deps.client,
      store: this.store,
      symbols: this.allSymbols(),
      tf: this.baseTf,
      from,
      to,
      feed: this.cfg.broker.feed,
      // Bereinigung der Tagesbars wie in fetch/optimize — sonst lägen im bereinigten Cache rohe Bars.
      adjustment: this.cfg.broker.adjustment,
      assetClass: this.assetClass,
      calendar: this.calendar,
      exact,
      log: (m) => this.log.info(m),
    });
  }

  private async backfillAll(now: Ms): Promise<void> {
    const res = await this.backfillRange(now - this.warmupMs(), now, false);
    for (const [sym, bars] of res) {
      this.base.set(sym, bars);
      this.aggDirty.add(sym);
    }
  }

  /** Nach einem Stream-Abriss die Lücke ab letzter Nachricht − 2 min nachladen (nur Minutenbasis). */
  private async backfillAfterReconnect(now: Ms): Promise<void> {
    if (!this.reconnectDue || this.reconnectFrom === null) return;
    const from = this.reconnectFrom;
    this.reconnectDue = false;
    this.reconnectFrom = null;
    if (this.baseTf !== '1Min') return;
    this.journal.append('note', { text: 'Datenstrom wieder verbunden — Lücke nachladen', from }, now);
    const res = await this.backfillRange(from, now, true);
    for (const [sym, bars] of res) {
      if (bars.length === 0) continue;
      this.base.set(sym, mergeBars(this.base.get(sym) ?? [], bars));
      this.aggDirty.add(sym);
    }
  }

  /** Fenster, in dem eine gefüllte eigene Einstiegs-Order ohne Buch-Position als „eigener Fill nach Absturz" gilt. */
  static readonly ADOPT_FILL_WINDOW_MS = 6 * HOUR;

  /**
   * Eigene Einstiegs-Orders aus der Zeit vor einem Neustart/Absturz übernehmen:
   *  - offen ⇒ als Pending (der Fill kommt über syncOrders/Stream);
   *  - kürzlich GEFÜLLT, aber nicht im Buch (Absturz zwischen Senden und Speichern) ⇒ als Position buchen —
   *    aber nur, wenn die RUNDE noch offen ist: kein Bein gefüllt, kein eigener Exit/Stop dieser Runde gefüllt,
   *    und der Broker hält genau die gefüllte Menge auf derselben Seite. Sonst gälte eine längst geschlossene
   *    Runde (oder ein Handkauf des Nutzers) als eigene Position, ihr gefülltes Stop-Bein als Schutz-Stop, und
   *    der nächste Abgleich buchte Phantom-Exits und räumte die Beine der echten Runde ab (Secreview 3, #1).
   *    Bei mehreren Kandidaten gewinnt die jüngste Order. Alles Unklare bleibt dem Abgleich (Halt 'reconcile').
   */
  private async adoptOwnEntryOrders(now: Ms): Promise<void> {
    const all = await this.deps.client.listOrders({ status: 'all', symbols: this.cfg.universe.symbols, after: now - Engine.ADOPT_FILL_WINDOW_MS - DAY, nested: true, limit: 500 });
    // Gefüllte eigene Exit-/Stop-Orders je Runde (Anker = entryTime in der Kennung): Runde geschlossen.
    const closedRounds = new Set<string>();
    for (const o of all) {
      const p = parseClientId(o.clientOrderId);
      if (p && p.mode === this.mode && (p.kind === 'exit' || p.kind === 'stop') && o.filledQty > 0) closedRounds.add(`${o.symbol}|${p.ms}`);
    }
    const candidates = new Map<string, (typeof all)[number]>();
    for (const o of all) {
      const p = parseClientId(o.clientOrderId);
      if (!p || p.kind !== 'entry' || p.mode !== this.mode) continue;
      if (this.book.positions.has(o.symbol) || this.book.pendingEntries.has(o.symbol)) continue;
      if (isOpenStatus(o.status)) {
        this.book.markPending(o.symbol, { clientId: o.clientOrderId, orderId: o.id, intent: null, submittedAt: o.submittedAt ?? now });
        this.log.warn('Offene Einstiegs-Order übernommen', { symbol: o.symbol, clientId: o.clientOrderId });
        continue;
      }
      const filledAt = o.filledAt ?? o.submittedAt ?? 0;
      if (!(o.filledQty > 0) || filledAt < now - Engine.ADOPT_FILL_WINDOW_MS) continue;
      if (o.legs.some((l) => l.filledQty > 0)) continue; // Bein gefüllt ⇒ Runde zu
      if (closedRounds.has(`${o.symbol}|${filledAt}`)) continue; // eigener Exit/Stop dieser Runde gefüllt ⇒ Runde zu
      const prev = candidates.get(o.symbol);
      if (!prev || (prev.filledAt ?? prev.submittedAt ?? 0) < filledAt) candidates.set(o.symbol, o);
    }
    if (candidates.size === 0) return;
    // Nur, was der Broker wirklich hält — in genau dieser Menge und auf dieser Seite.
    const held = new Map((await this.deps.client.listPositions()).map((bp) => [bp.symbol, bp]));
    for (const o of candidates.values()) {
      const bp = held.get(o.symbol);
      const side = o.side === 'buy' ? 'long' : 'short';
      if (!bp || bp.side !== side || Math.abs(bp.qty - o.filledQty) > 1e-6 || this.book.positions.has(o.symbol)) continue;
      await this.requireExecutor().applyEntryFill(o, now);
      this.journal.append('reconcile', { action: 'adopt_own_fill', symbol: o.symbol, orderId: o.id, clientId: o.clientOrderId, qty: o.filledQty, note: 'Gefüllte eigene Einstiegs-Order ohne Buch-Position (Absturz vor dem Speichern) — als Position gebucht' }, now);
      this.log.warn('Gefüllte eigene Einstiegs-Order übernommen', { symbol: o.symbol, clientId: o.clientOrderId, qty: o.filledQty });
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
        await this.saveState();
      } catch (e) {
        await this.onError('trade_update', e, this.now());
        await this.saveState();
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
        this.pendingFlush.set(sym, mergeBars(this.pendingFlush.get(sym) ?? [], fresh));
      }
      this.aggDirty.add(sym);
    }
    this.incoming.clear();
  }

  static readonly FLUSH_EVERY_MS = 5 * MIN;

  /** Neue Stream-Bars in den Cache schreiben — höchstens alle 5 min, beim Stopp und am Tagesende (force). */
  private flushStore(force: boolean, now: Ms): void {
    if (this.pendingFlush.size === 0) return;
    if (!force && this.lastFlushAt !== null && now - this.lastFlushAt < Engine.FLUSH_EVERY_MS) return;
    for (const [sym, bars] of [...this.pendingFlush]) {
      try {
        this.store.upsert(sym, this.baseTf, bars);
        this.pendingFlush.delete(sym);
      } catch (e) {
        this.log.warn('Bars-Cache nicht schreibbar', { symbol: sym, error: errMsg(e) });
        if (!force) return;
      }
    }
    this.lastFlushAt = now;
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
    this.account = {
      equity: r.account.equity,
      lastEquity: r.account.lastEquity,
      cash: r.account.cash,
      dayTradeCount: r.account.daytradeCount,
      patternDayTrader: r.account.patternDayTrader,
    };
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

  private async saveState(): Promise<void> {
    if (!this.state) return;
    Object.assign(this.state, this.book.toState());
    try {
      await this.stateStore.save(this.state);
    } catch (e) {
      this.log.error('State nicht speicherbar', { error: errMsg(e) });
    }
  }
}
