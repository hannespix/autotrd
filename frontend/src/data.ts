/**
 * Datenschicht — ausschließlich Firestore (`onSnapshot`/`getDocs`) und
 * Callables; kein fetch-Polling, kein /api/* (MILESTONES M3).
 */

import type { Position, Quote, Strategy, Wallet } from '@autotrd/shared';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  documentId,
  type Unsubscribe,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db } from './firebase.js';
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
  const q = query(collection(db(), 'market', symbol, 'events'), orderBy(documentId()));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as EventDay));
  });
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
  const q = query(
    collection(db(), 'market', symbol, 'news'),
    orderBy('published', 'desc'),
    limit(12),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as NewsRow));
  });
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
  return onSnapshot(doc(db(), 'meta', 'forecastStats'), (snap) => {
    cb(snap.exists() ? (snap.data() as ForecastStatsDoc) : null);
  });
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
  return onSnapshot(doc(db(), 'market', symbol), (snap) => {
    cb(snap.exists() ? (snap.data() as MarketDocData) : null);
  });
}

export function watchBars(symbol: string, cb: (bars: ChartBar[]) => void): Unsubscribe {
  const q = query(collection(db(), 'market', symbol, 'bars'), orderBy(documentId()));
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs.map((d) => ({
        date: d.id,
        ...(d.data() as Omit<ChartBar, 'date'>),
      })),
    );
  });
}

// Achtung: Firestore unterstützt KEINE absteigenden Key-Scans
// (orderBy(documentId(), 'desc')) — deshalb sortieren beide Queries über
// echte Felder (`at` bzw. `date`), die der Scan mitschreibt.
export function watchLatestSignal(
  symbol: string,
  cb: (sig: SignalRow | null) => void,
): Unsubscribe {
  const q = query(
    collection(db(), 'market', symbol, 'signals'),
    orderBy('at', 'desc'),
    limit(1),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.empty ? null : (snap.docs[0]!.data() as SignalRow));
  });
}

export function watchLatestIndicators(
  symbol: string,
  cb: (row: IndicatorRow | null) => void,
): Unsubscribe {
  const q = query(
    collection(db(), 'market', symbol, 'indicators'),
    orderBy('date', 'desc'),
    limit(1),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.empty ? null : (snap.docs[0]!.data() as IndicatorRow));
  });
}

export function watchUserDoc(
  uid: string,
  cb: (data: { strategy: Strategy | null; wallet: Wallet | null }) => void,
): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid), (snap) => {
    cb({
      strategy: (snap.get('settings.strategy') as Strategy | undefined) ?? null,
      wallet: (snap.get('wallet') as Wallet | undefined) ?? null,
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

/** Quotes aller vorhandenen market/**-Docs (für die Markt-Übersicht). */
export async function loadMarketQuotes(): Promise<Map<string, MarketDocData>> {
  const snap = await getDocs(collection(db(), 'market'));
  const map = new Map<string, MarketDocData>();
  for (const d of snap.docs) map.set(d.id, d.data() as MarketDocData);
  return map;
}
