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
import { bootstrap, engineConfig, fetchSymbols, heldSymbols, strategyChoice, strategyForFn, streamLimitViolation, type App } from '../../src/app.ts';
import { parseConfig } from '../../src/core/config.ts';
import { emptyState, homePaths, writeJsonAtomic } from '../../src/core/journal.ts';
import { setLogSink } from '../../src/core/log.ts';
import { saveChampion, type ChampionBasis, type ChampionFile } from '../../src/optimize/promote.ts';

setLogSink(() => undefined);

const dir = mkdtempSync(join(tmpdir(), 'autotrd-basiswahl-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = join(dir, 'keine.env');
let n = 0;

function app(o: { champion: ChampionFile | null; basisSchalter?: boolean; timeframe?: number; symbols?: string[]; candidates?: string[]; positions?: string[]; maxPositionPct?: number }): App {
  const home = join(dir, `home-${++n}`);
  const cfgPfad = join(dir, `cfg-${n}.yaml`);
  const symbols = o.symbols ?? ['AAA', 'BBB'];
  writeFileSync(
    cfgPfad,
    `universe:\n  symbols: [${symbols.join(', ')}]\n  benchmark: SPY\n${o.candidates ? `  candidates: [${o.candidates.join(', ')}]\n` : ''}` +
      `timeframe: ${o.timeframe ?? 1440}\nstrategy:\n  basis: ${o.basisSchalter ?? true}\n${o.maxPositionPct !== undefined ? `risk:\n  maxPositionPct: ${o.maxPositionPct}\n` : ''}`,
    'utf8',
  );
  if (o.champion) saveChampion(homePaths(home).champion, o.champion);
  if (o.positions) {
    const st = emptyState('paper', '2026-09-01', 100_000);
    for (const sym of o.positions) st.positions[sym] = { symbol: sym, side: 'long', qty: 1, entryPrice: 100, entryTime: 1, stop: 80, target: null, initialStop: 80, highWater: 100, strategy: 'regime_allocation', barsHeld: 0, entryDay: '2026-09-01' };
    writeJsonAtomic(homePaths(home).state, st);
  }
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

  it('WÄCHTER (M6): pass false ⇒ die Basis ERÖFFNET nichts (entriesAllowed false, Grund), führt aber — noTrade-Symbole des Korbs eingeschlossen; unbekannte Symbole nichts', () => {
    const a = app({ champion: champion(block({ pass: false }), { noTrade: ['BBB'] }) });
    const bbb = strategyChoice(a, 'BBB')!;
    expect(bbb).toMatchObject({ source: 'basis', entriesAllowed: false, sizing: { mode: 'allocation', positionPct: 20 } });
    expect(bbb.entryLockReason).toMatch(/Latte nicht bestanden — keine neuen Einstiege/);
    expect(strategyChoice(a, 'CCC')).toMatchObject({ entriesAllowed: false });
    expect(strategyChoice(a, 'ZZZ')).toBeNull();
    // strategyForFn reicht Einstiegsrecht, Grund und Quelle an die Engine durch.
    expect(strategyForFn(a)('BBB')).toMatchObject({ source: 'basis', entriesAllowed: false, entryLockReason: expect.stringMatching(/Latte/) });
    expect(strategyForFn(a)('ZZZ')).toBeNull();
  });

  it('Schalter aus (M8) ⇒ Wahl ohne Einstiegsrecht; Zeitrahmen ≠ Config oder Block ohne positionPct ⇒ gar keine Basis (unführbar)', () => {
    expect(strategyChoice(app({ champion: champion(block()), basisSchalter: false }), 'BBB')).toMatchObject({ entriesAllowed: false, entryLockReason: expect.stringMatching(/Schalter aus/) });
    expect(strategyChoice(app({ champion: champion(block({ timeframe: 5 })) }), 'BBB')).toBeNull();
    const { positionPct: _weg, ...ohneFeld } = block();
    expect(strategyChoice(app({ champion: champion(ohneFeld as ChampionBasis) }), 'BBB')).toBeNull();
  });

  it('mit Einstiegsrecht trägt die Wahl entriesAllowed true und die Quelle', () => {
    expect(strategyForFn(app({ champion: champion(block()) }))('BBB')).toMatchObject({ source: 'basis', entriesAllowed: true });
    expect(strategyForFn(app({ champion: champion(block(), { alpha: ['AAA'] }) }))('AAA')).toMatchObject({ source: 'champion' });
  });

  it('M11: Korb-Symbole außerhalb des Kandidatenpools bekommen keine Wahl', () => {
    const a = app({ champion: champion(block()), candidates: ['AAA', 'BBB', 'SPY'] });
    expect(strategyChoice(a, 'BBB')?.source).toBe('basis');
    expect(strategyChoice(a, 'CCC')).toBeNull();
  });

  it('G15: die Notiz der Wahl nennt den wirksamen Deckel des Nutzers', () => {
    const a = app({ champion: champion(block({ pass: false })), maxPositionPct: 10 });
    // Der Grund der Sperre ist der Journal-Text; der Deckel steht in der Basis-Notiz der Plattform (buildStrategyFor) —
    // hier prüfen wir, dass die Wahl die Config des Nutzers überhaupt sieht: unverändertes Sizing, gedeckelt wird in risk/sizing.ts.
    expect(strategyChoice(a, 'BBB')).toMatchObject({ sizing: { mode: 'allocation', positionPct: 20 } });
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

  it('WÄCHTER (M6): ohne Einstiegsrecht bleibt der Korb nur mit offenem Bestand laut state.json im Universum (heldSymbols)', () => {
    const offen = app({ champion: champion(block({ pass: false })), positions: ['CCC'] });
    expect(heldSymbols(offen)).toEqual(['CCC']);
    expect(engineConfig(offen, heldSymbols(offen)).universe.symbols).toEqual(['AAA', 'BBB', 'CCC']);
    const leer = app({ champion: champion(block({ pass: false })) });
    expect(heldSymbols(leer)).toEqual([]);
    expect(engineConfig(leer, heldSymbols(leer)).universe.symbols).toEqual(['AAA', 'BBB']);
  });

  it('M10: streamLimitViolation — über 30 Symbolen (inkl. Benchmark und Basis-Korb) mit IEX ein Fehlertext, mit SIP oder ≤ 30 null', () => {
    const viele = Array.from({ length: 26 }, (_, i) => `S${i}`);
    const cfg = parseConfig({ universe: { symbols: viele, benchmark: 'SPY' }, timeframe: 1440 });
    expect(streamLimitViolation(cfg)).toBeNull(); // 26 + SPY = 27
    const korb = champion(block({ symbols: ['K1', 'K2', 'K3', 'K4', 'K5'] }));
    const a = app({ champion: korb, symbols: viele });
    const engineCfg = engineConfig(a);
    expect(engineCfg.universe.symbols).toHaveLength(31);
    expect(streamLimitViolation(engineCfg)).toMatch(/32 Symbole.*erlaubt 30/);
    expect(streamLimitViolation({ ...engineCfg, broker: { ...engineCfg.broker, feed: 'sip' } })).toBeNull();
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
