/**
 * Prognose 2.0 Teil 3: Feature-Regressoren (kausal, gedeckelt) und
 * Band-Kalibrierung aus der REALISIERTEN Fehlerverteilung. Die V1-Kerne
 * bleiben Golden-Parity — hier wird nur das V2-Delta geprüft.
 */
import { describe, expect, it } from 'vitest';
import {
  CALIB_MAX,
  CALIB_MIN,
  MIN_SAMPLES_PER_COMBO,
  TILT_CAP,
  VOL_REGIME_MAX,
  VOL_REGIME_MIN,
  applyBandCalibration,
  computeForecast,
  computeForecastV2,
  computeIntradayForecastV2,
  forecastFeatures,
} from '../src/forecast.js';

/** Deterministische Pseudo-Kurse: Trend + milde Wellen (kein Math.random). */
const wave = (n: number, drift: number, amp = 1): number[] =>
  Array.from({ length: n }, (_, i) => 100 + i * drift + amp * Math.sin(i * 0.7));

describe('forecastFeatures', () => {
  it('starker Aufwärtstrend: RSI überkauft ⇒ Mean-Reversion negativ, MACD-Momentum positiv', () => {
    const f = forecastFeatures(wave(60, 0.8, 0.2), 20);
    expect(f.rsiState).toBeLessThan(0);
    expect(f.macdMom).toBeGreaterThan(0);
  });

  it('Vola-Regime bleibt im Clamp-Fenster', () => {
    const calm = [...wave(60, 0.05, 0.1), ...wave(30, 0, 3).map((v, i) => v + i)];
    const f = forecastFeatures(calm, 20);
    expect(f.volRegime).toBeGreaterThanOrEqual(VOL_REGIME_MIN);
    expect(f.volRegime).toBeLessThanOrEqual(VOL_REGIME_MAX);
  });

  it('kausal: identische letzte Closes vor Indikator-Fenster ⇒ gleiche Werte wie eigener Aufruf', () => {
    const closes = wave(80, 0.3);
    const a = forecastFeatures(closes, 20);
    const b = forecastFeatures([...closes], 20);
    expect(a).toEqual(b);
  });

  it('zu kurze Historie: neutrale Beiträge statt NaN', () => {
    const f = forecastFeatures([100, 101, 102], 20);
    expect(Number.isFinite(f.signal)).toBe(true);
    expect(f.rsiState).toBe(0); // RSI braucht 15 Bars
  });
});

describe('computeForecastV2', () => {
  const closes = wave(60, 0.5, 0.3);

  it('Punkt-Verschiebung gegenüber V1 respektiert den Feature-Tilt-Cap je Schritt', () => {
    const v1 = computeForecast(closes, '2026-07-20')!;
    const v2 = computeForecastV2(closes, '2026-07-20')!;
    const cap = TILT_CAP * v1.dailyVol;
    v2.points.forEach((p, i) => {
      expect(Math.abs(p.value - v1.points[i]!.value)).toBeLessThanOrEqual(cap * (i + 1) + 1e-6);
    });
    expect(v2.features).toBeDefined();
  });

  it('Band ist im turbulenten Regime mindestens so breit wie V1', () => {
    const v1 = computeForecast(closes, '2026-07-20')!;
    const v2 = computeForecastV2(closes, '2026-07-20')!;
    v2.band.forEach((b, i) => {
      const w1 = v1.band[i]!.upper - v1.band[i]!.lower;
      expect(b.upper - b.lower).toBeGreaterThanOrEqual(w1 - 1e-6);
    });
  });

  it('liefert null bei < 5 Bars (wie V1)', () => {
    expect(computeForecastV2([1, 2, 3], '2026-07-20')).toBeNull();
  });

  it('Intraday-V2: gleiche Zeitachse wie V1, Features vorhanden', () => {
    const v2 = computeIntradayForecastV2(closes, 1_753_452_000)!;
    expect(v2.points[0]!.t).toBe(1_753_452_000 + 300);
    expect(v2.features.volRegime).toBeGreaterThan(0);
  });
});

describe('applyBandCalibration', () => {
  const fc = computeForecast(wave(60, 0.5, 0.3), '2026-07-20')!;

  it('ohne Kombi-Evidenz (n < Minimum): unverändert, calib null', () => {
    const { fc: out, calib } = applyBandCalibration(fc, { n: MIN_SAMPLES_PER_COMBO - 1, hits: 3, maeSum: 5 });
    expect(calib).toBeNull();
    expect(out.band).toEqual(fc.band);
  });

  it('große realisierte MAE weitet das Band (s > 1), Mitte bleibt', () => {
    const maePct = 5; // 5 % realisierter Fehler — weit über dem Regressions-σ
    const { fc: out, calib } = applyBandCalibration(fc, { n: 10, hits: 5, maeSum: maePct * 10 });
    expect(calib).not.toBeNull();
    expect(calib!.s).toBeGreaterThan(1);
    out.band.forEach((b, i) => {
      const w0 = fc.band[i]!.upper - fc.band[i]!.lower;
      expect(b.upper - b.lower).toBeGreaterThan(w0);
      const mid0 = (fc.band[i]!.upper + fc.band[i]!.lower) / 2;
      expect((b.upper + b.lower) / 2).toBeCloseTo(mid0, 3);
    });
  });

  it('winzige realisierte MAE engt das Band ein, aber nie unter CALIB_MIN', () => {
    const { calib } = applyBandCalibration(fc, { n: 20, hits: 15, maeSum: 0.02 });
    expect(calib!.s).toBeGreaterThanOrEqual(CALIB_MIN);
    expect(calib!.s).toBeLessThan(1);
  });

  it('Clamp nach oben (CALIB_MAX)', () => {
    const { calib } = applyBandCalibration(fc, { n: 20, hits: 5, maeSum: 20 * 50 });
    expect(calib!.s).toBe(CALIB_MAX);
  });
});
