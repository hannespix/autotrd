/**
 * Korb-Rang — die Stelle, an der eine Querschnitts-Strategie sich am
 * leichtesten die Zukunft einbaut.
 *
 * Eine Rangliste ist verführerisch: Wer versehentlich die Kennzahl von
 * morgen mitranken lässt, bekommt die schönste Kante der Welt und merkt es
 * nie, weil jede einzelne Zeitreihe kausal aussieht. Deshalb prüft diese
 * Datei nicht die Strategie, sondern die RANGBILDUNG in `core/logic.ts`:
 *
 *  · Sie darf nur geschlossene Bars bis `snap.i` sehen.
 *  · Sie darf nicht davon abhängen, in welcher Reihenfolge der Aufrufer
 *    seine Liste gebaut hat.
 *  · Ein Symbol mit VERALTETER letzter Bar darf nicht mitranken — live
 *    passiert das, sobald ein Symbol im Bucket keinen Trade hatte, und ein
 *    Vergleich über verschiedene Zeitpunkte wäre schlicht falsch.
 *  · Symbole verschiedener Strategien werden getrennt rangiert.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { korbRaenge, type SymbolInput } from '../../src/core/logic.ts';
import type { Bar, Decision, IndicatorSet, Params, Strategy, SymbolSnapshot } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';

const BUCKET = 300_000;
const okSession = { isRegularSession: true, minutesToClose: 200, minutesSinceOpen: 100, barsSinceOpen: 20, isLastBarOfDay: false, day: '2026-09-04' };

/** Serie mit `n` Bars; Close = `closes[k]`, Bar-Zeit = k·BUCKET. */
function serie(closes: number[]): BarSeries {
  const bars: Bar[] = closes.map((c, k) => ({ t: k * BUCKET, o: c, h: c + 1, l: c - 1, c, v: 1000 }));
  return BarSeries.from(bars);
}

/**
 * Strategie, deren Kennzahl schlicht der Close der Entscheidungs-Bar ist —
 * so ist der erwartete Rang von Hand nachrechenbar.
 */
function closeRanker(id = 'ranker'): Strategy {
  return {
    id,
    timeframes: TIMEFRAMES,
    paramSpace: [],
    defaults: {},
    holdsOvernight: true,
    warmupBars: () => 1,
    precompute: () => ({}),
    decide: (): Decision => ({ kind: 'hold' }),
    crossScore: (snap: SymbolSnapshot): number | null => snap.bars.c[snap.i] ?? null,
  };
}

/** Strategie ohne Querschnitt — darf nie einen Rang bekommen. */
const einzeln: Strategy = (() => {
  // Die Eigenschaft ganz WEGLASSEN, nicht auf undefined setzen: Genau so sehen
  // die vier bestehenden Vorlagen aus (exactOptionalPropertyTypes).
  const { crossScore: _weg, ...rest } = closeRanker('einzeln');
  return rest;
})();

function input(symbol: string, bars: BarSeries, i: number, strategy: Strategy = closeRanker()): SymbolInput {
  return { snap: { symbol, bars, i, position: null, session: okSession }, strategy, params: {} as Params, ind: {} as IndicatorSet };
}

describe('korbRaenge', () => {
  it('rangiert absteigend nach Kennzahl; 0 = stärkstes, 1 = schwächstes', () => {
    const r = korbRaenge([
      input('SCHWACH', serie([10, 10, 10]), 2),
      input('STARK', serie([10, 10, 30]), 2),
      input('MITTE', serie([10, 10, 20]), 2),
    ]);
    expect(r.get('STARK')).toEqual({ pct: 0, rank: 1, of: 3 });
    expect(r.get('MITTE')).toEqual({ pct: 0.5, rank: 2, of: 3 });
    expect(r.get('SCHWACH')).toEqual({ pct: 1, rank: 3, of: 3 });
  });

  /**
   * DER Lookahead-Test. Dieselbe Entscheidungs-Bar, aber die Serien enthalten
   * zusätzlich die Zukunft. Ändert sich der Rang, sieht die Rangbildung nach
   * vorn — und alles, was darauf aufbaut, ist wertlos.
   */
  it('sieht nur bis zur Entscheidungs-Bar — angehängte Zukunft ändert nichts', () => {
    const jetzt = korbRaenge([input('A', serie([10, 10, 30]), 2), input('B', serie([10, 10, 20]), 2), input('C', serie([10, 10, 10]), 2)]);
    // Dieselben ersten drei Bars, danach kehrt sich alles um.
    const mitZukunft = korbRaenge([
      input('A', serie([10, 10, 30, 1, 1]), 2),
      input('B', serie([10, 10, 20, 999, 999]), 2),
      input('C', serie([10, 10, 10, 500, 500]), 2),
    ]);
    expect(mitZukunft.get('A')).toEqual(jetzt.get('A'));
    expect(mitZukunft.get('B')).toEqual(jetzt.get('B'));
    expect(mitZukunft.get('C')).toEqual(jetzt.get('C'));
    expect(mitZukunft.get('A')!.rank, 'A bleibt stärkstes, obwohl es später abstürzt').toBe(1);
  });

  it('hängt nicht daran, wie der Aufrufer die Liste sortiert hat', () => {
    const bauen = () => [input('A', serie([1, 1, 30]), 2), input('B', serie([1, 1, 20]), 2), input('C', serie([1, 1, 10]), 2)];
    const vor = korbRaenge(bauen());
    const rueck = korbRaenge([...bauen()].reverse());
    for (const s of ['A', 'B', 'C']) expect(rueck.get(s), s).toEqual(vor.get(s));
  });

  /**
   * Live kann ein Symbol im Bucket keinen Trade haben; seine letzte
   * geschlossene Bar ist dann älter. Seine Kennzahl stammt von einem anderen
   * Zeitpunkt — mitranken wäre ein Vergleich von Äpfeln mit Birnen.
   */
  it('lässt Symbole mit VERALTETER letzter Bar draußen', () => {
    const r = korbRaenge([
      input('AKTUELL1', serie([1, 1, 30]), 2),
      input('AKTUELL2', serie([1, 1, 10]), 2),
      input('VERALTET', serie([1, 999]), 1), // Bar-Zeit 1·BUCKET statt 2·BUCKET
    ]);
    expect(r.has('VERALTET'), 'trotz höchster Kennzahl kein Rang').toBe(false);
    expect(r.get('AKTUELL1')).toEqual({ pct: 0, rank: 1, of: 2 });
    expect(r.get('AKTUELL2')!.of, 'die Korbgröße zählt nur die Rangierten').toBe(2);
  });

  it('rangiert je Strategie getrennt — verschiedene Kennzahlen sind nicht vergleichbar', () => {
    const a = closeRanker('a');
    const b = closeRanker('b');
    const r = korbRaenge([
      input('A1', serie([1, 1, 30]), 2, a),
      input('A2', serie([1, 1, 10]), 2, a),
      input('B1', serie([1, 1, 20]), 2, b),
    ]);
    expect(r.get('A1')).toEqual({ pct: 0, rank: 1, of: 2 });
    expect(r.get('A2')).toEqual({ pct: 1, rank: 2, of: 2 });
    expect(r.get('B1'), 'eigene Gruppe, also allein und damit stärkstes').toEqual({ pct: 0, rank: 1, of: 1 });
  });

  it('gibt Strategien ohne Querschnitt keinen Rang', () => {
    const r = korbRaenge([input('X', serie([1, 1, 30]), 2, einzeln), input('Y', serie([1, 1, 10]), 2, einzeln)]);
    expect(r.size).toBe(0);
  });

  it('überspringt Symbole ohne Kennzahl (Aufwärmphase, fehlende Daten)', () => {
    const ohneWert: Strategy = { ...closeRanker(), crossScore: (snap) => (snap.symbol === 'LEER' ? null : (snap.bars.c[snap.i] ?? null)) };
    const r = korbRaenge([input('LEER', serie([1, 1, 99]), 2, ohneWert), input('DA', serie([1, 1, 5]), 2, ohneWert)]);
    expect(r.has('LEER')).toBe(false);
    expect(r.get('DA')).toEqual({ pct: 0, rank: 1, of: 1 });
  });

  it('behandelt Gleichstand reproduzierbar (alphabetisch)', () => {
    const gleich = () => [input('ZZZ', serie([1, 1, 10]), 2), input('AAA', serie([1, 1, 10]), 2), input('MMM', serie([1, 1, 10]), 2)];
    const eins = korbRaenge(gleich());
    const zwei = korbRaenge([...gleich()].reverse());
    expect(eins.get('AAA')!.rank).toBe(1);
    expect(eins.get('MMM')!.rank).toBe(2);
    expect(eins.get('ZZZ')!.rank).toBe(3);
    for (const s of ['AAA', 'MMM', 'ZZZ']) expect(zwei.get(s), s).toEqual(eins.get(s));
  });

  it('ein einzelnes Symbol bekommt pct 0, nicht NaN', () => {
    const r = korbRaenge([input('ALLEIN', serie([1, 1, 10]), 2)]);
    expect(r.get('ALLEIN')).toEqual({ pct: 0, rank: 1, of: 1 });
  });
});
