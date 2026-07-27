/**
 * Datenschicht — ausschließlich Firestore (`onSnapshot`/`getDocs`) und
 * Callables; kein fetch-Polling, kein /api/* (MILESTONES M3).
 */

import {
  STRATEGY_PRESETS,
  type Position,
  type Quote,
  type Strategy,
  type StrategyDoc,
  type StrategyPreset,
  type StrategySpec,
  type Wallet,
} from '@autotrd/shared';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot as fsOnSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  documentId,
  type Unsubscribe,
} from 'firebase/firestore';

// ── Listener-Buchhaltung (M9): jeder onSnapshot läuft über diesen Wrapper,
// damit Panel-Wechsel nachweislich keine Listener leaken (E2E-Zähler).
// Der Zähler liegt in listeners.ts, weil die Supabase-Schicht denselben
// benutzt — sonst würde der Leak-Test nach der Umstellung nichts mehr messen.
import { listenerCount, trackListener } from './listeners.js';

export { listenerCount };

const onSnapshot = ((...args: Parameters<typeof fsOnSnapshot>): Unsubscribe =>
  trackListener(
    (fsOnSnapshot as (...a: unknown[]) => Unsubscribe)(...args),
  )) as typeof fsOnSnapshot;
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db } from './firebase.js';
import { muxWatch } from './mux.js';
import type { ChartBar } from './chart.js';

export interface MarketDocData {
  name?: string;
  assetClass?: string;
  quote?: Quote;
  sentiment?: SentimentField;
  forecast?: {
    points: Array<{ time: string; value: number }>;
    band: Array<{ time: string; upper: number; lower: number }>;
    w: number;
    lookback: number;
    predictedPct: number;
    sentiment: number;
    baseDate: string;
    /** Band-Kalibrierung aus realisierter Fehlerverteilung (null = ±1σ Regression). */
    calib?: { s: number; maePct: number; n: number } | null;
  } | null;
  /** Kurzfrist-Prognose (nächste Stunde, 5-min-Raster) — je Scan erneuert. */
  forecastIntraday?: {
    points: Array<{ t: number; value: number }>;
    band: Array<{ t: number; upper: number; lower: number }>;
    w: number;
    lookback: number;
    predictedPct: number;
    baseT: number;
    updatedAt: string;
    calib?: { s: number; maePct: number; n: number } | null;
  } | null;
}

export interface EventDay {
  date: string;
  sentiment: number;
  label: 'bullish' | 'bearish' | 'neutral';
  count: number;
  top: Array<{ title: string; source: string; url: string; kind: string }>;
}

export function watchEvents(symbol: string, cb: (events: EventDay[]) => void): Unsubscribe {
  return muxWatch(
    `events:${symbol}`,
    (emit) => {
      const q = query(collection(db(), 'market', symbol, 'events'), orderBy(documentId()));
      return onSnapshot(q, (snap) => emit(snap.docs.map((d) => d.data())));
    },
    (p) => cb(p as EventDay[]),
  );
}

export interface NewsRow {
  title: string;
  source: string;
  url: string;
  ts: string;
  kind: string;
  sent: { sentiment: number; label: string };
}

export function watchNews(symbol: string, cb: (news: NewsRow[]) => void): Unsubscribe {
  return muxWatch(
    `news:${symbol}`,
    (emit) => {
      const q = query(
        collection(db(), 'market', symbol, 'news'),
        orderBy('published', 'desc'),
        limit(12),
      );
      return onSnapshot(q, (snap) => emit(snap.docs.map((d) => d.data())));
    },
    (p) => cb(p as NewsRow[]),
  );
}

/** KI-Tages-Doc aus market/{sym}/ai/{date} (M6b — zentral gecacht). */
export interface AiDayDoc {
  date: string;
  summary: string;
  cause: string | null;
  confidence: number | null;
  tags: Array<{ type: string; count: number }>;
  model: string | null;
  degraded: boolean;
  reason: 'no_api_key' | 'budget_exceeded' | 'ai_error' | null;
}

export function watchLatestAi(symbol: string, cb: (ai: AiDayDoc | null) => void): Unsubscribe {
  return muxWatch(
    `ai:${symbol}`,
    (emit) => {
      const q = query(collection(db(), 'market', symbol, 'ai'), orderBy('date', 'desc'), limit(1));
      return onSnapshot(q, (snap) => emit(snap.empty ? null : snap.docs[0]!.data()));
    },
    (p) => cb(p as AiDayDoc | null),
  );
}

export interface SentimentField {
  overall: number;
  label: string;
  n: number;
  topEvents?: Array<{ type: string; count: number }>;
}

/** Aggregat je (w, lookback)-Kombi — Rohmaterial des Self-Tunings. */
export interface ComboStatRow {
  n: number;
  hits: number;
  maeSum: number;
}

export interface ForecastStatsDoc {
  scored?: number;
  dirAccuracy?: number | null;
  best?: { w: number; lookback: number };
  tuningActive?: boolean;
  combos?: Record<string, ComboStatRow>;
  updatedAt?: string;
}

export function watchForecastStats(cb: (stats: ForecastStatsDoc | null) => void): Unsubscribe {
  return muxWatch(
    'forecastStats',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'forecastStats'), (snap) =>
        emit(snap.exists() ? snap.data() : null),
      ),
    (p) => cb(p as ForecastStatsDoc | null),
  );
}

/** Kurzfrist-Lernstatistik (meta/forecastStatsIntraday) — gleiche Struktur. */
export function watchForecastStatsIntraday(
  cb: (stats: ForecastStatsDoc | null) => void,
): Unsubscribe {
  return muxWatch(
    'forecastStatsIntraday',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'forecastStatsIntraday'), (snap) =>
        emit(snap.exists() ? snap.data() : null),
      ),
    (p) => cb(p as ForecastStatsDoc | null),
  );
}

/** Bewertete Shadow-Prognose (market/{sym}/forecasts) fürs Prognose-Labor. */
export interface EvaluatedForecastRow {
  baseDate: string;
  w: number;
  lookback: number;
  predictedPct: number;
  evaluated: boolean;
  evaluatedAt?: string;
  maePct?: number;
  dirHit?: boolean;
  nPoints?: number;
}

/**
 * Letzte bewertete Prognosen eines Symbols (Vorhersage vs. Realität).
 * orderBy(evaluatedAt) filtert implizit auf bewertete Docs — unbewertete
 * haben das Feld nicht und fehlen im Index (kein Composite-Index nötig).
 */
export function watchEvaluatedForecasts(
  symbol: string,
  cb: (rows: EvaluatedForecastRow[]) => void,
): Unsubscribe {
  return muxWatch(
    `fclab:${symbol}`,
    (emit) => {
      const q = query(
        collection(db(), 'market', symbol, 'forecasts'),
        orderBy('evaluatedAt', 'desc'),
        limit(8),
      );
      return onSnapshot(q, (snap) => emit(snap.docs.map((d) => d.data())));
    },
    (p) => cb(p as EvaluatedForecastRow[]),
  );
}

export interface SignalRow {
  direction: 'buy' | 'sell' | 'hold';
  buyVotes: number;
  sellVotes: number;
  requiredConfluence: number;
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger', 'buy' | 'sell' | 'hold'>>;
  price: number;
  at: string;
  /** Genauigkeitsgewichtetes Prognose-Stimmgewicht dieses Scans (Teil 4). */
  forecastVote?: { base: number; weight: number; factor: number | null };
}

export interface IndicatorRow {
  rsi: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  bollinger: { upper: number; middle: number; lower: number; pctB: number } | null;
}

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

/** Profil (users/{uid}) serverseitig anlegen, falls es noch fehlt. */
export async function ensureProfile(): Promise<void> {
  await httpsCallable(fns(), 'ensureProfile')({});
}

/** Strategie serverseitig validieren + speichern (flaches Schema). */
export async function saveStrategy(strategy: Strategy): Promise<void> {
  await httpsCallable(fns(), 'saveStrategy')({ strategy });
}

export function watchMarketDoc(
  symbol: string,
  cb: (data: MarketDocData | null) => void,
): Unsubscribe {
  return muxWatch(
    `marketDoc:${symbol}`,
    (emit) =>
      onSnapshot(doc(db(), 'market', symbol), (snap) => emit(snap.exists() ? snap.data() : null)),
    (p) => cb(p as MarketDocData | null),
  );
}

export function watchBars(symbol: string, cb: (bars: ChartBar[]) => void): Unsubscribe {
  return muxWatch(
    `bars:${symbol}`,
    (emit) => {
      const q = query(collection(db(), 'market', symbol, 'bars'), orderBy(documentId()));
      return onSnapshot(q, (snap) =>
        emit(snap.docs.map((d) => ({ date: d.id, ...(d.data() as Omit<ChartBar, 'date'>) }))),
      );
    },
    (p) => cb(p as ChartBar[]),
  );
}

// Achtung: Firestore unterstützt KEINE absteigenden Key-Scans
// (orderBy(documentId(), 'desc')) — deshalb sortieren beide Queries über
// echte Felder (`at` bzw. `date`), die der Scan mitschreibt.
export function watchLatestSignal(
  symbol: string,
  cb: (sig: SignalRow | null) => void,
): Unsubscribe {
  return muxWatch(
    `signal:${symbol}`,
    (emit) => {
      const q = query(
        collection(db(), 'market', symbol, 'signals'),
        orderBy('at', 'desc'),
        limit(1),
      );
      return onSnapshot(q, (snap) => emit(snap.empty ? null : snap.docs[0]!.data()));
    },
    (p) => cb(p as SignalRow | null),
  );
}

export function watchLatestIndicators(
  symbol: string,
  cb: (row: IndicatorRow | null) => void,
): Unsubscribe {
  return muxWatch(
    `indicators:${symbol}`,
    (emit) => {
      const q = query(
        collection(db(), 'market', symbol, 'indicators'),
        orderBy('date', 'desc'),
        limit(1),
      );
      return onSnapshot(q, (snap) => emit(snap.empty ? null : snap.docs[0]!.data()));
    },
    (p) => cb(p as IndicatorRow | null),
  );
}

/** Optionale UI-Elemente (Options-Modal ⚙, settings.ui) — synct über Geräte. */
export interface UiPrefs {
  /** Prognose-Pfeil ✏ — Opt-in (Feedback 25.07.): default AUS, gilt auch für den Scan-Vote. */
  predArrow?: boolean;
  /** Vergleichs-Overlay-Eingabe im Chart (default an). */
  cmpOverlay?: boolean;
  /** Multi-Chart-Raster-Umschalter 1/2/4 (default an). */
  chartGrid?: boolean;
  /** Indikator-Extras: VWAP-Chip + RSI/MACD-Unterpanels (default an). */
  subPanels?: boolean;
  /** Marktgruppen-Filter (Taschenmesser Teil 2): Klassen-Key → sichtbar?
   *  Fehlender Eintrag = sichtbar (Opt-out-Filter, default alles an). */
  marketGroups?: Record<string, boolean>;
}

export function watchUserDoc(
  uid: string,
  cb: (data: {
    strategy: Strategy | null;
    wallet: Wallet | null;
    /** Nutzer-Hotkeys (M9, settings.hotkeys) — z. B. { palette, buy, sell }. */
    hotkeys: Record<string, string> | null;
    ui: UiPrefs | null;
    /** Auto-Tuner-Schalter (MT5). Fehlt das Feld, ist der Tuner AN. */
    autoTune: boolean;
  }) => void,
): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid), (snap) => {
    cb({
      strategy: (snap.get('settings.strategy') as Strategy | undefined) ?? null,
      wallet: (snap.get('wallet') as Wallet | undefined) ?? null,
      hotkeys: (snap.get('settings.hotkeys') as Record<string, string> | undefined) ?? null,
      ui: (snap.get('settings.ui') as UiPrefs | undefined) ?? null,
      // Dieselbe Default-Regel wie im Scheduler (`!== false`): Wer nie etwas
      // eingestellt hat, bekommt die Selbstverbesserung — abstellen ist eine
      // bewusste Entscheidung, nicht der Zufall eines fehlenden Feldes.
      autoTune: snap.get('settings.autoTune') !== false,
    });
  });
}

/** UI-Präferenzen speichern — Rules erlauben Owner-Updates nur aufs settings-Feld. */
export async function saveUiPrefs(uid: string, ui: UiPrefs): Promise<void> {
  await updateDoc(doc(db(), 'users', uid), { 'settings.ui': ui });
}

/** Auto-Tuner an-/abschalten (MT5) — dasselbe Feld, das `tuneAll` prüft. */
export async function saveAutoTune(uid: string, on: boolean): Promise<void> {
  await updateDoc(doc(db(), 'users', uid), { 'settings.autoTune': on });
}

export function watchPositions(uid: string, cb: (positions: Position[]) => void): Unsubscribe {
  return onSnapshot(collection(db(), 'users', uid, 'positions'), (snap) => {
    cb(snap.docs.map((d) => d.data() as Position));
  });
}

export interface TradeRow {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  executedAt: string;
  source: 'engine' | 'manual';
  pnl?: number;
  riskExit?: string;
}

export function watchTrades(uid: string, cb: (trades: TradeRow[]) => void): Unsubscribe {
  const q = query(
    collection(db(), 'users', uid, 'trades'),
    orderBy('at', 'desc'),
    limit(40),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as TradeRow));
  });
}

/* ── Portfolio-Kennzahlen (M12): schreibt NUR der tägliche snapshotEquity-
   Scheduler — das Dashboard liest genau ein Stats-Doc + die Equity-Serie. ── */

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
  bySymbol: Record<string, { pnl: number; n: number }>;
  byClass: Record<string, { pnl: number; n: number }>;
  /**
   * Ausstiegsgründe (MT1): stop_loss · take_profit · trailing_stop · signal.
   * Steht fast alles unter `signal`, sind Stop und Take reine Dekoration —
   * dann entscheidet nicht die Risikosteuerung, sondern eine gekippte
   * Indikator-Stimme über das Ergebnis.
   */
  exits?: Record<string, { n: number; pnl: number; wins: number }>;
  /** Kostenprofil (MT1) — hat die Strategie Luft über der Reibung? */
  costs?: {
    n: number;
    fees: number;
    grossPnl: number;
    feeSharePct: number | null;
    avgWinGrossPct: number | null;
    avgLossGrossPct: number | null;
    roundTripPct: number | null;
    edgeOverCost: number | null;
  };
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

export function watchEquitySeries(
  uid: string,
  cb: (points: EquitySeriesPoint[]) => void,
): Unsubscribe {
  const q = query(
    collection(db(), 'users', uid, 'equity'),
    orderBy('date', 'desc'),
    limit(120),
  );
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs
        .map((d) => ({ date: d.get('date') as string, equity: d.get('equity') as number }))
        .reverse(),
    );
  });
}

/**
 * Eintrag im Änderungs-Journal des Auto-Tuners (MT5).
 *
 * Es steht bewusst JEDE Prüfung drin, auch die abgelehnten: Ein Journal, das
 * nur Erfolge zeigt, verschweigt das Interessante — wie viele Ideen
 * ausprobiert und verworfen wurden, und woran es lag.
 */
export interface TuneLogRow {
  at: string;
  variantId: string;
  /** Klartext: „Mindest-Haltedauer 60 → 120". */
  change: string;
  reason: string;
  promoted: boolean;
  p: number | null;
  edge: number;
  nCandidate: number;
  nIncumbent: number;
}

export function watchTuneLog(uid: string, cb: (rows: TuneLogRow[]) => void): Unsubscribe {
  const q = query(collection(db(), 'users', uid, 'tuneLog'), orderBy('at', 'desc'), limit(24));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data() as TuneLogRow)));
}

/**
 * Stand EINER Variante der Schatten-Flotte.
 *
 * Ohne diese Zeile zeigte das Journal nur fertige Urteile — und ein Urteil,
 * das „zu wenig Evidenz" lautet, wäre ohne den Fortschritt unlesbar: Man
 * sähe nicht, ob eine Variante gerade erst angefangen hat oder seit Wochen
 * kaum handelt (was selbst schon ein Befund ist).
 */
export interface TuneFleetRow {
  id: string;
  /** Abgeschlossene Schatten-Trades — die Stichprobe des Vergleichs. */
  trades: number;
  /** Summe der Ergebnisse dieser Trades. */
  pnl: number;
  /** Aktuell offene Schatten-Positionen. */
  open: number;
  startedAt: string;
}

interface FleetVariantDoc {
  book?: { positions?: Record<string, unknown> };
  pnls?: number[];
  startedAt?: string;
}

export function watchTuneFleet(uid: string, cb: (rows: TuneFleetRow[]) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid, 'tuning', 'fleet'), (snap) => {
    const variants = (snap.get('variants') as Record<string, FleetVariantDoc> | undefined) ?? {};
    cb(
      Object.entries(variants)
        .map(([id, v]) => {
          const pnls = v.pnls ?? [];
          return {
            id,
            trades: pnls.length,
            pnl: pnls.reduce((a, b) => a + b, 0),
            open: Object.keys(v.book?.positions ?? {}).length,
            startedAt: v.startedAt ?? '',
          };
        })
        .sort((a, b) => b.trades - a.trades || a.id.localeCompare(b.id)),
    );
  });
}

/** Manueller Paper-Trade über das trade-Callable (Preis kommt vom Server). */
export async function callTrade(input: {
  symbol: string;
  side: 'buy' | 'sell';
  qty?: number;
}): Promise<void> {
  await httpsCallable(fns(), 'trade')(input);
}

export interface UniverseEntry {
  symbol: string;
  name: string;
}
export interface UniverseClass {
  label: string;
  groups: Record<string, UniverseEntry[]>;
}

/** Katalog aus meta/universe (einmalig; ändert sich praktisch nie). */
export async function loadUniverse(): Promise<Record<string, UniverseClass> | null> {
  const snap = await getDoc(doc(db(), 'meta', 'universe'));
  if (!snap.exists()) return null;
  return (snap.data() as { classes: Record<string, UniverseClass> }).classes;
}

/* ── Workspace-Persistenz (M9): users/{uid}/workspaces/{wsId} ── */

export interface WorkspaceDocData {
  preset: string;
  /** Panel-Sichtbarkeit + Reihenfolge (id → {hidden, order}); fehlend = sichtbar,
   *  Reihenfolge = DOM-Default (Taschenmesser Teil 3: Module per Drag sortieren). */
  panels: Record<string, { hidden?: boolean; order?: number }>;
  /** Link-Gruppen der verlinkbaren Panels (chart/news → 'A'|'B'|'C'). */
  groups: Record<string, string>;
  /** Zuletzt aktives Symbol je Link-Gruppe. */
  symbols: Record<string, string>;
  updatedAt: string;
}

export async function loadWorkspace(uid: string): Promise<WorkspaceDocData | null> {
  const snap = await getDoc(doc(db(), 'users', uid, 'workspaces', 'default'));
  return snap.exists() ? (snap.data() as WorkspaceDocData) : null;
}

export async function saveWorkspace(uid: string, data: WorkspaceDocData): Promise<void> {
  await setDoc(doc(db(), 'users', uid, 'workspaces', 'default'), data);
}

/** Quotes aller vorhandenen market/**-Docs (für die Markt-Übersicht). */
export async function loadMarketQuotes(): Promise<Map<string, MarketDocData>> {
  const snap = await getDocs(collection(db(), 'market'));
  const map = new Map<string, MarketDocData>();
  for (const d of snap.docs) map.set(d.id, d.data() as MarketDocData);
  return map;
}

/** Tiefe Historie (Chart-Audit 2): EIN Jahres-Chunk market/{sym}/ohlcDaily/{JAHR}. */
export async function loadDailyChunk(symbol: string, year: number): Promise<ChartBar[]> {
  const snap = await getDoc(doc(db(), 'market', symbol, 'ohlcDaily', String(year)));
  if (!snap.exists()) return [];
  const days = (snap.data() as { days?: Record<string, { open: number; high: number; low: number; close: number; volume: number }> }).days ?? {};
  return Object.entries(days)
    .map(([date, b]) => ({ date, ...b }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Kurz-Update fürs aktive Symbol — Server schreibt den frischen Kurs in
 *  market/{sym}.quote (alle Clients sehen ihn via onSnapshot). */
export async function callQuoteNow(symbol: string): Promise<void> {
  await httpsCallable(fns(), 'quoteNow')({ symbol });
}

/** Ein-Schuss-Blick auf Wallet + Startkapital + offene Positionen (A/B-Duell). */
export async function loadWalletSnapshot(
  uid: string,
): Promise<{ balance: number; initialCapital: number; positions: Position[] }> {
  const [userSnap, posSnap] = await Promise.all([
    getDoc(doc(db(), 'users', uid)),
    getDocs(collection(db(), 'users', uid, 'positions')),
  ]);
  return {
    balance: (userSnap.get('wallet.paperBalance') as number | undefined) ?? 0,
    initialCapital: (userSnap.get('settings.strategy.broker.initialCapital') as number | undefined) ?? 25_000,
    positions: posSnap.docs.map((d) => d.data() as Position),
  };
}

/* ── Strategie-Studio (M10): users/{uid}/strategies + Presets + Callables ── */

export interface StrategyRow {
  id: string;
  doc: StrategyDoc;
}

export function watchStrategies(uid: string, cb: (rows: StrategyRow[]) => void): Unsubscribe {
  const q = query(collection(db(), 'users', uid, 'strategies'), orderBy('updatedAt', 'desc'));
  return onSnapshot(q, (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, doc: d.data() as StrategyDoc }))),
  );
}

/** Presets aus meta/strategyPresets (vom Scan geseedet; Fallback: shared). */
export async function loadStrategyPresets(): Promise<StrategyPreset[]> {
  try {
    const snap = await getDoc(doc(db(), 'meta', 'strategyPresets'));
    if (snap.exists()) return (snap.data() as { presets: StrategyPreset[] }).presets;
  } catch {
    /* Rules/Netz — Fallback unten */
  }
  return STRATEGY_PRESETS;
}

export async function callSaveStrategyDraft(input: {
  id?: string;
  name: string;
  spec: StrategySpec;
}): Promise<string> {
  const res = await httpsCallable(fns(), 'saveStrategyDraft')(input);
  return (res.data as { id: string }).id;
}

/** Strategie endgültig löschen — auch publizierte (Owner-Frage 26.07.). */
export async function callDeleteStrategy(id: string): Promise<void> {
  await httpsCallable(fns(), 'deleteStrategy')({ id });
}

export async function callPublishStrategy(id: string): Promise<number> {
  const res = await httpsCallable(fns(), 'publishStrategyVersion')({ id });
  return (res.data as { version: number }).version;
}

export async function callAssignStrategy(
  id: string,
  symbols: string[],
  mode: 'paper' | 'shadow' = 'paper',
): Promise<void> {
  await httpsCallable(fns(), 'assignStrategy')({ id, symbols, mode });
}

/** Befördern (M11 A/B): Shadow → paper; überlappende Paper-Strategien → shadow. */
export async function callPromoteStrategy(id: string): Promise<string[]> {
  const res = await httpsCallable(fns(), 'promoteStrategy')({ id });
  return (res.data as { demoted: string[] }).demoted;
}

export interface ShadowSignalRow {
  id: string;
  symbol: string;
  direction: 'buy' | 'sell';
  price: number;
  at: string;
}

/** Hätte-Feed: letzte Shadow-Signale, neueste zuerst. Sortiert übers
 *  `at`-Feld — absteigende Scans über die Doc-ID erlaubt Firestore nicht. */
export async function loadShadowSignals(uid: string, strategyId: string, max = 20): Promise<ShadowSignalRow[]> {
  const snap = await getDocs(
    query(
      collection(db(), 'users', uid, 'strategies', strategyId, 'shadowSignals'),
      orderBy('at', 'desc'),
      limit(max),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ShadowSignalRow, 'id'>) }));
}

export interface BacktestRunDoc {
  symbol: string;
  specSource: 'compiled' | 'draft';
  totalReturnPct: number;
  buyHoldPct: number;
  numTrades: number;
  winRatePct: number;
  maxDrawdownPct: number;
  sharpe: number;
  equityCurve: Array<{ date: string; value: number }>;
  barsFrom: string;
  barsTo: string;
  at: string;
}

export async function callRunBacktest(strategyId: string, symbol: string): Promise<void> {
  await httpsCallable(fns(), 'runBacktest')({ strategyId, symbol });
}

/** Parameter-Sweep (M11): ≤2 Achsen, ≤60 Kombis — Ergebnis kommt direkt zurück. */
export interface SweepRow {
  x: number;
  y: number | null;
  totalReturnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  numTrades: number;
  winRatePct: number;
}
export interface SweepResult {
  rows: SweepRow[];
  best: SweepRow;
  /** Serverseitig kompilierte Spec des Siegers — für „Als Entwurf übernehmen". */
  bestSpec: StrategySpec;
  combos: number;
  barsFrom: string;
  barsTo: string;
}
export async function callRunSweep(req: {
  symbol: string;
  xParam: string;
  xValues: number[];
  yParam?: string;
  yValues?: number[];
}): Promise<SweepResult> {
  const res = await httpsCallable(fns(), 'runSweep')(req);
  return res.data as SweepResult;
}

/** Jüngster Backtest-Report einer Strategie (M11, onSnapshot). */
export function watchLatestRun(
  uid: string,
  strategyId: string,
  cb: (run: BacktestRunDoc | null) => void,
): Unsubscribe {
  const q = query(
    collection(db(), 'users', uid, 'strategies', strategyId, 'runs'),
    orderBy('at', 'desc'),
    limit(1),
  );
  return onSnapshot(q, (snap) => cb(snap.empty ? null : (snap.docs[0]!.data() as BacktestRunDoc)));
}

/** Aktive User-Prognose (Chart-Pfeil) eines Symbols — null wenn keine. */
export async function loadPrediction(
  uid: string,
  symbol: string,
): Promise<import('@autotrd/shared').UserPrediction | null> {
  const snap = await getDoc(doc(db(), 'users', uid, 'predictions', symbol));
  return snap.exists() ? (snap.data() as import('@autotrd/shared').UserPrediction) : null;
}

export async function callSavePrediction(input: {
  symbol: string;
  targetPrice?: number;
  targetDate?: string;
  confidence?: number;
  basePrice?: number;
  clear?: boolean;
}): Promise<void> {
  await httpsCallable(fns(), 'savePrediction')(input);
}

/** Bars einmalig für die Studio-Vorschau (gecachte Tages-Bars, aufsteigend). */
export async function loadBarsOnce(symbol: string): Promise<ChartBar[]> {
  const q = query(collection(db(), 'market', symbol, 'bars'), orderBy(documentId()));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ date: d.id, ...(d.data() as Omit<ChartBar, 'date'>) }));
}

/** 5m-Intraday-Bars der letzten N Handelstage aus market/{sym}/ohlc5m
 *  (Chunk-Doc je ET-Tag; Chart-Feedback 24.07.: „minutengenaue Daten"). */
export async function loadIntraday(
  symbol: string,
  days: number,
): Promise<import('./chart.js').IntradayChartBar[]> {
  const q = query(collection(db(), 'market', symbol, 'ohlc5m'), orderBy(documentId()));
  const snap = await getDocs(q);
  const chunks = snap.docs.slice(-Math.max(days, 1));
  const out: import('./chart.js').IntradayChartBar[] = [];
  for (const d of chunks) {
    const data = d.data() as { bars?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };
    for (const b of data.bars ?? []) {
      out.push({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    }
  }
  return out;
}

/** Event-Tage einmalig (Sentiment + Tags je Datum) für die Vorschau. */
export async function loadEventsOnce(
  symbol: string,
): Promise<Map<string, { sentiment: number | null; tags: string[] }>> {
  const snap = await getDocs(collection(db(), 'market', symbol, 'events'));
  const map = new Map<string, { sentiment: number | null; tags: string[] }>();
  for (const d of snap.docs) {
    const data = d.data() as { sentiment?: number; topEvents?: string[] };
    map.set(d.id, { sentiment: data.sentiment ?? null, tags: data.topEvents ?? [] });
  }
  return map;
}
