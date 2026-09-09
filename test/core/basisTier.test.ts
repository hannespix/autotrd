/**
 * Die Basis-Stufe (core/basisTier.ts): Wer handelt was, und wann nicht.
 *
 * Wächter, die Geld kosten, wenn sie fehlen:
 *  (a) Die Basis übersteuert NIE ein Symbol, das der Alpha-Champion führt.
 *  (b) Die Basis handelt NIE bei `pass: false` — ein Block ist ein Befund,
 *      keine Freigabe.
 *  (c) Zeitrahmen, Schalter, fehlendes `positionPct` (Block vor der
 *      Basis-Stufe) und fehlende Symbole sperren — mit Grund fürs Journal.
 *  (d) Das Engine-Universum bekommt den Korb als Block, oder gar nicht.
 */
import { describe, expect, it } from 'vitest';
import { basisChoiceFor, basisStatus, universeWithBasis } from '../../src/core/basisTier.ts';
import { parseConfig } from '../../src/core/config.ts';
import type { ChampionBasis, ChampionFile } from '../../src/optimize/promote.ts';

const block = (over: Partial<ChampionBasis> = {}): ChampionBasis => ({
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

const champion = (basis?: ChampionBasis, alpha: string[] = []): ChampionFile => ({
  version: 1,
  updatedAt: 1,
  symbols: Object.fromEntries(
    alpha.map((s) => [s, { strategy: 'trend_donchian', params: {}, timeframe: 1440 as const, score: 1, oos: {} as never, gates: [], decidedAt: 1, trials: 1, dataRange: {} as never }]),
  ),
  noTrade: {},
  ...(basis ? { basis } : {}),
});

describe('basisStatus', () => {
  it('handelbar: Block bestanden, Zeitrahmen passt, positionPct da, Schalter an — Allokations-Sizing und Notiz', () => {
    const s = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true });
    expect(s.tradable).toBe(true);
    if (!s.tradable) return;
    expect(s.symbols).toEqual(['SPY', 'IEF', 'GLD']);
    expect(s.sizing).toEqual({ mode: 'allocation', positionPct: 20 });
    expect(s.note).toContain('Position 20 % der Equity je Symbol');
    expect(s.note).toContain('Risiko je Trade ohne Wirkung');
  });

  it('kein Champion oder kein Block ⇒ nicht handelbar, ohne Journal-Grund (kein Rauschen)', () => {
    expect(basisStatus({ champion: null, timeframe: 1440, enabled: true })).toEqual({ tradable: false, basis: null, reason: null });
    expect(basisStatus({ champion: champion(), timeframe: 1440, enabled: true })).toEqual({ tradable: false, basis: null, reason: null });
  });

  it('WÄCHTER: pass false ⇒ nie handelbar, auch wenn alles andere passt', () => {
    const s = basisStatus({ champion: champion(block({ pass: false })), timeframe: 1440, enabled: true });
    expect(s.tradable).toBe(false);
    if (s.tradable) return;
    expect(s.reason).toMatch(/Latte nicht bestanden/);
  });

  it('Zeitrahmen ≠ Config, Block ohne positionPct, ohne Symbole, Schalter aus ⇒ nicht handelbar, je mit Grund', () => {
    const tf = basisStatus({ champion: champion(block()), timeframe: 5, enabled: true });
    expect(tf).toMatchObject({ tradable: false, reason: expect.stringMatching(/Zeitrahmen 1440 ≠ Config 5/) });
    const { positionPct: _weg, ...ohneFeld } = block();
    const ohnePct = basisStatus({ champion: champion(ohneFeld as ChampionBasis), timeframe: 1440, enabled: true });
    expect(ohnePct).toMatchObject({ tradable: false, reason: expect.stringMatching(/ohne positionPct/) });
    const nullPct = basisStatus({ champion: champion(block({ positionPct: 0 })), timeframe: 1440, enabled: true });
    expect(nullPct.tradable).toBe(false);
    const leer = basisStatus({ champion: champion(block({ symbols: [] })), timeframe: 1440, enabled: true });
    expect(leer).toMatchObject({ tradable: false, reason: expect.stringMatching(/ohne Symbole/) });
    const aus = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: false });
    expect(aus).toMatchObject({ tradable: false, reason: expect.stringMatching(/vom Nutzer abgeschaltet/) });
  });
});

describe('basisChoiceFor', () => {
  const status = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true });

  it('Symbol im Korb ohne Alpha-Champion ⇒ Basis-Wahl mit Parametern und Allokation', () => {
    const c = basisChoiceFor({ status, symbol: 'IEF', alphaLeads: false });
    expect(c).toEqual({ strategyId: 'regime_allocation', params: block().params, sizing: { mode: 'allocation', positionPct: 20 }, label: 'Basis V2' });
  });

  it('WÄCHTER: der Alpha-Champion führt ⇒ keine Basis-Wahl, auch für ein Korb-Symbol', () => {
    expect(basisChoiceFor({ status, symbol: 'SPY', alphaLeads: true })).toBeNull();
  });

  it('Symbol nicht im Korb ⇒ null; nicht handelbare Basis ⇒ null', () => {
    expect(basisChoiceFor({ status, symbol: 'TLT', alphaLeads: false })).toBeNull();
    const aus = basisStatus({ champion: champion(block({ pass: false })), timeframe: 1440, enabled: true });
    expect(basisChoiceFor({ status: aus, symbol: 'IEF', alphaLeads: false })).toBeNull();
  });
});

describe('universeWithBasis', () => {
  const cfg = parseConfig({ universe: { symbols: ['AAPL', 'SPY'] }, timeframe: 1440 });

  it('erweitert das Universum um den Korb (ohne Dubletten), wenn die Basis handelbar ist', () => {
    const out = universeWithBasis(cfg, champion(block()));
    expect(out.universe.symbols).toEqual(['AAPL', 'SPY', 'IEF', 'GLD']);
    // Die Eingabe bleibt unberührt.
    expect(cfg.universe.symbols).toEqual(['AAPL', 'SPY']);
  });

  it('unverändert ohne Block, bei pass false, falschem Zeitrahmen oder ausgeschaltetem Schalter', () => {
    expect(universeWithBasis(cfg, null)).toBe(cfg);
    expect(universeWithBasis(cfg, champion(block({ pass: false })))).toBe(cfg);
    expect(universeWithBasis(cfg, champion(block({ timeframe: 5 })))).toBe(cfg);
    const aus = parseConfig({ universe: { symbols: ['AAPL'] }, timeframe: 1440, strategy: { basis: false } });
    expect(universeWithBasis(aus, champion(block()))).toBe(aus);
  });

  it('der Korb kommt als Ganzes — auch die Symbole, die der Alpha-Champion führt, bleiben im Universum', () => {
    const out = universeWithBasis(parseConfig({ universe: { symbols: ['AAPL'] }, timeframe: 1440 }), champion(block(), ['SPY']));
    expect(out.universe.symbols).toEqual(['AAPL', 'SPY', 'IEF', 'GLD']);
  });
});
