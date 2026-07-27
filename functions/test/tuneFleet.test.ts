/**
 * Schatten-Flotte des Auto-Tuners (MT2).
 *
 * Geprüft wird das Zusammenspiel, an dem am 27.07. alles hing: Greifen
 * Risiko-Ausstiege unabhängig von der Haltefrist? Bremst die Haltefrist
 * wirklich nur den Signal-Ausstieg? Und bleibt der Zustand über Wochen
 * benutzbar, statt unbegrenzt zu wachsen?
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, type Strategy, type Variant } from '../../shared/src/index.js';
import {
  FLEET_START_BALANCE,
  MAX_PNLS,
  emptyVariantState,
  stepFleet,
  type FleetSymbolData,
  type FleetState,
} from '../src/core/tuneFleet.js';

/** Strategie, die allein am RSI hängt — damit die Signale eindeutig sind. */
function nurRsi(patch: Partial<Strategy['engine']> = {}): Strategy {
  const s = structuredClone(DEFAULT_STRATEGY);
  s.indicators.macd.enabled = false;
  s.indicators.bollinger.enabled = false;
  s.signals.minConfluence = 1;
  s.signals.exitConfluence = 1;
  s.signals.useForecast = false;
  s.signals.timeframe = 'daily';
  Object.assign(s.engine, patch);
  return s;
}

const variante = (id: string, s: Strategy): Variant => ({
  id,
  axis: 'test',
  label: 'Test',
  value: id,
  strategy: s,
});

/** Fallende Reihe → RSI tief → Kaufsignal. */
const fallend = (n = 40, start = 200): number[] =>
  Array.from({ length: n }, (_, i) => start - i * 2);
/** Steigende Reihe → RSI hoch → Verkaufssignal. */
const steigend = (n = 40, start = 100): number[] =>
  Array.from({ length: n }, (_, i) => start + i * 2);

const markt = (closes: number[], price = closes[closes.length - 1]!): Map<string, FleetSymbolData> =>
  new Map([['AAPL', { closes, price }]]);

const T0 = new Date('2026-07-27T14:00:00.000Z');
const spaeter = (min: number): Date => new Date(T0.getTime() + min * 60_000);

describe('stepFleet — Einstieg', () => {
  it('kauft bei Kaufsignal und legt ein Schattenkonto an', () => {
    const v = [variante('a', nurRsi())];
    const r = stepFleet(v, markt(fallend()), {}, ['AAPL'], T0);
    expect(r.state.a!.book.positions.AAPL).toBeDefined();
    expect(r.state.a!.book.balance).toBeLessThan(FLEET_START_BALANCE);
  });

  it('respektiert die Kauf-Pause der jeweiligen Variante', () => {
    const v = [variante('a', nurRsi({ cooldownMin: 240 }))];
    const zustand: FleetState = {
      a: { ...emptyVariantState(T0), lastTrades: { AAPL: T0.toISOString() } },
    };
    const r = stepFleet(v, markt(fallend()), zustand, ['AAPL'], spaeter(30));
    expect(r.state.a!.book.positions.AAPL).toBeUndefined();
  });
});

describe('stepFleet — Ausstieg', () => {
  /** Konto mit offener Position, eröffnet zu T0. */
  const mitPosition = (einstand: number, qty = 10): FleetState => ({
    a: {
      ...emptyVariantState(T0),
      book: {
        balance: FLEET_START_BALANCE - einstand * qty,
        positions: { AAPL: { qty, avgEntry: einstand, openedAt: T0.toISOString() } },
      },
    },
  });

  it('bremst den SIGNAL-Ausstieg innerhalb der Haltefrist', () => {
    const v = [variante('a', nurRsi({ minHoldMin: 240 }))];
    // Steigende Reihe = Verkaufssignal, aber erst 30 min gehalten.
    const r = stepFleet(v, markt(steigend(), 101), mitPosition(100), ['AAPL'], spaeter(30));
    expect(r.state.a!.book.positions.AAPL).toBeDefined();
    expect(r.closed).toBe(0);
  });

  it('lässt ihn nach Ablauf der Frist zu', () => {
    const v = [variante('a', nurRsi({ minHoldMin: 60 }))];
    const r = stepFleet(v, markt(steigend(), 101), mitPosition(100), ['AAPL'], spaeter(120));
    expect(r.state.a!.book.positions.AAPL).toBeUndefined();
    expect(r.closed).toBe(1);
  });

  it('lässt den STOP-LOSS auch innerhalb der Haltefrist feuern', () => {
    // Der entscheidende Fall: Eine Haltefrist darf das Sicherheitsnetz
    // niemals aushebeln. Kurs 8 % unter Einstand, Stop steht bei 2 %.
    const v = [variante('a', nurRsi({ minHoldMin: 1440, stopLossPct: 2 }))];
    const r = stepFleet(v, markt(fallend(), 92), mitPosition(100), ['AAPL'], spaeter(5));
    expect(r.state.a!.book.positions.AAPL).toBeUndefined();
    expect(r.closed).toBe(1);
  });

  it('lässt den TAKE-PROFIT auch innerhalb der Haltefrist feuern', () => {
    const v = [variante('a', nurRsi({ minHoldMin: 1440, takeProfitPct: 4 }))];
    const r = stepFleet(v, markt(steigend(), 110), mitPosition(100), ['AAPL'], spaeter(5));
    expect(r.state.a!.book.positions.AAPL).toBeUndefined();
    expect(r.closed).toBe(1);
  });

  it('schreibt bei jedem Abschluss ein Ergebnis fort — Rohstoff der Bewertung', () => {
    const v = [variante('a', nurRsi({ minHoldMin: 0 }))];
    const r = stepFleet(v, markt(steigend(), 120), mitPosition(100), ['AAPL'], spaeter(120));
    expect(r.state.a!.pnls).toHaveLength(1);
    expect(r.state.a!.pnls[0]).toBeGreaterThan(0); // 100 → 120 ist ein Gewinn
  });
});

describe('stepFleet — Zustandspflege', () => {
  it('unterscheidet Varianten: gleiche Kurse, verschiedene Entscheidungen', () => {
    // Der ganze Zweck der Flotte. Kurz gehalten → bleibt drin;
    // ohne Frist → verkauft.
    const zustand: FleetState = {
      kurz: {
        ...emptyVariantState(T0),
        book: {
          balance: 24_000,
          positions: { AAPL: { qty: 10, avgEntry: 100, openedAt: T0.toISOString() } },
        },
      },
      ohne: {
        ...emptyVariantState(T0),
        book: {
          balance: 24_000,
          positions: { AAPL: { qty: 10, avgEntry: 100, openedAt: T0.toISOString() } },
        },
      },
    };
    const r = stepFleet(
      [variante('kurz', nurRsi({ minHoldMin: 240 })), variante('ohne', nurRsi({ minHoldMin: 0 }))],
      markt(steigend(), 101),
      zustand,
      ['AAPL'],
      spaeter(30),
    );
    expect(r.state.kurz!.book.positions.AAPL).toBeDefined();
    expect(r.state.ohne!.book.positions.AAPL).toBeUndefined();
  });

  it('räumt Varianten weg, die es nicht mehr gibt', () => {
    // Sonst sammelten sich Zahlen zu Parametern an, die niemand mehr fährt.
    const zustand: FleetState = { alt: emptyVariantState(T0), a: emptyVariantState(T0) };
    const r = stepFleet([variante('a', nurRsi())], markt(fallend()), zustand, ['AAPL'], T0);
    expect(Object.keys(r.state)).toEqual(['a']);
  });

  it('deckelt die Ergebnisliste, damit das Dokument nicht überläuft', () => {
    const zustand: FleetState = {
      a: {
        ...emptyVariantState(T0),
        pnls: Array.from({ length: MAX_PNLS + 50 }, (_, i) => i),
        book: {
          balance: 24_000,
          positions: { AAPL: { qty: 10, avgEntry: 100, openedAt: T0.toISOString() } },
        },
      },
    };
    const r = stepFleet(
      [variante('a', nurRsi({ minHoldMin: 0 }))],
      markt(steigend(), 120),
      zustand,
      ['AAPL'],
      spaeter(120),
    );
    expect(r.state.a!.pnls).toHaveLength(MAX_PNLS);
    // Die JÜNGSTEN bleiben — die ältesten fallen vorne raus.
    expect(r.state.a!.pnls[MAX_PNLS - 1]).toBeGreaterThan(0);
  });

  it('überspringt Symbole ohne brauchbaren Kurs', () => {
    const leer = new Map<string, FleetSymbolData>([['AAPL', { closes: [], price: 0 }]]);
    const r = stepFleet([variante('a', nurRsi())], leer, {}, ['AAPL'], T0);
    expect(r.state.a!.book.balance).toBe(FLEET_START_BALANCE);
    expect(r.closed).toBe(0);
  });

  it('fasst den übergebenen Zustand nicht an', () => {
    const zustand: FleetState = { a: emptyVariantState(T0) };
    const kopie = JSON.stringify(zustand);
    stepFleet([variante('a', nurRsi())], markt(fallend()), zustand, ['AAPL'], T0);
    expect(JSON.stringify(zustand)).toBe(kopie);
  });
});
