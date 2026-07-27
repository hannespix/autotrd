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
  EXIT_SIGNAL,
  costProfile,
  exitBreakdown,
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

/* ── MT1: Ausstiegsgründe & Kostenprofil ───────────────────────────────────
 * Die Zahlen unten sind die echten Werte der beiden Owner-Testkonten vom
 * 27.07. — sie sind der Grund, warum es diese Kennzahlen gibt. */

describe('exitBreakdown', () => {
  it('gruppiert nach Ausstiegsgrund, Signal-Exits als eigener Topf', () => {
    const b = exitBreakdown([
      { symbol: 'AAPL', pnl: -12, riskExit: 'stop_loss' },
      { symbol: 'QQQ', pnl: 30, riskExit: 'take_profit' },
      { symbol: 'TSLA', pnl: -4 },            // kein riskExit = Signal-Ausstieg
      { symbol: 'QQQ', pnl: 6 },
    ]);
    expect(b.stop_loss).toEqual({ n: 1, pnl: -12, wins: 0 });
    expect(b.take_profit).toEqual({ n: 1, pnl: 30, wins: 1 });
    expect(b[EXIT_SIGNAL]).toEqual({ n: 2, pnl: 2, wins: 1 });
  });

  it('macht sichtbar, wenn ALLE Trades am Signal sterben', () => {
    // Genau das war der Befund: Stop (1,5 %) und Take (3 %) wurden nie
    // erreicht, die Bewegungen lagen bei 0,4–0,6 %.
    const b = exitBreakdown(Array.from({ length: 16 }, (_, i) => ({ symbol: 'QQQ', pnl: i < 6 ? 7 : -18 })));
    expect(Object.keys(b)).toEqual([EXIT_SIGNAL]);
    expect(b[EXIT_SIGNAL]?.n).toBe(16);
  });

  it('ersetzt Punkte im Schlüssel (Firestore würde daran verschachteln)', () => {
    expect(exitBreakdown([{ symbol: 'X', pnl: 1, riskExit: 'a.b' }]).a_b?.n).toBe(1);
  });

  it('überspringt Trades ohne brauchbares Ergebnis', () => {
    expect(exitBreakdown([{ symbol: 'X', pnl: Number.NaN }])).toEqual({});
  });
});

describe('costProfile', () => {
  /** Ein Trade wie im Livesystem: 2.500 $ Position, 0,15 % je Seite. */
  const t = (pnl: number) => ({ symbol: 'QQQ', pnl, notional: 2500, feeRate: 0.0015 });

  it('rechnet die Gebühren aus dem Nettoergebnis zurück', () => {
    // Roundtrip = 2500 × 0,0015 × 2 = 7,50 $. Netto-Gewinn 4,85 → brutto 12,35
    // = 0,494 % Bewegung. Exakt die Rechnung, die die Ursache fand.
    const c = costProfile([t(4.85)]);
    expect(c.fees).toBeCloseTo(7.5, 2);
    expect(c.grossPnl).toBeCloseTo(12.35, 2);
    expect(c.avgWinGrossPct).toBeCloseTo(0.494, 3);
    expect(c.roundTripPct).toBeCloseTo(0.3, 3);
  });

  it('liefert edgeOverCost — die eine Zahl, die Luft über der Reibung misst', () => {
    // 0,494 % Gewinnbewegung gegen 0,30 % Kosten = Faktor 1,65.
    // Unter 2 verdient überwiegend der Broker.
    expect(costProfile([t(4.85)]).edgeOverCost).toBeCloseTo(1.65, 2);
    // Ein Trade mit 1,5 % Bruttobewegung hat dagegen Luft.
    expect(costProfile([{ ...t(0), pnl: 2500 * 0.015 - 7.5 }]).edgeOverCost).toBeGreaterThan(4);
  });

  it('reproduziert den Gebührenanteil von Konto B (86 %)', () => {
    // 16 Trades, netto −8,71 $ im Schnitt → Gebühren 7,50 sind 86 % davon.
    const c = costProfile(Array.from({ length: 16 }, () => t(-8.71)));
    expect(c.feeSharePct).toBeCloseTo(86.1, 0);
  });

  it('trennt Gewinn- und Verlustbewegung', () => {
    const c = costProfile([t(4.85), t(-16.55)]);
    expect(c.avgWinGrossPct).toBeCloseTo(0.494, 3);
    expect(c.avgLossGrossPct).toBeCloseTo(0.362, 3); // (16,55 − 7,50) / 2500
  });

  it('lässt den Anteil bei Ergebnis nahe null offen statt eine Riesenzahl zu zeigen', () => {
    expect(costProfile([t(0)]).feeSharePct).toBeNull();
  });

  it('ignoriert Trades ohne Positionswert oder Satz — kein Rateanteil', () => {
    expect(costProfile([{ symbol: 'X', pnl: 5 }]).n).toBe(0);
    expect(costProfile([{ symbol: 'X', pnl: 5, notional: 0, feeRate: 0.0015 }]).n).toBe(0);
    expect(costProfile([]).edgeOverCost).toBeNull();
  });
});
