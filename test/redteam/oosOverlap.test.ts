/**
 * RED-TEAM: stepDays < oosDays ist erlaubt (config.ts:264 verbietet nur
 * step > oos) ⇒ überlappende OOS-Fenster. aggregateOos summiert Trades und
 * verkettet Tagesrenditen je Fold ⇒ dieselben Tage zählen mehrfach:
 * oos_trades-Gate und PSR-n werden künstlich aufgeblasen.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.ts';
import { DAY } from '../../src/core/time.ts';
import { buildFolds, walkForward } from '../../src/optimize/walkForward.ts';
import { mulberry32 } from '../../src/optimize/search.ts';
import { REWARD_PROFILE, dailyBars, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig } from '../optimize/fakes.ts';

describe('RED-TEAM OOS-Überlappung', () => {
  it('Config akzeptiert step < oos; OOS-Fenster überlappen dann', () => {
    const cfg = parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { stepDays: 10, oosDays: 30 } });
    expect(cfg.optimizer.stepDays).toBe(10);
    const plan = buildFolds({ dataStart: 0, dataEnd: 400 * DAY, isDays: 120, oosDays: 30, stepDays: 10, holdoutDays: 60 });
    for (let k = 1; k < plan.folds.length; k++) {
      // Erwartet: disjunkte OOS-Kette. Beobachtet: jeder Tag liegt in 3 Folds.
      expect(plan.folds[k]!.oosStart).toBeGreaterThanOrEqual(plan.folds[k - 1]!.oosEnd);
    }
  });

  it('OOS-Trades werden dann mehrfach gezählt (Gate minOosTrades ausgehebelt)', () => {
    const cfg = testConfig({ optimizer: { stepDays: 10, oosDays: 30, samples: 8 } });
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
    // Fake: ein Trade je Tag ⇒ ehrliche Zahl = eindeutige OOS-Tage. Beobachtet: ~3×.
    expect(wfa.oos.trades).toBe(uniqueDays.size);
  });
});
