/**
 * Task 36: Die Bilanz des Momentum-Schattenbuchs.
 *
 * Am 31.10. stand das Schattendepot bei 1,26 Mio $ — gestartet mit 25.000 $,
 * realisiert −64.000 $. Das Buch wurde mit `set(…, {merge: true})`
 * gespeichert; merge mischt verschachtelte Maps, ein verkauftes Symbol blieb
 * in `holdings` stehen, und jede Woche wurde jede Leiche erneut „verkauft".
 * Die Tests halten fest, dass die Bilanzprüfung genau dieses Muster sieht und
 * ehrliche Bücher über viele Läufe NICHT verwirft.
 */

import { describe, expect, it } from 'vitest';
import {
  MOMENTUM_BILANZ_TOLERANZ,
  applyMomentumOrders,
  emptyMomentumBook,
  momentumBuchStimmig,
  type MomentumBook,
} from '../src/momentum.js';

const now = new Date('2026-10-31T22:00:00Z');
const fee = () => 0.001;

/** Firestore-merge nachgestellt: verschachtelte Maps werden GEMISCHT,
 *  gelöschte Schlüssel bleiben stehen. */
function mergeWieFirestore(alt: MomentumBook, neu: MomentumBook): MomentumBook {
  return { ...neu, holdings: { ...alt.holdings, ...neu.holdings } };
}

describe('momentumBuchStimmig', () => {
  it('frisches Buch geht auf', () => {
    expect(momentumBuchStimmig(emptyMomentumBook(25_000, now))).toBe(true);
  });

  it('bleibt über 200 Rebalancings mit krummen Kursen stimmig', () => {
    let book = emptyMomentumBook(25_000, now);
    const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
    for (let i = 0; i < 200; i += 1) {
      const preise = new Map(syms.map((s, j) => [s, 10 + ((i * 7 + j * 13) % 37) * 1.37 + 0.003] as const));
      const verkauf = Object.keys(book.holdings).filter((_, j) => (i + j) % 2 === 0);
      const kauf = syms.filter((s) => !(s in book.holdings) || verkauf.includes(s)).slice(0, 3);
      book = applyMomentumOrders({
        book,
        orders: [
          ...verkauf.map((s) => ({ symbol: s, side: 'sell' as const, notional: null })),
          ...kauf.map((s) => ({ symbol: s, side: 'buy' as const, notional: 4_321.17 })),
        ],
        preise,
        feeRate: fee,
        now,
      });
      expect(momentumBuchStimmig(book)).toBe(true);
    }
    expect(book.pnls.length).toBeGreaterThan(50);
  });

  it('erkennt die Leiche aus dem merge — schon nach EINEM Verkauf', () => {
    const preise = new Map([['AAA', 100], ['BBB', 50]]);
    let book = applyMomentumOrders({
      book: emptyMomentumBook(25_000, now),
      orders: [{ symbol: 'AAA', side: 'buy', notional: 10_000 }],
      preise,
      feeRate: fee,
      now,
    });
    expect(momentumBuchStimmig(book)).toBe(true);
    const nachVerkauf = applyMomentumOrders({
      book,
      orders: [
        { symbol: 'AAA', side: 'sell', notional: null },
        { symbol: 'BBB', side: 'buy', notional: 5_000 },
      ],
      preise,
      feeRate: fee,
      now,
    });
    expect(momentumBuchStimmig(nachVerkauf)).toBe(true);
    book = mergeWieFirestore(book, nachVerkauf);
    expect(Object.keys(book.holdings).sort()).toEqual(['AAA', 'BBB']);
    expect(momentumBuchStimmig(book)).toBe(false);
  });

  it('Bücher ohne Bilanzfelder (vor dem 31.10.) sind nicht prüfbar ⇒ nicht stimmig', () => {
    const { startkapital: _s, realisiert: _r, ...alt } = emptyMomentumBook(25_000, now);
    expect(momentumBuchStimmig(alt as MomentumBook)).toBe(false);
  });

  it('kaputte Bestände und erfundenes Bargeld fallen auf', () => {
    const b = emptyMomentumBook(25_000, now);
    expect(momentumBuchStimmig({ ...b, cash: b.cash + MOMENTUM_BILANZ_TOLERANZ + 0.01 })).toBe(false);
    expect(momentumBuchStimmig({ ...b, cash: b.cash + MOMENTUM_BILANZ_TOLERANZ })).toBe(true);
    expect(momentumBuchStimmig({ ...b, holdings: { X: { qty: Number.NaN, avgEntry: 1, openedAt: '' } } })).toBe(false);
    expect(momentumBuchStimmig({ ...b, cash: Number.NaN })).toBe(false);
  });

  it('applyMomentumOrders trägt startkapital und realisiert fort', () => {
    const preise = new Map([['AAA', 100]]);
    const b1 = applyMomentumOrders({
      book: emptyMomentumBook(25_000, now),
      orders: [{ symbol: 'AAA', side: 'buy', notional: 10_000 }],
      preise,
      feeRate: fee,
      now,
    });
    const b2 = applyMomentumOrders({
      book: b1,
      orders: [{ symbol: 'AAA', side: 'sell', notional: null }],
      preise: new Map([['AAA', 110]]),
      feeRate: fee,
      now,
    });
    expect(b2.startkapital).toBe(25_000);
    expect(b2.realisiert).toBeCloseTo(b2.pnls[0] ?? Number.NaN, 1);
    expect(b2.cash).toBeCloseTo(25_000 + (b2.realisiert ?? 0), 1);
  });
});
