/**
 * Intraday-Kurzfrist-Prognose (Prognose 2.0 Teil 2): Zeitraster, Kausalität
 * und vor allem das BAR-REALISIERT-GATE — das Intraday-Pendant zum heiligen
 * Lookahead-Gate des Tages-Pfads.
 */
import { describe, expect, it } from 'vitest';
import {
  INTRADAY_HORIZON,
  INTRADAY_STEP_SEC,
  computeIntradayForecast,
  isIntradayForecastDue,
  scoreIntradayForecast,
} from '../src/forecast.js';

const BASE_T = 1_753_452_000; // beliebiger Bar-Start (UNIX-Sekunden)

const closesUp = Array.from({ length: 48 }, (_, i) => 100 + i * 0.1);

describe('computeIntradayForecast', () => {
  it('projiziert horizon Punkte im 5-min-Raster ab baseT', () => {
    const fc = computeIntradayForecast(closesUp, BASE_T);
    expect(fc).not.toBeNull();
    expect(fc!.points).toHaveLength(INTRADAY_HORIZON);
    fc!.points.forEach((p, i) => expect(p.t).toBe(BASE_T + (i + 1) * INTRADAY_STEP_SEC));
    expect(fc!.band).toHaveLength(INTRADAY_HORIZON);
  });

  it('steigender Trend ⇒ steigende Projektion über baseClose', () => {
    const fc = computeIntradayForecast(closesUp, BASE_T)!;
    expect(fc.points[INTRADAY_HORIZON - 1]!.value).toBeGreaterThan(fc.baseClose);
  });

  it('kausal: nutzt nur die übergebenen Closes (lookback-Segment)', () => {
    // identische letzte 24 Bars ⇒ identische Prognose, egal was davor kam
    const tail = closesUp.slice(-24);
    const a = computeIntradayForecast([...Array(24).fill(500), ...tail], BASE_T, 12, 24);
    const b = computeIntradayForecast(tail, BASE_T, 12, 24);
    expect(a!.points).toEqual(b!.points);
  });

  it('liefert null bei < 5 Bars', () => {
    expect(computeIntradayForecast([1, 2, 3, 4], BASE_T)).toBeNull();
  });
});

describe('isIntradayForecastDue (Bar-realisiert-Gate)', () => {
  const points = [{ t: BASE_T + 300 }, { t: BASE_T + 600 }];

  it('nicht fällig, solange der letzte Bar noch läuft', () => {
    // letzter Bar startet BASE_T+600, läuft bis BASE_T+900
    expect(isIntradayForecastDue(points, BASE_T + 600)).toBe(false);
    expect(isIntradayForecastDue(points, BASE_T + 899)).toBe(false);
  });

  it('fällig exakt ab Bar-Abschluss (Start + Bar-Länge)', () => {
    expect(isIntradayForecastDue(points, BASE_T + 900)).toBe(true);
  });

  it('leere Punktliste nie fällig', () => {
    expect(isIntradayForecastDue([], BASE_T + 10_000)).toBe(false);
  });
});

describe('scoreIntradayForecast', () => {
  const points = [
    { t: BASE_T + 300, value: 101 },
    { t: BASE_T + 600, value: 102 },
  ];

  it('ohne realisierten LETZTEN Bar kein Score (Gate-Semantik)', () => {
    const actuals = { [String(BASE_T + 300)]: 100.5 };
    expect(scoreIntradayForecast(points, 100, actuals)).toBeNull();
  });

  it('bewertet MAE + Richtung gegen realisierte Closes', () => {
    const actuals = { [String(BASE_T + 300)]: 100.5, [String(BASE_T + 600)]: 101.5 };
    const s = scoreIntradayForecast(points, 100, actuals)!;
    expect(s.nPoints).toBe(2);
    expect(s.dirHit).toBe(true); // beide über baseClose
    expect(s.maePct).toBeGreaterThan(0);
  });

  it('Lücken (fehlende Zwischen-Bars) werden übersprungen', () => {
    const actuals = { [String(BASE_T + 600)]: 99 };
    const s = scoreIntradayForecast(points, 100, actuals)!;
    expect(s.nPoints).toBe(1);
    expect(s.dirHit).toBe(false); // prognostiziert ↑, realisiert ↓
  });
});
