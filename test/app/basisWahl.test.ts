/**
 * Die Strategie-Wahl des Dauerprozesses (`src/app.ts`, `strategyChoice`) mit
 * der Basis-Stufe — dieselbe Reihenfolge wie `buildStrategyFor` auf der
 * Plattform: Alpha-Champion → Basis → noTrade/nichts.
 *
 * Wächter: (a) Basis übersteuert nie den Alpha-Champion, (b) Basis handelt
 * nie bei pass false, (c) Zeitrahmen/Schalter/positionPct sperren,
 * (d) `fetch` lädt den eigenen Basis-Korb mit, (e) das Engine-Universum
 * (`engineConfig`) trägt den Korb der Basis, der Optimierer-Korb nicht.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrap, engineConfig, fetchSymbols, strategyChoice, strategyForFn, type App } from '../../src/app.ts';
import { parseConfig } from '../../src/core/config.ts';
import { homePaths } from '../../src/core/journal.ts';
import { setLogSink } from '../../src/core/log.ts';
import { saveChampion, type ChampionBasis, type ChampionFile } from '../../src/optimize/promote.ts';

setLogSink(() => undefined);

const dir = mkdtempSync(join(tmpdir(), 'autotrd-basiswahl-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = join(dir, 'keine.env');
let n = 0;

function app(o: { champion: ChampionFile | null; basisSchalter?: boolean; timeframe?: number }): App {
  const home = join(dir, `home-${++n}`);
  const cfgPfad = join(dir, `cfg-${n}.yaml`);
  writeFileSync(
    cfgPfad,
    `universe:\n  symbols: [AAA, BBB]\n  benchmark: SPY\ntimeframe: ${o.timeframe ?? 1440}\nstrategy:\n  basis: ${o.basisSchalter ?? true}\n`,
    'utf8',
  );
  if (o.champion) saveChampion(homePaths(home).champion, o.champion);
  return bootstrap({ config: cfgPfad, env, home });
}

const block = (over: Partial<ChampionBasis> = {}): ChampionBasis => ({
  version: 1,
  strategy: 'regime_allocation',
  params: { lookback: 126, skip: 21, regimeLen: 150, topPct: 0.4, exitPct: 0.6, stopPct: 20 },
  symbols: ['AAA', 'BBB', 'CCC'],
  label: 'Basis V2',
  timeframe: 1440,
  pass: true,
  gates: [],
  measuredAt: 1,
  positionPct: 20,
  ...over,
});

const alphaEntry = { strategy: 'trend_donchian', params: { entryLookback: 30 }, timeframe: 1440 as const, score: 1, oos: {} as never, gates: [], decidedAt: 1, trials: 1, dataRange: {} as never };

function champion(basis: ChampionBasis | null, o: { alpha?: string[]; noTrade?: string[] } = {}): ChampionFile {
  return {
    version: 1,
    updatedAt: 1,
    symbols: Object.fromEntries((o.alpha ?? []).map((s) => [s, alphaEntry])),
    noTrade: Object.fromEntries((o.noTrade ?? []).map((s) => [s, { reason: 'x', decidedAt: 1, bestScore: null }])),
    ...(basis ? { basis } : {}),
  };
}

describe('strategyChoice: Alpha → Basis → noTrade', () => {
  it('WÄCHTER: der Alpha-Champion führt AAA, die Basis übernimmt BBB (trotz noTrade) und CCC — mit Parametern und Allokation', () => {
    const a = app({ champion: champion(block(), { alpha: ['AAA'], noTrade: ['BBB'] }) });
    const aaa = strategyChoice(a, 'AAA')!;
    expect(aaa.source).toBe('champion');
    expect(aaa.strategy.id).toBe('trend_donchian');
    expect(aaa.sizing).toBeUndefined();
    const bbb = strategyChoice(a, 'BBB')!;
    expect(bbb.source).toBe('basis');
    expect(bbb.strategy.id).toBe('regime_allocation');
    expect(bbb.params).toMatchObject({ lookback: 126, stopPct: 20 });
    expect(bbb.sizing).toEqual({ mode: 'allocation', positionPct: 20 });
    expect(strategyChoice(a, 'CCC')?.source).toBe('basis');
    // strategyForFn reicht das Sizing an die Engine durch.
    expect(strategyForFn(a)('BBB')).toMatchObject({ sizing: { mode: 'allocation', positionPct: 20 } });
    expect(strategyForFn(a)('AAA')).not.toHaveProperty('sizing');
  });

  it('WÄCHTER: pass false ⇒ die Basis handelt nichts; noTrade bleibt noTrade, unbekannte Symbole nichts', () => {
    const a = app({ champion: champion(block({ pass: false }), { noTrade: ['BBB'] }) });
    expect(strategyChoice(a, 'BBB')).toBeNull();
    expect(strategyChoice(a, 'CCC')).toBeNull();
    expect(strategyChoice(a, 'AAA')).toBeNull();
  });

  it('Zeitrahmen ≠ Config, Schalter aus, Block ohne positionPct ⇒ keine Basis', () => {
    expect(strategyChoice(app({ champion: champion(block({ timeframe: 5 })) }), 'BBB')).toBeNull();
    expect(strategyChoice(app({ champion: champion(block()), basisSchalter: false }), 'BBB')).toBeNull();
    const { positionPct: _weg, ...ohneFeld } = block();
    expect(strategyChoice(app({ champion: champion(ohneFeld as ChampionBasis) }), 'BBB')).toBeNull();
  });

  it('Symbol außerhalb des Basis-Korbs ⇒ wie bisher (kein Champion, allowWithoutChampion false ⇒ null)', () => {
    expect(strategyChoice(app({ champion: champion(block()) }), 'ZZZ')).toBeNull();
  });
});

describe('Universum: Engine mit Basis-Korb, Optimierer ohne', () => {
  it('engineConfig erweitert das Universum um den Korb; die Config der App bleibt unverändert', () => {
    const a = app({ champion: champion(block()) });
    expect(engineConfig(a).universe.symbols).toEqual(['AAA', 'BBB', 'CCC']);
    expect(a.config.universe.symbols).toEqual(['AAA', 'BBB']);
    expect(engineConfig(app({ champion: champion(block({ pass: false })) })).universe.symbols).toEqual(['AAA', 'BBB']);
    expect(engineConfig(app({ champion: null })).universe.symbols).toEqual(['AAA', 'BBB']);
  });

  it('fetchSymbols lädt den eigenen Basis-Korb (optimizer.basisUniverse) mit — Universum, Benchmark, Korb', () => {
    const cfg = parseConfig({
      universe: { symbols: ['AAA'], benchmark: 'SPY' },
      timeframe: 1440,
      optimizer: { fixedCandidates: [{ strategy: 'regime_allocation', tier: 'basis' }], basisUniverse: ['IEF', 'GLD', 'SPY'] },
    });
    expect(fetchSymbols(cfg).sort()).toEqual(['AAA', 'GLD', 'IEF', 'SPY']);
    expect(fetchSymbols(parseConfig({ universe: { symbols: ['AAA'], benchmark: 'SPY' } })).sort()).toEqual(['AAA', 'SPY']);
  });
});
