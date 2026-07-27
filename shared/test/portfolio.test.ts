/**
 * portfolio.test.ts — pure Kennzahlen (M12 Teil 1).
 *
 * Enthält bewusst die Kalender-Randfälle aus MILESTONES (Wochenend-/
 * Feiertagslücken, DST-Wechsel): Die Serie arbeitet auf ISO-Datums-Strings
 * ohne Zeitzonen-Arithmetik — Lücken sind fehlende Tage, keine Nullrenditen.
 */

import { describe, expect, it } from 'vitest';
import {
  attribution,
  dailyReturns,
  drawdown,
  normalizeSeries,
  positionValue,
  sharpe,
  tradeStats,
} from '../src/index.js';

describe('normalizeSeries', () => {
  it('sortiert, dedupliziert (letzter gewinnt) und wirft Müll raus', () => {
    const s = normalizeSeries([
      { date: '2026-07-22', equity: 110 },
      { date: '2026-07-20', equity: 100 },
      { date: '2026-07-22', equity: 111 }, // Doppel-Snapshot am selben Tag
      { date: '2026-07-21', equity: Number.NaN },
      { date: 'kaputt', equity: 5 },
    ]);
    expect(s).toEqual([
      { date: '2026-07-20', equity: 100 },
      { date: '2026-07-22', equity: 111 },
    ]);
  });
});

describe('dailyReturns', () => {
  it('Wochenendlücke (Fr→Mo) ergibt genau EINE Rendite', () => {
    const r = dailyReturns([
      { date: '2026-07-24', equity: 100 }, // Freitag
      { date: '2026-07-27', equity: 102 }, // Montag
    ]);
    expect(r).toEqual([0.02]);
  });

  it('DST-Wechsel (US-Sommerzeitbeginn 08.03.2026) verzerrt nichts — reine Kalendertage', () => {
    const r = dailyReturns([
      { date: '2026-03-06', equity: 100 }, // Freitag vor DST
      { date: '2026-03-09', equity: 101 }, // Montag nach der Umstellung
      { date: '2026-03-10', equity: 101 },
    ]);
    expect(r).toEqual([0.01, 0]);
  });

  it('Basis ≤ 0 trägt keine Rendite (kein Division-durch-Null-Ausreißer)', () => {
    const r = dailyReturns([
      { date: '2026-07-20', equity: 0 },
      { date: '2026-07-21', equity: 50 },
      { date: '2026-07-22', equity: 55 },
    ]);
    expect(r).toEqual([0.1]);
  });
});

describe('sharpe', () => {
  it('annualisiert mit sqrt(252)', () => {
    // mean 0.02, Stichproben-Std 0.01 → 2 · √252 ≈ 31.75
    expect(sharpe([0.01, 0.02, 0.03])).toBeCloseTo(31.75, 2);
  });
  it('null bei zu kurzer oder flacher Serie', () => {
    expect(sharpe([])).toBeNull();
    expect(sharpe([0.01])).toBeNull();
    expect(sharpe([0.01, 0.01, 0.01])).toBeNull(); // Streuung 0
  });
});

describe('drawdown', () => {
  it('HWM, MaxDD und aktueller DD', () => {
    const d = drawdown([
      { date: '2026-07-20', equity: 100 },
      { date: '2026-07-21', equity: 120 },
      { date: '2026-07-22', equity: 90 }, // −25 % vom HWM 120
      { date: '2026-07-23', equity: 110 }, // aktuell −8.33 %
    ]);
    expect(d.hwm).toBe(120);
    expect(d.maxDDPct).toBe(25);
    expect(d.currentDDPct).toBeCloseTo(8.33, 2);
  });
  it('leere Serie → alles null', () => {
    expect(drawdown([])).toEqual({ hwm: null, maxDDPct: null, currentDDPct: null });
  });
  it('monoton steigend → 0 % Drawdown', () => {
    const d = drawdown([
      { date: '2026-07-20', equity: 100 },
      { date: '2026-07-21', equity: 105 },
    ]);
    expect(d.maxDDPct).toBe(0);
    expect(d.currentDDPct).toBe(0);
  });
});

describe('tradeStats', () => {
  it('WinRate, ProfitFactor, Expectancy, avgWin/avgLoss', () => {
    const s = tradeStats([
      { symbol: 'AAPL', pnl: 100 },
      { symbol: 'AAPL', pnl: 50 },
      { symbol: 'TSLA', pnl: -75 },
      { symbol: 'QQQ', pnl: 0 }, // weder Win noch Loss, zählt aber als Trade
    ]);
    expect(s.n).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.winRatePct).toBe(50);
    expect(s.profitFactor).toBe(2); // 150 / 75
    expect(s.expectancy).toBe(18.75); // 75 / 4
    expect(s.avgWin).toBe(75);
    expect(s.avgLoss).toBe(-75);
  });
  it('ohne Verluste ist ProfitFactor null (nicht Infinity)', () => {
    expect(tradeStats([{ symbol: 'AAPL', pnl: 10 }]).profitFactor).toBeNull();
  });
  it('ohne Trades alles null/0', () => {
    const s = tradeStats([]);
    expect(s.n).toBe(0);
    expect(s.winRatePct).toBeNull();
    expect(s.expectancy).toBeNull();
  });
});

describe('attribution', () => {
  it('gruppiert je Symbol und Klasse, Punkte in Keys werden entschärft', () => {
    const a = attribution([
      { symbol: 'BTC-USD', pnl: 40, assetClass: 'crypto' },
      { symbol: 'BTC-USD', pnl: -10, assetClass: 'crypto' },
      { symbol: 'X.Y', pnl: 5, assetClass: null },
    ]);
    expect(a.bySymbol['BTC-USD']).toEqual({ pnl: 30, n: 2 });
    expect(a.bySymbol['X_Y']).toEqual({ pnl: 5, n: 1 }); // Firestore-Map-Key ohne Punkt
    expect(a.byClass['crypto']).toEqual({ pnl: 30, n: 2 });
    expect(a.byClass['unbekannt']).toEqual({ pnl: 5, n: 1 });
  });
});

describe('positionValue', () => {
  it('Long = Marktwert, ohne Kurs konservativ zum Einstand', () => {
    expect(positionValue({ qty: 3, avgEntry: 100 }, 110)).toBe(330);
    expect(positionValue({ qty: 3, avgEntry: 100 }, null)).toBe(300);
  });
  it('Short = Margin + gespiegelter P&L (verdient am fallenden Kurs)', () => {
    // 2 Stück short zu 100, Kurs 90 → 200 Margin + 20 Gewinn
    expect(positionValue({ qty: 2, avgEntry: 100, side: 'short' }, 90)).toBe(220);
    // Kurs 115 → 200 Margin − 30 Verlust
    expect(positionValue({ qty: 2, avgEntry: 100, side: 'short' }, 115)).toBe(170);
    // ohne Kurs: nur Margin (P&L 0)
    expect(positionValue({ qty: 2, avgEntry: 100, side: 'short' }, null)).toBe(200);
  });
});
