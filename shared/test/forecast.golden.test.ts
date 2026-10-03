/**
 * Golden-Parity Forecast: TS-Port vs. Python-Referenz (forecaster.compute).
 *
 * Die Fixtures stammen aus der Zeit, als die Prognose einen Sentiment-Tilt
 * kannte (`w × sentiment × vol`). Seit 28.07. gibt es den nicht mehr — der
 * Port kann also nur noch die Fälle nachrechnen, in denen der Tilt ohnehin
 * null war: `w == 0` ODER `sentiment == 0`. Das sind 252 der 540 Fälle, und
 * sie prüfen weiterhin das, worauf es ankommt: Regression, Residuen-Band,
 * Rundungen und vor allem die KALENDER-Logik über DST-Wechsel,
 * Wochenenden und Jahreswechsel.
 *
 * Die Fixtures werden bewusst NICHT neu erzeugt: Ein Golden-Test, dessen
 * Sollwerte man beim Umbau mitändert, prüft nichts mehr. Toleranz 1e-9.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeForecast, type ForecastComputation } from '../src/forecast.js';

interface FixtureCase {
  series: string;
  baseDate: string;
  sentiment: number;
  w: number;
  lookback: number;
  result: {
    points: Array<{ time: string; value: number }>;
    band: Array<{ time: string; upper: number; lower: number }>;
    slope: number;
    slope_adj: number;
    tilt: number;
    daily_vol: number;
    sigma: number;
    base_close: number;
    lookback: number;
  } | null;
}

const file = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../reference/golden/forecast.json'),
    'utf8',
  ),
) as { closes: Record<string, number[]>; cases: FixtureCase[] };

const TOL = 1e-9;
const close = (a: number, b: number, label: string): void => {
  expect(Math.abs(a - b), label).toBeLessThanOrEqual(TOL);
};

describe('Forecast-Golden-Parity (tilt-freie Fälle)', () => {
  it('alle tilt-freien Kombinationen matchen die Python-Referenz', () => {
    let checked = 0;
    for (const c of file.cases) {
      // Fälle MIT Tilt kann der Port nicht mehr reproduzieren — der Term
      // existiert nicht mehr. Sie zu „bestehen" wäre nur möglich, indem man
      // die Sollwerte anpasst; dann prüfte der Test nichts.
      if (c.w !== 0 && c.sentiment !== 0) continue;
      const closes = file.closes[c.series]!;
      const actual: ForecastComputation | null = computeForecast(
        closes, c.baseDate, 6, c.lookback,
      );
      const label = `${c.series}/${c.baseDate}/s${c.sentiment}/w${c.w}/lb${c.lookback}`;
      if (c.result === null) {
        expect(actual, label).toBeNull();
        continue;
      }
      expect(actual, label).not.toBeNull();
      const a = actual!;
      close(a.slope, c.result.slope, `${label}: slope`);
      close(a.slopeAdj, c.result.slope_adj, `${label}: slopeAdj`);
      close(c.result.tilt, 0, `${label}: Fixture ist tilt-frei`);
      close(a.dailyVol, c.result.daily_vol, `${label}: dailyVol`);
      close(a.sigma, c.result.sigma, `${label}: sigma`);
      close(a.baseClose, c.result.base_close, `${label}: baseClose`);
      expect(a.points.length, `${label}: points-Länge`).toBe(c.result.points.length);
      for (let i = 0; i < a.points.length; i++) {
        // Kalender-Parity: exakt dieselben Werktage (DST/Wochenende/Neujahr)
        expect(a.points[i]!.time, `${label}: Datum[${i}]`).toBe(c.result.points[i]!.time);
        close(a.points[i]!.value, c.result.points[i]!.value, `${label}: Wert[${i}]`);
        close(a.band[i]!.upper, c.result.band[i]!.upper, `${label}: upper[${i}]`);
        close(a.band[i]!.lower, c.result.band[i]!.lower, `${label}: lower[${i}]`);
      }
      checked += 1;
    }
    expect(checked, 'tilt-freie Fixtures').toBe(252);
  });
});
