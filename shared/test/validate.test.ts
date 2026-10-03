import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  MAX_LEVERAGE,
  MAX_OPEN_POSITIONS_CAP,
  isStrategy,
  validateStrategy,
} from '../src/index.js';

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
    // Seit Phase 3 sind Meldungen Codes; das Frontend übersetzt (valText).
    expect(problems.join('\n')).toMatch(/val\.altSchema\|strategy/);
    expect(isStrategy(legacy)).toBe(false);
  });

  it('meldet fehlende Pflichtschlüssel', () => {
    const problems = validateStrategy({ broker: DEFAULT_STRATEGY.broker });
    expect(problems).toEqual(
      expect.arrayContaining(['val.pflichtFehlt|watchlist']),
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

describe('Hebel + Positionslimit (28.07.)', () => {
  const mitBroker = (leverage: unknown): unknown => {
    const s = structuredClone(DEFAULT_STRATEGY) as Record<string, Record<string, unknown>>;
    s.broker!.leverage = leverage;
    return s;
  };
  const mitEngine = (maxOpenPositions: unknown): unknown => {
    const s = structuredClone(DEFAULT_STRATEGY) as Record<string, Record<string, unknown>>;
    s.engine!.maxOpenPositions = maxOpenPositions;
    return s;
  };

  it('beide Felder dürfen fehlen (Altbestand bleibt gültig)', () => {
    const s = structuredClone(DEFAULT_STRATEGY) as Record<string, Record<string, unknown>>;
    delete s.broker!.leverage;
    delete s.engine!.maxOpenPositions;
    expect(validateStrategy(s)).toEqual([]);
  });

  it('gültige Hebel gehen durch', () => {
    expect(validateStrategy(mitBroker(1))).toEqual([]);
    expect(validateStrategy(mitBroker(MAX_LEVERAGE))).toEqual([]);
  });

  it('Hebel über dem Maximum wird abgelehnt', () => {
    // Wichtig, dass das schon beim SPEICHERN scheitert: Die Hülle würde ihn
    // ohnehin klemmen, aber dann zeigte die UI dauerhaft eine Zahl an, nach
    // der nie gehandelt wird.
    expect(validateStrategy(mitBroker(MAX_LEVERAGE + 1)).join()).toMatch(/leverage/);
    expect(validateStrategy(mitBroker(0)).join()).toMatch(/leverage/);
    expect(validateStrategy(mitBroker('3')).join()).toMatch(/leverage/);
  });

  it('gültige Positionslimits gehen durch', () => {
    expect(validateStrategy(mitEngine(1))).toEqual([]);
    expect(validateStrategy(mitEngine(MAX_OPEN_POSITIONS_CAP))).toEqual([]);
  });

  it('Positionslimit außerhalb der Spanne wird abgelehnt', () => {
    expect(validateStrategy(mitEngine(0)).join()).toMatch(/maxOpenPositions/);
    expect(validateStrategy(mitEngine(MAX_OPEN_POSITIONS_CAP + 1)).join()).toMatch(/maxOpenPositions/);
    expect(validateStrategy(mitEngine(null)).join()).toMatch(/maxOpenPositions/);
  });
});
