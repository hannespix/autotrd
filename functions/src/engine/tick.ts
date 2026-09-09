/**
 * Der Engine-Takt: EIN Lauf je Minute (Cloud Scheduler), kein Dauerprozess,
 * kein WebSocket. Je Takt:
 *
 *   1. Lease `meta/engineLease` (Transaktion) — zwei überlappende Läufe
 *      hätten zwei Bücher auf einem Konto.
 *   2. Nutzerliste: `users where settings.strategy.engine.running == true`,
 *      Zugang (`mayTrade`), kein laufender Reset, Broker-Zugang
 *      (`brokerZugang`: Verbindung + Sperrgrund der Echtgeld-Kette). Ohne
 *      Broker wird der Nutzer übersprungen; ein VERRIEGELTES Live-Konto läuft
 *      mit Einstiegs-Sperre weiter — Abgleich, Schutz-Stops, Exits und
 *      Glattstellungen gehen vor (Exits werden nie gesperrt).
 *   3. Globale Config (`meta/engineConfig`) + Champion (`meta/champion`),
 *      Config je Nutzer aus dessen Settings.
 *   4. Marktzeit-Gate: Aktienmarkt zu und niemand hat etwas Zurückgestelltes
 *      oder ein Kommando ⇒ nur Herzschlag.
 *   5. Bars EINMAL je Takt mit dem Plattform-Key in den geteilten Cache;
 *      Nutzer-Engines lesen daraus (keine Datenaufrufe je Nutzer).
 *   6. Je Nutzer (parallel, Limit 3, Zeitbudget je Nutzer, Reihenfolge
 *      rotiert je Minute): Engine bauen → start (Konto, Abgleich, Backfill
 *      aus dem Cache, Schutz-Stops) → Kommandos → tick → stop → Journal-Batch
 *      (leert atomar den Puffer im State-Doc) → Spiegel. Fehler je Nutzer
 *      fangen, weiter mit dem nächsten.
 *   7. Herzschlag `meta/health` (Merge) — `bewerteHerzschlag` bleibt gültig.
 *
 * Alles, was Geld bewegt, macht die Engine selbst (`src/engine`): derselbe
 * `decide()`-Pfad wie Backtest und Dauerprozess. Diese Datei verdrahtet nur.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AlpacaClient, AlpacaClock } from '../../../src/alpaca/types.ts';
import { universeWithBasis } from '../../../src/core/basisTier.ts';
import { parseConfig, type Config } from '../../../src/core/config.ts';
import { errMsg, logger } from '../../../src/core/log.ts';
import { DAY, MIN, addDays, dayKeyFor, nextTradingDay, sessionBounds, type Calendar } from '../../../src/core/time.ts';
import type { AssetClass, Ms, Strategy } from '../../../src/core/types.ts';
import { backfill } from '../../../src/data/backfill.ts';
import { barStoreRoot, type BarStore, type BaseTimeframe } from '../../../src/data/store.ts';
import { Engine, StateMismatchError, warmupWindowMs, type EngineTimers, type ProcessEvents } from '../../../src/engine/engine.ts';
import { resetLaeuft } from '../../../shared/src/circuitBreaker.js';
import { mayTrade } from '../../../shared/src/zugang.js';
import type { BrokerVerbindung, BrokerZugang } from '../core/brokerZugang.js';
import { applyCommands, claimCommands } from './commands.js';
import { buildUserConfig, globalConfigRaw, type UserRiskSource } from './config.js';
import { isRecord, isoOf, plain, type DocData, type DocSnapLike, type FirestoreLike, type WriteGuard } from './firestoreLike.js';
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
/**
 * Zeitbudget je Nutzer (Konto, Abgleich, Orders, Journal). Danach gilt der Nutzer als gescheitert und der
 * Takt geht weiter — ein hängender Broker eines Nutzers darf nicht die Exits aller anderen blockieren
 * (Secreview 2, M7). Der REST-Client bekommt dieselbe Frist, damit nach dem Budget kein Aufruf mehr beginnt.
 */
export const USER_BUDGET_MS = 20_000;
/** Weiche Frist des ganzen Takts: danach wird kein weiterer Nutzer begonnen (Function-Timeout 55 s). */
export const TICK_SOFT_DEADLINE_MS = 40_000;
/** REST je Aufruf im Takt: kurz, höchstens ein Wiederholversuch — 3 × 15 s + Backoff sprengen jedes Budget. */
export const REQUEST_TIMEOUT_MS = 5_000;
export const REQUEST_ATTEMPTS = 2;

/** Grenzen des Trading-Clients je Nutzer und Takt. */
export interface ClientLimits {
  timeoutMs: number;
  attempts: number;
  /** Absolute Frist (Epoch-ms) — danach beginnt kein Aufruf mehr. */
  deadline: Ms;
}

export interface ClientOptions {
  feed: 'iex' | 'sip';
  assetClass: AssetClass;
  limits?: ClientLimits | undefined;
}

export interface TickDeps {
  db: FirestoreLike;
  /** Plattform-Datenclient (Bars, Kalender, Uhr, Stammdaten); null ⇒ kein Datenkey. */
  dataClientFor: (o: { feed: 'iex' | 'sip'; assetClass: AssetClass }) => AlpacaClient | null;
  /**
   * Broker-Zugang eines Nutzers (`core/brokerZugang.brokerZugang`): Verbindung plus Sperrgrund des
   * Order-Pfads (Echtgeld-Kette). null ⇒ kein Broker. Ein gesperrter Zugang läuft mit Einstiegs-Sperre.
   */
  brokerZugang: (uid: string, nowMs: Ms) => Promise<BrokerZugang | null>;
  /** Trading-Client aus den Nutzer-Schlüsseln (`createAlpacaClient`), mit Zeitgrenzen des Takts. */
  clientFor: (v: BrokerVerbindung, o: ClientOptions) => AlpacaClient;
  /** EZB-Kurs-Felder (`core/fx.fxFelder`). */
  fx: FxFn;
  /** Strategie-Register; Default `src/strategy` (Tests: Skript-Strategie). */
  getStrategy?: ((id: string) => Strategy) | undefined;
  /** Wurzel für Bars-Cache und Nutzer-Homes (Default /tmp/autotrd). */
  tmpRoot?: string | undefined;
  log?: typeof logger | undefined;
  parallel?: number | undefined;
  leaseMs?: number | undefined;
  /** Zeitbudget je Nutzer (Default USER_BUDGET_MS). */
  userBudgetMs?: number | undefined;
  /** Weiche Frist des Takts (Default TICK_SOFT_DEADLINE_MS). */
  tickSoftDeadlineMs?: number | undefined;
  /** `at`-Stempel der Trade-Docs (Tests). */
  timestampNow?: (() => unknown) | undefined;
}

export interface UserOutcome {
  uid: string;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  durationMs?: number;
  /** true, wenn das Zeitbudget je Nutzer gerissen wurde (der Nutzer-Lauf wurde aufgegeben). */
  budgetExceeded?: boolean;
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

/** Reihenfolge je Takt verschieben (stabile Query-Reihenfolge ⇒ sonst immer dieselben Nachzügler). */
export function rotate<T>(items: readonly T[], shift: number): T[] {
  if (items.length < 2) return [...items];
  const k = ((shift % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

/**
 * Schreibsperre eines Nutzer-Laufs: bis zur Frist und solange der Takt den Lauf nicht aufgegeben hat. Danach
 * wirft jeder Firestore-Schreibvorgang des Laufs (State, Journal, Spiegel) — der aufgegebene Lauf kann den
 * jüngeren Stand des nächsten Takts nicht mehr überschreiben (Secreview 3, #2).
 */
export class RunGuard implements WriteGuard {
  private readonly deadline: Ms;
  private abandoned = false;
  constructor(deadline: Ms) {
    this.deadline = deadline;
  }
  abandon(): void {
    this.abandoned = true;
  }
  allowed(): boolean {
    return !this.abandoned && Date.now() < this.deadline;
  }
  assert(what: string): void {
    if (!this.allowed()) throw new Error(`Lauf aufgegeben (Zeitbudget) — ${what} wird nicht mehr geschrieben`);
  }
}

/** Nutzer-Lauf mit Zeitbudget: danach gilt er als gescheitert und darf nichts mehr schreiben (REST-Client hat dieselbe Frist). */
async function withBudget(run: Promise<UserOutcome>, budgetMs: number, uid: string, guard: RunGuard): Promise<UserOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<UserOutcome>((resolve) => {
    timer = setTimeout(() => {
      guard.abandon();
      resolve({ uid, status: 'failed', reason: `Zeitbudget je Nutzer (${budgetMs} ms) überschritten — Lauf aufgegeben`, budgetExceeded: true });
    }, budgetMs);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Marktzeit ohne Broker-Uhr: algorithmischer NYSE-Kalender (Feiertage, Wochenenden; Frühschlüsse nur mit Kalender). */
export function fallbackClock(now: Ms): AlpacaClock {
  const day = dayKeyFor(now, 'us_equity');
  const today = sessionBounds(day, 'us_equity');
  const isOpen = today !== null && now >= today.open && now < today.close;
  const nextDay = today !== null && now < today.open ? day : nextTradingDay(day, 'us_equity');
  const next = sessionBounds(nextDay, 'us_equity');
  return {
    timestamp: now,
    isOpen,
    nextOpen: isOpen ? (sessionBounds(nextTradingDay(day, 'us_equity'), 'us_equity')?.open ?? now + DAY) : (next?.open ?? now + DAY),
    nextClose: isOpen ? today.close : (next?.close ?? now + DAY),
  };
}

/** Kommandos eines Nutzers ohne Broker verwerfen (Transaktion) und den Grund spiegeln. */
async function discardCommandsWithoutBroker(db: FirestoreLike, snap: DocSnapLike, now: Ms, log: typeof logger): Promise<void> {
  if (!needsWorkWhileClosed(snap) && typeof (snap.get('engine') as { commandAt?: unknown } | undefined)?.commandAt !== 'string') return;
  try {
    const cmds = await claimCommands(db, snap.id);
    const actions = cmds ? Object.keys(cmds) : [];
    await db.doc(`users/${snap.id}`).set(
      plain({ engine: { commandAt: null, lastTickAt: isoOf(now), ...(actions.length ? { lastError: `Kommando ${actions.join('/')} verworfen — kein Broker verbunden` } : {}) } }),
      { merge: true },
    );
  } catch (e) {
    log.warn('Kommandos ohne Broker nicht verwerfbar', { error: errMsg(e) });
  }
}

function sameNotes(prev: unknown, notes: readonly string[]): boolean {
  return Array.isArray(prev) && prev.length === notes.length && prev.every((x, i) => x === notes[i]);
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
  /** Sperrgrund des Order-Pfads (Echtgeld-Kette) — null = frei. */
  sperre: string | null;
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
  budgetMs: number;
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
    // Nur der Hash, kein Fehlertext: `meta/health` ist öffentlich, Fehlertexte können Pfade mit uid tragen
    // (Secreview 2, M1). Der volle Fehler steht privat in `users/{uid}.engine.lastError` und im Log.
    failed: result.failed.map((f) => ({ uid: uidKurz(f.uid) })),
    fetchOk: result.fetchOk,
    durationMs: Date.now() - started,
    /*
     * Felder, die es NUR in Sonderfällen gibt, hier ausdrücklich auf null.
     *
     * `writeHealth` schreibt mit `{ merge: true }`, und Firestore merged Maps
     * TIEF: Ein Schlüssel, den der neue Schreibvorgang nicht nennt, bleibt
     * stehen. Ohne diese Zeilen überlebte ein `skipped: 'market_closed'` von
     * heute früh den ganzen Handelstag, während daneben ein frischer
     * Herzschlag lief — das Dashboard meldete „Markt geschlossen", obwohl der
     * Takt in derselben Sekunde 30 Symbole verarbeitete (08.09.2026, 17:25
     * MESZ = 11:25 ET, Markt seit zwei Stunden offen). Dasselbe gälte für
     * einen alten `error`: Die Karte zeigte den Fehler für immer.
     *
     * `plain()` ist ein JSON-Roundtrip, also überlebt `null` — nur
     * `undefined` fiele weg. Die Reihenfolge zählt: `...extra` überschreibt.
     */
    skipped: null,
    nextOpen: null,
    error: null,
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
  // Bereinigung der Tagesbars — derselbe Schalter wie beim Optimierer (`broker.adjustment`), seit der
  // Basis-Stufe im Doc `meta/engineConfig` (scripts/module/engineConfig.mjs; Prüfbefund M7 gilt live).
  // Der Takt folgt ihm: eigene Cache-Wurzel je Bereinigung, bereinigter Abruf; ein Doc ohne das Feld
  // bleibt roh — rohe und bereinigte Tagesbars mischen sich nie (functions/test/engine/bereinigung).
  const adjustment = base.broker.adjustment;
  const tf = base.timeframe;
  const baseTf: BaseTimeframe = tf === 1440 ? '1Day' : '1Min';

  // 2. Nutzer (Zugang), Marktzeit-Gate
  const usersSnap = await db.collection('users').where('settings.strategy.engine.running', '==', true).get();
  let candidates: DocSnapLike[] = [];
  for (const u of usersSnap.docs) {
    if (!mayTrade(u.data())) result.skippedUsers.push({ uid: u.id, reason: 'zugang' });
    // Laufender Konto-Reset (`resetWallet` setzt den Marker, er verfällt von selbst): keine Orders, keine
    // Trade-Docs hinter dem Archiv-Schnitt, kein Überschreiben des frisch gesetzten Saldos (Secreview 2, G2).
    else if (resetLaeuft(u.get('risk.resetLaeuftSeit'), new Date(now))) result.skippedUsers.push({ uid: u.id, reason: 'reset_laeuft' });
    else candidates.push(u);
  }
  const dataClient = deps.dataClientFor({ feed, assetClass });
  if (!dataClient) log.error('Kein Plattform-Datenkey (ALPACA_API_KEY/ALPACA_SECRET_KEY) — keine Bars, keine Einstiege');
  const store = sharedStoreFor(barStoreRoot(join(tmpRoot, 'shared', 'bars'), assetClass, feed, adjustment), adjustment);
  const shared = buildShared(dataClient, store, now);
  let clock: AlpacaClock | null = null;
  if (dataClient) {
    try {
      clock = await shared.getClock();
    } catch (e) {
      log.warn('Broker-Uhr nicht lesbar — algorithmischer NYSE-Kalender gatet die Marktzeit', { error: errMsg(e) });
    }
  }
  // Ohne Broker-Uhr (kein Datenkey, Uhr nicht lesbar): algorithmischer Kalender statt kein Gate — sonst liefen
  // alle Engines nachts minütlich (Secreview 2, G7). Frühschlüsse kennt der Fallback nur über den Kalender.
  if (assetClass === 'us_equity' && !clock) clock = fallbackClock(now);
  if (assetClass === 'us_equity' && clock && !clock.isOpen) {
    const needy = candidates.filter(needsWorkWhileClosed);
    if (needy.length === 0) {
      await writeHealth(db, { lastRunAt: isoOf(now), lastRunSkipped: 'market_closed', engine: healthEngine({ skipped: 'market_closed', nextOpen: isoOf(clock.nextOpen) }) }, log);
      result.skipped = 'market_closed';
      return finish();
    }
    candidates = needy;
  }

  // 3. Zugang, Config, Strategie je Nutzer
  const prepared: UserPrep[] = [];
  for (const snap of candidates) {
    const uid = snap.id;
    let zugang: BrokerZugang | null;
    try {
      zugang = await deps.brokerZugang(uid, now);
    } catch (e) {
      result.failed.push({ uid, error: `Broker-Verbindung: ${errMsg(e)}` });
      continue;
    }
    if (!zugang) {
      result.skippedUsers.push({ uid, reason: 'kein_broker' });
      // Ein liegengebliebenes Kommando ohne Broker würde den Nutzer nächtlich in die Lauf-Liste heben und
      // beim späteren Verbinden feuern (Secreview 2, G3) — verwerfen und dem Nutzer sagen, warum.
      await discardCommandsWithoutBroker(db, snap, now, log);
      continue;
    }
    try {
      const uc = buildUserConfig(global, snap.get('settings'));
      // Eine veraltete Symbolauswahl sperrt Einstiege wie jede andere offene
      // Kette — Exits, Abgleich und Schutz-Stops laufen weiter.
      const sperre = zugang.sperre ?? uc.auswahlVeraltet ?? null;
      // Der Korb der Basis-Stufe kommt als Block ins Universum dieser Engine (wenn der Champion-Block
      // `basis` bestanden hat und der Nutzer-Schalter an ist) — die Engine führt nur ihr Universum.
      const mitBasis = universeWithBasis(uc.config, champion);
      // Verriegelt (Echtgeld-Kette offen): keine Einstiege, und Fremdbestand wird nie adoptiert — ein
      // Schutz-Stop auf eine Handposition wäre eine Order auf einem verriegelten Konto.
      const config: Config = sperre ? { ...mitBasis, engine: { ...mitBasis.engine, onOrphan: 'halt' } } : mitBasis;
      const strategy = buildStrategyFor({ champion, config, getStrategy: deps.getStrategy, log: userLogger(log, uid) });
      if (championNote) strategy.notes.unshift(championNote);
      if (sperre) strategy.notes.push(`Einstiege gesperrt: ${sperre} — Abgleich, Schutz-Stops und Exits laufen weiter`);
      prepared.push({ uid, snap, verbindung: zugang.verbindung, sperre, config, configSource: uc.source, strategy });
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
      await backfill({ client: probing, store, symbols: [...symbols], tf: baseTf, from: now - windowMs, to: now, feed, adjustment, assetClass, calendar, log: (m) => log.info(m) });
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

  // 5. Je Nutzer — Reihenfolge rotiert je Minute, damit ein langsamer Nutzer nicht Takt für Takt dieselben
  //    Nachfolger verdrängt; je Nutzer ein Zeitbudget; nach der weichen Frist beginnt kein weiterer.
  const budgetMs = deps.userBudgetMs ?? USER_BUDGET_MS;
  const softDeadlineMs = deps.tickSoftDeadlineMs ?? TICK_SOFT_DEADLINE_MS;
  const ctx: TickContext = { deps, db, now, log, tmpRoot, assetClass, feed, calendar, shared, fetchOk: result.fetchOk, budgetMs };
  await parallel(rotate(prepared, Math.floor(now / MIN)), deps.parallel ?? USERS_PARALLEL, async (p) => {
    if (Date.now() - started > softDeadlineMs) {
      result.skippedUsers.push({ uid: p.uid, reason: 'zeitbudget_takt' });
      return;
    }
    const guard = new RunGuard(Date.now() + budgetMs);
    const o = await withBudget(runUser(ctx, p, guard), budgetMs, p.uid, guard);
    if (o.status === 'ok') result.ok++;
    else if (o.status === 'failed') {
      result.failed.push({ uid: o.uid, error: o.reason ?? 'unbekannt' });
      if (o.budgetExceeded) await mirrorError(db, o.uid, o.reason ?? 'Zeitbudget überschritten', now).catch((err: unknown) => log.warn('Spiegel (Fehler) nicht schreibbar', { error: errMsg(err) }));
    } else result.skippedUsers.push({ uid: o.uid, reason: o.reason ?? 'unbekannt' });
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

async function runUser(ctx: TickContext, p: UserPrep, guard: RunGuard): Promise<UserOutcome> {
  const { deps, db, now } = ctx;
  const uid = p.uid;
  const started = Date.now();
  const log = userLogger(ctx.log, uid);
  const mode = p.verbindung.mode;
  // Stufe eines Symbols (champion/basis/config) für Positions- und Trade-Docs — nur, wenn die Wahl von
  // heute noch dieselbe Strategie ist wie die der Position; sonst unbekannt.
  const stufeFor = (symbol: string, strategyId: string): string | undefined => {
    const c = p.strategy.fn(symbol);
    return c && c.strategy.id === strategyId ? c.source : undefined;
  };
  const journal = new FirestoreJournal({ db, mode, assetClass: ctx.assetClass, fx: deps.fx, log, timestampNow: deps.timestampNow, stufeFor });
  const stateStore = new FirestoreStateStore(db, uid, { journal, guard });
  let engine: Engine | null = null;
  let error: string | null = null;
  let commandsSeen = false;
  try {
    // Frist des REST-Clients knapp VOR dem Budget des Takts: Wenn der Takt aufgibt, beginnt kein Aufruf mehr.
    const limits: ClientLimits = { timeoutMs: REQUEST_TIMEOUT_MS, attempts: REQUEST_ATTEMPTS, deadline: started + Math.max(1_000, ctx.budgetMs - 1_000) };
    const client = withSharedData(deps.clientFor(p.verbindung, { feed: ctx.feed, assetClass: ctx.assetClass, limits }), ctx.shared);
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
      entryLock: () => p.sperre,
    });
    // Strategie-Notizen („kein Champion", Zeitrahmen-Abweichung, Sperre) nur bei Änderung ins Journal — sonst
    // ein Dokument je Minute für die Information „nichts passiert" (Secreview 2, G1). Der Spiegel zeigt sie immer.
    if (!sameNotes((p.snap.get('engine') as { notes?: unknown } | undefined)?.notes, p.strategy.notes)) {
      for (const n of p.strategy.notes) journal.append('note', { text: n }, now);
    }
    try {
      await engine.start();
    } catch (e) {
      if (!(e instanceof StateMismatchError)) throw e;
      // Der State gehört zu einem anderen Alpaca-Konto oder Modus (Nutzer hat neue Schlüssel hinterlegt, Paper ⇒ Live):
      // archivieren statt weiterhandeln — der Abgleich hätte die alten Positionen als „fehlt" mit geschätztem Kurs
      // ausgebucht (Secreview 2, M9; Secreview 3, #4). Der nächste Takt startet mit leerem Buch; die alten Positionen
      // bleiben beim alten Konto samt Beinen (DAY-Beine verfallen dort um 16:00 — steht in der Journal-Notiz).
      const archived = await stateStore.archive(now, e.message);
      journal.append('note', { text: `Engine-State archiviert (${e.message}) — Positionen des alten Kontos/Modus bleiben dort samt Schutz-Stops; DAY-Beine verfallen am Sitzungsende`, archived }, now);
      log.warn('Engine-State archiviert — Konto/Modus gewechselt', { archived, kind: e.kind });
      engine = null;
      throw new Error(`${e.kind === 'mode' ? 'Modus' : 'Konto'} gewechselt — Engine-State archiviert, nächster Takt startet neu`);
    }
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
    // Journal-Docs und das Leeren des Puffers im State-Doc in EINEM Batch (Secreview 2, M5).
    await journal.flush(uid, stateStore.bufferClearOp(), guard);
    stateStore.markBufferCleared();
  } catch (e) {
    log.error('Journal nicht schreibbar — Puffer bleibt im State-Doc und wird im nächsten Takt nachgeschrieben', { error: errMsg(e) });
    error ??= `Journal: ${errMsg(e)}`;
  }
  try {
    if (!guard.allowed()) {
      // Aufgegebener Lauf: nichts mehr spiegeln — der Takt hat den Nutzer längst als gescheitert gemeldet.
    } else if (error === null && engine) {
      const status = engine.status();
      await mirrorPositions(db, uid, status, now, stufeFor);
      await mirrorUser(db, uid, {
        mode,
        status,
        now,
        lastError: null,
        champion: { source: p.strategy.source, symbols: p.strategy.tradable, basis: p.strategy.basisSymbols },
        commandsSeen,
        configSource: p.configSource,
        notes: p.strategy.notes,
      });
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
