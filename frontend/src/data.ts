/**
 * Datenschicht — ausschließlich Firestore (`onSnapshot`/`getDocs`) und
 * Callables; kein fetch-Polling, kein /api/* (MILESTONES M3).
 */

import {
  type GlobalAxisStats,
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
  getDoc,
  getDocs,
  limit,
  onSnapshot as fsOnSnapshot,
  orderBy,
  query,
  setDoc,
  startAfter,
  updateDoc,
  documentId,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';

// ── Listener-Buchhaltung (M9): jeder onSnapshot läuft über diesen Wrapper,
// damit Panel-Wechsel nachweislich keine Listener leaken (E2E-Zähler).
// Der Zähler liegt in listeners.ts statt hier, damit ihn auch Module
// hochzählen können, die data.ts nicht importieren.
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
  /** News-Lage (News-Rückkehr 29.07.): Veto-Grundlage + Schlagzeilen-Anzeige. */
  news?: import('@autotrd/shared').NewsSnapshot | null;
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

/**
 * Handelshistorie, Positionen und Kennzahlen auf null — Kursdaten bleiben.
 *
 * Das Bestätigungswort geht mit auf die Leitung und wird SERVERSEITIG noch
 * einmal geprüft. Ein Client-Guard allein wäre bei einer unumkehrbaren
 * Aktion keine Sicherung, nur eine Bequemlichkeit.
 */
export async function resetWallet(confirm: string): Promise<ResetWalletResult> {
  const r = await httpsCallable(fns(), 'resetWallet')({ confirm });
  return r.data as ResetWalletResult;
}

export interface ResetWalletResult {
  ok: true;
  deleted: Record<string, number>;
  balance: number;
  resetAt: string;
}

export interface TaxReportResult {
  ok: true;
  bericht: Steuerbericht;
  csv: string;
  gelesen: number;
  historieUnvollstaendig: boolean;
}

/**
 * Jahres-Steuerbericht serverseitig rechnen lassen.
 *
 * Bewusst KEIN Client-Rechenweg: Der Bericht braucht die volle Historie
 * inklusive Archiv, und die liegt hinter den Firestore-Regeln. Ihn im Browser
 * zu rechnen hieße, alle Trades aller Jahre zu laden — teuer und langsam,
 * ohne dass der Nutzer etwas davon hätte.
 */
export async function callTaxReport(jahr: number, echtgeld: boolean): Promise<TaxReportResult> {
  const r = await httpsCallable(fns(), 'taxReport')({ jahr, echtgeld });
  return r.data as TaxReportResult;
}

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

/**
 * Zustand der Broker-Anbindung prüfen, ohne zu handeln.
 *
 * Bewusst ein reiner Lese-Aufruf: Wer die Anbindung erst beim ersten Trade
 * testet, testet sie mit Geld.
 */
export async function callBrokerStatus(): Promise<BrokerStatusResult> {
  const r = await httpsCallable(fns(), 'brokerStatus')({});
  return r.data as BrokerStatusResult;
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
    /**
     * Zugangsstufe (Owner 26.07.): 'pending' = angelegt, wartet auf
     * Freischaltung — der Scan überspringt das Konto STILL. Genau deshalb
     * muss die Oberfläche es zeigen (Fund 01.08.: „Engine fängt bei neuem
     * Konto nicht an zu handeln" — sie lief, das Konto war nur nicht frei).
     * Fehlendes Feld = Bestandskonto = freigeschaltet.
     */
    accessLevel: 'pending' | 'approved' | 'blocked';
    /** Kontotyp (Owner 02.08.): Admins sehen die Freischaltungs-Karte.
     *  Das Feld setzt NUR die Konsole bzw. das adminUsers-Callable —
     *  Client-Updates auf dem User-Doc erlauben die Rules nur für `settings`. */
    admin: boolean;
  }) => void,
): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid), (snap) => {
    const rawAccess = snap.get('accessLevel') as string | undefined;
    cb({
      accessLevel: rawAccess === 'pending' || rawAccess === 'blocked' ? rawAccess : 'approved',
      admin: snap.get('admin') === true,
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

/** Seitengröße der Historie (Owner-Wunsch 28.07.: „über Pagination nachladen
 *  damit nicht immer alle direkt geladen werden"). */
export const TRADE_PAGE = 50;

/**
 * Der LIVE-KOPF der Handelshistorie: die neuesten `pageSize` Trades.
 *
 * Bewusst gedeckelt und bewusst NICHT die ganze Historie: Ein `onSnapshot`
 * ohne Limit hielte jede Zeile dauerhaft im Speicher und im Abrechnungs-
 * zähler — bei einem System, das alle fünf Minuten handeln soll, wächst das
 * unbegrenzt. Ältere Seiten kommen über `loadMoreTrades` als EINMALIGE
 * Abfrage dazu, ohne Listener.
 *
 * Sortiert wird über `executedAt` (ISO-String): lexikografisch identisch mit
 * chronologisch, einfeldrig — also ohne zusammengesetzten Index, und
 * derselbe Schlüssel, den die Seiten-Abfrage als Cursor benutzt. Über zwei
 * verschiedene Felder zu sortieren (`at` live, `executedAt` paginiert) wäre
 * die klassische Quelle für doppelte oder übersprungene Zeilen an der Naht.
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

/**
 * Seiten-Cursor der Handelshistorie: das LETZTE Dokument der geladenen Seite,
 * nicht dessen Zeitstempel.
 *
 * Warum das wichtig ist (Owner-Fund 04.08.: „warum kann man nicht mehr weitere
 * laden?"): Ein Zeitstempel-Cursor mit `startAfter(executedAt)` springt über
 * ALLE Zeilen mit exakt diesem Wert hinweg. Der Momentum-Sockel schreibt aber
 * bis zu 38 Orders in einem Rutsch — landen davon zwei in derselben
 * Millisekunde und fällt die Seitengrenze genau dazwischen, verschwinden
 * Zeilen lautlos, und im Extremfall besteht die nächste Seite nur aus schon
 * bekannten Zeilen: Der Knopf reagiert, es passiert nur nichts Sichtbares.
 * Ein Dokument-Cursor ist in Firestore eindeutig und kennt das Problem nicht.
 */
export type TradeCursor = QueryDocumentSnapshot;

export interface TradePage {
  rows: TradeRow[];
  /** Letztes Dokument dieser Seite — Cursor für die nächste. */
  cursor: TradeCursor | null;
  /** Keine weiteren Zeilen mehr (Seite kam unvollständig zurück). */
  done: boolean;
}

/**
 * Eine ÄLTERE Seite nachladen (einmalige Abfrage, kein Listener).
 *
 * `done` wird aus einer unvollständigen Seite abgeleitet, nicht aus einer
 * zusätzlichen Zählabfrage: Kommen weniger als `pageSize` Zeilen zurück, gibt
 * es keine älteren mehr. Das spart eine Abfrage pro Klick — und `count()`
 * über eine wachsende Historie zu rechnen, nur um einen Knopf auszugrauen,
 * wäre genau die Sorte Kosten, die niemand bemerkt.
 */
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
 * Der Betriebszustand der Engine, wie ihn der Scan hinterlässt (meta/health).
 *
 * Warum das ins Dashboard gehört (Owner 04.08.: „das ist sehr langweilig
 * anzuschauen"): Seit dem 04.08. entscheiden fünf Mechaniken mit, ob ein
 * Trade zustande kommt — Regime-Ampel, Trade-Filter, News-Veto,
 * Kostenschwelle und Hebel-Ampel. Alle arbeiten unsichtbar. Ein Nutzer sieht
 * bisher nur, DASS nichts passiert, und das sieht bei einer scharfen Regel
 * genauso aus wie bei einem toten System. Diese Zahlen machen aus „es tut
 * sich nichts" ein „6 Leerverkäufe abgelehnt, weil der Markt steigt".
 */
export interface HealthDoc {
  lastScanAt?: string;
  trades?: number;
  entryGate?: Record<string, number>;
  /**
   * Richtungs-Verteilung der Signale des letzten Scans (04.08.).
   *
   * Beantwortet die Frage, die die Blockade-Zähler offenlassen: Ein Scan ohne
   * Trades kann ein ruhiger Markt sein (viel `hold`) oder einer, in dem die
   * Engine gegen den Trend wollte und gestoppt wurde (viel `sell` bei Regime
   * `trend`). Beides sieht sonst gleich aus.
   */
  signalDirs?: { buy?: number; sell?: number; hold?: number };
  konten?: Record<string, number>;
  regime?: { state?: string; vix?: number | null; realizedVolPct?: number | null; aboveSma200?: boolean | null };
  kalender?: { bevorstehend?: string | null; stundenBis?: number | null; turnOfMonth?: boolean; fomcVeraltet?: boolean };
  watched?: string[];
}

export function watchHealth(cb: (doc: HealthDoc | null) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'meta', 'health'), (snap) =>
    cb(snap.exists() ? (snap.data() as HealthDoc) : null),
  );
}

/** Auffällige Positionierungen des letzten Tageslaufs (meta/positioning). */
export interface PositioningDoc {
  at?: string;
  abgedeckt?: number;
  zustaende?: Record<string, number>;
  auffaellig?: Record<string, { state?: string; fundingAnnualPct?: number | null; oiChangePct?: number | null }>;
}

export function watchPositioning(cb: (doc: PositioningDoc | null) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'meta', 'positioning'), (snap) =>
    cb(snap.exists() ? (snap.data() as PositioningDoc) : null),
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

/**
 * Kollektives Vorwissen (`meta/tuneGlobal`) — öffentlich lesbar wie die
 * anderen `meta`-Dokumente, weil es ausschließlich Zählwerte enthält:
 * wie oft eine Einstellungs-Änderung geprüft und wie oft sie übernommen
 * wurde. Keine Trades, keine Beträge, keine Kennungen.
 */
export function watchTuneGlobal(cb: (stats: GlobalAxisStats) => void): Unsubscribe {
  return muxWatch(
    'tuneGlobal',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'tuneGlobal'), (snap) =>
        emit(snap.exists() ? ((snap.get('axes') as GlobalAxisStats | undefined) ?? {}) : {}),
      ),
    (p) => cb(p as GlobalAxisStats),
  );
}

/** Manueller Paper-Trade über das trade-Callable (Preis kommt vom Server). */
export async function callTrade(input: {
  symbol: string;
  side: 'buy' | 'sell';
  qty?: number;
}): Promise<void> {
  await httpsCallable(fns(), 'trade')(input);
}

/* ── Admin-Verwaltung (Owner 02.08.): Freischalten aus der App ── */

export interface AdminUserRow {
  uid: string;
  email: string | null;
  accessLevel: 'pending' | 'approved' | 'blocked';
  requestedAt: string | null;
  admin: boolean;
  /** Gesamt-P&L (Equity − Kapitalbasis) — dieselbe Formel wie die
   *  Performance-Karte; null ohne Wallet/Kapitalbasis. */
  pnl: number | null;
  pnlPct: number | null;
  equity: number | null;
}

/** Alle Konten (Wartende zuerst) — antwortet nur für Admin-Konten. */
export async function adminListUsers(): Promise<AdminUserRow[]> {
  const r = await httpsCallable(fns(), 'adminUsers')({ action: 'list' });
  return (r.data as { users: AdminUserRow[] }).users;
}

/** Zugangsstufe eines FREMDEN Kontos setzen (das eigene ist serverseitig tabu). */
export async function adminSetAccess(
  target: string,
  level: 'pending' | 'approved' | 'blocked',
): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'set', target, level });
}

/** Admin-Recht eines FREMDEN Kontos vergeben/entziehen. */
export async function adminSetAdmin(target: string, admin: boolean): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'setAdmin', target, admin });
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

