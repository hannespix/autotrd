/**
 * Datenschicht — ausschließlich Firestore (`onSnapshot`/`getDocs`) und
 * Callables; kein fetch-Polling, kein /api/* (MILESTONES M3).
 */

import {
  type Position,
  type Quote,
  type Strategy,
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
  forecast?: {
    points: Array<{ time: string; value: number }>;
    band: Array<{ time: string; upper: number; lower: number }>;
    lookback: number;
    predictedPct: number;
    baseDate: string;
    /** Band-Kalibrierung aus realisierter Fehlerverteilung (null = ±1σ Regression). */
    calib?: { s: number; maePct: number; n: number } | null;
  } | null;
  /** Kurzfrist-Prognose (nächste Stunde, 5-min-Raster) — je Scan erneuert. */
  forecastIntraday?: {
    points: Array<{ t: number; value: number }>;
    band: Array<{ t: number; upper: number; lower: number }>;
    lookback: number;
    predictedPct: number;
    baseT: number;
    updatedAt: string;
    calib?: { s: number; maePct: number; n: number } | null;
  } | null;
}

/** Aggregat je Lookback-Fenster — Rohmaterial des Self-Tunings. */
export interface ComboStatRow {
  n: number;
  hits: number;
  maeSum: number;
}

export interface ForecastStatsDoc {
  scored?: number;
  dirAccuracy?: number | null;
  best?: { lookback: number };
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

/** Was die Engine im letzten Scan angefasst hat — zwei Tiefen, eine Quelle. */
export interface WatchScope {
  /** Tief analysiert: 5-min-Kerzen, Indikatoren, Prognose, Handelsentscheidung. */
  symbols: string[];
  /** Katalog-Symbole mit offenem Markt in diesem Scan. */
  catalogOpen: number;
  /** Davon frisch bekurst (Spark-Bündel). Weicht ab ⇒ ein Chunk hat gepatzt. */
  catalogQuotes: number;
}

/**
 * Die Symbole, die die Engine gerade beobachtet und handelt.
 *
 * Quelle ist der Heartbeat des Scans, nicht eine gespeicherte Auswahl: Was
 * das Dashboard zeigt, MUSS das sein, was die Engine tatsächlich anfasst.
 * Bis 28.07. war es eine handverlesene Watchlist — die Anzeige konnte also
 * Symbole zeigen, die längst nicht mehr gehandelt wurden, und umgekehrt.
 *
 * `symbols` ist dabei nur die TIEFE Stufe. Kurse bekommt seit dem
 * Batch-Umbau der ganze Katalog bei jedem Scan (Owner-Frage: „kann das tool
 * nicht alles immer parallel beobachten?"); `catalogOpen`/`catalogQuotes`
 * machen das sichtbar, statt es dem Nutzer als „nur xx Symbole" zu zeigen.
 */
export function watchWatchedSymbols(cb: (scope: WatchScope) => void): Unsubscribe {
  return muxWatch(
    'watched',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'health'), (snap) =>
        emit(
          snap.exists()
            ? {
                symbols: (snap.get('watched') as string[] | undefined) ?? [],
                catalogOpen: (snap.get('catalogOpen') as number | undefined) ?? 0,
                catalogQuotes: (snap.get('catalogQuotes') as number | undefined) ?? 0,
              }
            : { symbols: [], catalogOpen: 0, catalogQuotes: 0 },
        ),
      ),
    (p) => cb(p as WatchScope),
  );
}

/** Bewertete Shadow-Prognose (market/{sym}/forecasts) fürs Prognose-Labor. */
export interface EvaluatedForecastRow {
  baseDate: string;
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
 * Tages-Stand des Momentum-Rankings (meta/momentum).
 *
 * Öffentlich lesbar wie alle meta-Dokumente: Das Ranking ist keine
 * Nutzerdatei, sondern eine Eigenschaft des Marktes — und es kostet keinen
 * zusätzlichen Read, wenn alle dieselbe Zeile lesen.
 */
export interface MomentumDoc {
  at: string;
  date: string;
  /** Bewertbare Symbole (mit genug Historie) von `universum` insgesamt. */
  ranked: number;
  universum: number;
  /** Marktfilter: steht der Leitindex über seiner 200-Tage-Linie? */
  marktOffen: boolean;
  top: Array<{ symbol: string; score: number }>;
  ziel: string[];
  gehalten: string[];
  equity: number;
  trades: number;
  rebalanced: boolean;
  fehlendeHistorie: number;
}

export function watchMomentum(cb: (doc: MomentumDoc | null) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'meta', 'momentum'), (snap) =>
    cb(snap.exists() ? (snap.data() as MomentumDoc) : null),
  );
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

