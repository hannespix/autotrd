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

/* ── Entscheiden und Protokollieren (MT4/MT5) ─────────────────────────────── */

import { decideTuning } from '../src/core/tuneFleet.js';
import { buildVariants } from '../../shared/src/index.js';

/** n Ergebnisse um `mittel` mit etwas Streuung — sonst gibt es keinen Test. */
const serie = (n: number, mittel: number): number[] =>
  Array.from({ length: n }, (_, i) => mittel + (i % 2 === 0 ? 1 : -1));

describe('decideTuning', () => {
  const basis = () => structuredClone(DEFAULT_STRATEGY);

  it('befördert die beste belegte Variante — und nur eine', () => {
    // Zwei Varianten schlagen die amtierende; nur die STÄRKERE gewinnt.
    // Zwei Änderungen gleichzeitig ließen sich hinterher nicht mehr
    // auseinanderhalten.
    const b = basis();
    const v = buildVariants(b, 3);
    const fleet: FleetState = {
      [v[0]!.id]: { ...emptyVariantState(T0), pnls: serie(40, 8) },
      [v[1]!.id]: { ...emptyVariantState(T0), pnls: serie(40, 14) },
      [v[2]!.id]: { ...emptyVariantState(T0), pnls: serie(40, 1) },
    };
    const d = decideTuning(b, v, fleet, serie(40, 0), T0);
    expect(d.winner?.id).toBe(v[1]!.id);
    expect(d.entries.filter((e) => e.promoted)).toHaveLength(1);
  });

  it('befördert nichts, solange die Evidenz fehlt', () => {
    const b = basis();
    const v = buildVariants(b, 2);
    const fleet: FleetState = {
      [v[0]!.id]: { ...emptyVariantState(T0), pnls: serie(10, 50) }, // sehr gut, aber nur 10
      [v[1]!.id]: { ...emptyVariantState(T0), pnls: [] },
    };
    const d = decideTuning(b, v, fleet, serie(40, 0), T0);
    expect(d.winner).toBeNull();
    expect(d.entries[0]!.reason).toMatch(/Zu wenig Evidenz/);
  });

  it('protokolliert JEDE geprüfte Variante, auch die abgelehnten', () => {
    // Ein Journal, das nur Erfolge zeigt, verschweigt das Interessante:
    // wie viele Ideen verworfen wurden und warum.
    const b = basis();
    const v = buildVariants(b, 4);
    const d = decideTuning(b, v, {}, serie(40, 0), T0);
    expect(d.entries).toHaveLength(4);
    expect(d.entries.every((e) => e.reason.length > 0)).toBe(true);
    expect(d.entries.every((e) => !e.promoted)).toBe(true);
  });

  it('schreibt die Änderung in Klartext — lesbar ohne Code', () => {
    const b = basis();
    const v = buildVariants(b, 20).filter((x) => x.id === 'minHoldMin=120');
    const d = decideTuning(b, v, {}, serie(40, 0), T0);
    expect(d.entries[0]!.change).toBe('Mindest-Haltedauer 60 → 120');
  });

  it('hält im Eintrag nachprüfbare Zahlen fest', () => {
    const b = basis();
    const v = buildVariants(b, 1);
    const fleet: FleetState = { [v[0]!.id]: { ...emptyVariantState(T0), pnls: serie(40, 9) } };
    const e = decideTuning(b, v, fleet, serie(40, 0), T0).entries[0]!;
    expect(e.nCandidate).toBe(40);
    expect(e.nIncumbent).toBe(40);
    expect(e.edge).toBeCloseTo(9, 6);
    expect(e.p).not.toBeNull();
    expect(e.at).toBe(T0.toISOString());
  });

  it('lässt eine strengere Schwelle durchgreifen', () => {
    const b = basis();
    const v = buildVariants(b, 1);
    const fleet: FleetState = { [v[0]!.id]: { ...emptyVariantState(T0), pnls: serie(40, 9) } };
    // Mit 100 geforderten Trades je Seite reicht die Evidenz nicht mehr.
    const d = decideTuning(b, v, fleet, serie(40, 0), T0, { minTrades: 100 });
    expect(d.winner).toBeNull();
  });

  it('Bonferroni: dieselbe Evidenz reicht bei EINER Variante, aber nicht bei sechs', () => {
    // Wer 6 Varianten gleichzeitig gegen α = 5 % prüft, findet im Schnitt
    // 0,3 Scheinsieger je Durchgang — täglich geprüft wären das rund
    // hundert unbegründete Umstellungen im Jahr. Deshalb bekommt jede
    // einzelne Prüfung α/6. Die Daten hier sind so gebaut, dass p zwischen
    // beiden Schwellen liegt (t ≈ 2,5 ⇒ p ≈ 0,015): stark genug für einen
    // Einzeltest, zu schwach für sechs parallele.
    const rausch = (n: number, mittel: number, amp: number): number[] =>
      Array.from({ length: n }, (_, i) => mittel + (i % 2 === 0 ? amp : -amp));
    const b = basis();
    const pnls = rausch(40, 1, 1.8);
    const live = rausch(40, 0, 1.8);

    const eine = buildVariants(b, 1);
    const d1 = decideTuning(b, eine, { [eine[0]!.id]: { ...emptyVariantState(T0), pnls } }, live, T0);
    expect(d1.winner).not.toBeNull();

    const sechs = buildVariants(b, 6);
    const fleet: FleetState = {};
    for (const v of sechs) fleet[v.id] = { ...emptyVariantState(T0), pnls: [...pnls] };
    const d6 = decideTuning(b, sechs, fleet, live, T0);
    expect(d6.winner).toBeNull();
    // Und die Ablehnung ist begründet, nicht still: p steht im Journal.
    expect(d6.entries.every((e) => e.p !== null)).toBe(true);
  });
});
