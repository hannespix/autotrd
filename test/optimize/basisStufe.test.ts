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
import { BASIS_STUFE, grenzenFuer, stufeOf } from '../../src/risk/limits.ts';
import type { RiskConfig } from '../../src/core/config.ts';
import { ConfigSchema } from '../../src/core/config.ts';
import { simulateWindow } from '../../src/optimize/walkForward.ts';
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

  it('ohne Angabe bleibt die Stufe offen — der Simulator setzt dann `other`', () => {
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
    expect(gesehen).toBe(undefined);
  });
});
