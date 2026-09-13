/**
 * Der risikolose Zins in der Messung (Befund B2 vom 12.09.2026,
 * Vorregistrierung `docs/wissen/vorregistrierung/2026-09-13-sharpe-gegen-zins.md`).
 *
 * Zwei Dinge werden hier bewiesen, nicht behauptet:
 * 1. Ein Sharpe gegen NULL verbucht Bargeld als Kante — gegen den Zins
 *    gerechnet bleibt davon nichts.
 * 2. Die Zinsreihe liegt TAGGENAU auf den Renditen. Ein Versatz um einen Tag
 *    wäre ein neuer, subtilerer Messfehler als der behobene; er ist deshalb
 *    ein Fehler, kein stilles Ergebnis.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { dayKeyFor } from '../../src/core/time.ts';
import {
  RISK_FREE_MAX_GAP,
  alignRiskFree,
  excessReturns,
  probabilisticSharpeOfReturns,
  riskFreeFromBars,
  sharpeRatio,
  tagesachse,
} from '../../src/backtest/metrics.ts';

const DAY = 86_400_000;
/** 2024-01-02, 21:00 UTC = 16:00 ET — Tagesschluss einer regulären Sitzung. */
const T0 = Date.UTC(2024, 0, 2, 21, 0);

/** Geldmarkt-Bars aus vorgegebenen Tagesrenditen: c₀ = 100, cᵢ = cᵢ₋₁·(1+rᵢ). */
function geldmarktBars(renditen: readonly number[], start = T0): BarSeries {
  let c = 100;
  const bars = [{ t: start, o: c, h: c, l: c, c, v: 1 }];
  for (let i = 0; i < renditen.length; i++) {
    c = c * (1 + renditen[i]!);
    bars.push({ t: start + (i + 1) * DAY, o: c, h: c, l: c, c, v: 1 });
  }
  return BarSeries.from(bars);
}

const tage = (n: number, start = T0): string[] => Array.from({ length: n }, (_, i) => dayKeyFor(start + i * DAY, 'us_equity'));

describe('Zinsreihe aus dem Geldmarkt-Symbol', () => {
  it('Tagesrendite je Tag = Schluss/Vortagsschluss − 1; der erste Tag hat keinen Satz', () => {
    const rf = riskFreeFromBars({ symbol: 'BIL', bars: geldmarktBars([0.0002, 0.0001, 0.0003]), assetClass: 'us_equity' });
    expect(rf).not.toBeNull();
    const t = tage(4);
    // Tag 0 ist der Startschluss — ohne Vortag gibt es für ihn keinen Satz.
    expect(rf!.perDay.has(t[0]!)).toBe(false);
    expect(rf!.perDay.get(t[1]!)).toBeCloseTo(0.0002, 12);
    expect(rf!.perDay.get(t[2]!)).toBeCloseTo(0.0001, 12);
    expect(rf!.perDay.get(t[3]!)).toBeCloseTo(0.0003, 12);
  });

  it('je Handelstag zählt die LETZTE Bar; unter zwei Tagen gibt es keine Reihe', () => {
    const mehrfach = BarSeries.from([
      { t: T0 - 3 * 3_600_000, o: 100, h: 100, l: 100, c: 100, v: 1 },
      { t: T0, o: 100, h: 100, l: 100, c: 101, v: 1 },
      { t: T0 + DAY, o: 101, h: 101, l: 101, c: 102.01, v: 1 },
    ]);
    const rf = riskFreeFromBars({ symbol: 'BIL', bars: mehrfach, assetClass: 'us_equity' });
    // 101 ist der Schluss des ersten Tages (nicht 100), also 102,01/101 − 1 = 1 %.
    expect(rf!.perDay.get(tage(2)[1]!)).toBeCloseTo(0.01, 12);
    expect(riskFreeFromBars({ symbol: 'BIL', bars: geldmarktBars([]), assetClass: 'us_equity' })).toBeNull();
  });
});

describe('Ausrichtung der Zinsreihe', () => {
  const renditen = Array.from({ length: 20 }, (_, i) => 0.0001 + i * 0.00001);
  const rf = riskFreeFromBars({ symbol: 'BIL', bars: geldmarktBars(renditen), assetClass: 'us_equity' })!;

  /**
   * DER Wächter dieser Änderung. Die Reihe wird über die GANZE Historie
   * gebildet, nicht über das Fenster — sonst fehlte dem ersten Tag jedes
   * Fensters sein Vortagsschluss, und alles verrutschte um einen Tag. Ein
   * solcher Versatz sähe in jeder Kennzahl plausibel aus.
   */
  it('Ausrichtung: der Satz zum ersten Tag eines Fensters ist der DIESES Tages, nicht der des Vortags', () => {
    // Fenster ab Tag 10 (mitten in der Historie), fünf Tage lang.
    const achse = tage(5, T0 + 10 * DAY);
    const aus = alignRiskFree(achse, rf)!;
    expect(aus.rates).toHaveLength(5);
    expect(aus.missing).toBe(0);
    // renditen[i] ist die Rendite von Tag i+1 ⇒ Tag 10 trägt renditen[9].
    expect(aus.rates[0]).toBeCloseTo(renditen[9]!, 12);
    expect(aus.rates[4]).toBeCloseTo(renditen[13]!, 12);
    // Der Vortagssatz ist ausdrücklich NICHT der erste Wert.
    expect(aus.rates[0]).not.toBeCloseTo(renditen[8]!, 12);
  });

  it('Lücken zählen und stehen in der Quelle; über 2 % gibt es keine Reihe (⇒ Rückfall auf null)', () => {
    // 60 Tage Achse, aber nur 20 Tage Zinsreihe ⇒ weit über der Toleranz.
    expect(alignRiskFree(tage(60), rf)).toBeNull();
    expect(alignRiskFree([], rf)).toBeNull();
    // Genau ein fehlender Tag von 100 liegt unter der Toleranz (1 % ≤ 2 %).
    const lang = riskFreeFromBars({ symbol: 'BIL', bars: geldmarktBars(Array.from({ length: 120 }, () => 0.0001)), assetClass: 'us_equity' })!;
    const achse = tage(100, T0 + DAY);
    const mitLuecke = new Map(lang.perDay);
    mitLuecke.delete(achse[42]!);
    const aus = alignRiskFree(achse, { symbol: 'BIL', perDay: mitLuecke })!;
    expect(aus.missing).toBe(1);
    expect(aus.covered).toBe(99);
    expect(aus.rates[42]).toBe(0);
    expect(aus.quelle).toContain('BIL über dieselben Tage');
    expect(aus.quelle).toContain('99 von 100 belegt');
    expect(RISK_FREE_MAX_GAP).toBe(0.02);
  });

  it('Tagesachse: je Handelstag EIN Schlüssel, in Reihenfolge — auch bei mehreren Bars je Tag', () => {
    const equity = [
      { t: T0, equity: 100 },
      { t: T0 + 3_600_000, equity: 101 },
      { t: T0 + DAY, equity: 102 },
      { t: T0 + DAY + 60_000, equity: 103 },
      { t: T0 + 2 * DAY, equity: 104 },
    ];
    expect(tagesachse(equity, 'us_equity')).toEqual(tage(3));
    expect(tagesachse([], 'us_equity')).toEqual([]);
  });

  it('excessReturns wirft bei Längenversatz — ein verrutschter Zins ist ein Fehler, kein Ergebnis', () => {
    expect(() => excessReturns([0.01, 0.02, 0.03], [0.0001, 0.0001])).toThrow(/nicht ausgerichtet: 3 Renditen, 2 Sätze/);
    expect(() => sharpeRatio([0.01, 0.02, 0.03], 252, [0.0001, 0.0001])).toThrow(/nicht ausgerichtet/);
    const ex = excessReturns([0.01, 0.02], [0.001, 0.002]);
    expect(ex[0]).toBeCloseTo(0.009, 12);
    expect(ex[1]).toBeCloseTo(0.018, 12);
  });
});

/* ───────────────────────── Der Beweis ───────────────────────── */

/**
 * Eine Strategie, die NUR den Geldmarkt hält: Rendite = Zinsreihe plus ein
 * kleines, mittelwertfreies Handelsrauschen. Ohne Zins ist sie ein
 * Wunderwerk, mit Zins ist sie genau das, was sie ist — nichts.
 */
const N = 504;
const M = 0.04 / 252; // ≈ 4 % p. a. kurzer Zins
const zinsRauschen = 2e-5;
const handelsRauschen = 5e-5;
const zinsReihe = Array.from({ length: N }, (_, i) => M + zinsRauschen * (i % 2 === 0 ? 1 : -1));
const nurGeldmarkt = zinsReihe.map((r, i) => r + handelsRauschen * (Math.floor(i / 2) % 2 === 0 ? 1 : -1));

describe('Bargeld ist keine Kante (Befund B2)', () => {
  it('nur Geldmarkt halten: Sharpe 46,7 gegen sr0 = 0 — gegen den Zins 0,0', () => {
    const ohneZins = sharpeRatio(nurGeldmarkt, 252)!;
    const mitZins = sharpeRatio(nurGeldmarkt, 252, zinsReihe)!;
    expect(ohneZins).toBeCloseTo(46.7, 1);
    expect(ohneZins).toBeGreaterThan(5);
    expect(mitZins).toBeCloseTo(0, 6);
    expect(Math.abs(mitZins)).toBeLessThan(0.1);
  });

  it('PSR derselben Reihe: 1,000 (besteht das Gate 0,9) gegen 0,500 (fällt durch)', () => {
    const ohneZins = probabilisticSharpeOfReturns({ returns: nurGeldmarkt })!;
    const mitZins = probabilisticSharpeOfReturns({ returns: nurGeldmarkt, riskFree: zinsReihe })!;
    expect(ohneZins.ueberschuss).toBe(false);
    expect(ohneZins.psr).toBeCloseTo(1, 6);
    expect(ohneZins.psr).toBeGreaterThanOrEqual(0.9);
    expect(mitZins.ueberschuss).toBe(true);
    expect(mitZins.psr).toBeCloseTo(0.5, 6);
    expect(mitZins.psr).toBeLessThan(0.9);
    // Schiefe und Kurtosis stammen aus DERSELBEN Reihe wie der Sharpe.
    expect(mitZins.sr).toBeCloseTo(0, 9);
    expect(mitZins.n).toBe(N);
  });

  it('der Zins misst sich selbst zu null, nicht zu 125,9', () => {
    // Dieselbe Reihe gegen sich selbst: ohne Zins ein Sharpe von 125,9 …
    expect(sharpeRatio(zinsReihe, 252)!).toBeCloseTo(125.9, 1);
    // … mit Zins bleibt eine Reihe aus Nullen, deren Sharpe nicht definiert ist.
    expect(sharpeRatio(zinsReihe, 252, zinsReihe)).toBeNull();
  });

  it('eine echte Aktienreihe verliert nur rf/σ — die Latte sinkt mit, nicht gegen den Trend', () => {
    // Marktartige Reihe: 8 % p. a. Ertrag, ~16 % p. a. Schwankung.
    const markt = Array.from({ length: N }, (_, i) => 0.08 / 252 + 0.01 * (i % 2 === 0 ? 1 : -1));
    const ohneZins = sharpeRatio(markt, 252)!;
    const mitZins = sharpeRatio(markt, 252, zinsReihe)!;
    const sigma = 0.01 * Math.sqrt(252);
    expect(ohneZins - mitZins).toBeCloseTo(0.04 / sigma, 2);
    expect(mitZins).toBeLessThan(ohneZins);
    // Der Abschlag der kassenlastigen Reihe ist ein Vielfaches davon —
    // deshalb geht die Änderung für sie in die STRENGERE Richtung.
    expect(sharpeRatio(nurGeldmarkt, 252)! - sharpeRatio(nurGeldmarkt, 252, zinsReihe)!).toBeGreaterThan(10 * (ohneZins - mitZins));
  });
});
