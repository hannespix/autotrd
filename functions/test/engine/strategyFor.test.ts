import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config.ts';
import { setLogSink } from '../../../src/core/log.ts';
import type { ChampionFile } from '../../../src/optimize/promote.ts';
import { buildStrategyFor, championFromDoc } from '../../src/engine/strategyFor.ts';

setLogSink(() => undefined);

const entry = (strategy: string, timeframe: 5 | 15 = 5, params: Record<string, number> = {}) => ({
  strategy,
  params,
  timeframe,
  score: 1,
  oos: {} as ChampionFile['symbols'][string]['oos'],
  gates: [],
  decidedAt: 1,
  trials: 1,
  dataRange: {} as ChampionFile['symbols'][string]['dataRange'],
});

describe('Champion ⇒ strategyFor', () => {
  it('Champion hat Vorrang, noTrade ist null, unbekannte Symbole ohne Freigabe null', () => {
    const config = parseConfig({ universe: { symbols: ['AAPL', 'MSFT', 'NVDA'] }, timeframe: 5 });
    const champion = championFromDoc({ version: 1, updatedAt: 1, symbols: { AAPL: entry('trend_donchian', 5, { entryLookback: 30 }) }, noTrade: { MSFT: { reason: 'x', decidedAt: 1, bestScore: null } } })!;
    const m = buildStrategyFor({ champion, config });
    expect(m.source).toBe('champion');
    expect(m.tradable).toEqual(['AAPL']);
    const aapl = m.fn('AAPL')!;
    expect(aapl.strategy.id).toBe('trend_donchian');
    expect(aapl.params.entryLookback).toBe(30);
    expect(m.fn('MSFT')).toBeNull();
    expect(m.fn('NVDA')).toBeNull();
    expect(m.fn('XYZ')).toBeNull();
  });

  it('abweichender Zeitrahmen oder unbekannte Strategie ⇒ nicht gehandelt, mit Notiz', () => {
    const config = parseConfig({ universe: { symbols: ['AAPL', 'MSFT'] }, timeframe: 5 });
    const champion = championFromDoc({ version: 1, symbols: { AAPL: entry('trend_donchian', 15), MSFT: entry('gibt_es_nicht') }, noTrade: {} })!;
    const m = buildStrategyFor({ champion, config });
    expect(m.tradable).toEqual([]);
    expect(m.notes.join('\n')).toMatch(/AAPL: Champion-Zeitrahmen 15/);
    expect(m.notes.join('\n')).toMatch(/MSFT: Champion-Strategie nicht ladbar/);
  });

  it('kein Champion: nur mit allowWithoutChampion die Config-Strategie, sonst Notiz „kein Champion"', () => {
    const strict = buildStrategyFor({ champion: null, config: parseConfig({ universe: { symbols: ['AAPL'] } }) });
    expect(strict.source).toBe('none');
    expect(strict.tradable).toEqual([]);
    expect(strict.notes[0]).toMatch(/kein Champion/);
    const loose = buildStrategyFor({ champion: null, config: parseConfig({ universe: { symbols: ['AAPL'] }, strategy: { id: 'mean_reversion', allowWithoutChampion: true } }) });
    expect(loose.source).toBe('config');
    expect(loose.fn('AAPL')?.strategy.id).toBe('mean_reversion');
  });

  it('meta/champion mit fremder Version ⇒ Fehler; fehlendes Doc ⇒ null', () => {
    expect(championFromDoc(undefined)).toBeNull();
    expect(() => championFromDoc({ version: 2 })).toThrow(/Champion-Version/);
  });

  it('injiziertes Register (Tests) ersetzt src/strategy', () => {
    const config = parseConfig({ universe: { symbols: ['AAPL'] } });
    const champion = championFromDoc({ version: 1, symbols: { AAPL: entry('test_x') }, noTrade: {} })!;
    const fake = { id: 'test_x', timeframes: [5], paramSpace: [], defaults: { a: 1 }, holdsOvernight: false, warmupBars: () => 1, precompute: () => ({}), decide: () => ({ kind: 'hold' as const }) };
    const m = buildStrategyFor({ champion, config, getStrategy: () => fake });
    expect(m.fn('AAPL')?.params).toEqual({ a: 1 });
  });
});
