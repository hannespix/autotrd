/**
 * RED-TEAM: Der Incumbent-Re-Score ist überwiegend IN-SAMPLE.
 *
 * finalParams eines Laufs entstehen aus der Suche auf dem finalen Fenster
 * [last.isStart, last.oosEnd) (walkForward.ts:461). Beim nächsten Lauf
 * (rollierendes lookback, +1 Tag) liegen die OOS-Fenster der letzten
 * ⌈isDays+oosDays)/step⌉ Folds fast vollständig in genau diesem Fenster.
 * `oosScoreOnFolds` (run.ts:255) und `include` (run.ts:225, Gleichstand
 * zugunsten des Incumbent) bewerten den Champion dort also auf Daten, auf
 * denen er gefittet wurde.
 *
 * Zweiter Punkt: VALIDIERUNG.md §6 verspricht „Reißt er ein Gate, verliert
 * er den Status" — run.ts prüft für den Incumbent aber NUR objectiveMedian > 0.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAY } from '../../src/core/time.ts';
import { homePaths } from '../../src/core/journal.ts';
import { emptyChampionFile, saveChampion, type ChampionEntry } from '../../src/optimize/promote.ts';
import { runOptimization } from '../../src/optimize/run.ts';
import { buildFolds } from '../../src/optimize/walkForward.ts';
import { REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig } from '../optimize/fakes.ts';

describe('RED-TEAM Incumbent', () => {
  it('OOS-Fenster des Folgelaufs dürfen nicht im finalen Suchfenster des Vorlaufs liegen', () => {
    const T0 = Date.UTC(2025, 0, 1);
    const cfg = { isDays: 120, oosDays: 30, stepDays: 30, holdoutDays: 60 };
    const prev = buildFolds({ dataStart: T0, dataEnd: T0 + 400 * DAY, ...cfg });
    const last = prev.folds[prev.folds.length - 1]!;
    const fitWindow = { start: last.isStart, end: last.oosEnd }; // Fenster der finalen Suche = Fit-Fenster des Champions
    // Nächster Lauf einen Tag später, gleiches lookback (400 Tage rollierend)
    const next = buildFolds({ dataStart: T0 + DAY, dataEnd: T0 + 401 * DAY, ...cfg });
    const contaminated = next.folds.filter((f) => {
      const overlap = Math.min(f.oosEnd, fitWindow.end) - Math.max(f.oosStart, fitWindow.start);
      return overlap / (f.oosEnd - f.oosStart) > 0.5; // > 50 % des OOS-Fensters war Fit-Daten des Incumbent
    });
    // Erwartet für einen ehrlichen Re-Score: 0 kontaminierte Folds. Beobachtet: 5 von 7.
    expect(`${contaminated.length} von ${next.folds.length} Folds`).toBe(`0 von ${next.folds.length} Folds`);
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('Incumbent, der das Gate oos_trades reißt, verliert den Status (VALIDIERUNG §6) — tut er nicht', () => {
    const home = mkdtempSync(join(tmpdir(), 'autotrd-redteam-'));
    dirs.push(home);
    const paths = homePaths(home);
    const stale: ChampionEntry = {
      strategy: 'sparse',
      params: { a: 5, b: 2 },
      timeframe: 1440,
      score: 1,
      oos: { objectiveMedian: 1, objectiveMean: 1, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
      gates: [],
      decidedAt: 1,
      trials: 1,
      dataRange: { start: 0, end: 1 },
    };
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: stale } });
    // Echte Kante, aber nur alle 10 Tage ein Trade ⇒ ~3 Trades je 30-Tage-OOS, weit unter minOosTrades=60.
    const sparse = { ...REWARD_PROFILE, barsPerTrade: 10 };
    const out = runOptimization({
      config: testConfig({ symbols: ['AAA'], home, optimizer: { strategies: ['sparse'] } }),
      symbols: ['AAA'],
      strategies: ['sparse'],
      barsFor: () => dailyBars(400),
      home,
      initialEquity: 10_000,
      simulate: makeFakeSimulate(() => sparse),
      metricsFns: fakeMetricsFns,
      getStrategy: () => fakeStrategy('sparse'),
      now: () => Date.UTC(2026, 8, 6),
    });
    const r = out.runs[0]!;
    const cand = r.results[0]!;
    const tradesGate = cand.gates.find((g) => g.name === 'oos_trades')!;
    expect(tradesGate.pass).toBe(false); // der Kandidat (= dieselben Params/Strategie) reißt das Gate …
    expect(r.incumbentRescore!).toBeGreaterThan(0); // … der Incumbent hat trotzdem einen positiven Re-Score …
    // … und darf laut Doku NICHT weiterhandeln. Beobachtet: action = 'keep', Champion bleibt.
    expect(r.decision.action).not.toBe('keep');
    expect(out.champion.symbols.AAA).toBeUndefined();
  });
});
