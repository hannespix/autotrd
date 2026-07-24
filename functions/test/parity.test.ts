/**
 * M10-Parity-Test: der kompilierte Classic-Baum (compileClassic + evaluate)
 * muss auf VOLLSTÄNDIGEN Indikator-Daten exakt dieselbe Richtung liefern wie
 * die Konfluenz-Engine (computeSignal, M4). Beide Pfade sehen identische
 * Werte: der Baum-Kontext wird aus dem Snapshot der Engine selbst gebaut.
 *
 * Fixtures: deterministische Pseudo-Random-Walks (seeded LCG — kein
 * Math.random, reproduzierbar) × Config-Grid × Forecast-Varianten.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  compileClassic,
  evaluate,
  validateStrategySpec,
  type RuleContext,
  type SignalDirection,
  type Strategy,
} from '../../shared/src/index.js';
import { computeSignal, type ForecastVoteInput } from '../src/core/engine.js';

// ── deterministische Serien ──────────────────────────────────────────────────

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function makeSeries(seed: number, n = 60): number[] {
  const rnd = lcg(seed);
  const drift = (rnd() - 0.5) * 1.2; // Auf-/Abwärts-/Seitwärts-Regime je Seed
  let price = 80 + rnd() * 120;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    price = Math.max(1, price * (1 + drift / 100 + (rnd() - 0.5) * 0.04));
    out.push(Number(price.toFixed(4)));
  }
  return out;
}

function strat(patch: {
  rsi?: boolean;
  macd?: boolean;
  bb?: boolean;
  minConfluence?: number;
  useForecast?: boolean;
  forecastWeight?: number;
}): Strategy {
  const s = structuredClone(DEFAULT_STRATEGY);
  s.indicators.rsi.enabled = patch.rsi ?? true;
  s.indicators.macd.enabled = patch.macd ?? true;
  s.indicators.bollinger.enabled = patch.bb ?? true;
  s.signals.minConfluence = patch.minConfluence ?? 2;
  s.signals.useForecast = patch.useForecast ?? true;
  s.signals.forecastWeight = patch.forecastWeight ?? 2;
  return s;
}

/** Baum-Richtung aus der kompilierten Spec — Margin-Kodierung macht buy∧sell unmöglich. */
function treeDirection(s: Strategy, ctx: RuleContext): SignalDirection {
  const spec = compileClassic(s);
  expect(validateStrategySpec(spec)).toEqual([]); // Guards: Tiefe/Knoten/Threshold
  const buy = evaluate(spec.buy, ctx);
  const sell = evaluate(spec.sell, ctx);
  expect(buy && sell).toBe(false);
  return buy ? 'buy' : sell ? 'sell' : 'hold';
}

const CONFIGS: Array<[string, Strategy]> = [
  ['Default (alle an, minConf 2, Forecast w2)', strat({})],
  ['ohne Forecast', strat({ useForecast: false })],
  ['nur RSI+BB, minConf 1', strat({ macd: false, minConfluence: 1 })],
  ['minConf 3, Forecast w1', strat({ minConfluence: 3, forecastWeight: 1 })],
  ['nur MACD, minConf 1, ohne Forecast', strat({ rsi: false, bb: false, minConfluence: 1, useForecast: false })],
];

const FORECASTS: Array<ForecastVoteInput | null> = [
  null,
  { predictedPct: 2.4 },
  { predictedPct: -1.8 },
  { predictedPct: 0.1 }, // unter Threshold 0.5 → hold-Vote
];

describe('Parity: compileClassic ⇔ Konfluenz-Engine', () => {
  it('liefert auf 100 Serien × 5 Configs × 4 Forecasts identische Richtungen', () => {
    let nonHold = 0;
    let checked = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const closes = makeSeries(seed * 7919);
      const price = closes[closes.length - 1]!;
      for (const [, s] of CONFIGS) {
        for (const fc of FORECASTS) {
          // Parity gilt auf VOLLSTÄNDIGEN Daten: fehlt der Forecast, obwohl
          // die Config ihn nutzt, überspringt die Engine den Vote — der Baum
          // ist dann bewusst konservativer (eigener Doku-Test unten).
          if (fc === null && s.signals.useForecast && Math.trunc(s.signals.forecastWeight) > 0) {
            continue;
          }
          const eng = computeSignal(closes, price, s.indicators, s.signals, fc);
          // Beide Pfade sehen exakt dieselben Werte (Engine-Snapshot → Kontext)
          const ctx: RuleContext = {
            values: {
              price,
              rsi: eng.snapshot.rsi,
              macdLine: eng.snapshot.macd?.line,
              macdSignal: eng.snapshot.macd?.signal,
              macdHistogram: eng.snapshot.macd?.histogram,
              pctB: eng.snapshot.bollinger?.pctB,
            },
            forecastPct: fc?.predictedPct ?? null,
          };
          const tree = treeDirection(s, ctx);
          expect(tree, `Seed ${seed}, fc=${fc?.predictedPct ?? '–'}`).toBe(eng.direction);
          checked++;
          if (eng.direction !== 'hold') nonHold++;
        }
      }
    }
    // 3 der 5 Configs nutzen den Forecast → dort entfällt die fc=null-Kombi
    expect(checked).toBe(100 * (CONFIGS.length * FORECASTS.length - 3));
    // Der Test wäre wertlos, wenn alles nur „hold" wäre
    expect(nonHold).toBeGreaterThan(50);
  });

  it('Margin-Fall: buy erreicht Konfluenz, gewinnt aber nicht gegen sell', () => {
    // Konstruierter Kontext: RSI kauft, BB verkauft, Forecast (w2) verkauft →
    // buy=1, sell=3. minConf=1: Engine → sell; Baum muss dasselbe sagen.
    const s = strat({ macd: false, minConfluence: 1 });
    const ctx: RuleContext = {
      values: { price: 100, rsi: 20, pctB: 99 },
      forecastPct: -3,
    };
    const spec = compileClassic(s);
    expect(evaluate(spec.buy, ctx)).toBe(false);
    expect(evaluate(spec.sell, ctx)).toBe(true);
  });

  it('Patt (buy == sell) hält — beide Bäume false', () => {
    // RSI kauft (1), Forecast w1 verkauft (1) → 1:1 → Engine hält.
    const s = strat({ macd: false, bb: false, minConfluence: 1, forecastWeight: 1 });
    const ctx: RuleContext = { values: { price: 100, rsi: 20 }, forecastPct: -3 };
    const spec = compileClassic(s);
    expect(evaluate(spec.buy, ctx)).toBe(false);
    expect(evaluate(spec.sell, ctx)).toBe(false);
  });

  it('unerreichbare Konfluenz kompiliert zu Niemals-Bäumen', () => {
    const s = strat({ macd: false, bb: false, useForecast: false, minConfluence: 3 });
    const spec = compileClassic(s); // nur RSI (W=1), req=3 → Engine hält immer
    expect(validateStrategySpec(spec)).toEqual([]);
    expect(evaluate(spec.buy, { values: { price: 100, rsi: 5 } })).toBe(false);
    expect(evaluate(spec.sell, { values: { price: 100, rsi: 95 } })).toBe(false);
  });

  it('dokumentierte Abweichung: ENTSCHEIDEND fehlende Daten ⇒ Baum hält, Engine handelt', () => {
    // Nur RSI+MACD, minConf 1. RSI-Daten fehlen, MACD kauft: die Engine
    // überspringt RSI und kauft (1 ≥ 1). Im Baum könnte das unbekannte RSI
    // die Margin noch kippen → „unbekannt" → bewusst KEIN Trade.
    const s = strat({ bb: false, useForecast: false, minConfluence: 1 });
    const ctx: RuleContext = {
      values: { price: 100, rsi: null, macdLine: 1.2, macdSignal: 1.0, macdHistogram: 0.2 },
    };
    const spec = compileClassic(s);
    expect(evaluate(spec.buy, ctx)).toBe(false); // konservativ: kein Trade
    expect(evaluate(spec.sell, ctx)).toBe(false);

    // Gegenprobe: kann die Unbekannte das Ergebnis NICHT mehr kippen,
    // handelt auch der Baum — er ist nur so konservativ wie nötig.
    const ctx2: RuleContext = {
      values: { price: 100, rsi: null, macdLine: 1.2, macdSignal: 1.0, macdHistogram: 0.2, pctB: 2 },
      forecastPct: 2,
    };
    const s2 = strat({ minConfluence: 2 }); // MACD+BB+Forecast(w2) = 4 Votes reichen sicher
    expect(evaluate(compileClassic(s2).buy, ctx2)).toBe(true);
  });
});
