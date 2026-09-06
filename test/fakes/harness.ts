/**
 * Szenario-Harness für Engine-Tests: Fake-Broker, Fake-Streams, Inline-
 * Strategie, injizierte Zeit und gefangene Timer. Die Tests treiben die
 * Schleife über `engine.tick(now)` selbst — nichts läuft im Hintergrund.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type Config } from '../../src/core/config.ts';
import { homePaths, Journal, readJson, type EngineState, type HomePaths, type JournalEvent, type JournalEventKind } from '../../src/core/journal.ts';
import { setLogSink } from '../../src/core/log.ts';
import { addDays, msFromET, MIN, type CalendarDay } from '../../src/core/time.ts';
import type { Bar, Decision, Ms, Strategy } from '../../src/core/types.ts';
import type { BarStore } from '../../src/data/store.ts';
import { Engine, type ProcessEvents } from '../../src/engine/engine.ts';
import { FakeAlpaca } from './fakeAlpaca.ts';
import { FakeDataStream, FakeTradeStream } from './fakeStreams.ts';

// Tests sollen nicht das Log fluten; wer Log-Zeilen prüfen will, setzt selbst eine Senke.
setLogSink(() => undefined);

/** Dienstag, 1. September 2026 — regulärer Handelstag (Labor Day ist der 7.). */
export const DAY1 = '2026-09-01';
export const OPEN1 = msFromET(2026, 9, 1, 9, 30);
export const CLOSE1 = msFromET(2026, 9, 1, 16, 0);

/** Zehn Minuten-Schlusskurse: Bucket 09:30 schließt bei 100.15, Bucket 09:35 bei 100.37. */
export const TEN_CLOSES = [100, 100.1, 100.2, 100.1, 100.15, 100.3, 100.25, 100.35, 100.4, 100.37];

export function minuteBars(start: Ms, closes: readonly number[]): Bar[] {
  return closes.map((c, i) => ({ t: start + i * MIN, o: Number((c - 0.05).toFixed(4)), h: Number((c + 0.1).toFixed(4)), l: Number((c - 0.1).toFixed(4)), c, v: 1000 }));
}

export interface StrategyScript {
  enterAt?: number;
  exitAt?: number;
  moveStopAt?: number;
  side?: 'long' | 'short';
  holdsOvernight?: boolean;
  warmup?: number;
  stopPct?: number;
  /** null ⇒ kein Ziel. */
  targetPct?: number | null;
  id?: string;
}

/** Inline-Strategie: „enter an Bar k mit Stop = close·(1−stopPct), Ziel = close·(1+targetPct)"; optional Exit/Stop-Nachziehen an Bar n. */
export function scriptedStrategy(s: StrategyScript = {}): Strategy {
  const stopPct = s.stopPct ?? 0.02;
  const targetPct = s.targetPct === undefined ? 0.04 : s.targetPct;
  const side = s.side ?? 'long';
  return {
    id: s.id ?? 'test_enter',
    timeframes: [1, 5, 15, 1440],
    paramSpace: [],
    defaults: {},
    holdsOvernight: s.holdsOvernight ?? false,
    warmupBars: () => s.warmup ?? 1,
    precompute: () => ({}),
    decide(snap): Decision {
      const c = snap.bars.c[snap.i]!;
      if (snap.position) {
        if (s.exitAt !== undefined && snap.i >= s.exitAt) return { kind: 'exit', reason: 'script' };
        if (s.moveStopAt !== undefined && snap.i >= s.moveStopAt) {
          const stop = side === 'long' ? c * (1 - stopPct / 2) : c * (1 + stopPct / 2);
          return { kind: 'move_stop', stop, reason: 'script' };
        }
        return { kind: 'hold' };
      }
      if (s.enterAt !== undefined && snap.i >= s.enterAt) {
        const stop = side === 'long' ? c * (1 - stopPct) : c * (1 + stopPct);
        const d: Decision = { kind: 'enter', side, stop, reason: 'script' };
        if (targetPct !== null) return { ...d, target: side === 'long' ? c * (1 + targetPct) : c * (1 - targetPct) };
        return d;
      }
      return { kind: 'hold' };
    },
  };
}

/** Alle Werktage im Bereich als reguläre Handelstage (09:30–16:00). */
export function weekdayCalendar(fromDay: string, toDay: string): CalendarDay[] {
  const out: CalendarDay[] = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push({ date: d, open: '09:30', close: '16:00' });
  }
  return out;
}

export function testConfig(over: Record<string, unknown> = {}): Config {
  return parseConfig({
    universe: { symbols: ['AAPL'] },
    timeframe: 5,
    engine: { barGraceSec: 4, maxDataAgeSec: 180, maxConsecutiveErrors: 3, onOrphan: 'halt', reconcileEverySec: 60 },
    ...over,
  });
}

export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'autotrd-test-'));
}

export interface Scenario {
  home: string;
  paths: HomePaths;
  config: Config;
  fake: FakeAlpaca;
  data: FakeDataStream;
  trade: FakeTradeStream;
  engine: Engine;
  journal: Journal;
  notifications: Array<{ level: string; text: string }>;
  intervals: Array<{ fn: () => void; ms: number }>;
  now: () => Ms;
  setNow: (ms: Ms) => void;
  state: () => EngineState | null;
  events: (kind?: JournalEventKind) => JournalEvent[];
  /** Minuten-Bars über den Datenstrom einspeisen (Frische = Ende der letzten Bar). */
  pushBars: (symbol: string, bars: readonly Bar[]) => void;
}

export interface ScenarioOptions {
  config?: Config;
  strategies?: Record<string, Strategy | null>;
  defaultStrategy?: Strategy | null;
  now?: Ms;
  preload?: Record<string, Bar[]>;
  home?: string;
  benchmark?: string;
  mode?: 'paper' | 'live';
  /** Default true: Engine sofort starten. */
  start?: boolean;
  calendar?: CalendarDay[];
  fake?: FakeAlpaca;
  store?: BarStore;
  statSync?: (path: string) => unknown;
  processEvents?: ProcessEvents;
}

export async function startScenario(o: ScenarioOptions = {}): Promise<Scenario> {
  const config = o.config ?? testConfig();
  const home = o.home ?? tmpHome();
  const paths = homePaths(home);
  let now = o.now ?? OPEN1 + 10 * MIN + 5_000;
  const nowFn = () => now;
  const fake = o.fake ?? new FakeAlpaca({ mode: o.mode ?? 'paper', assetClass: config.universe.assetClass, now: nowFn });
  fake.now = nowFn;
  fake.calendarDays = o.calendar ?? (config.universe.assetClass === 'crypto' ? [] : weekdayCalendar(addDays(DAY1, -60), addDays(DAY1, 60)));
  for (const [sym, bars] of Object.entries(o.preload ?? {})) fake.bars.set(sym, bars);
  const data = new FakeDataStream();
  const trade = new FakeTradeStream();
  trade.attach(fake);
  const notifications: Array<{ level: string; text: string }> = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const defaultStrategy = o.defaultStrategy === undefined ? scriptedStrategy({ enterAt: 1 }) : o.defaultStrategy;
  const engine = new Engine({
    config,
    mode: o.mode ?? 'paper',
    home,
    client: fake,
    dataStream: data,
    tradeStream: trade,
    strategyFor: (sym) => {
      const s = o.strategies && sym in o.strategies ? o.strategies[sym] : defaultStrategy;
      return s ? { strategy: s, params: {} } : null;
    },
    benchmarkSymbol: o.benchmark,
    notify: async (level, text) => {
      notifications.push({ level, text });
    },
    now: nowFn,
    timers: {
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms });
        return intervals.length;
      },
      clearInterval: () => undefined,
    },
    sleep: async () => undefined,
    store: o.store,
    statSync: o.statSync,
    processEvents: o.processEvents,
  });
  const journal = new Journal(paths.journal);
  const sc: Scenario = {
    home,
    paths,
    config,
    fake,
    data,
    trade,
    engine,
    journal,
    notifications,
    intervals,
    now: nowFn,
    setNow: (ms) => {
      now = ms;
    },
    state: () => readJson<EngineState>(paths.state),
    events: (kind) => journal.readAll().filter((e) => kind === undefined || e.kind === kind),
    pushBars: (symbol, bars) => {
      for (const b of bars) data.push(symbol, b);
    },
  };
  if (o.start !== false) await engine.start();
  return sc;
}

/** Standardweg zu einer offenen Position: erste Entscheidungs-Bar → Bracket → Fill → Buch. */
export async function openPositionViaFill(sc: Scenario, symbol = 'AAPL', fillPrice = 100.4): Promise<void> {
  sc.pushBars(symbol, minuteBars(OPEN1, TEN_CLOSES));
  await sc.engine.tick(sc.now());
  const parent = sc.fake.openOrders(symbol).find((x) => x.orderClass === 'bracket' || x.type === 'market');
  if (!parent) throw new Error('kein Einstieg gesendet');
  sc.fake.fill(parent.id, fillPrice);
  await sc.engine.idle();
}
