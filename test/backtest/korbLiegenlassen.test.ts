import { describe, expect, it } from 'vitest';
import { marktKette, marktKetteAufAchse } from '../../src/backtest/marktbezug.ts';
import { sharpeRatio } from '../../src/backtest/metrics.ts';
import { DAY, dayKeyFor } from '../../src/core/time.ts';
import type { BarSeriesLike } from '../../src/core/types.ts';
import { T0, dailyBars } from '../optimize/fakes.ts';
import { seriesOf } from './helpers.ts';

/**
 * Prüfbefund M6 (Red-Team erster Champion): „Korb je Fold liegenlassen" als
 * zweite Maßstab-Zeile — nur Bericht. Wer aus einem Momentum-gekippten Korb
 * die Stärksten kauft, erbt den Tilt; die Zeile sagt, ob die Strategie ihren
 * eigenen Korb schlägt. Hier die Rechnung: `marktKetteAufAchse` mit Ständen
 * (Umschichtung zum Schluss des ersten Achsentags ≥ `ab`, Wert läuft weiter)
 * und `marktKette` mit Bars je Fenster (der per_fold-Weg).
 */

/** Krypto-Semantik der Fakes: jeder Kalendertag ist Handelstag, Tagesschlüssel = UTC-Datum. */
function serie(n: number, close: (k: number) => number): BarSeriesLike {
  return seriesOf(Array.from({ length: n }, (_, k) => ({ t: T0 + k * DAY, o: close(k), h: close(k), l: close(k), c: close(k), v: 1 })));
}
const tag = (k: number) => dayKeyFor(T0 + k * DAY, 'crypto');

describe('marktKetteAufAchse mit Ständen — der Korb je Fold liegengelassen', () => {
  // A verdoppelt sich über 10 Tage linear, B bleibt bei 100, C fällt linear auf 50.
  const bars = new Map<string, BarSeriesLike>([
    ['A', serie(11, (k) => 100 + 10 * k)],
    ['B', serie(11, () => 100)],
    ['C', serie(11, (k) => 100 - 5 * k)],
  ]);
  const achse = Array.from({ length: 11 }, (_, k) => tag(k));

  it('ohne Stände: alle Symbole am ersten Tag gleichgewichtet — identisch mit der Rechnung ohne Umschichtung', () => {
    const k = marktKetteAufAchse({ bars, dayKeys: achse, assetClass: 'crypto', periodsPerYear: 365 })!;
    expect(k.dailyReturns).toHaveLength(11);
    expect(k.dailyReturns[0]).toBe(0);
    // Tag 2: Mittel aus 110/100, 100/100, 95/100 = 1,01667
    expect(k.dailyReturns[1]).toBeCloseTo((110 / 100 + 1 + 95 / 100) / 3 - 1, 12);
    expect(k.netReturnPct).toBeCloseTo(((200 / 100 + 1 + 50 / 100) / 3 - 1) * 100, 9);
    expect(k.symbole).toBe(3);
  });

  it('WÄCHTER: Stand 2 ab Tag 6 nur {A}: zum Schluss von Tag 6 wird der Wert auf A umgeschichtet — der Wert läuft weiter, die Gewichte werden neu gesetzt', () => {
    const staende = [
      { ab: tag(0), symbols: new Set(['A', 'B', 'C']) },
      { ab: tag(5), symbols: new Set(['A']) },
    ];
    const k = marktKetteAufAchse({ bars, dayKeys: achse, assetClass: 'crypto', periodsPerYear: 365, staende })!;
    const ohne = marktKetteAufAchse({ bars, dayKeys: achse, assetClass: 'crypto', periodsPerYear: 365 })!;
    // Bis einschließlich Tag 6 (Index 5) identisch — die Umschichtung passiert zum Schluss dieses Tages.
    for (let d = 0; d <= 5; d++) expect(k.dailyReturns[d]).toBeCloseTo(ohne.dailyReturns[d]!, 12);
    // Danach nur noch A: Rendite von Tag 7 = 160/150 − 1.
    expect(k.dailyReturns[6]).toBeCloseTo(160 / 150 - 1, 12);
    expect(k.dailyReturns[10]).toBeCloseTo(200 / 190 - 1, 12);
    // Wertkontinuität: Endwert = Wert am Tag 6 × A-Faktor ab Tag 6.
    const wert6 = (150 / 100 + 1 + 75 / 100) / 3;
    expect(k.netReturnPct).toBeCloseTo((wert6 * (200 / 150) - 1) * 100, 9);
    expect(k.symbole).toBe(3); // je gehalten
    expect(k.sharpe).toBeCloseTo(sharpeRatio(k.dailyReturns, 365)!, 12);
  });

  it('ein Stand, dessen Mitglied am Umschichtungstag keinen Kurs hat, wird ohne dieses Mitglied gekauft; ein Stand vor der Achse gilt ab Tag 1', () => {
    const luecke = new Map<string, BarSeriesLike>([
      ['A', serie(11, (k) => 100 + 10 * k)],
      ['Z', serie(3, () => 50)], // nur Tage 1–3, ab Tag 6 kein Kurs mehr … aber Vortrag: 50 bleibt
      ['N', seriesOf([{ t: T0 + 8 * DAY, o: 10, h: 10, l: 10, c: 10, v: 1 }])], // erst ab Tag 9 einen Kurs
    ]);
    const staende = [
      { ab: tag(-3), symbols: new Set(['A', 'N']) }, // vor der Achse: gilt ab Tag 1 — N ohne Kurs ⇒ nur A
      { ab: tag(5), symbols: new Set(['A', 'N']) }, // Tag 6: N hat noch keinen Kurs ⇒ weiter nur A
    ];
    const k = marktKetteAufAchse({ bars: luecke, dayKeys: achse, assetClass: 'crypto', periodsPerYear: 365, staende })!;
    expect(k.symbole).toBe(1);
    expect(k.netReturnPct).toBeCloseTo(100, 9); // nur A: 100 → 200
    // Kein Mitglied mit Kurs ⇒ null
    expect(marktKetteAufAchse({ bars: luecke, dayKeys: achse, assetClass: 'crypto', periodsPerYear: 365, staende: [{ ab: tag(0), symbols: new Set(['N']) }] })).toBeNull();
  });
});

describe('marktKette mit Bars je Fenster — der per_fold-Weg des liegengelassenen Korbs', () => {
  const bars = new Map<string, BarSeriesLike>([
    ['A', dailyBars(60)],
    ['B', serie(60, (k) => 100 + k)],
  ]);
  const ranges = [
    { start: T0 + 10 * DAY, end: T0 + 30 * DAY },
    { start: T0 + 30 * DAY, end: T0 + 50 * DAY },
  ];
  it('WÄCHTER: barsFuer wählt je Fenster den Korb — Fenster 2 nur B ⇒ dessen Rendite, Fenster 1 gleichgewichtet', () => {
    const nurB = new Map([['B', bars.get('B')!]]);
    const k = marktKette({ bars, ranges, assetClass: 'crypto', periodsPerYear: 365, barsFuer: (r) => (r.start === ranges[1]!.start ? nurB : bars) })!;
    const beide = marktKette({ bars, ranges, assetClass: 'crypto', periodsPerYear: 365 })!;
    expect(k.fenster).toBe(2);
    // Fenster 1 identisch, Fenster 2 anders ⇒ die Kette unterscheidet sich
    expect(k.netReturnPct).not.toBeCloseTo(beide.netReturnPct, 9);
    // Fenster 2 nur B: 130 → 149 über 20 Tage (Kauf am ersten Tag des Fensters, Tag 30)
    const f1 = marktKette({ bars, ranges: [ranges[0]!], assetClass: 'crypto', periodsPerYear: 365 })!;
    expect(k.netReturnPct).toBeCloseTo(((1 + f1.netReturnPct / 100) * (149 / 130) - 1) * 100, 9);
  });
});
