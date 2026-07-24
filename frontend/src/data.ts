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
  documentId,
  type Unsubscribe,
} from 'firebase/firestore';

// ── Listener-Buchhaltung (M9): jeder onSnapshot läuft über diesen Wrapper,
// damit Panel-Wechsel nachweislich keine Listener leaken (E2E-Zähler). ──
let activeListeners = 0;

export function listenerCount(): number {
  return activeListeners;
}

const onSnapshot = ((...args: Parameters<typeof fsOnSnapshot>): Unsubscribe => {
  activeListeners += 1;
  const unsub = (fsOnSnapshot as (...a: unknown[]) => Unsubscribe)(...args);
  let closed = false;
  return () => {
    if (!closed) {
      closed = true;
      activeListeners -= 1;
    }
    unsub();
  };
}) as typeof fsOnSnapshot;
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

export interface ForecastStatsDoc {
  scored?: number;
  dirAccuracy?: number | null;
  best?: { w: number; lookback: number };
  tuningActive?: boolean;
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

export interface SignalRow {
  direction: 'buy' | 'sell' | 'hold';
  buyVotes: number;
  sellVotes: number;
  requiredConfluence: number;
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger', 'buy' | 'sell' | 'hold'>>;
  price: number;
  at: string;
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

export function watchUserDoc(
  uid: string,
  cb: (data: {
    strategy: Strategy | null;
    wallet: Wallet | null;
    /** Nutzer-Hotkeys (M9, settings.hotkeys) — z. B. { palette, buy, sell }. */
    hotkeys: Record<string, string> | null;
  }) => void,
): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid), (snap) => {
    cb({
      strategy: (snap.get('settings.strategy') as Strategy | undefined) ?? null,
      wallet: (snap.get('wallet') as Wallet | undefined) ?? null,
      hotkeys: (snap.get('settings.hotkeys') as Record<string, string> | undefined) ?? null,
    });
  });
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
  /** Panel-Sichtbarkeit (id → hidden); fehlend = sichtbar. */
  panels: Record<string, { hidden?: boolean }>;
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

export async function callPublishStrategy(id: string): Promise<number> {
  const res = await httpsCallable(fns(), 'publishStrategyVersion')({ id });
  return (res.data as { version: number }).version;
}

export async function callAssignStrategy(id: string, symbols: string[]): Promise<void> {
  await httpsCallable(fns(), 'assignStrategy')({ id, symbols });
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
