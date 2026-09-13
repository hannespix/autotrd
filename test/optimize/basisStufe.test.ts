/**
 * Die Basis-Simulation des Optimierers trägt die Stufe `basis`.
 *
 * Der Fehler, gegen den das hier steht, hat einen ganzen Messlauf wertlos
 * gemacht und drei Tage lang eine Owner-Entscheidung blockiert:
 *
 * `WindowSimArgs` reichte kein `stufe` durch. Jede Position des Optimierers
 * lief deshalb als `other` — und `grenzenFuer(risk, 'other')` gibt die
 * GLOBALEN Notbremsen zurück. `risk.tiers.basis` erreichte die Messung nie.
 * Die Engine wendete Stufen-Bremsen an, der Optimierer nicht: zwei
 * Entscheidungspfade (§0.1) für dieselbe Frage.
 *
 * Sichtbar wurde es erst durch die Notbremsen-Bilanz im Bericht:
 *
 *     V3 (ohne tiers):        konto:daily_loss 3×   erste 2024-08-05
 *     V4 (tiers.basis 5/30):  other:daily_loss 3×   erste 2024-08-05
 *
 * Dieselben drei Tage, dieselbe Schwelle — die gelockerte Bremse war nie im
 * Spiel. V4 hat deshalb V3 reproduziert, und ich habe daraus zunächst den
 * falschen Schluss gezogen, die Tagesbremse sei nicht die Ursache.
 */
import { describe, expect, it } from 'vitest';
import { ALPHA_STUFE, BASIS_STUFE, grenzenFuer, stufeOf } from '../../src/risk/limits.ts';
import type { RiskConfig } from '../../src/core/config.ts';
import { ConfigSchema } from '../../src/core/config.ts';
import { simulateKorbWindow, simulateWindow } from '../../src/optimize/walkForward.ts';
import { OHNE_BREMSEN } from '../../src/core/types.ts';
import { msFromET } from '../../src/core/time.ts';
import { barsMap, baseConfig, strategyOf } from '../backtest/helpers.ts';

const riskMitStufen = (): RiskConfig => {
  const cfg = ConfigSchema.parse({ universe: { symbols: ['TEST'] } });
  return {
    ...cfg.risk,
    maxDailyLossPct: 2,
    maxDrawdownPct: 10,
    tiers: { alpha: { maxDailyLossPct: null, maxDrawdownPct: null }, basis: { maxDailyLossPct: 5, maxDrawdownPct: 30 } },
  };
};

describe('Stufe der Basis-Allokation', () => {
  it('WÄCHTER: `other` bekommt die GLOBALEN Bremsen — deshalb ist die falsche Stufe kein Fehler, sondern ein stiller Rückfall', () => {
    const risk = riskMitStufen();
    expect(grenzenFuer(risk, 'other')).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
    expect(grenzenFuer(risk, 'basis')).toEqual({ maxDailyLossPct: 5, maxDrawdownPct: 30 });
    // Genau diese beiden Zeilen sind der ganze Bug: Wer `basis` meint und
    // `other` liefert, bekommt keine Fehlermeldung, sondern die alte Schwelle.
  });

  it('WÄCHTER: die Konstante zeigt auf die Stufe, die `stufeOf` aus der Quelle `basis` ableitet', () => {
    expect(BASIS_STUFE).toBe('basis');
    expect(stufeOf(BASIS_STUFE)).toBe('basis');
    // Und die Gegenprobe: aus der Quelle der Engine kommt dieselbe Stufe.
    expect(stufeOf('basis')).toBe('basis');
    expect(grenzenFuer(riskMitStufen(), stufeOf(BASIS_STUFE))).toEqual({ maxDailyLossPct: 5, maxDrawdownPct: 30 });
  });

  it('ohne gesetzte tiers ist die Stufe folgenlos — der Fix ändert keine bestehende Messung', () => {
    const cfg = ConfigSchema.parse({ universe: { symbols: ['TEST'] } });
    for (const stufe of ['alpha', 'basis', 'other'] as const) {
      expect(grenzenFuer(cfg.risk, stufe)).toEqual({ maxDailyLossPct: cfg.risk.maxDailyLossPct, maxDrawdownPct: cfg.risk.maxDrawdownPct });
    }
  });
});

/*
 * Und der Wächter, der den Bug WIRKLICH gefangen hätte: nicht `grenzenFuer`,
 * sondern die Durchreichung durch `simulateWindow` — den Pfad, den der
 * Optimierer nimmt. Die drei Tests oben waren grün, während der Bug lebte.
 */
describe('simulateWindow reicht die Stufe an den Simulator durch', () => {
  it('WÄCHTER: die Wahl, die simulateWindow baut, trägt die übergebene Stufe', () => {
    let gesehen: string | undefined | null = null;
    simulateWindow({
      symbol: 'AAA',
      strategy: strategyOf({ id: 'x', timeframes: [1440], decide: () => ({ kind: 'hold' }) }),
      params: {},
      bars: barsMap({ AAA: [{ t: msFromET(2024, 1, 2, 9, 30), o: 100, h: 100, l: 100, c: 100, v: 1_000 }] }),
      config: baseConfig({ timeframe: 1440 }),
      initialEquity: 10_000,
      range: { start: 0, end: Number.MAX_SAFE_INTEGER },
      stufe: BASIS_STUFE,
      // Der Fake fängt ab, was `simulateWindow` dem Simulator übergibt.
      simulate: (input) => {
        gesehen = input.strategyFor('AAA')?.stufe;
        return { trades: [], equity: [], dailyReturns: [], metrics: {} as never, finalEquity: 10_000, notes: [], bremsen: OHNE_BREMSEN };
      },
    });
    expect(gesehen).toBe('basis');
  });

  it('WÄCHTER: ohne Angabe gilt `alpha` — `other` verlöre bei gesetzten tiers jeden eigenen Schutz', () => {
    let gesehen: string | undefined | null = 'nie gesetzt';
    simulateWindow({
      symbol: 'AAA',
      strategy: strategyOf({ id: 'x', timeframes: [1440], decide: () => ({ kind: 'hold' }) }),
      params: {},
      bars: barsMap({ AAA: [{ t: msFromET(2024, 1, 2, 9, 30), o: 100, h: 100, l: 100, c: 100, v: 1_000 }] }),
      config: baseConfig({ timeframe: 1440 }),
      initialEquity: 10_000,
      range: { start: 0, end: Number.MAX_SAFE_INTEGER },
      simulate: (input) => {
        gesehen = input.strategyFor('AAA')?.stufe;
        return { trades: [], equity: [], dailyReturns: [], metrics: {} as never, finalEquity: 10_000, notes: [], bremsen: OHNE_BREMSEN };
      },
    });
    // KORREKTUR (Prüferbefund M1): Die erste Begründung hier war falsch.
    // `other` IST geschützt — `grenzenFuer(risk,'other')` liefert die
    // globalen Werte, und `test/core/stufenbremse.test.ts` prüft genau das.
    // Die Vorgabe muss trotzdem `alpha` sein: Namensgleichheit mit
    // `stufeOf('champion')`, und eine künftige eigene `tiers.alpha`-Latte
    // wäre als `other` wirkungslos — ohne Fehlermeldung.
    expect(gesehen).toBe('alpha');
    expect(gesehen).toBe(ALPHA_STUFE);
  });

  it('WÄCHTER: eine eigene `tiers.alpha`-Latte wirkt NUR mit der Stufe `alpha` — als `other` bliebe sie stumm', () => {
    const risk = riskMitStufen();
    // Ohne eigene Alpha-Latte sind `alpha` und `other` gleichwertig: beide
    // erben die globalen 2 %/10 %. Der Unterschied entsteht erst, wenn das
    // Alpha eine eigene Latte bekommt — und dann ist er scharf.
    expect(grenzenFuer(risk, ALPHA_STUFE)).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
    const mitAlphaLatte: RiskConfig = { ...risk, tiers: { ...risk.tiers, alpha: { maxDailyLossPct: 1, maxDrawdownPct: 4 } } };
    expect(grenzenFuer(mitAlphaLatte, ALPHA_STUFE)).toEqual({ maxDailyLossPct: 1, maxDrawdownPct: 4 });
    // Dieselbe Config, Stufe `other`: die Latte des Alpha bleibt wirkungslos.
    expect(grenzenFuer(mitAlphaLatte, 'other')).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
  });
});

/*
 * Prüferbefund M3 (13.09.2026): Der Ensemble-Pfad hatte dasselbe Loch wie
 * `simulateWindow`, 55 Zeilen darunter — `Wahl` kannte kein `stufe`, und
 * `simulateKorbWindow` reichte die Wahl unverändert durch. Derselbe
 * Parametersatz mass über `simulateWindow` als `alpha` und über das Ensemble
 * als `other`: zwei Latten für eine Frage, latent bis jemand `risk.tiers`
 * setzt. `config/ensemble-1440.yaml` und `config/sleeves-1440.yaml` sind
 * aktive Configs.
 */
describe('simulateKorbWindow reicht die Stufe durch (Ensemble-Pfad)', () => {
  const wahl = (stufe?: string) => ({
    strategy: strategyOf({ id: 'x', timeframes: [1440], decide: () => ({ kind: 'hold' }) }),
    params: {},
    ...(stufe ? { stufe } : {}),
  });
  const einBar = barsMap({ AAA: [{ t: msFromET(2024, 1, 2, 9, 30), o: 100, h: 100, l: 100, c: 100, v: 1_000 }] });
  const fangen = (wahlFuer: (s: string) => ReturnType<typeof wahl> | null): string | undefined => {
    let gesehen: string | undefined;
    simulateKorbWindow({
      symbol: 'Ensemble',
      bars: einBar,
      korb: einBar,
      wahlFuer,
      config: baseConfig({ timeframe: 1440 }),
      initialEquity: 10_000,
      range: { start: 0, end: Number.MAX_SAFE_INTEGER },
      simulate: (input) => {
        gesehen = input.strategyFor('AAA')?.stufe;
        return { trades: [], equity: [], dailyReturns: [], metrics: {} as never, finalEquity: 10_000, notes: [], bremsen: OHNE_BREMSEN };
      },
    });
    return gesehen;
  };

  it('WÄCHTER: ohne Stufe in der Wahl gilt `alpha` — wie in simulateWindow, nicht `other`', () => {
    expect(fangen(() => wahl())).toBe('alpha');
  });

  it('eine ausdrückliche Stufe der Wahl gewinnt', () => {
    expect(fangen(() => wahl('basis'))).toBe('basis');
  });
});
