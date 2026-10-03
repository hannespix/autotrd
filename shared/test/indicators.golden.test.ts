/**
 * Golden-Tests: TS-Indikatoren vs. Python-`ta`-Referenz (MILESTONES M2).
 * Fixtures: reference/golden/indicators.json (Generator: gen_fixtures.py).
 * Toleranz 1e-9 (ARCHITECTURE §8) — Abweichungen darüber sind Parity-Brüche.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bollinger, ema, macd, sma, wilderRsi, type Series } from '../src/indicators.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../reference/golden/indicators.json',
);

interface Fixture {
  closes: number[];
  indicators: Record<string, (number | null)[]>;
}

const fixtures: Record<string, Fixture> = JSON.parse(readFileSync(fixturePath, 'utf8'));

const TOL = 1e-9;

function expectSeriesClose(actual: Series, expected: (number | null)[], label: string): void {
  expect(actual.length, `${label}: Länge`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const a = actual[i];
    if (e === null || e === undefined) {
      expect(a, `${label}[${i}]: erwartet null`).toBeNull();
    } else {
      expect(a, `${label}[${i}]: erwartet Zahl`).not.toBeNull();
      expect(Math.abs((a as number) - e), `${label}[${i}]: |Δ|`).toBeLessThanOrEqual(TOL);
    }
  }
}

describe.each(Object.entries(fixtures))('Golden-Parity %s', (_name, fx) => {
  it('RSI (Wilder) 7/14/21', () => {
    for (const w of [7, 14, 21]) {
      expectSeriesClose(wilderRsi(fx.closes, w), fx.indicators[`rsi_${w}`]!, `rsi_${w}`);
    }
  });

  it('MACD 12/26/9 (Linie, Signal, Histogramm)', () => {
    const m = macd(fx.closes, 12, 26, 9);
    expectSeriesClose(m.line, fx.indicators.macd_line!, 'macd_line');
    expectSeriesClose(m.signal, fx.indicators.macd_signal!, 'macd_signal');
    expectSeriesClose(m.histogram, fx.indicators.macd_histogram!, 'macd_histogram');
  });

  it('Bollinger 20/2 (ddof=0)', () => {
    const b = bollinger(fx.closes, 20, 2);
    expectSeriesClose(b.upper, fx.indicators.bb_upper!, 'bb_upper');
    expectSeriesClose(b.middle, fx.indicators.bb_middle!, 'bb_middle');
    expectSeriesClose(b.lower, fx.indicators.bb_lower!, 'bb_lower');
  });

  it('SMA-20 & EMA-20', () => {
    expectSeriesClose(sma(fx.closes, 20), fx.indicators.sma_20!, 'sma_20');
    expectSeriesClose(ema(fx.closes, 20), fx.indicators.ema_20!, 'ema_20');
  });
});
