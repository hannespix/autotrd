/**
 * Die Match-Kette der Intraday-Bewertung — isoliert nachgestellt.
 *
 * Live standen am 28.07. 150 fällige Prognosen im Zweig „unrealized", also
 * `scoreIntradayForecast` lieferte für JEDE null. Weil alle drei Bausteine
 * (Punkte erzeugen, Bars speichern, Punkte gegen Bars matchen) für sich
 * plausibel aussehen, muss ihr ZUSAMMENSPIEL geprüft werden — genau das
 * fällt sonst durch jede Lücke zwischen den Modultests.
 *
 * Der Test baut die Kette so nach, wie sie im Scan entsteht:
 *   Bars (5-min-Raster) → computeIntradayForecast → Punkte
 *   dieselben Bars → actuals-Map (wie loadIntradayActuals sie baut)
 *   → scoreIntradayForecast
 */

import { describe, expect, it } from 'vitest';
import {
  INTRADAY_HORIZON,
  INTRADAY_STEP_SEC,
  computeIntradayForecast,
  isIntradayForecastDue,
  scoreIntradayForecast,
} from '../../shared/src/index.js';

/** Ein 5-min-Raster ab `start`, wie Yahoo es für Krypto liefert. */
const bars = (start: number, n: number, preis = (i: number): number => 100 + i * 0.1) =>
  Array.from({ length: n }, (_, i) => ({ t: start + i * INTRADAY_STEP_SEC, c: preis(i) }));

/** Baut die Actuals-Map exakt wie `loadIntradayActuals`: Schlüssel = String(t). */
const actualsAus = (b: Array<{ t: number; c: number }>): Record<string, number> =>
  Object.fromEntries(b.filter((x) => x.c > 0).map((x) => [String(x.t), x.c]));

// Eine volle Stunde (baseT % 3600 === 0) — nur dann loggt der Scan Shadows.
const BASE_T = 1_753_452_000;

describe('Intraday-Match: Punkte gegen gespeicherte Bars', () => {
  it('lückenloses Raster ⇒ Score (die Kette funktioniert grundsätzlich)', () => {
    const historie = bars(BASE_T - 40 * INTRADAY_STEP_SEC, 41);
    const fc = computeIntradayForecast(
      historie.map((b) => b.c),
      BASE_T,
    )!;
    expect(fc).not.toBeNull();

    // Zukunft: die 12 Bars, die der Horizont abdeckt
    const zukunft = bars(BASE_T + INTRADAY_STEP_SEC, INTRADAY_HORIZON, (i) => 104 + i * 0.1);
    const score = scoreIntradayForecast(fc.points, fc.baseClose, actualsAus([...historie, ...zukunft]));

    expect(score, 'lückenloses Raster muss scoren').not.toBeNull();
    expect(score!.nPoints).toBe(INTRADAY_HORIZON);
  });

  it('der LETZTE Punkt entscheidet — fehlt er, gibt es gar keinen Score', () => {
    // Der scharfe Fall: 11 von 12 Bars da, nur der Schluss-Bar fehlt.
    // scoreForecast bricht dann ab, obwohl 11 Punkte auswertbar wären.
    // Genau so sieht „unrealized" in der Praxis aus.
    const historie = bars(BASE_T - 40 * INTRADAY_STEP_SEC, 41);
    const fc = computeIntradayForecast(
      historie.map((b) => b.c),
      BASE_T,
    )!;
    const fastAlles = bars(BASE_T + INTRADAY_STEP_SEC, INTRADAY_HORIZON - 1, (i) => 104 + i * 0.1);

    expect(
      scoreIntradayForecast(fc.points, fc.baseClose, actualsAus([...historie, ...fastAlles])),
      'ohne Schluss-Bar kein Score — Gate bleibt heilig',
    ).toBeNull();
  });

  it('ein Raster-Versatz von einer Sekunde killt JEDEN Match', () => {
    // Der Verdacht aus der Live-Diagnose: Punkte werden als baseT + k*300
    // gerechnet, die Actuals-Schlüssel kommen aus den Yahoo-Zeitstempeln.
    // Liegen die auch nur eine Sekunde daneben, trifft kein einziger
    // Schlüssel — und ALLE Prognosen landen in „unrealized", nicht nur
    // einzelne. Das erklärt eine 150 von 150 weit besser als Marktlücken.
    const historie = bars(BASE_T - 40 * INTRADAY_STEP_SEC, 41);
    const fc = computeIntradayForecast(
      historie.map((b) => b.c),
      BASE_T,
    )!;
    const versetzt = bars(BASE_T + INTRADAY_STEP_SEC + 1, INTRADAY_HORIZON, (i) => 104 + i * 0.1);

    expect(
      scoreIntradayForecast(fc.points, fc.baseClose, actualsAus([...historie, ...versetzt])),
      'ein Sekunden-Versatz darf nicht stillschweigend zu null führen',
    ).toBeNull();
  });

  it('Fälligkeit und Bewertbarkeit sind ZWEI Dinge', () => {
    // isIntradayForecastDue prüft nur die UHR, nicht die Daten. Eine
    // Prognose kann fällig sein und trotzdem nicht bewertbar — der Grund,
    // warum es den Zähler „unrealized" überhaupt gibt.
    const historie = bars(BASE_T - 40 * INTRADAY_STEP_SEC, 41);
    const fc = computeIntradayForecast(
      historie.map((b) => b.c),
      BASE_T,
    )!;
    const nachHorizont = BASE_T + (INTRADAY_HORIZON + 1) * INTRADAY_STEP_SEC;

    expect(isIntradayForecastDue(fc.points, nachHorizont), 'Uhr sagt: fällig').toBe(true);
    expect(
      scoreIntradayForecast(fc.points, fc.baseClose, actualsAus(historie)),
      'Daten sagen: nicht bewertbar',
    ).toBeNull();
  });

  it('Punkte liegen auf demselben 300er-Raster wie die Bars', () => {
    // Die Invariante, auf der die ganze Kette steht. Bricht sie, matcht
    // nichts mehr — und zwar lautlos.
    const historie = bars(BASE_T - 40 * INTRADAY_STEP_SEC, 41);
    const fc = computeIntradayForecast(
      historie.map((b) => b.c),
      BASE_T,
    )!;
    fc.points.forEach((p, i) => {
      expect(p.t, `Punkt ${i}`).toBe(BASE_T + (i + 1) * INTRADAY_STEP_SEC);
      expect((p.t - BASE_T) % INTRADAY_STEP_SEC).toBe(0);
    });
  });
});
