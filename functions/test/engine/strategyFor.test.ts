import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config.ts';
import { setLogSink } from '../../../src/core/log.ts';
import type { ChampionBasis, ChampionFile } from '../../../src/optimize/promote.ts';
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

/* ───────────────────────── Basis-Stufe ───────────────────────── */

const basisBlock = (over: Partial<ChampionBasis> = {}): ChampionBasis => ({
  version: 1,
  strategy: 'regime_allocation',
  params: { lookback: 126, skip: 21, regimeLen: 150, topPct: 0.4, exitPct: 0.6, stopPct: 20 },
  symbols: ['SPY', 'IEF', 'GLD'],
  label: 'Basis V2',
  timeframe: 1440,
  pass: true,
  gates: [],
  measuredAt: 1,
  positionPct: 20,
  ...over,
});

/** Champion-Doc der Plattform: Alpha-Eintrag für SPY (Tagesbars), noTrade für IEF, Basis-Block. */
function doc(basis: Partial<ChampionBasis> | null = {}, o: { alpha?: string[]; noTrade?: string[] } = { alpha: ['SPY'], noTrade: ['IEF'] }): Record<string, unknown> {
  return {
    version: 1,
    updatedAt: 1,
    symbols: Object.fromEntries((o.alpha ?? []).map((s) => [s, { ...entry('trend_donchian', 5), timeframe: 1440 }])),
    noTrade: Object.fromEntries((o.noTrade ?? []).map((s) => [s, { reason: 'x', decidedAt: 1, bestScore: null }])),
    ...(basis === null ? {} : { basis: basisBlock(basis) }),
  };
}

const cfg = (over: Record<string, unknown> = {}) => parseConfig({ universe: { symbols: ['SPY', 'IEF', 'GLD', 'AAPL'] }, timeframe: 1440, ...over });

describe('Basis-Stufe ⇒ strategyFor (Alpha → Basis → noTrade)', () => {
  it('championFromDoc liest den Block basis additiv; fremde Basis-Version oder kaputte params ⇒ Block weg mit Warnung, der Champion bleibt (M9)', () => {
    const c = championFromDoc(doc())!;
    expect(c.basis).toMatchObject({ strategy: 'regime_allocation', pass: true, symbols: ['SPY', 'IEF', 'GLD'], positionPct: 20 });
    expect(championFromDoc(doc(null))!.basis).toBeUndefined();
    const warnungen: string[] = [];
    const fremd = championFromDoc({ version: 1, symbols: { AAPL: entry('trend_donchian') }, noTrade: {}, basis: { version: 2 } }, (t) => warnungen.push(t))!;
    expect(fremd.basis).toBeUndefined();
    expect(Object.keys(fremd.symbols)).toEqual(['AAPL']);
    expect(warnungen.join('\n')).toMatch(/meta\/champion: Basis-Block unlesbar \(unbekannte Basis-Version 2\)/);
    const kaputt = championFromDoc({ version: 1, symbols: {}, noTrade: {}, basis: { ...basisBlock(), params: null } }, (t) => warnungen.push(t))!;
    expect(kaputt.basis).toBeUndefined();
    expect(warnungen.at(-1)).toMatch(/params ist kein Objekt/);
    // Eine fremde DOC-Version wirft weiterhin — die kann man nicht additiv übergehen.
    expect(() => championFromDoc({ version: 2 })).toThrow(/Champion-Version/);
  });

  it('WÄCHTER: Alpha vor Basis vor noTrade — SPY bleibt beim Champion, IEF (noTrade) und GLD handelt die Basis mit Allokation, AAPL nichts', () => {
    const m = buildStrategyFor({ champion: championFromDoc(doc()), config: cfg() });
    expect(m.source).toBe('champion');
    expect(m.tradable).toEqual(['SPY', 'IEF', 'GLD']);
    expect(m.basisSymbols).toEqual(['IEF', 'GLD']);
    const spy = m.fn('SPY')!;
    expect(spy.source).toBe('champion');
    expect(spy.strategy.id).toBe('trend_donchian');
    expect(spy.sizing).toBeUndefined();
    const ief = m.fn('IEF')!;
    expect(ief.source).toBe('basis');
    expect(ief.strategy.id).toBe('regime_allocation');
    expect(ief.params).toMatchObject({ lookback: 126, stopPct: 20 });
    expect(ief.sizing).toEqual({ mode: 'allocation', positionPct: 20 });
    expect(m.fn('GLD')?.source).toBe('basis');
    expect(m.fn('AAPL')).toBeNull();
    expect(m.notes.join('\n')).toMatch(/Basis-Allokation „Basis V2": 3 Symbole \(SPY, IEF, GLD\)/);
    expect(m.notes.join('\n')).toMatch(/Position 20 % der Equity je Symbol/);
    expect(m.notes.join('\n')).toMatch(/SPY führt der Alpha-Champion/);
  });

  it('WÄCHTER (M6): pass false ⇒ die Basis ERÖFFNET nichts (entriesAllowed false) — führt IEF (noTrade) und GLD aber weiter; Notiz nennt Latte und Bestand', () => {
    const m = buildStrategyFor({ champion: championFromDoc(doc({ pass: false })), config: cfg(), held: ['GLD', 'AAPL'] });
    expect(m.tradable).toEqual(['SPY', 'IEF', 'GLD']);
    expect(m.basisSymbols).toEqual(['IEF', 'GLD']);
    expect(m.fn('IEF')).toMatchObject({ source: 'basis', entriesAllowed: false, sizing: { mode: 'allocation', positionPct: 20 } });
    expect(m.fn('IEF')?.entryLockReason).toMatch(/Latte nicht bestanden — keine neuen Einstiege/);
    expect(m.fn('GLD')?.entriesAllowed).toBe(false);
    expect(m.fn('SPY')?.entriesAllowed).toBeUndefined();
    expect(m.notes.join('\n')).toMatch(/Latte nicht bestanden — keine neuen Einstiege; offene Basis-Positionen führt die Basis-Strategie zu Ende \(eigene Exits, Broker-Stop bleibt\): GLD/);
  });

  it('Schalter aus (strategy.basis false = global ∧ Nutzer) ⇒ Wahl ohne Einstiegsrecht, Notiz „Schalter aus"; an ⇒ Einstiegsrecht', () => {
    const aus = buildStrategyFor({ champion: championFromDoc(doc()), config: cfg({ strategy: { basis: false } }) });
    expect(aus.basisSymbols).toEqual(['IEF', 'GLD']);
    expect(aus.fn('GLD')).toMatchObject({ entriesAllowed: false, entryLockReason: expect.stringMatching(/Schalter aus \(strategy\.basis\)/) });
    expect(aus.notes.join('\n')).toMatch(/Schalter aus \(strategy\.basis\) — keine neuen Einstiege/);
    const an = buildStrategyFor({ champion: championFromDoc(doc()), config: cfg({ strategy: { basis: true } }) });
    expect(an.basisSymbols).toEqual(['IEF', 'GLD']);
    expect(an.fn('GLD')).toMatchObject({ entriesAllowed: true });
  });

  it('WÄCHTER (M11): Korb-Symbole außerhalb des Kandidatenpools der Config werden verworfen und genannt; ohne Pool eine Notiz', () => {
    // Der Pool ist candidates ∪ symbols — IEF steht in keinem von beiden.
    const mitPool = buildStrategyFor({ champion: championFromDoc(doc()), config: cfg({ universe: { symbols: ['SPY', 'GLD', 'AAPL'], candidates: ['SPY', 'GLD', 'TLT'] } }) });
    expect(mitPool.basisSymbols).toEqual(['GLD']);
    expect(mitPool.fn('IEF')).toBeNull();
    expect(buildStrategyFor({ champion: championFromDoc(doc()), config: cfg({ universe: { symbols: ['SPY', 'IEF', 'GLD', 'AAPL'], candidates: ['TLT'] } }) }).basisSymbols).toEqual(['IEF', 'GLD']);
    expect(mitPool.notes.join('\n')).toMatch(/außerhalb des Kandidatenpools verworfen: IEF/);
    const ohnePool = buildStrategyFor({ champion: championFromDoc(doc()), config: cfg() });
    expect(ohnePool.notes.join('\n')).toMatch(/Korb ungeprüft — meta\/engineConfig ohne Kandidatenpool/);
  });

  it('G15: die Basis-Notiz nennt den wirksamen Deckel des Nutzers (maxPositionPct 10 < positionPct 20)', () => {
    const m = buildStrategyFor({ champion: championFromDoc(doc()), config: cfg({ risk: { maxPositionPct: 10 } }) });
    expect(m.notes.join('\n')).toMatch(/Position 20 % der Equity je Symbol, durch risk\.maxPositionPct auf 10 % gedeckelt/);
    expect(m.fn('GLD')?.sizing).toEqual({ mode: 'allocation', positionPct: 20 });
  });

  it('Zeitrahmen des Blocks ≠ Config ⇒ keine Basis, mit Notiz; Block ohne positionPct ⇒ keine Basis', () => {
    const tf = buildStrategyFor({ champion: championFromDoc(doc({ timeframe: 5 })), config: cfg() });
    expect(tf.basisSymbols).toEqual([]);
    expect(tf.notes.join('\n')).toMatch(/Zeitrahmen 5 ≠ Config 1440/);
    const ohne = buildStrategyFor({ champion: championFromDoc(doc({ positionPct: undefined })), config: cfg() });
    expect(ohne.basisSymbols).toEqual([]);
    expect(ohne.notes.join('\n')).toMatch(/ohne positionPct/);
  });

  it('ohne Alpha-Champion ist die Quelle „basis"; ohne Block bleibt alles wie bisher (keine Basis-Notiz)', () => {
    const nurBasis = buildStrategyFor({ champion: championFromDoc(doc({}, { alpha: [], noTrade: [] })), config: cfg() });
    expect(nurBasis.source).toBe('basis');
    expect(nurBasis.tradable).toEqual(['SPY', 'IEF', 'GLD']);
    const ohne = buildStrategyFor({ champion: championFromDoc(doc(null)), config: cfg() });
    expect(ohne.basisSymbols).toEqual([]);
    expect(ohne.notes.some((n) => /Basis/.test(n))).toBe(false);
  });
});
