/**
 * Datenschicht — ausschließlich Firestore (`onSnapshot`/`getDocs`) und
 * Callables; kein fetch-Polling, kein /api/*.
 *
 * Was hier steht, ist genau das, was der Engine-Takt (`functions/src/engine`)
 * schreibt und was die bleibenden Callables anbieten:
 *
 *   users/{uid}                 settings.strategy.engine.running (Schalter),
 *                               settings.auto (Risiko), wallet, engine (Spiegel)
 *   users/{uid}/positions       Positions-Docs im alten Schema (+ Engine-Felder)
 *   users/{uid}/trades          zwei Fills je abgeschlossenem Trade
 *   users/{uid}/equity, stats   Tages-Snapshots und Kennzahlen (snapshotEquity)
 *   market/{sym}.quote          letzter Close je Takt
 *   meta/health, engineConfig, champion, optimizeReports/berichte/{date}
 */

import {
  accessLevelOf,
  BERICHTE_SEGMENTE,
  type AccessLevel,
  type AutoSettings,
  type KanteJeTrade,
  type Position,
  type Quote,
  type ReifeBefund,
  type Steuerbericht,
  type Strategy,
  type Wallet,
} from '@autotrd/shared';
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot as fsOnSnapshot,
  orderBy,
  query,
  startAfter,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db } from './firebase.js';
import { muxWatch } from './mux.js';
import { listenerCount, trackListener } from './listeners.js';

export { listenerCount };

// ── Listener-Buchhaltung: jeder onSnapshot läuft über diesen Wrapper, damit
// Mount/Unmount nachweislich keine Listener leaken (E2E-Zähler in main.ts).
const onSnapshot = ((...args: Parameters<typeof fsOnSnapshot>): Unsubscribe =>
  trackListener(
    (fsOnSnapshot as (...a: unknown[]) => Unsubscribe)(...args),
  )) as typeof fsOnSnapshot;

const useEmulators = import.meta.env.VITE_FIREBASE_USE_EMULATORS === '1';
let fnsEmulatorConnected = false;

function fns(): ReturnType<typeof getFunctions> {
  const f = getFunctions(getApp());
  if (!fnsEmulatorConnected && useEmulators) {
    connectFunctionsEmulator(f, '127.0.0.1', 5001);
    fnsEmulatorConnected = true;
  }
  return f;
}

/* ── Kleine Leser: Firestore-Rohwerte in verlässliche Formen ─────────────── */

const istObjekt = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const zahlOderNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const textOderNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const textListe = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/* ── Profil / Konto ──────────────────────────────────────────────────────── */

/**
 * Profil serverseitig sicherstellen (idempotent).
 *
 * `risiko` ist die Fassung des Risikohinweises, der der Nutzer gerade
 * zugestimmt hat. Für BESTANDSKONTEN spielt sie keine Rolle — der Server
 * kehrt vorher um. Für ein NEUES Konto ist sie Bedingung: Ohne sie wirft
 * er `srv.risikoBestaetigungFehlt`, und es entsteht gar kein Profil.
 */
export async function ensureProfile(risiko?: string): Promise<void> {
  await httpsCallable(fns(), 'ensureProfile')(risiko === undefined ? {} : { risiko });
}

export interface ResetWalletResult {
  ok: true;
  deleted: Record<string, number>;
  balance: number;
  resetAt: string;
  /** Woher der Startwert kam — „100.000 $" ohne Herkunft lässt offen, ob der
   *  Broker gefragt wurde oder die Einstellung gegriffen hat. */
  kapitalQuelle: 'einstellung' | 'broker';
  /** Warnung, wenn beim Broker noch Positionen liegen — der Reset leert nur
   *  das Buch, nie das Depot. */
  hinweis?: string;
}

/**
 * Handelshistorie, Positionen und Kennzahlen auf null — Kursdaten bleiben.
 *
 * Das Bestätigungswort geht mit auf die Leitung und wird SERVERSEITIG noch
 * einmal geprüft. Ein Client-Guard allein wäre bei einer unumkehrbaren
 * Aktion keine Sicherung, nur eine Bequemlichkeit.
 */
export async function resetWallet(confirm: string, vomBroker = false): Promise<ResetWalletResult> {
  const r = await httpsCallable(fns(), 'resetWallet')({ confirm, vomBroker });
  return r.data as ResetWalletResult;
}

export interface TaxReportResult {
  ok: true;
  bericht: Steuerbericht;
  csv: string;
  gelesen: number;
  historieUnvollstaendig: boolean;
}

/** Jahres-Steuerbericht serverseitig rechnen lassen (volle Historie inkl. Archiv). */
export async function callTaxReport(jahr: number, echtgeld: boolean): Promise<TaxReportResult> {
  const r = await httpsCallable(fns(), 'taxReport')({ jahr, echtgeld });
  return r.data as TaxReportResult;
}

export interface FxNachtragErgebnis {
  ok: true;
  geprueft: number;
  nachgetragen: number;
  ohneKurs: number;
}

/** Fehlende Wechselkurse historischer Trades einfrieren (Kurs des Handelstages). */
export async function callFxNachtragen(): Promise<FxNachtragErgebnis> {
  const r = await httpsCallable(fns(), 'fxNachtragen')({});
  return r.data as FxNachtragErgebnis;
}

/* ── Broker-Zugang & Echtgeld-Schalter ───────────────────────────────────── */

export interface BrokerStatusResult {
  ok: true;
  modus: 'paper' | 'live';
  wunschLive: boolean;
  envFreigabe: boolean;
  schluesselVorhanden: boolean;
  reife: ReifeBefund;
  kante: KanteJeTrade;
  konto: {
    id: string;
    status: string;
    currency: string;
    cash: number;
    equity: number;
    buyingPower: number;
    tradingBlocked: boolean;
    accountBlocked: boolean;
    patternDayTrader: boolean;
  } | null;
  abweichungen: Array<{
    symbol: string;
    eigeneMenge: number;
    brokerMenge: number;
    differenz: number;
  }>;
  meldung: string;
  fehler?: string;
}

/** Zustand der Broker-Anbindung prüfen, ohne zu handeln. */
export async function callBrokerStatus(): Promise<BrokerStatusResult> {
  const r = await httpsCallable(fns(), 'brokerStatus')({});
  return r.data as BrokerStatusResult;
}

export interface ConnectResult {
  ok: true;
  maskiert: string;
  art: 'paper' | 'live';
  verschluesselt: boolean;
  kontoStatus: string;
  cash: number;
  equity: number;
  meldung: string;
}

/**
 * Eigenes Alpaca-Konto verbinden. Die Schlüssel gehen einmal zum Server und
 * kommen nie zurück; die Antwort ist der Kontostatus und eine maskierte
 * Kennung. Echtgeld-Schlüssel (AK…) verlangen eine frische Anmeldung.
 */
export async function callConnectBroker(apiKey: string, secretKey: string): Promise<ConnectResult> {
  const r = await httpsCallable(fns(), 'connectBroker')({ apiKey, secretKey });
  return r.data as ConnectResult;
}

/** Verbindung lösen — der Server löscht das Schlüsselpaar. */
export interface DisconnectResult {
  ok: true;
  geloescht: boolean;
  orders?: {
    storniert: number;
    gefuellt: number;
    fehler: number;
    listeFehlgeschlagen: boolean;
    moeglicherweiseUnvollstaendig: boolean;
  };
  liveOrdersBleiben?: true;
  sweepUnmoeglich?: true;
}

export async function callDisconnectBroker(): Promise<DisconnectResult> {
  const r = await httpsCallable(fns(), 'connectBroker')({ action: 'disconnect' });
  return r.data as DisconnectResult;
}

export interface LiveModeStatus {
  reife: {
    bereit: boolean;
    erfuellt: number;
    gesamt: number;
    fazit: string;
    offeneCodes?: string[];
    kriterien: { name: string; erfuellt: boolean; ist: string; soll: string }[];
  };
  brokerArt: 'paper' | 'live' | null;
  serverFreigabe: boolean;
}

export interface LiveModeErgebnis {
  ok: true;
  modus: 'paper' | 'live';
  meldung: string;
  status?: LiveModeStatus;
}

/** Echtgeld-Schalter — abfragen oder umlegen. Der Server entscheidet. */
export async function callLiveMode(
  arg: { action: 'status' } | { live: boolean; bestaetigung?: string },
): Promise<LiveModeErgebnis> {
  const r = await httpsCallable(fns(), 'setLiveMode')(arg);
  return r.data as LiveModeErgebnis;
}

/* ── Engine-Schalter, Einstellungen, Kommandos ───────────────────────────── */

/**
 * `saveStrategy` (neues Payload): entweder den Engine-Schalter oder die
 * Einstellungen des Auto-Traders — nie beides in einem Aufruf, damit der
 * Server jede Änderung einzeln prüfen und ablehnen kann.
 */
export type SaveStrategyPayload = { engineRunning: boolean } | { auto: AutoSettings };

export async function saveStrategy(payload: SaveStrategyPayload): Promise<void> {
  await httpsCallable(fns(), 'saveStrategy')(payload);
}

export type EngineCommandAction = 'halt' | 'resume' | 'flatten';

export interface EngineCommandRequest {
  action: EngineCommandAction;
  reason?: string;
  ackDrawdown?: boolean;
}

export interface EngineCommandErgebnis {
  ok: true;
  action: EngineCommandAction;
  /** Wann das Kommando hinterlegt wurde (ISO). Wirksam wird es im nächsten Takt. */
  at: string;
}

/**
 * halt · resume · flatten — das Callable hinterlegt nur; ausgeführt wird im
 * nächsten Takt (CLAUDE.md §0.5: Sperren löst man über die Ursache).
 */
export async function engineCommand(req: EngineCommandRequest): Promise<EngineCommandErgebnis> {
  const r = await httpsCallable(fns(), 'engineCommand')(req);
  return r.data as EngineCommandErgebnis;
}

/* ── User-Doc: Schalter, Einstellungen, Wallet, Engine-Spiegel ───────────── */

export interface EngineHalt {
  halted: boolean;
  reason: string | null;
  since: number | null;
  /** ET-Tag, an dem ein Tages-Halt von selbst endet. */
  until: string | null;
  note: string | null;
}

/** `users/{uid}.engine` — der Spiegel des letzten Takts (Anzeige, nie Wahrheit). */
export interface EngineMirror {
  mode: 'paper' | 'live' | null;
  halt: EngineHalt | null;
  equity: number | null;
  cash: number | null;
  dayStartEquity: number | null;
  peakEquity: number | null;
  day: string | null;
  dayTradeCount: number | null;
  localDayTrades: number | null;
  patternDayTrader: boolean;
  positions: string[];
  pendingEntries: string[];
  pendingExits: string[];
  /** Nach Sitzungsschluss entschiedene Exits, die bei der nächsten Eröffnung laufen. */
  deferred: string[];
  consecutiveErrors: number;
  /** Einstiegssperre des Kerns (Datenalter, Abgleich, …) — null = frei. */
  entryLock: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  champion: { source: string; symbols: string[] } | null;
  /** Strategie-Notizen des Takts (Champion fehlt, Zeitrahmen weicht ab, Sperre). */
  notes: string[];
  configSource: string | null;
  /** Ein Kommando wartet auf den nächsten Takt (vom Callable gestempelt). */
  commandAt: string | null;
}

function leseHalt(roh: unknown): EngineHalt | null {
  if (!istObjekt(roh)) return null;
  return {
    halted: roh.halted === true,
    reason: textOderNull(roh.reason),
    since: zahlOderNull(roh.since),
    until: textOderNull(roh.until),
    note: textOderNull(roh.note),
  };
}

/** Engine-Spiegel in eine Form bringen, auf die sich die Anzeige verlassen kann. */
export function leseEngine(roh: unknown): EngineMirror | null {
  if (!istObjekt(roh)) return null;
  const champ = istObjekt(roh.champion)
    ? { source: textOderNull(roh.champion.source) ?? '', symbols: textListe(roh.champion.symbols) }
    : null;
  return {
    mode: roh.mode === 'live' ? 'live' : roh.mode === 'paper' ? 'paper' : null,
    halt: leseHalt(roh.halt),
    equity: zahlOderNull(roh.equity),
    cash: zahlOderNull(roh.cash),
    dayStartEquity: zahlOderNull(roh.dayStartEquity),
    peakEquity: zahlOderNull(roh.peakEquity),
    day: textOderNull(roh.day),
    dayTradeCount: zahlOderNull(roh.dayTradeCount),
    localDayTrades: zahlOderNull(roh.localDayTrades),
    patternDayTrader: roh.patternDayTrader === true,
    positions: textListe(roh.positions),
    pendingEntries: textListe(roh.pendingEntries),
    pendingExits: textListe(roh.pendingExits),
    deferred: textListe(roh.deferred),
    consecutiveErrors: zahlOderNull(roh.consecutiveErrors) ?? 0,
    entryLock: textOderNull(roh.entryLock),
    lastTickAt: textOderNull(roh.lastTickAt),
    lastError: textOderNull(roh.lastError),
    champion: champ,
    notes: textListe(roh.notes),
    configSource: textOderNull(roh.configSource),
    commandAt: textOderNull(roh.commandAt),
  };
}

export interface UserDocData {
  /**
   * Zugangsstufe: 'pending' = angelegt, wartet auf Freischaltung — der Takt
   * überspringt das Konto STILL. Fehlendes Feld = Bestandskonto = frei.
   */
  accessLevel: AccessLevel;
  /** Admins sehen die Freischaltungs-Karte. Setzt nur der Server. */
  admin: boolean;
  /** Alte Strategie — gebraucht werden `engine.running` (Schalter) und
   *  `broker.initialCapital` (Kapitalbasis, wenn `wallet.baseCapital` fehlt). */
  strategy: Strategy | null;
  /** `settings.auto` roh (Teilmenge erlaubt) — die Anzeige mischt Defaults dazu. */
  auto: Partial<AutoSettings> | null;
  wallet: Wallet | null;
  engine: EngineMirror | null;
}

export function watchUserDoc(uid: string, cb: (data: UserDocData) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid), (snap) => {
    const autoRoh = snap.get('settings.auto') as unknown;
    cb({
      accessLevel: accessLevelOf(snap.data()),
      admin: snap.get('admin') === true,
      strategy: (snap.get('settings.strategy') as Strategy | undefined) ?? null,
      auto: istObjekt(autoRoh) ? (autoRoh as Partial<AutoSettings>) : null,
      wallet: (snap.get('wallet') as Wallet | undefined) ?? null,
      engine: leseEngine(snap.get('engine')),
    });
  });
}

/* ── Positionen, Kurse ───────────────────────────────────────────────────── */

/** Positions-Doc im alten Schema plus die Felder, die der Takt zusätzlich schreibt. */
export interface PositionRow extends Position {
  strategy?: string;
  initialStop?: number | null;
  barsHeld?: number;
  entryDay?: string;
  quelle?: string;
  updatedAt?: string;
}

export function watchPositions(uid: string, cb: (positions: PositionRow[]) => void): Unsubscribe {
  return onSnapshot(collection(db(), 'users', uid, 'positions'), (snap) => {
    cb(snap.docs.map((d) => d.data() as PositionRow));
  });
}

export interface MarketDocData {
  quote?: Quote;
}

/** `market/{sym}` — nur der Kurs interessiert; über den Mux (ein Listener je Browser). */
export function watchMarketDoc(symbol: string, cb: (data: MarketDocData | null) => void): Unsubscribe {
  return muxWatch(
    `marketDoc:${symbol}`,
    (emit) =>
      onSnapshot(doc(db(), 'market', symbol), (snap) =>
        emit(snap.exists() ? { quote: snap.get('quote') as Quote | undefined } : null),
      ),
    (p) => cb(p as MarketDocData | null),
  );
}

/* ── Handelshistorie mit Paging ──────────────────────────────────────────── */

export interface TradeRow {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  executedAt: string;
  source: 'engine' | 'manual';
  pnl?: number;
  riskExit?: string;
  /** Richtung: `short` am Leerverkauf, `cover` am Eindecken; fehlen beide, ist es ein Long. */
  short?: boolean;
  cover?: boolean;
  /** Engine-Felder an schließenden Fills (additiv). */
  strategy?: string;
  exitReason?: string;
  rMultiple?: number;
  holdingDays?: number;
  fee?: number;
}

/** Seitengröße der Historie. */
export const TRADE_PAGE = 50;

/**
 * Der LIVE-KOPF der Handelshistorie: die neuesten `pageSize` Trades. Ältere
 * Seiten kommen über `loadMoreTrades` als EINMALIGE Abfrage dazu — sortiert
 * über `executedAt` (ISO), derselbe Schlüssel wie der Seiten-Cursor.
 */
export function watchTrades(
  uid: string,
  cb: (trades: TradeRow[], cursor: TradeCursor | null) => void,
  pageSize = TRADE_PAGE,
): Unsubscribe {
  const q = query(
    collection(db(), 'users', uid, 'trades'),
    orderBy('executedAt', 'desc'),
    limit(pageSize),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as TradeRow), snap.docs[snap.docs.length - 1] ?? null);
  });
}

/** Dokument-Cursor (eindeutig) statt Zeitstempel — zwei Fills in derselben
 *  Millisekunde würden ein Zeitstempel-Cursor lautlos überspringen. */
export type TradeCursor = QueryDocumentSnapshot;

export interface TradePage {
  rows: TradeRow[];
  cursor: TradeCursor | null;
  /** Keine weiteren Zeilen mehr (Seite kam unvollständig zurück). */
  done: boolean;
}

export async function loadMoreTrades(
  uid: string,
  after: TradeCursor,
  pageSize = TRADE_PAGE,
): Promise<TradePage> {
  const q = query(
    collection(db(), 'users', uid, 'trades'),
    orderBy('executedAt', 'desc'),
    startAfter(after),
    limit(pageSize),
  );
  const snap = await getDocs(q);
  return {
    rows: snap.docs.map((d) => d.data() as TradeRow),
    cursor: snap.docs[snap.docs.length - 1] ?? null,
    done: snap.docs.length < pageSize,
  };
}

/* ── Portfolio-Kennzahlen und Equity-Serie (snapshotEquity) ──────────────── */

export interface PortfolioStatsDoc {
  equityDays: number;
  sharpe30: number | null;
  sharpe90: number | null;
  hwm: number | null;
  maxDDPct: number | null;
  currentDDPct: number | null;
  trades: number;
  wins: number;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  updatedAt: string;
}

export function watchPortfolioStats(
  uid: string,
  cb: (stats: PortfolioStatsDoc | null) => void,
): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid, 'stats', 'main'), (snap) =>
    cb(snap.exists() ? (snap.data() as PortfolioStatsDoc) : null),
  );
}

export interface EquitySeriesPoint {
  date: string;
  equity: number;
}

export function watchEquitySeries(uid: string, cb: (points: EquitySeriesPoint[]) => void): Unsubscribe {
  const q = query(collection(db(), 'users', uid, 'equity'), orderBy('date', 'desc'), limit(120));
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs
        .map((d) => ({ date: d.get('date') as string, equity: d.get('equity') as number }))
        .filter((p) => typeof p.date === 'string' && typeof p.equity === 'number')
        .reverse(),
    );
  });
}

/* ── meta/*: Herzschlag, Config, Champion, Bericht ───────────────────────── */

/** `meta/health.engine` — was der letzte Takt über sich selbst sagt. */
export interface HealthEngine {
  at?: string;
  users?: number;
  ok?: number;
  skippedUsers?: number;
  failed?: Array<{ uid: string; error: string }>;
  fetchOk?: boolean;
  durationMs?: number;
  symbols?: number;
  /** Symbole mit Champion; null = kein Champion-Doc. */
  champion?: number | null;
  skipped?: string;
  nextOpen?: string;
  error?: string;
}

export interface HealthDoc {
  lastRunAt?: string;
  lastRunSkipped?: string | null;
  symbolsOk?: number;
  symbolsFailed?: number;
  /** Urteil des wachhund-Schedulers. */
  alarm?: { aktiv?: boolean; grund?: string; text?: string; seit?: string; at?: string };
  engine?: HealthEngine;
}

export function watchHealth(cb: (doc: HealthDoc | null) => void): Unsubscribe {
  return muxWatch(
    'health',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'health'), (snap) => emit(snap.exists() ? snap.data() : null)),
    (p) => cb(p as HealthDoc | null),
  );
}

/** Eingebautes Universum des Takts, wenn `meta/engineConfig` fehlt (functions/src/engine/config.ts). */
export const DEFAULT_UNIVERSE: readonly string[] = [
  'SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'AMD', 'TSLA',
];

/** Globaler Teil der Engine-Config (`meta/engineConfig`) — nur was die Anzeige braucht. */
export interface EngineConfigDoc {
  universe: { assetClass: string; symbols: string[] };
  timeframe: number | null;
}

export function watchEngineConfig(cb: (cfg: EngineConfigDoc | null) => void): Unsubscribe {
  return muxWatch(
    'engineConfig',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'engineConfig'), (snap) => {
        if (!snap.exists()) {
          emit(null);
          return;
        }
        const u = snap.get('universe') as unknown;
        const symbols = istObjekt(u) ? textListe(u.symbols) : [];
        emit({
          universe: {
            assetClass: istObjekt(u) && u.assetClass === 'crypto' ? 'crypto' : 'us_equity',
            symbols: symbols.length > 0 ? symbols : [...DEFAULT_UNIVERSE],
          },
          timeframe: zahlOderNull(snap.get('timeframe')),
        });
      }),
    (p) => cb(p as EngineConfigDoc | null),
  );
}

/** Ein Champion je Symbol (`meta/champion.symbols[sym]`, Format der champion.json). */
export interface ChampionEntryDoc {
  strategy: string;
  timeframe: number | null;
  score: number | null;
  oos: {
    trades: number | null;
    netProfit: number | null;
    netReturnPct: number | null;
    positiveFoldShare: number | null;
    profitFactor: number | null;
    maxDrawdownPct: number | null;
    feeShare: number | null;
  };
  gates: Array<{ name: string; pass: boolean; note: string }>;
  decidedAt: number | null;
  trials: number | null;
}

export interface NoTradeDoc {
  reason: string;
  decidedAt: number | null;
  bestScore: number | null;
}

export interface ChampionDoc {
  version: number | null;
  updatedAt: number | null;
  symbols: Record<string, ChampionEntryDoc>;
  noTrade: Record<string, NoTradeDoc>;
}

function leseChampionEntry(roh: unknown): ChampionEntryDoc | null {
  if (!istObjekt(roh) || typeof roh.strategy !== 'string') return null;
  const oos = istObjekt(roh.oos) ? roh.oos : {};
  const gates = Array.isArray(roh.gates)
    ? roh.gates.flatMap((g: unknown) =>
        istObjekt(g) && typeof g.name === 'string'
          ? [{ name: g.name, pass: g.pass === true, note: textOderNull(g.note) ?? '' }]
          : [],
      )
    : [];
  return {
    strategy: roh.strategy,
    timeframe: zahlOderNull(roh.timeframe),
    score: zahlOderNull(roh.score),
    oos: {
      trades: zahlOderNull(oos.trades),
      netProfit: zahlOderNull(oos.netProfit),
      netReturnPct: zahlOderNull(oos.netReturnPct),
      positiveFoldShare: zahlOderNull(oos.positiveFoldShare),
      profitFactor: zahlOderNull(oos.profitFactor),
      maxDrawdownPct: zahlOderNull(oos.maxDrawdownPct),
      feeShare: zahlOderNull(oos.feeShare),
    },
    gates,
    decidedAt: zahlOderNull(roh.decidedAt),
    trials: zahlOderNull(roh.trials),
  };
}

/** `meta/champion` in eine Form bringen, auf die sich die Anzeige verlassen kann. */
export function leseChampion(roh: unknown): ChampionDoc | null {
  if (!istObjekt(roh)) return null;
  const symbols: Record<string, ChampionEntryDoc> = {};
  if (istObjekt(roh.symbols)) {
    for (const [sym, e] of Object.entries(roh.symbols)) {
      const entry = leseChampionEntry(e);
      if (entry) symbols[sym] = entry;
    }
  }
  const noTrade: Record<string, NoTradeDoc> = {};
  if (istObjekt(roh.noTrade)) {
    for (const [sym, e] of Object.entries(roh.noTrade)) {
      if (!istObjekt(e)) continue;
      noTrade[sym] = {
        reason: textOderNull(e.reason) ?? '',
        decidedAt: zahlOderNull(e.decidedAt),
        bestScore: zahlOderNull(e.bestScore),
      };
    }
  }
  return {
    version: zahlOderNull(roh.version),
    updatedAt: zahlOderNull(roh.updatedAt),
    symbols,
    noTrade,
  };
}

export function watchChampion(cb: (doc: ChampionDoc | null) => void): Unsubscribe {
  return muxWatch(
    'champion',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'champion'), (snap) =>
        emit(snap.exists() ? leseChampion(snap.data()) : null),
      ),
    (p) => cb(p as ChampionDoc | null),
  );
}

export interface OptimizeReportDoc {
  date: string;
  markdown: string;
  truncated: boolean;
}

/**
 * Der jüngste Optimierer-Bericht (`meta/optimizeReports/berichte/{date}`) — einmalig
 * beim Öffnen, kein Listener: Der Bericht ändert sich einmal pro Nacht und
 * ist bis zu 900 kB groß.
 */
export async function loadOptimizeReport(): Promise<OptimizeReportDoc | null> {
  const q = query(collection(db(), ...BERICHTE_SEGMENTE), orderBy('date', 'desc'), limit(1));
  const snap = await getDocs(q);
  const d = snap.docs[0];
  if (!d) return null;
  return {
    date: textOderNull(d.get('date')) ?? d.id,
    markdown: textOderNull(d.get('markdown')) ?? '',
    truncated: d.get('truncated') === true,
  };
}

/* ── Nachrichten-Faden (Kunde ↔ Betreiber) ───────────────────────────────── */

export interface FadenNachricht {
  von: 'kunde' | 'admin';
  text: string;
  at: string;
}

/** Eigenen Faden lesen — geht auch für wartende Konten. */
export async function nachrichtenLesen(): Promise<FadenNachricht[]> {
  const r = await httpsCallable(fns(), 'nachricht')({ action: 'lesen' });
  return (r.data as { nachrichten: FadenNachricht[] }).nachrichten;
}

/** Nachricht an den Admin — die erste ist die zur Anmeldung. */
export async function nachrichtSenden(text: string): Promise<void> {
  await httpsCallable(fns(), 'nachricht')({ action: 'senden', text });
}

/* ── Admin-Verwaltung: Freischalten aus der App ──────────────────────────── */

export interface AdminUserRow {
  uid: string;
  email: string | null;
  accessLevel: AccessLevel;
  requestedAt: string | null;
  admin: boolean;
  /** Gesamt-P&L (Equity − Kapitalbasis) — dieselbe Formel wie die Performance-Karte. */
  pnl: number | null;
  pnlPct: number | null;
  equity: number | null;
  trades: number | null;
  reife: { bereit: boolean; erfuellt: number; gesamt: number; fazit: string; offeneCodes?: string[] };
  /** Zustimmung zum Risikohinweis — `null` bei Bestandskonten vor der Pflicht. */
  risiko: { version: string; at: string } | null;
  /** Broker-Abgleich (Altfeld) — `null` ohne Vermerk; sperrt weiterhin, wenn gesetzt. */
  abgleich: {
    sperre: boolean;
    fehlbestand: number;
    fremdbestand: number;
    kontoZustand: string | null;
    at: string | null;
  } | null;
}

/** Alle Konten (Wartende zuerst) — antwortet nur für Admin-Konten. */
export async function adminListUsers(): Promise<AdminUserRow[]> {
  const r = await httpsCallable(fns(), 'adminUsers')({ action: 'list' });
  return (r.data as { users: AdminUserRow[] }).users;
}

/** Zugangsstufe eines FREMDEN Kontos setzen (das eigene ist serverseitig tabu). */
export async function adminSetAccess(
  target: string,
  level: 'pending' | 'approved' | 'blocked' | 'archiviert',
): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'set', target, level });
}

/** Faden eines FREMDEN Kontos lesen (Admin). */
export async function adminNachrichten(target: string): Promise<FadenNachricht[]> {
  const r = await httpsCallable(fns(), 'adminUsers')({ action: 'nachrichten', target });
  return (r.data as { nachrichten: FadenNachricht[] }).nachrichten;
}

/** Antwort in den Faden eines FREMDEN Kontos (Admin). */
export async function adminAntworten(target: string, an: string): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'antworten', target, an });
}

/** Admin-Recht eines FREMDEN Kontos vergeben/entziehen. */
export async function adminSetAdmin(target: string, admin: boolean): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'setAdmin', target, admin });
}

export interface AdminLoeschBefund {
  ok: true;
  uid: string;
  authGeloescht: boolean;
}

/** Ein gesperrtes/archiviertes Konto ENDGÜLTIG löschen (DSGVO Art. 17) — unumkehrbar. */
export async function adminDeleteAccount(target: string, confirm: string): Promise<AdminLoeschBefund> {
  const r = await httpsCallable(fns(), 'adminUsers')({ action: 'delete', target, confirm });
  return r.data as AdminLoeschBefund;
}

/** Zustand des Echtgeld-Not-Aus — nur für Admin-Konten. */
export interface KillSwitchStatus {
  killSwitch: boolean;
  at: string | null;
  von: string | null;
}

export async function adminLiveStatus(): Promise<KillSwitchStatus> {
  const r = await httpsCallable(fns(), 'adminUsers')({ action: 'liveStatus' });
  return r.data as KillSwitchStatus;
}

/** Not-Aus setzen/lösen: friert plattformweit alle Echtgeld-Order-Pfade ein. */
export async function adminSetKillSwitch(an: boolean): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'setKillSwitch', an });
}
