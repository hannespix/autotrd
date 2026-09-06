/**
 * Struktur-Prüfung des Alt-Payloads `{ strategy }` (Übergang).
 *
 * Nur noch das, was der Auto-Trader daraus liest: `engine.running`. Die
 * Feld-für-Feld-Prüfung des alten Schemas ist mit dem Scan gegangen — was
 * bleibt, ist die harte Ablehnung des bekannten kaputten verschachtelten
 * Alt-Alt-Schemas.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, engineRunningAus, validateStrategy } from '../src/index.js';

describe('validateStrategy (Struktur des Alt-Payloads)', () => {
  it('akzeptiert DEFAULT_STRATEGY', () => {
    expect(validateStrategy(DEFAULT_STRATEGY)).toEqual([]);
    expect(engineRunningAus(DEFAULT_STRATEGY)).toBe(false);
  });

  it('lehnt das bekannte kaputte verschachtelte Alt-Alt-Schema ab', () => {
    const legacy = {
      strategy: { type: 'confluence', parameters: {} },
      indices: [{ symbol: 'NDX' }],
      risk_management: { stop_loss: 2 },
      execution: { interval: 5 },
      engine: { running: true },
    };
    const problems = validateStrategy(legacy);
    expect(problems).toEqual([
      'val.altSchema|strategy',
      'val.altSchema|indices',
      'val.altSchema|risk_management',
      'val.altSchema|execution',
    ]);
    // Aus einem abgelehnten Payload wird NICHTS gelesen — auch kein running.
    expect(engineRunningAus(legacy)).toBeUndefined();
  });

  it('lehnt Nicht-Objekte ab', () => {
    for (const x of [null, undefined, 'yaml', 5, []]) {
      expect(validateStrategy(x)).toEqual(['val.keinObjekt']);
      expect(engineRunningAus(x)).toBeUndefined();
    }
  });

  it('engine ist Pflicht und muss ein Objekt sein', () => {
    expect(validateStrategy({ broker: DEFAULT_STRATEGY.broker })).toEqual(['val.pflichtFehlt|engine']);
    expect(validateStrategy({ engine: 'an' })).toEqual(['val.objekt|engine']);
    expect(validateStrategy({ engine: null })).toEqual(['val.objekt|engine']);
  });

  it('engine.running muss ein Boolean sein — "yes" schaltet nichts ein', () => {
    expect(validateStrategy({ engine: { running: 'yes' } })).toEqual(['val.boolean|engine.running']);
    expect(validateStrategy({ engine: {} })).toEqual(['val.boolean|engine.running']);
    expect(engineRunningAus({ engine: { running: 'yes' } })).toBeUndefined();
  });

  it('alle anderen Felder sind egal — auch kaputte Handelsparameter blockieren den Schalter nicht', () => {
    const s = structuredClone(DEFAULT_STRATEGY) as unknown as Record<string, Record<string, unknown>>;
    s.broker!.initialCapital = -5;
    s.engine!.maxOpenPositions = 999;
    s.signals!.minConfluence = 0;
    s.engine!.running = true;
    expect(validateStrategy(s)).toEqual([]);
    expect(engineRunningAus(s)).toBe(true);
    // Auch ein minimales Objekt reicht: Es wird nur ein Feld gelesen.
    expect(engineRunningAus({ engine: { running: true } })).toBe(true);
  });
});
