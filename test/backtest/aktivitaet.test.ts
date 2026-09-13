/**
 * Aktivitätskennzahlen, datierte Tagesrenditen und die Korrelationsmatrix.
 *
 * Der tragende Wächter: `tagesrenditen` muss Wert für Wert dieselbe Reihe
 * liefern wie `SimResult.dailyReturns` desselben Laufs — sonst gäbe es zwei
 * Definitionen von „Tagesrendite", und die Korrelationsmatrix würde eine
 * andere Größe messen als Sharpe und PSR.
 *
 * Dazu die zwei Regeln, ohne die eine Korrelation falsch gelesen wird:
 * gemeinsame Tage schneiden (ein nicht gemessener Tag ist kein Datenpunkt),
 * aber flache Tage mit Rendite 0 mitzählen (nicht investiert heißt kein
 * Ertrag — keine bedingte Korrelation).
 */
import { describe, expect, it } from 'vitest';
import { aktivitaet, kalendertage, korrelationsmatrix, pearson, renditeketteVon, tagesrenditen } from '../../src/backtest/aktivitaet.ts';
import { simulate } from '../../src/backtest/simulator.ts';
import { DAY, msFromET } from '../../src/core/time.ts';
import type { Bar, EquityPoint, Side, Trade } from '../../src/core/types.ts';
import { baseConfig, barsMap, dayBars5, flat, strategyOf, type Ohlc } from './helpers.ts';

const TAGE = [
  '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08',
  '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15',
];
const tagMs = (k: number): number => {
  const [y, m, d] = TAGE[k]!.split('-').map(Number) as [number, number, number];
  return msFromET(y, m, d, 9, 30);
};
const tagesbars = (closes: readonly number[]): Bar[] => closes.map((c, k) => ({ t: tagMs(k), o: c, h: c, l: c, c, v: 1_000 }));

function trade(over: Partial<Trade> = {}): Trade {
  return {
    symbol: 'AAA',
    side: 'long' as Side,
    qty: 10,
    entryTime: 0,
    entryPrice: 100,
    exitTime: 0,
    exitPrice: 100,
    grossPnl: 0,
    fees: 0,
    netPnl: 0,
    rMultiple: null,
    exitReason: 'signal',
    strategy: 's',
    barsHeld: 1,
    mae: null,
    mfe: null,
    ...over,
  };
}

/* ───────────────────────── Tagesrenditen: eine Definition ───────────────────────── */

describe('tagesrenditen entspricht SimResult.dailyReturns', () => {
  const strategy = strategyOf({
    id: 'halt',
    decide: (snap) => {
      if (!snap.position && snap.i === 0) return { kind: 'enter', side: 'long', stop: 80, reason: 'e' };
      if (snap.position && snap.i === 4) return { kind: 'exit', reason: 'raus' };
      return { kind: 'hold' };
    },
  });

  it('Tagesbars: gleiche Länge, gleiche Werte, dazu der Tagesschlüssel', () => {
    const cfg = baseConfig({ timeframe: 1440, risk: { riskPerTradePct: 1, maxPositionPct: 50 } });
    const res = simulate({ bars: barsMap({ AAA: tagesbars([100, 102, 99, 104, 103, 101, 105]) }), strategyFor: () => ({ strategy, params: {} }), config: cfg, initialEquity: 10_000 });
    const r = tagesrenditen({ equity: res.equity, initialEquity: 10_000, assetClass: 'us_equity' });
    expect(r.renditen.length).toBe(res.dailyReturns.length);
    for (let i = 0; i < r.renditen.length; i++) expect(r.renditen[i]).toBeCloseTo(res.dailyReturns[i]!, 12);
    expect(r.tage).toEqual(TAGE.slice(0, 7));
  });

  it('5-min-Bars: viele Punkte je Tag ⇒ eine Rendite je Tag, aus dem LETZTEN Punkt des Tages', () => {
    // Die Equity muss sich INNERHALB des Tages bewegen, sonst prüft der Test
    // nicht, welcher Punkt des Tages zählt: mit offener Position steigt sie
    // Bar für Bar mit dem Kurs.
    const cfg = baseConfig({ timeframe: 5, risk: { riskPerTradePct: 1, maxPositionPct: 50 } });
    const steigend = (von: number): Ohlc[] => Array.from({ length: 6 }, (_, k) => [von + k, von + k, von + k, von + k] as const);
    const bars = [...dayBars5('2026-09-01', flat(6, 100)), ...dayBars5('2026-09-02', steigend(100)), ...dayBars5('2026-09-03', steigend(110))];
    const halten = strategyOf({
      decide: (snap) => (snap.position || snap.i > 0 ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: 80, reason: 'e' }),
    });
    const res = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy: halten, params: {} }), config: cfg, initialEquity: 10_000 });
    const r = tagesrenditen({ equity: res.equity, initialEquity: 10_000, assetClass: 'us_equity' });
    expect(r.tage).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(r.renditen.length).toBe(res.dailyReturns.length);
    for (let i = 0; i < r.renditen.length; i++) expect(r.renditen[i]).toBeCloseTo(res.dailyReturns[i]!, 12);
    // Die Kurve bewegt sich im Tag — erster und letzter Punkt eines Tages sind verschieden.
    const tag2 = res.equity.filter((p) => new Date(p.t).toISOString().slice(0, 10) === '2026-09-02');
    expect(tag2.length).toBeGreaterThan(1);
    expect(tag2[0]!.equity).not.toBe(tag2[tag2.length - 1]!.equity);
  });

  it('ohne Punkte: leere Reihe', () => {
    expect(tagesrenditen({ equity: [], initialEquity: 10_000, assetClass: 'us_equity' })).toEqual({ tage: [], renditen: [] });
  });

  it('Kette über Fenster: jedes Fenster startet frisch beim Startkapital', () => {
    const f1: EquityPoint[] = [{ t: tagMs(0), equity: 110 }, { t: tagMs(1), equity: 121 }];
    const f2: EquityPoint[] = [{ t: tagMs(2), equity: 90 }];
    const k = renditeketteVon({ fenster: [{ equity: f1 }, { equity: f2 }], initialEquity: 100, assetClass: 'us_equity' });
    expect(k.tage).toEqual([TAGE[0], TAGE[1], TAGE[2]]);
    // 110/100−1, 121/110−1, dann WIEDER gegen 100: 90/100−1.
    expect(k.renditen[0]).toBeCloseTo(0.1, 12);
    expect(k.renditen[1]).toBeCloseTo(0.1, 12);
    expect(k.renditen[2]).toBeCloseTo(-0.1, 12);
  });
});

/* ───────────────────────── Aktivität ───────────────────────── */

describe('aktivitaet', () => {
  const punkte = (n: number, exposure?: number): EquityPoint[] =>
    Array.from({ length: n }, (_, k) => (exposure === undefined ? { t: tagMs(k), equity: 10_000 } : { t: tagMs(k), equity: 10_000, exposure }));

  it('gleichzeitige Positionen: Mittel je Bar, Position offen von Fill bis Ausstieg (exklusiv)', () => {
    // Zwei Trades: Tag 0–2 und Tag 1–2. An Tag 0: 1, Tag 1: 2, Tag 2: 0, Tag 3–4: 0.
    const trades = [
      trade({ entryTime: tagMs(0), exitTime: tagMs(2) }),
      trade({ entryTime: tagMs(1), exitTime: tagMs(2) }),
    ];
    const a = aktivitaet({ trades, equity: punkte(5), assetClass: 'us_equity' });
    expect(a.mittlerePositionen).toBeCloseTo((1 + 2 + 0 + 0 + 0) / 5, 12);
    expect(a.handelstage).toBe(5);
    // Ohne Exposure-Angabe fällt „Zeit im Markt" auf die Haltezeiten zurück.
    expect(a.zeitImMarktQuelle).toBe('trades');
    expect(a.zeitImMarkt).toBeCloseTo(2 / 5, 12);
    expect(a.mittlereExposurePct).toBeNull();
  });

  it('mit Exposure je Punkt: gebundenes Kapital und Zeit im Markt kommen aus der Kurve', () => {
    const equity: EquityPoint[] = [
      { t: tagMs(0), equity: 10_000, exposure: 0 },
      { t: tagMs(1), equity: 10_000, exposure: 0.5 },
      { t: tagMs(2), equity: 10_000, exposure: 0.5 },
      { t: tagMs(3), equity: 10_000, exposure: 0 },
    ];
    const a = aktivitaet({ trades: [], equity, assetClass: 'us_equity' });
    expect(a.mittlereExposurePct).toBeCloseTo(25, 12);
    expect(a.zeitImMarktQuelle).toBe('exposure');
    expect(a.zeitImMarkt).toBeCloseTo(0.5, 12);
  });

  it('Exposure nur teilweise gesetzt ⇒ „nicht bewertbar" (null), nie 0 — fail-closed wie die Basis-Latte', () => {
    const equity: EquityPoint[] = [{ t: tagMs(0), equity: 10_000, exposure: 0.5 }, { t: tagMs(1), equity: 10_000 }];
    expect(aktivitaet({ trades: [], equity, assetClass: 'us_equity' }).mittlereExposurePct).toBeNull();
  });

  it('längste Pause ohne Einstieg: Ränder zählen mit', () => {
    // Einstiege an Tag 2 und Tag 7 ⇒ Pausen: Tag 0–1 (2), Tag 3–6 (4), Tag 8–9 (2).
    const trades = [trade({ entryTime: tagMs(2), exitTime: tagMs(2) }), trade({ entryTime: tagMs(7), exitTime: tagMs(7) })];
    const a = aktivitaet({ trades, equity: punkte(10), assetClass: 'us_equity' });
    expect(a.laengstePause).toBe(4);
    expect(a.pauseVon).toBe(TAGE[3]);
    expect(a.pauseBis).toBe(TAGE[6]);
  });

  it('kein einziger Einstieg ⇒ die Pause ist das ganze Fenster (die Zahl, die man im Betrieb spürt)', () => {
    const a = aktivitaet({ trades: [], equity: punkte(10), assetClass: 'us_equity' });
    expect(a.laengstePause).toBe(10);
    expect(a.pauseVon).toBe(TAGE[0]);
    expect(a.pauseBis).toBe(TAGE[9]);
    expect(a.trades).toBe(0);
  });

  it('Einstieg an jedem Handelstag ⇒ keine Pause', () => {
    const trades = Array.from({ length: 10 }, (_, k) => trade({ entryTime: tagMs(k), exitTime: tagMs(k) }));
    const a = aktivitaet({ trades, equity: punkte(10), assetClass: 'us_equity' });
    expect(a.laengstePause).toBe(0);
    expect(a.pauseVon).toBeNull();
  });

  it('ohne Equity-Punkte: alles null statt einer erfundenen Null', () => {
    const a = aktivitaet({ trades: [trade()], equity: [], assetClass: 'us_equity' });
    expect(a.handelstage).toBe(0);
    expect(a.zeitImMarkt).toBeNull();
    expect(a.mittlerePositionen).toBeNull();
    expect(a.laengstePause).toBeNull();
  });

  it('aus einem echten Lauf: Zeit im Markt und gebundenes Kapital passen zur Exposure der Kurve', () => {
    const cfg = baseConfig({ timeframe: 1440, risk: { riskPerTradePct: 1, maxPositionPct: 20 } });
    const strategy = strategyOf({
      decide: (snap) => {
        if (!snap.position && snap.i === 0) return { kind: 'enter', side: 'long', stop: 90, reason: 'e' };
        if (snap.position && snap.i >= 3) return { kind: 'exit', reason: 'raus' };
        return { kind: 'hold' };
      },
    });
    const res = simulate({ bars: barsMap({ AAA: tagesbars([100, 100, 100, 100, 100, 100]) }), strategyFor: () => ({ strategy, params: {} }), config: cfg, initialEquity: 10_000 });
    const a = aktivitaet({ trades: res.trades, equity: res.equity, assetClass: 'us_equity' });
    // Bars 1–3 im Buch (siehe test/backtest/exposure.test.ts) ⇒ 3 von 6 Tagen.
    expect(a.zeitImMarktQuelle).toBe('exposure');
    expect(a.zeitImMarkt).toBeCloseTo(3 / 6, 12);
    expect(a.mittlerePositionen).toBeCloseTo(3 / 6, 12);
    expect(a.mittlereExposurePct!).toBeGreaterThan(4.9);
    expect(a.mittlereExposurePct!).toBeLessThan(5.1);
  });
});

describe('kalendertage', () => {
  it('zählt wie computeMetrics: aufgerundet, mindestens 1', () => {
    expect(kalendertage({ start: 0, end: 30 * DAY })).toBe(30);
    expect(kalendertage({ start: 0, end: 1 })).toBe(1);
    expect(kalendertage({ start: 0, end: 0 })).toBe(1);
  });
});

/* ───────────────────────── Korrelation ───────────────────────── */

describe('pearson', () => {
  it('gleichläufig 1, gegenläufig −1', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12);
  });

  it('Konstante korreliert mit nichts (null, kein NaN) und < 2 Werte auch nicht', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1], [1])).toBeNull();
  });

  it('bleibt in [−1, 1] (Rundungsfehler dürfen nicht darüber laufen)', () => {
    const r = pearson([1e-9, 2e-9, 3e-9], [1e-9, 2e-9, 3e-9])!;
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThanOrEqual(-1);
  });
});

describe('korrelationsmatrix', () => {
  const reihe = (renditen: readonly number[], ab = 0) => ({
    tage: renditen.map((_, i) => `2026-01-${String(i + 1 + ab).padStart(2, '0')}`),
    renditen: [...renditen],
  });
  const auf = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

  it('Diagonale 1, symmetrisch, Durchschnitt über die Paare oberhalb', () => {
    const a = reihe(auf(30, (i) => Math.sin(i)));
    const b = reihe(auf(30, (i) => 2 * Math.sin(i)));
    const c = reihe(auf(30, (i) => -Math.sin(i)));
    const k = korrelationsmatrix([{ name: 'A', reihe: a }, { name: 'B', reihe: b }, { name: 'C', reihe: c }]);
    expect(k.namen).toEqual(['A', 'B', 'C']);
    expect(k.werte[0]![0]).toBe(1);
    expect(k.werte[0]![1]).toBeCloseTo(1, 12);
    expect(k.werte[1]![0]).toBe(k.werte[0]![1]);
    expect(k.werte[0]![2]).toBeCloseTo(-1, 12);
    // Paare: AB = +1, AC = −1, BC = −1 ⇒ Mittel −1/3.
    expect(k.durchschnitt).toBeCloseTo(-1 / 3, 12);
    expect(k.minGemeinsameTage).toBe(30);
    expect(k.maxGemeinsameTage).toBe(30);
    expect(k.zuWenigeTage).toBe(0);
  });

  it('nur GEMEINSAME Tage zählen — nicht gemessene Tage werden weggelassen, nicht mit 0 gefüllt', () => {
    const a = reihe(auf(30, (i) => Math.sin(i)));
    // Dieselben Renditen, aber um 25 Tage verschoben ⇒ 5 gemeinsame Tage.
    const b = { tage: a.tage.map((_, i) => `2026-01-${String(i + 26).padStart(2, '0')}`), renditen: [...a.renditen] };
    const k = korrelationsmatrix([{ name: 'A', reihe: a }, { name: 'B', reihe: b }], 20);
    expect(k.minGemeinsameTage).toBe(5);
    expect(k.werte[0]![1]).toBeNull();
    expect(k.zuWenigeTage).toBe(1);
    expect(k.durchschnitt).toBeNull();
    // Mit kleinerer Latte wird dasselbe Paar berechenbar — die Latte ist sichtbar, nicht heimlich.
    expect(korrelationsmatrix([{ name: 'A', reihe: a }, { name: 'B', reihe: b }], 5).werte[0]![1]).not.toBeNull();
  });

  it('flache Tage zählen mit Rendite 0 — das ist KEINE bedingte Korrelation', () => {
    // A ist an den ersten 10 Tagen investiert, danach flach; B genau umgekehrt.
    // Mit den Nullen sind die Reihen gegenläufig; ließe man sie weg, gäbe es
    // gar keinen gemeinsamen Tag mehr — und damit eine völlig andere Aussage.
    const tage = auf(20, (i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    const a = { tage, renditen: auf(20, (i) => (i < 10 ? 0.01 : 0)) };
    const b = { tage, renditen: auf(20, (i) => (i < 10 ? 0 : 0.01)) };
    const k = korrelationsmatrix([{ name: 'A', reihe: a }, { name: 'B', reihe: b }], 20);
    expect(k.minGemeinsameTage).toBe(20);
    expect(k.werte[0]![1]).toBeCloseTo(-1, 12);
    const nurInvestiert = korrelationsmatrix(
      [
        { name: 'A', reihe: { tage: tage.slice(0, 10), renditen: auf(10, () => 0.01) } },
        { name: 'B', reihe: { tage: tage.slice(10), renditen: auf(10, () => 0.01) } },
      ],
      1,
    );
    expect(nurInvestiert.minGemeinsameTage).toBe(0);
    expect(nurInvestiert.werte[0]![1]).toBeNull();
  });

  it('eine Reihe allein: Matrix 1×1, kein Durchschnitt', () => {
    const k = korrelationsmatrix([{ name: 'A', reihe: reihe(auf(30, (i) => i)) }]);
    expect(k.werte).toEqual([[1]]);
    expect(k.durchschnitt).toBeNull();
    expect(k.minGemeinsameTage).toBeNull();
  });
});
