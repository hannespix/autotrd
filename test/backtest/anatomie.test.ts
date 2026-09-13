/**
 * Exit-Anatomie und MFE/MAE — die Messung, die sagt, WO das Geld hingeht.
 *
 * Der wichtigste Test steht zuerst: **Die Auswertung verändert die Simulation
 * nicht.** MFE/MAE und `stopTrailed` sind reine Auswertungsgrößen; wenn die
 * Messung das Ergebnis verschiebt, ist die Messung falsch (Auftrag
 * 12.09.2026). Geprüft wird das dreifach:
 *  1. `excursions: false` liefert Trade für Trade (außer mae/mfe) und Punkt
 *     für Punkt dieselbe Kurve wie `excursions: true`.
 *  2. Die Auswertungsfunktionen mutieren ihre Eingaben nicht.
 *  3. `decide()` bekommt die Größen nie zu sehen — kein Feld eines
 *     `SymbolSnapshot` trägt sie, also kann keine Entscheidung daran hängen.
 *
 * Danach die Inhalte: Kategorien (Trailing ≠ Erststop), Kennzahlen je Grund,
 * MFE/MAE in Prozent vom Einstand und der Nachlauf nach Stop-Ausstiegen.
 */
import { describe, expect, it } from 'vitest';
import {
  EXIT_KATEGORIEN,
  exitAnatomie,
  exitKategorie,
  exkursionAuswertung,
  exkursionVon,
  median,
  medianHaltedauer,
  quartile,
  stopNachlauf,
} from '../../src/backtest/anatomie.ts';
import { aktivitaet, tagesrenditen } from '../../src/backtest/aktivitaet.ts';
import { simulate } from '../../src/backtest/simulator.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, BarSeriesLike, ExitReason, Side, SymbolSnapshot, Trade } from '../../src/core/types.ts';
import { baseConfig, barsMap, strategyOf } from './helpers.ts';

/** Handelstage ohne Feiertag (Labor Day 2026-09-07 ausgelassen). */
const TAGE = [
  '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08',
  '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15',
  '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22',
];

type Ohlc4 = readonly [o: number, h: number, l: number, c: number];

const tagesbars = (ohlc: readonly Ohlc4[]): Bar[] =>
  ohlc.map(([o, h, l, c], k) => {
    const [y, m, d] = TAGE[k]!.split('-').map(Number) as [number, number, number];
    return { t: msFromET(y, m, d, 9, 30), o, h, l, c, v: 1_000 };
  });

const flach = (n: number, p: number): Ohlc4[] => Array.from({ length: n }, () => [p, p, p, p] as const);

const CFG = baseConfig({ timeframe: 1440, risk: { riskPerTradePct: 1, maxPositionPct: 50 } });

/** Trade-Attrappe für die reinen Aggregationsfunktionen. */
function trade(over: Partial<Trade> = {}): Trade {
  return {
    symbol: 'AAA',
    side: 'long' as Side,
    qty: 10,
    entryTime: 1_000,
    entryPrice: 100,
    exitTime: 2_000,
    exitPrice: 100,
    grossPnl: 0,
    fees: 0,
    netPnl: 0,
    rMultiple: null,
    exitReason: 'signal' as ExitReason,
    strategy: 's',
    barsHeld: 1,
    mae: null,
    mfe: null,
    ...over,
  };
}

/* ───────────────────────── 1. Die Messung verändert nichts ───────────────────────── */

describe('Auswertung verändert die Simulation nicht', () => {
  // Ein Lauf mit allen Ausstiegsarten: Ziel, Trailing-Stop, Erststop, Signal.
  const bars = tagesbars([
    [100, 100, 100, 100], // 0 Einstieg entschieden
    [100, 101, 99, 100], //  1 Fill @100, Stop 75, Ziel 130; Trailing ab hier
    [100, 101, 96, 100], //  2 Stop steht bei 97 ⇒ Trailing-Fill @97
    ...flach(3, 100), //     3–5 nichts
    [100, 100, 100, 100], // 6 zweiter Einstieg entschieden
    [100, 140, 99, 130], //  7 Fill @100, Ziel 130 ⇒ Limit-Fill
    ...flach(2, 100), //     8–9
    [100, 100, 100, 100], // 10 dritter Einstieg entschieden
    [100, 101, 70, 74], //   11 Fill @100, Erststop 75 ⇒ Stop-Fill @75
    ...flach(3, 100), //     12–14
  ]);

  /** Einstieg an Bar 0/6/10, Stop 75, Ziel 130; nach dem Fill EINMAL Stop auf 97 nachziehen. */
  const strategy = strategyOf({
    id: 'anatomie',
    decide: (snap) => {
      if (!snap.position) {
        return snap.i === 0 || snap.i === 6 || snap.i === 10 ? { kind: 'enter', side: 'long', stop: 75, target: 130, reason: 'e' } : { kind: 'hold' };
      }
      // Nur beim ERSTEN Trade nachziehen — so trennt der Lauf Trailing vom Erststop.
      if (snap.i === 1) return { kind: 'move_stop', stop: 97, reason: 'trail' };
      return { kind: 'hold' };
    },
  });

  const lauf = (excursions?: boolean) =>
    simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy, params: {} }),
      config: CFG,
      initialEquity: 10_000,
      ...(excursions === undefined ? {} : { excursions }),
    });

  it('erzeugt überhaupt die drei unterschiedlichen Ausstiege (sonst prüft der Rest nichts)', () => {
    const res = lauf();
    expect(res.trades.map((t) => exitKategorie(t))).toEqual(['trailing', 'target', 'stop']);
    expect(res.trades[0]!.exitPrice).toBe(97);
    expect(res.trades[0]!.stopTrailed).toBe(true);
    expect(res.trades[2]!.stopTrailed).toBe(false);
  });

  it('mit und ohne Mitschrift: identische Trades (außer mae/mfe), identische Equity-Kurve, identische Kennzahlen', () => {
    const mit = lauf(true);
    const ohne = lauf(false);
    expect(ohne.trades.map((t) => ({ ...t, mae: null, mfe: null }))).toEqual(mit.trades.map((t) => ({ ...t, mae: null, mfe: null })));
    expect(ohne.equity).toEqual(mit.equity);
    expect(ohne.dailyReturns).toEqual(mit.dailyReturns);
    expect(ohne.metrics).toEqual(mit.metrics);
    expect(ohne.finalEquity).toBe(mit.finalEquity);
    expect(ohne.notes).toEqual(mit.notes);
    // Und die Mitschrift lieferte wirklich etwas — sonst wäre die Gleichheit trivial.
    expect(mit.trades.every((t) => t.mae !== null && t.mfe !== null)).toBe(true);
    expect(ohne.trades.every((t) => t.mae === null && t.mfe === null)).toBe(true);
  });

  it('die Auswertungsfunktionen mutieren ihre Eingaben nicht', () => {
    const res = lauf();
    const vorher = structuredClone({ trades: res.trades, equity: res.equity, dailyReturns: res.dailyReturns, metrics: res.metrics });
    exitAnatomie(res.trades);
    exkursionAuswertung(res.trades);
    stopNachlauf({ trades: res.trades, bars: barsMap({ AAA: bars }), horizont: 3 });
    aktivitaet({ trades: res.trades, equity: res.equity, assetClass: 'us_equity' });
    tagesrenditen({ equity: res.equity, initialEquity: 10_000, assetClass: 'us_equity' });
    expect({ trades: res.trades, equity: res.equity, dailyReturns: res.dailyReturns, metrics: res.metrics }).toEqual(vorher);
  });

  it('keine Entscheidung sieht MFE, MAE oder stopTrailed — die Felder erreichen `decide()` nie', () => {
    const gesehen: SymbolSnapshot['position'][] = [];
    const spion = strategyOf({
      id: 'spion',
      decide: (snap) => {
        gesehen.push(snap.position);
        if (!snap.position) return snap.i === 0 ? { kind: 'enter', side: 'long', stop: 75, target: 130, reason: 'e' } : { kind: 'hold' };
        if (snap.i === 1) return { kind: 'move_stop', stop: 97, reason: 'trail' };
        return { kind: 'hold' };
      },
    });
    simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy: spion, params: {} }), config: CFG, initialEquity: 10_000 });
    const mitPosition = gesehen.filter((p) => p !== null);
    expect(mitPosition.length).toBeGreaterThan(0);
    const verboten = ['mae', 'mfe', 'stopTrailed', 'highWaterMae', 'excursion'];
    for (const p of mitPosition) for (const k of verboten) expect(Object.keys(p!)).not.toContain(k);
  });
});

/* ───────────────────────── 2. Kategorien ───────────────────────── */

describe('exitKategorie: Trailing ist kein Erststop', () => {
  it('stop + stopTrailed ⇒ trailing; stop ohne Nachzug ⇒ stop', () => {
    expect(exitKategorie(trade({ exitReason: 'stop', stopTrailed: true }))).toBe('trailing');
    expect(exitKategorie(trade({ exitReason: 'stop', stopTrailed: false }))).toBe('stop');
  });

  it('fehlendes stopTrailed wird NICHT zu Trailing geraten, sondern gezählt', () => {
    const t = trade({ exitReason: 'stop' });
    expect(t.stopTrailed).toBeUndefined();
    expect(exitKategorie(t)).toBe('stop');
    expect(exitAnatomie([t]).stopOhneHerkunft).toBe(1);
    expect(exitAnatomie([trade({ exitReason: 'stop', stopTrailed: false })]).stopOhneHerkunft).toBe(0);
  });

  it('jeder andere Ausstiegsgrund bleibt er selbst und hat einen Platz in der Reihenfolge', () => {
    const gruende: ExitReason[] = ['target', 'signal', 'eod', 'time', 'kill_switch', 'drawdown', 'manual', 'reconcile', 'unmanaged'];
    for (const g of gruende) {
      expect(exitKategorie(trade({ exitReason: g }))).toBe(g);
      expect(EXIT_KATEGORIEN).toContain(g);
    }
    expect(EXIT_KATEGORIEN).toContain('trailing');
  });
});

/* ───────────────────────── 3. Kennzahlen je Ausstiegsgrund ───────────────────────── */

describe('exitAnatomie: Anzahl, Netto, Trefferquote, Haltedauer, Beitrag', () => {
  const trades: Trade[] = [
    trade({ exitReason: 'target', netPnl: 100, barsHeld: 10 }),
    trade({ exitReason: 'target', netPnl: 300, barsHeld: 20 }),
    trade({ exitReason: 'stop', stopTrailed: false, netPnl: -200, barsHeld: 2 }),
    trade({ exitReason: 'stop', stopTrailed: false, netPnl: -100, barsHeld: 4 }),
    trade({ exitReason: 'stop', stopTrailed: true, netPnl: -50, barsHeld: 1 }),
    trade({ exitReason: 'signal', netPnl: 20, barsHeld: 3 }),
  ];

  it('rechnet je Grund Summe, Mittel, Median, Trefferquote und Haltedauer', () => {
    const a = exitAnatomie(trades);
    expect(a.trades).toBe(6);
    expect(a.netto).toBe(70);
    const ziel = a.zeilen.find((z) => z.kategorie === 'target')!;
    expect(ziel.anzahl).toBe(2);
    expect(ziel.anteil).toBeCloseTo(2 / 6, 12);
    expect(ziel.nettoSumme).toBe(400);
    expect(ziel.nettoMittel).toBe(200);
    expect(ziel.nettoMedian).toBe(200);
    expect(ziel.trefferquote).toBe(1);
    expect(ziel.barsMittel).toBe(15);
    expect(ziel.barsMedian).toBe(15);
    const stop = a.zeilen.find((z) => z.kategorie === 'stop')!;
    expect(stop.anzahl).toBe(2);
    expect(stop.nettoSumme).toBe(-300);
    expect(stop.trefferquote).toBe(0);
    const trail = a.zeilen.find((z) => z.kategorie === 'trailing')!;
    expect(trail.anzahl).toBe(1);
    expect(trail.nettoSumme).toBe(-50);
  });

  it('Beitrag ist am BETRAG normiert: die Beträge ergeben 100 %, ein Verlustbringer bleibt negativ', () => {
    const a = exitAnatomie(trades);
    const summe = a.zeilen.reduce((s, z) => s + Math.abs(z.nettoBeitrag!), 0);
    expect(summe).toBeCloseTo(1, 12);
    expect(a.zeilen.find((z) => z.kategorie === 'stop')!.nettoBeitrag!).toBeLessThan(0);
    expect(a.zeilen.find((z) => z.kategorie === 'target')!.nettoBeitrag!).toBeGreaterThan(0);
    // Der Fall, der ein am Netto normierter Beitrag verdreht: Gesamtnetto negativ.
    const minus = exitAnatomie([trade({ exitReason: 'stop', stopTrailed: false, netPnl: -300 }), trade({ exitReason: 'target', netPnl: 200 })]);
    expect(minus.netto).toBe(-100);
    expect(minus.zeilen.find((z) => z.kategorie === 'stop')!.nettoBeitrag!).toBeLessThan(0);
    expect(minus.zeilen.find((z) => z.kategorie === 'target')!.nettoBeitrag!).toBeGreaterThan(0);
  });

  it('ohne Trades: leere Tabelle, keine Division durch null', () => {
    const a = exitAnatomie([]);
    expect(a.trades).toBe(0);
    expect(a.netto).toBe(0);
    expect(a.zeilen).toEqual([]);
  });

  it('bewegt sich nichts (Netto 0 je Grund), ist der Beitrag null statt einer Zufallszahl', () => {
    const a = exitAnatomie([trade({ exitReason: 'target', netPnl: 0 })]);
    expect(a.zeilen[0]!.nettoBeitrag).toBeNull();
  });

  it('Zeilen stehen in der Reihenfolge von EXIT_KATEGORIEN, leere Kategorien fehlen', () => {
    const a = exitAnatomie(trades);
    expect(a.zeilen.map((z) => z.kategorie)).toEqual(['target', 'trailing', 'stop', 'signal']);
  });
});

/* ───────────────────────── 4. Der Fall, in dem Geld verloren geht ───────────────────────── */

describe('der Altfall: Trailing verkauft bei −3 %, obwohl der Katastrophen-Stop bei −25 % lag', () => {
  // Genau der Befund aus CLAUDE.md §2. Ohne die Trennung Trailing/Erststop
  // liest man ihn als „Stop zu eng" und macht den Katastrophen-Stop weiter —
  // die falsche Reparatur an der falschen Marke.
  const bars = tagesbars([[100, 100, 100, 100], [100, 101, 99, 100], [100, 101, 96, 100], ...flach(3, 100)]);
  const strategy = strategyOf({
    id: 'trail',
    decide: (snap) => {
      if (!snap.position) return snap.i === 0 ? { kind: 'enter', side: 'long', stop: 75, target: 500, reason: 'e' } : { kind: 'hold' };
      if (snap.i === 1) return { kind: 'move_stop', stop: 97, reason: 'trail' };
      return { kind: 'hold' };
    },
  });

  it('der Bericht kann den Trailing-Verlust vom Erststop-Verlust unterscheiden', () => {
    const res = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy, params: {} }), config: CFG, initialEquity: 10_000 });
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('stop');
    expect(t.exitPrice).toBe(97);
    expect(t.netPnl).toBeLessThan(0);
    // Verlust rund 3 % vom Einstand — nicht 25 %.
    expect(exkursionVon(t)!.nettoPct).toBeLessThan(-2.9);
    expect(exkursionVon(t)!.nettoPct).toBeGreaterThan(-4);
    const a = exitAnatomie(res.trades);
    expect(a.zeilen.map((z) => z.kategorie)).toEqual(['trailing']);
    expect(a.zeilen[0]!.nettoBeitrag!).toBe(-1);
    // Und die Kategorie „stop" (Erstmarke) taucht gar nicht auf — die Marke hat nie gegriffen.
    expect(a.zeilen.some((z) => z.kategorie === 'stop')).toBe(false);
  });
});

/* ───────────────────────── 5. MFE / MAE ───────────────────────── */

describe('exkursionVon: Prozent vom Einstand, Vorzeichen je Richtung', () => {
  it('Long: MFE über, MAE unter dem Einstand', () => {
    const e = exkursionVon(trade({ side: 'long', entryPrice: 100, qty: 10, mfe: 112, mae: 94, netPnl: 50 }))!;
    expect(e.mfePct).toBeCloseTo(12, 12);
    expect(e.maePct).toBeCloseTo(-6, 12);
    expect(e.nettoPct).toBeCloseTo(5, 12); // 50 $ auf 1 000 $ Einstandswert
    expect(e.mitnahme).toBeCloseTo(5 / 12, 12);
    expect(e.gewinner).toBe(true);
  });

  it('Short: das Vorzeichen dreht — ein fallender Kurs ist der Buchgewinn', () => {
    const e = exkursionVon(trade({ side: 'short', entryPrice: 100, qty: 10, mfe: 88, mae: 106, netPnl: 50 }))!;
    expect(e.mfePct).toBeCloseTo(12, 12);
    expect(e.maePct).toBeCloseTo(-6, 12);
  });

  it('ohne MFE/MAE oder ohne Einstand: null (keine erfundene Null)', () => {
    expect(exkursionVon(trade({ mfe: null, mae: 90 }))).toBeNull();
    expect(exkursionVon(trade({ mfe: 110, mae: null }))).toBeNull();
    expect(exkursionVon(trade({ mfe: 110, mae: 90, entryPrice: 0 }))).toBeNull();
  });

  it('ohne Buchgewinn ist die Mitnahme null, nicht unendlich', () => {
    expect(exkursionVon(trade({ entryPrice: 100, mfe: 100, mae: 90, netPnl: -100 }))!.mitnahme).toBeNull();
  });
});

describe('exkursionAuswertung: Verteilungen statt Mittelwerte', () => {
  const trades = [
    trade({ entryPrice: 100, qty: 1, mfe: 110, mae: 99, netPnl: 10, exitReason: 'target' }), //  Gewinner, Mitnahme 1,0
    trade({ entryPrice: 100, qty: 1, mfe: 120, mae: 98, netPnl: 5, exitReason: 'signal' }), //   Gewinner, Mitnahme 0,25
    trade({ entryPrice: 100, qty: 1, mfe: 108, mae: 95, netPnl: -5, exitReason: 'stop', stopTrailed: false }), // Verlierer, war +8
    trade({ entryPrice: 100, qty: 1, mfe: 100, mae: 90, netPnl: -10, exitReason: 'stop', stopTrailed: false }), // Verlierer, nie im Plus
    trade({ mfe: null, mae: null, netPnl: 1 }), //                                               ohne Daten
  ];

  it('trennt Gewinner und Verlierer, zählt Trades ohne Kursextreme gesondert', () => {
    const a = exkursionAuswertung(trades);
    expect(a.gemessen).toBe(4);
    expect(a.ohneDaten).toBe(1);
    expect(a.gewinner.anzahl).toBe(2);
    expect(a.verlierer.anzahl).toBe(2);
    expect(a.gewinner.mitnahme!.median).toBeCloseTo((1 + 0.25) / 2, 12);
    expect(a.verlierer.maePct!.min).toBeCloseTo(-10, 12);
    expect(a.verlierer.maePct!.max).toBeCloseTo(-5, 12);
  });

  it('zählt Verlierer, die weiter im Plus standen als am Ende im Minus', () => {
    // +8 % gegen −5 % Verlust ⇒ zählt; 0 % gegen −10 % ⇒ zählt nicht.
    expect(exkursionAuswertung(trades).verlierer.warWeiterImPlus).toBe(1);
  });

  it('ohne Trades: alles null, kein NaN', () => {
    const a = exkursionAuswertung([]);
    expect(a.gemessen).toBe(0);
    expect(a.gewinner.mitnahme).toBeNull();
    expect(a.alle.mfePct).toBeNull();
  });
});

describe('MFE/MAE aus dem Simulator: nur aus Bars der Haltezeit', () => {
  it('Kursextreme NACH dem Ausstieg stehen nicht in MFE/MAE', () => {
    // Einstieg Bar 1 @100, Signal-Exit an Bar 2 ⇒ Fill am Open von Bar 3.
    // Bar 4 läuft auf 200 — das darf MFE nicht sehen.
    const bars = tagesbars([[100, 100, 100, 100], [100, 105, 98, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 200, 100, 200], ...flach(2, 200)]);
    const strategy = strategyOf({
      id: 'kurz',
      decide: (snap) => {
        if (!snap.position) return snap.i === 0 ? { kind: 'enter', side: 'long', stop: 50, reason: 'e' } : { kind: 'hold' };
        return snap.i === 2 ? { kind: 'exit', reason: 'raus' } : { kind: 'hold' };
      },
    });
    const res = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy, params: {} }), config: CFG, initialEquity: 10_000 });
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('signal');
    expect(t.mfe).toBe(105); // Hoch von Bar 1 und 2, nicht die 200 von Bar 4
    expect(t.mae).toBe(98);
  });

  it('der Fill-Kurs des Ausstiegs gehört zur Haltezeit — ein Gap-Open ist oft der schlechteste Kurs', () => {
    // Einstieg Bar 1 @100, Signal-Exit an Bar 1 ⇒ Fill am Open von Bar 2, das
    // bei 80 aufreißt. Ohne den Fill-Kurs wäre der MAE 99 und der Bericht
    // würde einen 20-%-Ausstieg als 1-%-Rückgang lesen.
    const bars = tagesbars([[100, 100, 100, 100], [100, 101, 99, 100], [80, 101, 79, 100], ...flach(3, 100)]);
    const strategy = strategyOf({
      id: 'gap',
      decide: (snap) => {
        if (!snap.position) return snap.i === 0 ? { kind: 'enter', side: 'long', stop: 50, reason: 'e' } : { kind: 'hold' };
        return snap.i === 1 ? { kind: 'exit', reason: 'raus' } : { kind: 'hold' };
      },
    });
    const res = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy, params: {} }), config: CFG, initialEquity: 10_000 });
    const t = res.trades[0]!;
    expect(t.exitPrice).toBe(80);
    expect(t.mae).toBe(80);
    // Tief und Hoch der Ausstiegs-Bar NACH dem Open zählen nicht mehr.
    expect(t.mfe).toBe(101);
  });
});

/* ───────────────────────── 6. Nachlauf nach Stop-Ausstiegen ───────────────────────── */

describe('stopNachlauf: die Kehrseite, ausdrücklich eine Was-wäre-wenn-Rechnung', () => {
  const serie = (ohlc: readonly Ohlc4[]): ReadonlyMap<string, BarSeriesLike> => new Map([['AAA', BarSeries.from(tagesbars(ohlc))]]);
  const t0 = msFromET(2026, 9, 1, 9, 30);
  const tag = (k: number): number => {
    const [y, m, d] = TAGE[k]!.split('-').map(Number) as [number, number, number];
    return msFromET(y, m, d, 9, 30);
  };

  it('Kurs erreicht im Horizont wieder den Einstand ⇒ erholt', () => {
    const bars = serie([[100, 100, 95, 95], [96, 99, 95, 98], [98, 101, 97, 100], ...flach(3, 100)]);
    const t = trade({ exitReason: 'stop', netPnl: -50, entryPrice: 100, exitTime: t0, side: 'long' });
    const n = stopNachlauf({ trades: [t], bars, horizont: 3 });
    expect(n.verlierer).toBe(1);
    expect(n.geprueft).toBe(1);
    expect(n.erholt).toBe(1);
    expect(n.horizont).toBe(3);
  });

  it('zu kurzer Horizont ⇒ nicht erholt (die Zahl hängt sichtbar am Horizont)', () => {
    const bars = serie([[100, 100, 95, 95], [96, 97, 95, 96], [96, 97, 95, 96], [96, 101, 95, 100], ...flach(2, 100)]);
    const t = trade({ exitReason: 'stop', netPnl: -50, entryPrice: 100, exitTime: t0, side: 'long' });
    expect(stopNachlauf({ trades: [t], bars, horizont: 2 }).erholt).toBe(0);
    expect(stopNachlauf({ trades: [t], bars, horizont: 3 }).erholt).toBe(1);
  });

  it('`bis` begrenzt den Blick hart — kein Nachlauf in den Holdout', () => {
    const bars = serie([[100, 100, 95, 95], [96, 97, 95, 96], [96, 101, 95, 100], ...flach(3, 100)]);
    const t = trade({ exitReason: 'stop', netPnl: -50, entryPrice: 100, exitTime: t0, side: 'long' });
    expect(stopNachlauf({ trades: [t], bars, horizont: 5 }).erholt).toBe(1);
    // Grenze VOR der Bar, die den Einstand wieder erreicht (Index 2).
    const n = stopNachlauf({ trades: [t], bars, horizont: 5, bis: tag(2) });
    expect(n.erholt).toBe(0);
    expect(n.geprueft).toBe(1);
  });

  it('ohne Folgebars: ohneDaten, nicht „nicht erholt"', () => {
    const bars = serie(flach(1, 100));
    const t = trade({ exitReason: 'stop', netPnl: -50, entryPrice: 100, exitTime: t0, side: 'long' });
    const n = stopNachlauf({ trades: [t], bars, horizont: 3 });
    expect(n.geprueft).toBe(0);
    expect(n.ohneDaten).toBe(1);
    expect(n.erholt).toBe(0);
    // Fremdes Symbol ohne Serie ⇒ ebenfalls ohneDaten.
    expect(stopNachlauf({ trades: [trade({ symbol: 'ZZZ', exitReason: 'stop', netPnl: -1 })], bars, horizont: 3 }).ohneDaten).toBe(1);
  });

  it('zählt nur ausgestoppte VERLIERER — Gewinner und andere Ausstiegsgründe nicht', () => {
    const bars = serie(flach(6, 100));
    const trades = [
      trade({ exitReason: 'stop', netPnl: 10 }),
      trade({ exitReason: 'signal', netPnl: -10 }),
      trade({ exitReason: 'target', netPnl: -10 }),
    ];
    expect(stopNachlauf({ trades, bars, horizont: 3 }).verlierer).toBe(0);
  });

  it('Short: „wieder im Einstand" heißt, dass der Kurs zurück nach UNTEN kam', () => {
    const bars = serie([[100, 106, 100, 105], [105, 106, 99, 100], ...flach(4, 100)]);
    const t = trade({ exitReason: 'stop', netPnl: -50, entryPrice: 100, exitTime: t0, side: 'short' });
    expect(stopNachlauf({ trades: [t], bars, horizont: 3 }).erholt).toBe(1);
  });
});

/* ───────────────────────── 7. Verteilungs-Helfer ───────────────────────── */

describe('median, quartile, medianHaltedauer', () => {
  it('Median über gerade und ungerade Längen, Eingabe bleibt unsortiert', () => {
    const xs = [5, 1, 3];
    expect(median(xs)).toBe(3);
    expect(xs).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('Quartile nach linearer Interpolation (Typ 7)', () => {
    const q = quartile([1, 2, 3, 4])!;
    expect(q.min).toBe(1);
    expect(q.q1).toBeCloseTo(1.75, 12);
    expect(q.median).toBeCloseTo(2.5, 12);
    expect(q.q3).toBeCloseTo(3.25, 12);
    expect(q.max).toBe(4);
    expect(q.n).toBe(4);
    expect(quartile([])).toBeNull();
    const eins = quartile([7])!;
    expect([eins.min, eins.q1, eins.median, eins.q3, eins.max]).toEqual([7, 7, 7, 7, 7]);
  });

  it('medianHaltedauer: mindestens 1 Bar, auch ohne Trades', () => {
    expect(medianHaltedauer([])).toBe(1);
    expect(medianHaltedauer([trade({ barsHeld: 0 })])).toBe(1);
    expect(medianHaltedauer([trade({ barsHeld: 4 }), trade({ barsHeld: 10 })])).toBe(7);
  });
});
