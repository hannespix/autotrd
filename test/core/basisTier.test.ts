/**
 * Die Basis-Stufe (core/basisTier.ts): Wer handelt was, und wann nicht.
 *
 * Wächter, die Geld kosten, wenn sie fehlen:
 *  (a) Die Basis übersteuert NIE ein Symbol, das der Alpha-Champion führt.
 *  (b) Die Basis ERÖFFNET NIE bei `pass: false` oder Schalter aus — ein
 *      Block ist ein Befund, keine Freigabe. Sie FÜHRT dann aber offene
 *      Basis-Positionen zu Ende (`entriesAllowed: false`, Prüfbefund M6/M8)
 *      statt sie zu liquidieren.
 *  (c) Zeitrahmen, fehlendes `positionPct` (Block vor der Basis-Stufe) und
 *      fehlende Symbole machen den Block unführbar — mit Grund fürs Journal.
 *  (d) Das Engine-Universum bekommt den Korb als Block, oder gar nicht — ohne
 *      Einstiegsrecht nur, solange darin etwas offen ist.
 *  (e) Korb-Symbole außerhalb des Kandidatenpools werden verworfen (M11).
 *  (f) Die Notiz nennt den wirksamen Deckel (`maxPositionPct`, G15).
 */
import { describe, expect, it } from 'vitest';
import { basisChoiceFor, basisFuehrungOf, basisStatus, universeWithBasis } from '../../src/core/basisTier.ts';
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

  it('WÄCHTER: pass false ⇒ nie handelbar, auch wenn alles andere passt — aber führbar (Bestand läuft nach eigener Regel aus)', () => {
    const s = basisStatus({ champion: champion(block({ pass: false })), timeframe: 1440, enabled: true });
    expect(s.tradable).toBe(false);
    if (s.tradable) return;
    expect(s.reason).toMatch(/Latte nicht bestanden — keine neuen Einstiege/);
    expect(s.reason).toMatch(/führt die Basis-Strategie zu Ende/);
    expect(s.fuehrung).toMatchObject({ symbols: ['SPY', 'IEF', 'GLD'], sizing: { mode: 'allocation', positionPct: 20 } });
    expect(basisFuehrungOf(s)?.symbols).toEqual(['SPY', 'IEF', 'GLD']);
  });

  it('Schalter aus ⇒ nicht handelbar, führbar — Grund nennt den Schalter (global ∧ Nutzer, M8)', () => {
    const aus = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: false });
    expect(aus).toMatchObject({ tradable: false, reason: expect.stringMatching(/Schalter aus \(strategy\.basis\) — keine neuen Einstiege/) });
    expect(basisFuehrungOf(aus)?.symbols).toEqual(['SPY', 'IEF', 'GLD']);
  });

  it('Zeitrahmen ≠ Config, Block ohne positionPct, ohne Symbole ⇒ nicht handelbar UND nicht führbar, je mit Grund', () => {
    const tf = basisStatus({ champion: champion(block()), timeframe: 5, enabled: true });
    expect(tf).toMatchObject({ tradable: false, reason: expect.stringMatching(/Zeitrahmen 1440 ≠ Config 5/) });
    expect(basisFuehrungOf(tf)).toBeNull();
    const { positionPct: _weg, ...ohneFeld } = block();
    const ohnePct = basisStatus({ champion: champion(ohneFeld as ChampionBasis), timeframe: 1440, enabled: true });
    expect(ohnePct).toMatchObject({ tradable: false, reason: expect.stringMatching(/ohne positionPct/) });
    expect(basisFuehrungOf(ohnePct)).toBeNull();
    const nullPct = basisStatus({ champion: champion(block({ positionPct: 0 })), timeframe: 1440, enabled: true });
    expect(nullPct.tradable).toBe(false);
    expect(basisFuehrungOf(nullPct)).toBeNull();
    const leer = basisStatus({ champion: champion(block({ symbols: [] })), timeframe: 1440, enabled: true });
    expect(leer).toMatchObject({ tradable: false, reason: expect.stringMatching(/ohne Symbole/) });
    expect(basisFuehrungOf(leer)).toBeNull();
  });

  it('WÄCHTER (M11): Korb-Symbole außerhalb des Kandidatenpools werden verworfen und genannt; ohne Pool keine Prüfung', () => {
    const s = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true, pool: ['SPY', 'GLD', 'AAPL'] });
    expect(s.tradable).toBe(true);
    if (!s.tradable) return;
    expect(s.symbols).toEqual(['SPY', 'GLD']);
    expect(s.verworfen).toEqual(['IEF']);
    expect(s.note).toMatch(/außerhalb des Kandidatenpools verworfen: IEF/);
    // Kein einziges Korb-Symbol im Pool ⇒ nicht handelbar, nicht führbar.
    const keins = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true, pool: ['AAPL'] });
    expect(keins).toMatchObject({ tradable: false, reason: expect.stringMatching(/kein Korb-Symbol im Kandidatenpool/) });
    expect(basisFuehrungOf(keins)).toBeNull();
    // Ohne Pool ist der Korb eine eigene Einheit.
    const ohne = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true });
    expect(ohne.tradable && ohne.symbols).toEqual(['SPY', 'IEF', 'GLD']);
    expect(ohne.tradable && ohne.verworfen).toEqual([]);
  });

  it('G15: Deckelt risk.maxPositionPct die Allokation, nennt die Notiz den wirksamen Wert — sonst nicht', () => {
    const gedeckelt = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true, maxPositionPct: 10 });
    expect(gedeckelt.tradable && gedeckelt.note).toMatch(/Position 20 % der Equity je Symbol, durch risk\.maxPositionPct auf 10 % gedeckelt/);
    // Das Sizing selbst bleibt die Semantik der Messung — den Deckel zieht risk/sizing.ts.
    expect(gedeckelt.tradable && gedeckelt.sizing).toEqual({ mode: 'allocation', positionPct: 20 });
    const frei = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true, maxPositionPct: 25 });
    expect(frei.tradable && frei.note).toMatch(/Position 20 % der Equity je Symbol \(Allokation/);
    expect(frei.tradable && frei.note).not.toMatch(/gedeckelt/);
  });
});

describe('basisChoiceFor', () => {
  const status = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: true });

  it('Symbol im Korb ohne Alpha-Champion ⇒ Basis-Wahl mit Parametern, Allokation und Einstiegsrecht', () => {
    const c = basisChoiceFor({ status, symbol: 'IEF', alphaLeads: false });
    expect(c).toEqual({ strategyId: 'regime_allocation', params: block().params, sizing: { mode: 'allocation', positionPct: 20 }, label: 'Basis V2', entriesAllowed: true });
  });

  it('WÄCHTER: der Alpha-Champion führt ⇒ keine Basis-Wahl, auch für ein Korb-Symbol — auch ohne Einstiegsrecht', () => {
    expect(basisChoiceFor({ status, symbol: 'SPY', alphaLeads: true })).toBeNull();
    const aus = basisStatus({ champion: champion(block({ pass: false })), timeframe: 1440, enabled: true });
    expect(basisChoiceFor({ status: aus, symbol: 'SPY', alphaLeads: true })).toBeNull();
  });

  it('Symbol nicht im Korb ⇒ null; unführbare Basis ⇒ null', () => {
    expect(basisChoiceFor({ status, symbol: 'TLT', alphaLeads: false })).toBeNull();
    const tf = basisStatus({ champion: champion(block()), timeframe: 5, enabled: true });
    expect(basisChoiceFor({ status: tf, symbol: 'IEF', alphaLeads: false })).toBeNull();
  });

  it('WÄCHTER (M6/M8): pass false oder Schalter aus ⇒ Wahl OHNE Einstiegsrecht, mit Grund — die Strategie führt, eröffnet nicht', () => {
    const latte = basisStatus({ champion: champion(block({ pass: false })), timeframe: 1440, enabled: true });
    const c = basisChoiceFor({ status: latte, symbol: 'IEF', alphaLeads: false });
    expect(c).toMatchObject({ strategyId: 'regime_allocation', sizing: { mode: 'allocation', positionPct: 20 }, entriesAllowed: false });
    expect(c?.entryLockReason).toMatch(/Latte nicht bestanden — keine neuen Einstiege/);
    const schalter = basisStatus({ champion: champion(block()), timeframe: 1440, enabled: false });
    expect(basisChoiceFor({ status: schalter, symbol: 'GLD', alphaLeads: false })).toMatchObject({ entriesAllowed: false, entryLockReason: expect.stringMatching(/Schalter aus/) });
    // Verworfene Symbole (Pool) bekommen auch ohne Einstiegsrecht keine Wahl.
    const pool = basisStatus({ champion: champion(block({ pass: false })), timeframe: 1440, enabled: true, pool: ['SPY', 'GLD'] });
    expect(basisChoiceFor({ status: pool, symbol: 'IEF', alphaLeads: false })).toBeNull();
    expect(basisChoiceFor({ status: pool, symbol: 'GLD', alphaLeads: false })).toMatchObject({ entriesAllowed: false });
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

  it('unverändert ohne Block, bei pass false, falschem Zeitrahmen oder ausgeschaltetem Schalter — solange nichts offen ist', () => {
    expect(universeWithBasis(cfg, null)).toBe(cfg);
    expect(universeWithBasis(cfg, champion(block({ pass: false })))).toBe(cfg);
    expect(universeWithBasis(cfg, champion(block({ timeframe: 5 })))).toBe(cfg);
    const aus = parseConfig({ universe: { symbols: ['AAPL'] }, timeframe: 1440, strategy: { basis: false } });
    expect(universeWithBasis(aus, champion(block()))).toBe(aus);
    // Offene Position außerhalb des Korbs ändert nichts.
    expect(universeWithBasis(cfg, champion(block({ pass: false })), ['AAPL'])).toBe(cfg);
  });

  it('WÄCHTER (M6/M8): ohne Einstiegsrecht bleibt der GANZE Korb im Universum, solange darin etwas offen ist — die Rang-Exits brauchen ihn', () => {
    const out = universeWithBasis(cfg, champion(block({ pass: false })), ['IEF']);
    expect(out.universe.symbols).toEqual(['AAPL', 'SPY', 'IEF', 'GLD']);
    const aus = parseConfig({ universe: { symbols: ['AAPL'] }, timeframe: 1440, strategy: { basis: false } });
    expect(universeWithBasis(aus, champion(block()), ['GLD']).universe.symbols).toEqual(['AAPL', 'SPY', 'IEF', 'GLD']);
    // Unführbar (Zeitrahmen fremd) hilft auch eine offene Position nicht — das ist der Fall „ohne Führung" der Engine.
    expect(universeWithBasis(cfg, champion(block({ timeframe: 5 })), ['IEF'])).toBe(cfg);
  });

  it('WÄCHTER (M11): der Kandidatenpool der Config filtert den Korb — Fremdes kommt nicht ins Universum', () => {
    const mitPool = parseConfig({ universe: { symbols: ['AAPL'], candidates: ['SPY', 'GLD'] }, timeframe: 1440 });
    expect(universeWithBasis(mitPool, champion(block())).universe.symbols).toEqual(['AAPL', 'SPY', 'GLD']);
  });

  it('der Korb kommt als Ganzes — auch die Symbole, die der Alpha-Champion führt, bleiben im Universum', () => {
    const out = universeWithBasis(parseConfig({ universe: { symbols: ['AAPL'] }, timeframe: 1440 }), champion(block(), ['SPY']));
    expect(out.universe.symbols).toEqual(['AAPL', 'SPY', 'IEF', 'GLD']);
  });
});
