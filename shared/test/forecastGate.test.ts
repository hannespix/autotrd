/**
 * LOOKAHEAD-GATE-Tests (CLAUDE.md §5 — das Gate ist heilig).
 * Adversariale Fälle: Bewertung vor Realisierung MUSS scheitern; fehlender
 * End-Tag MUSS blocken; Feiertagslücken dürfen nur Zwischen-Tage überspringen.
 */
import { describe, expect, it } from 'vitest';
import {
  bestParams,
  comboKey,
  isForecastDue,
  nextWeekdays,
  scoreForecast,
  DEFAULT_LOOKBACK,
  DEFAULT_W,
} from '../src/forecast.js';

const pts = (days: string[], values: number[]) =>
  days.map((time, i) => ({ time, value: values[i] ?? 100 }));

describe('isForecastDue — strikt base_date/Horizont < heute', () => {
  const horizon = pts(['2026-07-20', '2026-07-21', '2026-07-22'], [100, 101, 102]);

  it('letzter Horizont-Tag < heute → fällig', () => {
    expect(isForecastDue(horizon, '2026-07-23')).toBe(true);
  });

  it('ADVERSARIAL: letzter Horizont-Tag == heute → NICHT fällig (Bar unfertig)', () => {
    expect(isForecastDue(horizon, '2026-07-22')).toBe(false);
  });

  it('ADVERSARIAL: Horizont in der Zukunft → NICHT fällig', () => {
    expect(isForecastDue(horizon, '2026-07-21')).toBe(false);
    expect(isForecastDue(horizon, '2026-07-01')).toBe(false);
  });

  it('leere Punktliste → nie fällig', () => {
    expect(isForecastDue([], '2026-07-23')).toBe(false);
  });
});

describe('scoreForecast — realisierte Closes, Endtag-Pflicht', () => {
  const p = pts(['2026-07-20', '2026-07-21', '2026-07-22'], [100, 102, 104]);

  it('bewertet vollständig realisierte Prognosen (MAE + Richtungs-Hit)', () => {
    const s = scoreForecast(p, 99, { '2026-07-20': 100, '2026-07-21': 101, '2026-07-22': 103 });
    expect(s).not.toBeNull();
    expect(s!.nPoints).toBe(3);
    expect(s!.dirHit).toBe(true); // pred 104 > base 99, act 103 > base 99
    expect(s!.maePct).toBeGreaterThan(0);
  });

  it('ADVERSARIAL: fehlender Close am END-Tag → kein Score (nie Teil-Bewertung festschreiben)', () => {
    expect(scoreForecast(p, 99, { '2026-07-20': 100, '2026-07-21': 101 })).toBeNull();
    expect(scoreForecast(p, 99, { '2026-07-20': 100, '2026-07-21': 101, '2026-07-22': 0 })).toBeNull();
  });

  it('Feiertagslücke in der Mitte wird übersprungen, Endtag zählt', () => {
    const s = scoreForecast(p, 99, { '2026-07-20': 100, '2026-07-22': 103 }); // 21. = Feiertag
    expect(s).not.toBeNull();
    expect(s!.nPoints).toBe(2);
  });

  it('Richtungs-Miss wird als solcher gewertet', () => {
    const s = scoreForecast(p, 99, { '2026-07-22': 95 }); // pred hoch, real runter
    expect(s!.dirHit).toBe(false);
  });
});

describe('nextWeekdays — Kalender (DST-neutral via UTC)', () => {
  it('Freitag → Montag (Wochenende übersprungen), über US-DST-Beginn hinweg', () => {
    // 2026-03-06 ist Freitag; 8. März = DST-Beginn in den USA
    expect(nextWeekdays('2026-03-06', 3)).toEqual(['2026-03-09', '2026-03-10', '2026-03-11']);
  });

  it('Jahreswechsel', () => {
    expect(nextWeekdays('2025-12-31', 2)).toEqual(['2026-01-01', '2026-01-02']);
  });
});

describe('bestParams — Self-Tuning ohne Lookahead', () => {
  it('Defaults, solange zu wenig Evidenz (MIN_TOTAL)', () => {
    expect(bestParams({})).toEqual({ w: DEFAULT_W, lookback: DEFAULT_LOOKBACK });
    expect(bestParams({ [comboKey(1, 10)]: { n: 5, hits: 5, maeSum: 1 } }))
      .toEqual({ w: DEFAULT_W, lookback: DEFAULT_LOOKBACK });
  });

  it('wählt beste Richtungs-Quote, Tiebreak niedrigste MAE', () => {
    const combos = {
      [comboKey(0.25, 10)]: { n: 10, hits: 9, maeSum: 30 }, // 90 %, MAE 3.0
      [comboKey(0.5, 20)]: { n: 10, hits: 9, maeSum: 20 },  // 90 %, MAE 2.0 ← Gewinner
      [comboKey(1, 30)]: { n: 10, hits: 7, maeSum: 5 },     // 70 %
    };
    expect(bestParams(combos)).toEqual({ w: 0.5, lookback: 20 });
  });

  it('ignoriert Kombis unter MIN_SAMPLES_PER_COMBO', () => {
    const combos = {
      [comboKey(1, 30)]: { n: 2, hits: 2, maeSum: 0.1 }, // perfekt, aber n<8
      [comboKey(0.25, 10)]: { n: 20, hits: 12, maeSum: 40 },
    };
    expect(bestParams(combos)).toEqual({ w: 0.25, lookback: 10 });
  });
});
