/**
 * Der Engine-Takt: EIN Lauf je Minute (Cloud Scheduler), kein Dauerprozess,
 * kein WebSocket. Je Takt:
 *
 *   1. Lease `meta/engineLease` (Transaktion) — zwei überlappende Läufe
 *      hätten zwei Bücher auf einem Konto.
 *   2. Nutzerliste: `users where settings.strategy.engine.running == true`,
 *      Zugang (`mayTrade`), Broker-Verbindung (Drei-Guard-Kette + Kill-Switch
 *      in `brokerVerbindung`); ohne Verbindung wird der Nutzer übersprungen.
 *   3. Globale Config (`meta/engineConfig`) + Champion (`meta/champion`),
 *      Config je Nutzer aus dessen Settings.
 *   4. Marktzeit-Gate: Aktienmarkt zu und niemand hat etwas Zurückgestelltes
 *      oder ein Kommando ⇒ nur Herzschlag.
 *   5. Bars EINMAL je Takt mit dem Plattform-Key in den geteilten Cache;
 *      Nutzer-Engines lesen daraus (keine Datenaufrufe je Nutzer).
 *   6. Je Nutzer (parallel, Limit 3): Engine bauen → start (Konto, Abgleich,
 *      Backfill aus dem Cache, Schutz-Stops) → Kommandos → tick → stop →
 *      Journal-Batch → Spiegel. Fehler je Nutzer fangen, weiter mit dem
 *      nächsten.
 *   7. Herzschlag `meta/health` (Merge) — `bewerteHerzschlag` bleibt gültig.
 *
 * Alles, was Geld bewegt, macht die Engine selbst (`src/engine`): derselbe
 * `decide()`-Pfad wie Backtest und Dauerprozess. Diese Datei verdrahtet nur.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AlpacaClient, AlpacaClock } from '../../../src/alpaca/types.ts';
import { parseConfig, type Config } from '../../../src/core/config.ts';
import { errMsg, logger } from '../../../src/core/log.ts';
import { DAY, MIN, addDays, dayKeyFor, type Calendar } from '../../../src/core/time.ts';
import type { AssetClass, Ms, Strategy } from '../../../src/core/types.ts';
import { backfill } from '../../../src/data/backfill.ts';
import { barStoreRoot, type BarStore, type BaseTimeframe } from '../../../src/data/store.ts';
import { Engine, warmupWindowMs, type EngineTimers, type ProcessEvents } from '../../../src/engine/engine.ts';
import { mayTrade } from '../../../shared/src/zugang.js';
import type { BrokerVerbindung } from '../core/brokerZugang.js';
import { applyCommands, claimCommands } from './commands.js';
import { buildUserConfig, globalConfigRaw, type UserRiskSource } from './config.js';
import { isRecord, isoOf, plain, type DocData, type DocSnapLike, type FirestoreLike } from './firestoreLike.js';
import { FirestoreJournal, type FxFn } from './journal.js';
import { mirrorError, mirrorPositions, mirrorQuotes, mirrorUser, type QuoteMark } from './mirror.js';
import { SharedBarStoreView, cachedAsset, cachedCalendar, delegateClient, sharedStoreFor, withSharedData, type SharedServices } from './sharedData.js';
import { FirestoreStateStore } from './state.js';
import { buildStrategyFor, championFromDoc, type StrategyMap } from './strategyFor.js';
import { NoopDataStream, NoopTradeStream } from './streams.js';

export const LEASE_PATH = 'meta/engineLease';
export const HEALTH_PATH = 'meta/health';
export const CHAMPION_PATH = 'meta/champion';
export const CONFIG_PATH = 'meta/engineConfig';
/** Lease-Dauer: länger als das Function-Timeout (55 s), kürzer als zwei Takte. */
export const LEASE_MS = 90_000;
export const USERS_PARALLEL = 3;
export const DEFAULT_TMP_ROOT = '/tmp/autotrd';

export interface TickDeps {
  db: FirestoreLike;
  /** Plattform-Datenclient (Bars, Kalender, Uhr, Stammdaten); null ⇒ kein Datenkey. */
  dataClientFor: (o: { feed: 'iex' | 'sip'; assetClass: AssetClass }) => AlpacaClient | null;
  /** Order-Pfad-Verbindung eines Nutzers (`core/brokerZugang.brokerVerbindung`). */
  brokerVerbindung: (uid: string, nowMs: Ms) => Promise<BrokerVerbindung | null>;
  /** Trading-Client aus den Nutzer-Schlüsseln (`createAlpacaClient`). */
  clientFor: (v: BrokerVerbindung, o: { feed: 'iex' | 'sip'; assetClass: AssetClass }) => AlpacaClient;
  /** EZB-Kurs-Felder (`core/fx.fxFelder`). */
  fx: FxFn;
  /** Strategie-Register; Default `src/strategy` (Tests: Skript-Strategie). */
  getStrategy?: ((id: string) => Strategy) | undefined;
  /** Wurzel für Bars-Cache und Nutzer-Homes (Default /tmp/autotrd). */
  tmpRoot?: string | undefined;
  log?: typeof logger | undefined;
  parallel?: number | undefined;
  leaseMs?: number | undefined;
  /** `at`-Stempel der Trade-Docs (Tests). */
  timestampNow?: (() => unknown) | undefined;
}

export interface UserOutcome {
  uid: string;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  durationMs?: number;
}

export interface TickResult {
  skipped: null | 'market_closed' | 'lease';
  /** Nutzer, für die eine Engine lief. */
  users: number;
  ok: number;
  failed: Array<{ uid: string; error: string }>;
  skippedUsers: Array<{ uid: string; reason: string }>;
  symbolsOk: number;
  symbolsFailed: number;
  fetchOk: boolean;
  durationMs: number;
}

const NOOP_TIMERS: EngineTimers = { setInterval: () => 0, clearInterval: () => undefined };
const NOOP_PROCESS: ProcessEvents = { on: () => undefined, off: () => undefined };

/**
 * HALT-„Datei" des Takts: Es gibt keine Datei — die Flagge IST der manuelle
 * Halt im State. Ohne diese Brücke hübe `checkHaltFile` jeden per Kommando
 * gesetzten Halt im nächsten Takt wieder auf („HALT-Datei entfernt"), weil
 * unter /tmp nie eine Datei liegt. So bleibt ein manueller Halt, bis ein
 * `resume`-Kommando ihn hebt — und nichts sonst gilt als gesetzt.
 */
export function haltFlagStat(engine: Pick<Engine, 'status'> | null): unknown {
  const h = engine?.status().halt;
  if (h?.halted && h.reason === 'manual') return {};
  const e = new Error('ENOENT: keine HALT-Datei im Functions-Takt') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  throw e;
}

/** `meta/health` ist öffentlich lesbar — dort stehen keine uids, nur ein kurzer Hash zum Zuordnen. */
export function uidKurz(uid: string): string {
  return createHash('sha256').update(uid).digest('hex').slice(0, 10);
}

/** Braucht dieser Nutzer einen Lauf bei geschlossenem Markt? (Spiegel-Felder des User-Docs) */
export function needsWorkWhileClosed(snap: DocSnapLike): boolean {
  const e = snap.get('engine');
  if (!isRecord(e)) return false;
  if (Array.isArray(e.deferred) && e.deferred.length > 0) return true;
  return typeof e.commandAt === 'string';
}

async function parallel<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function userLogger(base: typeof logger, uid: string): typeof logger {
  const tag = `[${uidKurz(uid)}]`;
  return {
    debug: (m, d) => base.debug(`${tag} ${m}`, d),
    info: (m, d) => base.info(`${tag} ${m}`, d),
    warn: (m, d) => base.warn(`${tag} ${m}`, d),
    error: (m, d) => base.error(`${tag} ${m}`, d),
  };
}

/* ───────────────────────── Lease ───────────────────────── */

async function acquireLease(db: FirestoreLike, now: Ms, ttl: number): Promise<string | null> {
  const ref = db.doc(LEASE_PATH);
  const holder = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const until = snap.exists ? Number(snap.get('until') ?? 0) : 0;
    if (Number.isFinite(until) && until >= now) return null;
    tx.set(ref, { until: now + ttl, holder, since: isoOf(now) });
    return holder;
  });
}

async function releaseLease(db: FirestoreLike, holder: string, now: Ms): Promise<void> {
  const ref = db.doc(LEASE_PATH);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('holder') !== holder) return;
    tx.set(ref, { until: 0, holder: null, releasedAt: isoOf(now) });
  });
}

async function writeHealth(db: FirestoreLike, fields: DocData, log: typeof logger): Promise<void> {
  try {
    await db.doc(HEALTH_PATH).set(plain(fields), { merge: true });
  } catch (e) {
    log.error('meta/health nicht schreibbar', { error: errMsg(e) });
  }
}

/* ───────────────────────── Takt ───────────────────────── */

interface UserPrep {
  uid: string;
  snap: DocSnapLike;
  verbindung: BrokerVerbindung;
  config: Config;
  configSource: UserRiskSource;
  strategy: StrategyMap;
}

interface TickContext {
  deps: TickDeps;
  db: FirestoreLike;
  now: Ms;
  log: typeof logger;
  tmpRoot: string;
  assetClass: AssetClass;
  feed: 'iex' | 'sip';
  calendar: Calendar | undefined;
  shared: SharedServices;
  fetchOk: boolean;
}

export async function runEngineTick(deps: TickDeps, now: Ms = Date.now()): Promise<TickResult> {
  const started = Date.now();
  const log = deps.log ?? logger;
  const db = deps.db;
  const empty = (skipped: TickResult['skipped']): TickResult => ({
    skipped,
    users: 0,
    ok: 0,
    failed: [],
    skippedUsers: [],
    symbolsOk: 0,
    symbolsFailed: 0,
    fetchOk: false,
    durationMs: Date.now() - started,
  });

  let holder: string | null;
  try {
    holder = await acquireLease(db, now, deps.leaseMs ?? LEASE_MS);
  } catch (e) {
    log.error('Lease nicht prüfbar — Takt übersprungen', { error: errMsg(e) });
    holder = null;
  }
  if (holder === null) {
    log.warn('Engine-Takt: Lease belegt — übersprungen');
    await writeHealth(db, { lastRunAt: isoOf(now), lastRunSkipped: 'lease', engine: { at: isoOf(now), skipped: 'lease', durationMs: Date.now() - started } }, log);
    return empty('lease');
  }
  try {
    return await runLocked(deps, db, now, log, started);
  } finally {
    try {
      await releaseLease(db, holder, now);
    } catch (e) {
      log.warn('Lease nicht freigegeben (läuft in 90 s ab)', { error: errMsg(e) });
    }
  }
}

async function runLocked(deps: TickDeps, db: FirestoreLike, now: Ms, log: typeof logger, started: Ms): Promise<TickResult> {
  const tmpRoot = deps.tmpRoot ?? DEFAULT_TMP_ROOT;
  const result: TickResult = { skipped: null, users: 0, ok: 0, failed: [], skippedUsers: [], symbolsOk: 0, symbolsFailed: 0, fetchOk: false, durationMs: 0 };
  const finish = (): TickResult => {
    result.durationMs = Date.now() - started;
    return result;
  };
  const healthEngine = (extra: DocData = {}): DocData => ({
    at: isoOf(now),
    users: result.users,
    ok: result.ok,
    skippedUsers: result.skippedUsers.length,
    failed: result.failed.map((f) => ({ uid: uidKurz(f.uid), error: f.error })),
    fetchOk: result.fetchOk,
    durationMs: Date.now() - started,
    ...extra,
  });

  // 1. Globale Config + Champion
  const [cfgSnap, champSnap] = await Promise.all([db.doc(CONFIG_PATH).get(), db.doc(CHAMPION_PATH).get()]);
  const global = globalConfigRaw(cfgSnap.exists ? cfgSnap.data() : undefined);
  let base: Config;
  try {
    base = parseConfig(global);
  } catch (e) {
    const error = `meta/engineConfig ungültig: ${errMsg(e)}`;
    log.error(error);
    await writeHealth(db, { lastRunAt: isoOf(now), lastRunSkipped: null, engine: healthEngine({ error }) }, log);
    return finish();
  }
  let championNote: string | null = null;
  let champion = null;
  try {
    champion = championFromDoc(champSnap.exists ? champSnap.data() : undefined);
  } catch (e) {
    championNote = errMsg(e);
    log.error(championNote);
  }
  const assetClass = base.universe.assetClass;
  const feed = base.broker.feed;
  const tf = base.timeframe;
  const baseTf: BaseTimeframe = tf === 1440 ? '1Day' : '1Min';

  // 2. Nutzer (Zugang), Marktzeit-Gate
  const usersSnap = await db.collection('users').where('settings.strategy.engine.running', '==', true).get();
  let candidates: DocSnapLike[] = [];
  for (const u of usersSnap.docs) {
    if (mayTrade(u.data())) candidates.push(u);
    else result.skippedUsers.push({ uid: u.id, reason: 'zugang' });
  }
  const dataClient = deps.dataClientFor({ feed, assetClass });
  if (!dataClient) log.error('Kein Plattform-Datenkey (ALPACA_API_KEY/ALPACA_SECRET_KEY) — keine Bars, keine Einstiege');
  const store = sharedStoreFor(barStoreRoot(join(tmpRoot, 'shared', 'bars'), assetClass, feed));
  const shared = buildShared(dataClient, store, now);
  let clock: AlpacaClock | null = null;
  if (dataClient) {
    try {
      clock = await shared.getClock();
    } catch (e) {
      log.warn('Broker-Uhr nicht lesbar — Marktzeit-Gate ausgesetzt, die Engine gatet selbst', { error: errMsg(e) });
    }
  }
  if (assetClass === 'us_equity' && clock && !clock.isOpen) {
    const needy = candidates.filter(needsWorkWhileClosed);
    if (needy.length === 0) {
      await writeHealth(db, { lastRunAt: isoOf(now), lastRunSkipped: 'market_closed', engine: healthEngine({ skipped: 'market_closed', nextOpen: isoOf(clock.nextOpen) }) }, log);
      result.skipped = 'market_closed';
      return finish();
    }
    candidates = needy;
  }

  // 3. Verbindung, Config, Strategie je Nutzer
  const prepared: UserPrep[] = [];
  for (const snap of candidates) {
    const uid = snap.id;
    let verbindung: BrokerVerbindung | null;
    try {
      verbindung = await deps.brokerVerbindung(uid, now);
    } catch (e) {
      result.failed.push({ uid, error: `Broker-Verbindung: ${errMsg(e)}` });
      continue;
    }
    if (!verbindung) {
      result.skippedUsers.push({ uid, reason: 'kein_broker' });
      continue;
    }
    try {
      const uc = buildUserConfig(global, snap.get('settings'));
      const strategy = buildStrategyFor({ champion, config: uc.config, getStrategy: deps.getStrategy, log: userLogger(log, uid) });
      if (championNote) strategy.notes.unshift(championNote);
      prepared.push({ uid, snap, verbindung, config: uc.config, configSource: uc.source, strategy });
    } catch (e) {
      const error = `Config: ${errMsg(e)}`;
      result.failed.push({ uid, error });
      await mirrorError(db, uid, error, now).catch((err: unknown) => log.warn('Spiegel (Fehler) nicht schreibbar', { error: errMsg(err) }));
    }
  }
  result.users = prepared.length;

  // 4. Bars einmal je Takt (Vereinigung aller Symbole + Benchmarks, größtes Warmup)
  const symbols = new Set<string>();
  let maxWarm = 0;
  for (const p of prepared) {
    for (const s of p.config.universe.symbols) {
      symbols.add(s);
      const c = p.strategy.fn(s);
      if (c) maxWarm = Math.max(maxWarm, c.strategy.warmupBars(c.params));
    }
    if (p.config.universe.benchmark) symbols.add(p.config.universe.benchmark);
  }
  const windowMs = warmupWindowMs(maxWarm || 50, tf, assetClass) + 3 * DAY;
  const today = dayKeyFor(now, assetClass);
  let calendar: Calendar | undefined;
  if (dataClient && assetClass !== 'crypto') {
    try {
      const days = await cachedCalendar(today, () => dataClient.getCalendar(addDays(today, -50), addDays(today, 130)));
      if (days.length > 0) calendar = new Map(days.map((d) => [d.date, d]));
    } catch (e) {
      log.warn('Broker-Kalender nicht ladbar — algorithmischer Fallback gilt', { error: errMsg(e) });
    }
  }
  const probe = { errors: 0 };
  if (dataClient && symbols.size > 0) {
    const probing = delegateClient(dataClient, {
      getBars: async (req) => {
        try {
          return await dataClient.getBars(req);
        } catch (e) {
          probe.errors++;
          throw e;
        }
      },
    });
    try {
      await backfill({ client: probing, store, symbols: [...symbols], tf: baseTf, from: now - windowMs, to: now, feed, assetClass, calendar, log: (m) => log.info(m) });
    } catch (e) {
      probe.errors++;
      log.error('Bars-Abruf fehlgeschlagen', { error: errMsg(e) });
    }
    const keepFrom = now - windowMs - 30 * DAY;
    for (const s of symbols) {
      try {
        store.prune(s, baseTf, keepFrom);
      } catch (e) {
        log.warn('Bars-Cache nicht gekürzt', { symbol: s, error: errMsg(e) });
      }
    }
  }
  result.fetchOk = dataClient !== null && probe.errors === 0;
  const quotes: QuoteMark[] = [];
  for (const s of symbols) {
    const bars = store.load(s, baseTf);
    const last = bars[bars.length - 1];
    if (last) {
      result.symbolsOk++;
      quotes.push({ symbol: s, price: last.c, at: last.t + (baseTf === '1Min' ? MIN : DAY) });
    } else result.symbolsFailed++;
  }
  if (result.fetchOk && quotes.length > 0) {
    try {
      await mirrorQuotes(db, quotes);
    } catch (e) {
      log.warn('market/*.quote nicht schreibbar', { error: errMsg(e) });
    }
  }

  // 5. Je Nutzer
  const ctx: TickContext = { deps, db, now, log, tmpRoot, assetClass, feed, calendar, shared, fetchOk: result.fetchOk };
  await parallel(prepared, deps.parallel ?? USERS_PARALLEL, async (p) => {
    const o = await runUser(ctx, p);
    if (o.status === 'ok') result.ok++;
    else if (o.status === 'failed') result.failed.push({ uid: o.uid, error: o.reason ?? 'unbekannt' });
    else result.skippedUsers.push({ uid: o.uid, reason: o.reason ?? 'unbekannt' });
  });

  // 6. Herzschlag
  await writeHealth(
    db,
    {
      lastRunAt: isoOf(now),
      lastRunSkipped: null,
      symbolsOk: result.symbolsOk,
      symbolsFailed: result.symbolsFailed,
      engine: healthEngine({ symbols: symbols.size, champion: champion ? Object.keys(champion.symbols).length : null }),
    },
    log,
  );
  log.info(`Engine-Takt: ${result.ok}/${result.users} Nutzer ok, ${result.failed.length} Fehler, ${result.skippedUsers.length} übersprungen, ${result.symbolsOk} Symbole`, {
    durationMs: Date.now() - started,
  });
  return finish();
}

function buildShared(dataClient: AlpacaClient | null, store: BarStore, now: Ms): SharedServices {
  const noData = (): Promise<never> => Promise.reject(new Error('Kein Plattform-Datenkey (ALPACA_API_KEY/ALPACA_SECRET_KEY)'));
  let clockPromise: Promise<AlpacaClock> | null = null;
  return {
    store,
    getClock: () => {
      if (!dataClient) return noData();
      // Ein Broker-Uhr-Aufruf je Takt; ein Fehler wird nicht gemerkt (nächster Aufrufer versucht es erneut).
      if (!clockPromise) {
        clockPromise = dataClient.getClock().catch((e: unknown) => {
          clockPromise = null;
          throw e;
        });
      }
      return clockPromise;
    },
    getCalendar: (start, end) => (dataClient ? cachedCalendar(`${start}..${end}`, () => dataClient.getCalendar(start, end)) : noData()),
    getAsset: (symbol) => (dataClient ? cachedAsset(symbol, () => dataClient.getAsset(symbol), now) : noData()),
    getLatestBars: (s) => (dataClient ? dataClient.getLatestBars(s) : noData()),
    getLatestQuotes: (s) => (dataClient ? dataClient.getLatestQuotes(s) : noData()),
  };
}

async function runUser(ctx: TickContext, p: UserPrep): Promise<UserOutcome> {
  const { deps, db, now } = ctx;
  const uid = p.uid;
  const started = Date.now();
  const log = userLogger(ctx.log, uid);
  const mode = p.verbindung.mode;
  const journal = new FirestoreJournal({ db, mode, assetClass: ctx.assetClass, fx: deps.fx, log, timestampNow: deps.timestampNow });
  const stateStore = new FirestoreStateStore(db, uid);
  let engine: Engine | null = null;
  let error: string | null = null;
  let commandsSeen = false;
  try {
    const client = withSharedData(deps.clientFor(p.verbindung, { feed: ctx.feed, assetClass: ctx.assetClass }), ctx.shared);
    engine = new Engine({
      config: p.config,
      mode,
      home: join(ctx.tmpRoot, 'users', uid),
      client,
      dataStream: new NoopDataStream(ctx.fetchOk ? now : null),
      tradeStream: new NoopTradeStream(),
      strategyFor: p.strategy.fn,
      benchmarkSymbol: p.config.universe.benchmark,
      calendar: ctx.calendar,
      now: () => now,
      timers: NOOP_TIMERS,
      log,
      store: new SharedBarStoreView(ctx.shared.store),
      statSync: () => haltFlagStat(engine),
      processEvents: NOOP_PROCESS,
      stateStore,
      journal,
    });
    for (const n of p.strategy.notes) journal.append('note', { text: n }, now);
    await engine.start();
    try {
      const cmds = await claimCommands(db, uid);
      commandsSeen = true;
      if (cmds) await applyCommands(engine, cmds, journal, now);
    } catch (e) {
      log.warn('Kommandos nicht lesbar', { error: errMsg(e) });
      journal.append('error', { where: 'commands', error: errMsg(e) }, now);
    }
    await engine.tick(now);
  } catch (e) {
    error = errMsg(e);
    log.error('Nutzer-Takt fehlgeschlagen', { error });
    journal.append('error', { where: 'tick', error }, now);
  } finally {
    if (engine) {
      try {
        await engine.stop();
      } catch (e) {
        log.warn('Engine-Stopp fehlgeschlagen', { error: errMsg(e) });
      }
    }
  }
  try {
    await journal.flush(uid);
  } catch (e) {
    log.error('Journal nicht schreibbar', { error: errMsg(e) });
    error ??= `Journal: ${errMsg(e)}`;
  }
  try {
    if (error === null && engine) {
      const status = engine.status();
      await mirrorPositions(db, uid, status, now);
      await mirrorUser(db, uid, { mode, status, now, lastError: null, champion: { source: p.strategy.source, symbols: p.strategy.tradable }, commandsSeen, configSource: p.configSource });
    } else {
      await mirrorError(db, uid, error ?? 'unbekannt', now);
    }
  } catch (e) {
    log.error('Spiegel nicht schreibbar', { error: errMsg(e) });
    error ??= `Spiegel: ${errMsg(e)}`;
  }
  const durationMs = Date.now() - started;
  return error === null ? { uid, status: 'ok', durationMs } : { uid, status: 'failed', reason: error, durationMs };
}
