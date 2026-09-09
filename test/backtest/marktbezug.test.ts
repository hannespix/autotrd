/**
 * Der Maßstab, an dem jede Holdout-Zahl gemessen wird. Er entscheidet nichts,
 * aber er entscheidet, wie ein Mensch die Entscheidung liest — und ein
 * geschönter Maßstab ist gefährlicher als eine geschönte Strategie: Er lässt
 * eine wertlose Kante gut aussehen und wird dabei nie geprüft.
 */
import { describe, expect, it } from 'vitest';
import { kaufenUndHalten, kaufenUndHaltenKurve, kurvenstandVor } from '../../src/backtest/marktbezug.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { msFromET, parseDay } from '../../src/core/time.ts';
import type { Bar, BarSeriesLike } from '../../src/core/types.ts';

/** Tagesbars ab `day` (ET-Sitzungsbeginn), ein Schluss je Handelstag. */
function tage(day: string, closes: readonly (number | null)[]): Bar[] {
  const { y, m, d } = parseDay(day);
  const out: Bar[] = [];
  for (let k = 0; k < closes.length; k++) {
    const c = closes[k];
    if (c === null || c === undefined) continue; // Lücke: an diesem Tag gibt es keine Bar
    const t = msFromET(y, m, d + k, 9, 30);
    out.push({ t, o: c, h: c, l: c, c, v: 1_000 });
  }
  return out;
}

function korb(entries: Record<string, readonly (number | null)[]>, day = '2025-01-06'): ReadonlyMap<string, BarSeriesLike> {
  const m = new Map<string, BarSeriesLike>();
  for (const [sym, closes] of Object.entries(entries)) m.set(sym, BarSeries.from(tage(day, closes)));
  return m;
}

const WEIT = { start: 0, end: Number.MAX_SAFE_INTEGER };
const BASIS = { assetClass: 'us_equity' as const, periodsPerYear: 252 };

describe('kaufenUndHalten', () => {
  it('flache Kurse ⇒ 0 % Rendite, kein Drawdown', () => {
    const r = kaufenUndHalten({ bars: korb({ AAA: [100, 100, 100, 100] }), range: WEIT, ...BASIS });
    expect(r).not.toBeNull();
    expect(r!.netReturnPct).toBeCloseTo(0, 9);
    expect(r!.maxDrawdownPct).toBeCloseTo(0, 9);
    expect(r!.symbole).toBe(1);
    expect(r!.punkte).toBe(4);
  });

  it('gleichgewichtet: eines verdoppelt, eines flach ⇒ +50 %', () => {
    const r = kaufenUndHalten({ bars: korb({ AAA: [100, 200], BBB: [50, 50] }), range: WEIT, ...BASIS });
    expect(r!.netReturnPct).toBeCloseTo(50, 9);
    expect(r!.symbole).toBe(2);
  });

  it('gewichtet nach Anteilen, nicht nach Kursen — teure Aktien zählen nicht mehr', () => {
    // BBB kostet das Zehnfache, bewegt sich aber gleich stark relativ.
    const r = kaufenUndHalten({ bars: korb({ AAA: [10, 11], BBB: [1000, 1100] }), range: WEIT, ...BASIS });
    expect(r!.netReturnPct).toBeCloseTo(10, 9);
  });

  it('Drawdown wird aus der Wertreihe gemessen, nicht aus Anfang und Ende', () => {
    const r = kaufenUndHalten({ bars: korb({ AAA: [100, 50, 100] }), range: WEIT, ...BASIS });
    expect(r!.netReturnPct).toBeCloseTo(0, 9);
    expect(r!.maxDrawdownPct).toBeCloseTo(50, 6); // zwischendurch halbiert
  });

  it('Fenster [start, end): Bars davor und danach zählen nicht', () => {
    const bars = korb({ AAA: [100, 110, 120, 130] });
    const s = bars.get('AAA')!;
    // Fenster genau über Bar 1 und 2 (110 → 120): +9.09 %, nicht +30 %.
    const r = kaufenUndHalten({ bars, range: { start: s.t[1]!, end: s.t[3]! }, ...BASIS });
    expect(r!.punkte).toBe(2);
    expect(r!.netReturnPct).toBeCloseTo((120 / 110 - 1) * 100, 9);
  });

  it('Symbol ohne Kurs am ersten Tag bekommt kein rückwirkendes Gewicht', () => {
    // BBB startet erst am zweiten Tag und verdoppelt sich danach. Wer es
    // mitzählt, schreibt dem Maßstab einen Gewinn gut, den niemand hätte
    // kaufen können — Survivorship durch die Hintertür.
    const r = kaufenUndHalten({ bars: korb({ AAA: [100, 100, 100], BBB: [null, 50, 100] }), range: WEIT, ...BASIS });
    expect(r!.symbole).toBe(1);
    expect(r!.netReturnPct).toBeCloseTo(0, 9);
  });

  it('Lücke mitten im Fenster: letzter bekannter Kurs gilt weiter', () => {
    // AAA fehlt an Tag 2 (Handelsstopp). Wer den Tag überspringt statt
    // fortzuschreiben, verzerrt die Renditereihe und damit den Sharpe.
    const r = kaufenUndHalten({ bars: korb({ AAA: [100, 120, null, 120], BBB: [10, 10, 10, 10] }), range: WEIT, ...BASIS });
    expect(r!.punkte).toBe(4);
    expect(r!.netReturnPct).toBeCloseTo(10, 9); // (1.2 + 1.0)/2 − 1
    // Entscheidend ist NICHT die Endrendite (die stimmt auch bei falscher
    // Behandlung), sondern die Renditereihe: Wer den Lückentag auf den
    // Einstand zurücksetzt, erfindet einen Einbruch und einen Erholungstag —
    // und verzerrt damit genau den Sharpe, der den Maßstab vergleichbar macht.
    expect(r!.maxDrawdownPct).toBeCloseTo(0, 9);
    expect(r!.sharpe).not.toBeNull();
  });

  it('weniger als zwei Handelstage oder kein Symbol ⇒ null statt einer erfundenen Zahl', () => {
    expect(kaufenUndHalten({ bars: korb({ AAA: [100] }), range: WEIT, ...BASIS })).toBeNull();
    expect(kaufenUndHalten({ bars: new Map(), range: WEIT, ...BASIS })).toBeNull();
    const leer = kaufenUndHalten({ bars: korb({ AAA: [100, 110] }), range: { start: 0, end: 1 }, ...BASIS });
    expect(leer).toBeNull();
  });

  it('Sharpe ist annualisiert und positiv bei stetigem Anstieg', () => {
    const closes = Array.from({ length: 30 }, (_, k) => 100 * 1.001 ** k);
    const r = kaufenUndHalten({ bars: korb({ AAA: closes }), range: WEIT, ...BASIS });
    expect(r!.sharpe).not.toBeNull();
    expect(r!.sharpe!).toBeGreaterThan(5); // rauschfreier Anstieg ⇒ sehr hoher Sharpe
  });

  it('days zählt Kalendertage des Fensters wie computeMetrics', () => {
    const bars = korb({ AAA: [100, 110] });
    const s = bars.get('AAA')!;
    const spanne = s.t[1]! - s.t[0]!;
    const r = kaufenUndHalten({ bars, range: { start: s.t[0]!, end: s.t[1]! + spanne }, ...BASIS });
    expect(r!.days).toBe(2);
  });
});

describe('kaufenUndHaltenKurve / kurvenstandVor: dieselbe Kurve, in Fenster geschnitten', () => {
  const BASIS_ARGS = { assetClass: 'us_equity' as const };

  it('Kurve beginnt bei 1, je Handelstag ein Punkt mit der Zeit seiner letzten Bar; Stand vor einem Zeitpunkt ist der letzte Punkt davor', () => {
    const bars = korb({ AAA: [100, 110, 120, 130] });
    const s = bars.get('AAA')!;
    const k = kaufenUndHaltenKurve({ bars, range: WEIT, ...BASIS_ARGS })!;
    expect(k.symbole).toBe(1);
    expect([...k.kurve]).toEqual([1, 1.1, 1.2, 1.3]);
    expect([...k.zeiten]).toEqual([s.t[0], s.t[1], s.t[2], s.t[3]]);
    expect(kurvenstandVor(k, s.t[0]!)).toBe(1); // vor dem ersten Punkt: der Einstand
    expect(kurvenstandVor(k, s.t[2]!)).toBe(1.1);
    expect(kurvenstandVor(k, s.t[3]! + 1)).toBe(1.3);
  });

  it('Scheiben summieren sich zur Rendite der ganzen Range — dieselbe Kurve wie kaufenUndHalten, nicht je Fenster neu gewichtet', () => {
    const bars = korb({ AAA: [100, 110, 120, 130, 90, 95], BBB: [50, 50, 60, 40, 40, 44] });
    const s = bars.get('AAA')!;
    const k = kaufenUndHaltenKurve({ bars, range: WEIT, ...BASIS_ARGS })!;
    const ganz = kaufenUndHalten({ bars, range: WEIT, ...BASIS_ARGS, periodsPerYear: 252 })!;
    const grenzen = [0, s.t[2]!, s.t[4]!, Number.MAX_SAFE_INTEGER];
    let summe = 0;
    for (let i = 0; i + 1 < grenzen.length; i++) summe += kurvenstandVor(k, grenzen[i + 1]!) - kurvenstandVor(k, grenzen[i]!);
    expect(summe).toBeCloseTo(ganz.netReturnPct / 100, 12);
    expect(k.kurve[k.kurve.length - 1]! - 1).toBeCloseTo(ganz.netReturnPct / 100, 12);
  });

  it('ohne zwei Handelstage im Fenster: null — wie kaufenUndHalten', () => {
    expect(kaufenUndHaltenKurve({ bars: korb({ AAA: [100] }), range: WEIT, ...BASIS_ARGS })).toBeNull();
  });
});
