/**
 * RED-TEAM (behoben): stepDays < oosDays ergab überlappende OOS-Fenster —
 * dieselben Tage zählten in mehreren Folds, oos_trades-Gate und PSR-n waren
 * künstlich aufgeblasen. Jetzt erzwingt die Config stepDays = oosDays, und die
 * OOS-Kette ist lückenlos und überlappungsfrei.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.ts';
import { DAY } from '../../src/core/time.ts';
import { buildFolds, walkForward } from '../../src/optimize/walkForward.ts';
import { mulberry32 } from '../../src/optimize/search.ts';
import { REWARD_PROFILE, dailyBars, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig } from '../optimize/fakes.ts';

describe('RED-TEAM OOS-Überlappung (Regression)', () => {
  it('Config lehnt step ≠ oos ab; die OOS-Kette ist disjunkt und lückenlos', () => {
    expect(() => parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { stepDays: 10, oosDays: 30 } })).toThrow(/stepDays/);
    const plan = buildFolds({ dataStart: 0, dataEnd: 400 * DAY, isDays: 120, oosDays: 30, stepDays: 30, holdoutDays: 60 });
    expect(plan.folds.length).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < plan.folds.length; k++) {
      expect(plan.folds[k]!.oosStart).toBe(plan.folds[k - 1]!.oosEnd);
    }
  });

  it('OOS-Trades entsprechen den eindeutigen OOS-Tagen (keine Mehrfachzählung)', () => {
    const cfg = testConfig({ optimizer: { stepDays: 30, oosDays: 30, samples: 8 } });
    const bars = dailyBars(400);
    const wfa = walkForward({
      symbol: 'AAA',
      strategy: fakeStrategy('edge'),
      bars,
      config: simConfigOf(cfg),
      optimizer: cfg.optimizer,
      initialEquity: 10_000,
      simulate: makeFakeSimulate(REWARD_PROFILE),
      rng: mulberry32(1),
    });
    const uniqueDays = new Set<number>();
    for (const f of wfa.folds) for (let t = f.fold.oosStart; t < f.fold.oosEnd; t += DAY) uniqueDays.add(t);
    // Fake: ein Trade je Tag ⇒ ehrliche Zahl = eindeutige OOS-Tage.
    expect(wfa.oos.trades).toBe(uniqueDays.size);
  });
});
