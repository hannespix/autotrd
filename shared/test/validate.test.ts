import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, isStrategy, validateStrategy } from '../src/index.js';

describe('validateStrategy (flaches Schema, CLAUDE.md §2)', () => {
  it('akzeptiert DEFAULT_STRATEGY', () => {
    expect(validateStrategy(DEFAULT_STRATEGY)).toEqual([]);
    expect(isStrategy(DEFAULT_STRATEGY)).toBe(true);
  });

  it('lehnt das bekannte kaputte verschachtelte Alt-Schema ab', () => {
    const legacy = {
      strategy: { type: 'confluence', parameters: {} },
      indices: [{ symbol: 'NDX' }],
      risk_management: { stop_loss: 2 },
      execution: { interval: 5 },
    };
    const problems = validateStrategy(legacy);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/Alt-Schema/);
    expect(isStrategy(legacy)).toBe(false);
  });

  it('meldet fehlende Pflichtschlüssel', () => {
    const problems = validateStrategy({ broker: DEFAULT_STRATEGY.broker });
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining("'watchlist' fehlt")]),
    );
  });

  it('lehnt Nicht-Objekte ab', () => {
    expect(validateStrategy(null)).toHaveLength(1);
    expect(validateStrategy('yaml')).toHaveLength(1);
    expect(validateStrategy([])).toHaveLength(1);
  });

  it('prüft Feldtypen im Detail', () => {
    const broken = structuredClone(DEFAULT_STRATEGY) as Record<string, unknown>;
    (broken.broker as Record<string, unknown>).initialCapital = -5;
    (broken.engine as Record<string, unknown>).running = 'yes';
    (broken.signals as Record<string, unknown>).minConfluence = 0;
    const problems = validateStrategy(broken);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('broker.initialCapital'),
        expect.stringContaining('engine.running'),
        expect.stringContaining('signals.minConfluence'),
      ]),
    );
  });
});
