import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.ts';
import type { AccountView, HaltState, Trade } from '../../src/core/types.ts';
import { checkHalt, dailyLossPct, drawdownPct, resumeHalt } from '../../src/risk/limits.ts';
import { countDayTrades, pdtCheck } from '../../src/risk/pdt.ts';
import { sizePosition } from '../../src/risk/sizing.ts';
import { msFromET } from '../../src/core/time.ts';

const risk = parseConfig({ universe: { symbols: ['AAPL'] } }).risk;
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

function acc(over: Partial<AccountView> = {}): AccountView {
  return { equity: 10_000, cash: 10_000, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false, ...over };
}

describe('sizePosition', () => {
  const base = { equity: 10_000, cash: 10_000, price: 100, stop: 98, side: 'long' as const, riskPct: 0.5, maxPositionPct: 20, exposureBudget: 10_000, qtyStep: 1 };

  it('nimmt das Minimum aus Risiko, Deckel, Exposure und Bargeld', () => {
    expect(sizePosition(base).qty).toBe(20); // Deckel 2000 $ / 100
    expect(sizePosition({ ...base, maxPositionPct: 100 }).qty).toBe(25); // Risiko 50 $ / 2 $
    expect(sizePosition({ ...base, maxPositionPct: 100, exposureBudget: 1_050 }).qty).toBe(10);
    expect(sizePosition({ ...base, maxPositionPct: 100, cash: 550 }).qty).toBe(5);
  });

  it('Short braucht kein Bargeld, aber einen Stop oberhalb', () => {
    expect(sizePosition({ ...base, side: 'short', stop: 102, cash: 0, maxPositionPct: 100 }).qty).toBe(25);
    expect(sizePosition({ ...base, side: 'short', stop: 98 }).qty).toBe(0);
  });

  it('rundet auf die Stückelung (Krypto) und meldet den Begrenzer', () => {
    expect(sizePosition({ ...base, price: 30_000, stop: 29_000, qtyStep: 0.0001, maxPositionPct: 100 }).qty).toBe(0.05);
    const r = sizePosition({ ...base, price: 5_000, stop: 4_900 });
    expect(r.qty).toBe(0);
    expect(r.reason).toMatch(/Positionsdeckel/);
  });

  it('ungültige Eingaben ⇒ 0 mit Grund', () => {
    expect(sizePosition({ ...base, price: 0 }).reason).toMatch(/Kurs/);
    expect(sizePosition({ ...base, equity: 0 }).reason).toMatch(/Equity/);
  });

  /* ── Allokations-Sizing der Basis-Stufe (Prüfbefund K4) ── */

  describe('sizing: allocation (Basis-Stufe)', () => {
    const alloc = { ...base, stop: 80, maxPositionPct: 100, sizing: { mode: 'allocation' as const, positionPct: 20 } };

    it('Zielstückzahl = floor(Equity × positionPct / Kurs) — unabhängig vom Risiko je Trade und von der Stop-Distanz', () => {
      // 10 000 × 20 % / 100 = 20 Stück; riskPct 0,5 % ergäbe 50 $ / 20 $ = 2 Stück.
      expect(sizePosition(alloc).qty).toBe(20);
      expect(sizePosition({ ...alloc, riskPct: 5 }).qty).toBe(20);
      expect(sizePosition({ ...alloc, riskPct: 0 }).qty).toBe(20);
      expect(sizePosition({ ...alloc, stop: 99 }).qty).toBe(20);
      expect(sizePosition({ ...alloc, price: 33, stop: 26 }).qty).toBe(60); // 2 000 / 33 = 60,6 ⇒ 60
      expect(sizePosition(alloc).notional).toBe(2_000);
    });

    it('WÄCHTER: Identität — Risiko 4 % bei Stop 20 % ist Allokation 20 %', () => {
      const messung = sizePosition({ ...base, stop: 80, riskPct: 4, maxPositionPct: 25 });
      const handel = sizePosition({ ...base, stop: 80, riskPct: 0.5, maxPositionPct: 25, sizing: { mode: 'allocation', positionPct: 20 } });
      expect(handel.qty).toBe(messung.qty);
      expect(handel.qty).toBe(20);
      for (const price of [7, 33, 250, 612.5]) {
        expect(sizePosition({ ...base, price, stop: price * 0.8, riskPct: 4, maxPositionPct: 25 }).qty).toBe(
          sizePosition({ ...base, price, stop: price * 0.8, riskPct: 0.5, maxPositionPct: 25, sizing: { mode: 'allocation', positionPct: 20 } }).qty,
        );
      }
    });

    it('WÄCHTER: die Deckel des Nutzers verkleinern nur — maxPositionPct, Exposure-Budget, Bargeld', () => {
      expect(sizePosition({ ...alloc, maxPositionPct: 10 }).qty).toBe(10);
      expect(sizePosition({ ...alloc, maxPositionPct: 50 }).qty).toBe(20); // ein weiterer Deckel vergrößert nichts
      expect(sizePosition({ ...alloc, exposureBudget: 1_250 }).qty).toBe(12);
      expect(sizePosition({ ...alloc, cash: 550 }).qty).toBe(5);
      const r = sizePosition({ ...alloc, maxPositionPct: 0.5 });
      expect(r.qty).toBe(0);
      expect(r.reason).toMatch(/Positionsdeckel/);
    });

    it('der Stop bleibt Pflicht: ohne Stop auf der Verlustseite keine Stückzahl — auch in der Allokation', () => {
      const r = sizePosition({ ...alloc, stop: 100 });
      expect(r.qty).toBe(0);
      expect(r.reason).toMatch(/Verlustseite/);
      expect(sizePosition({ ...alloc, side: 'short', stop: 120, cash: 0 }).qty).toBe(20);
    });

    it('meldet den Begrenzer „Allokation", wenn der Anteil unter eine Stückelung fällt', () => {
      const r = sizePosition({ ...alloc, price: 5_000 });
      expect(r.qty).toBe(0);
      expect(r.reason).toMatch(/Allokation/);
    });
  });
});

describe('checkHalt', () => {
  const inp = { halt: noHalt, risk, now: 1, today: '2026-09-04', nextDay: '2026-09-08' };

  it('Prozentrechnung', () => {
    expect(dailyLossPct(acc({ equity: 9_800 }))).toBeCloseTo(-2, 9);
    expect(drawdownPct(acc({ equity: 9_000, peakEquity: 10_000 }))).toBeCloseTo(10, 9);
  });

  it('löst die Tages-Notbremse genau an der Schwelle aus', () => {
    expect(checkHalt({ ...inp, account: acc({ equity: 9_801 }) }).triggered).toBe(false);
    const r = checkHalt({ ...inp, account: acc({ equity: 9_800 }) });
    expect(r.triggered).toBe(true);
    expect(r.halt.reason).toBe('daily_loss');
    expect(r.halt.until).toBe('2026-09-08');
  });

  it('Drawdown geht vor Tagesverlust und hat kein Enddatum', () => {
    const r = checkHalt({ ...inp, account: acc({ equity: 8_900, dayStartEquity: 8_950, peakEquity: 10_000 }) });
    expect(r.halt.reason).toBe('drawdown');
    expect(r.halt.until).toBeNull();
  });

  it('Tages-Halt endet am Zieltag; Drawdown-Halt nicht', () => {
    const day: HaltState = { halted: true, reason: 'daily_loss', since: 1, until: '2026-09-08', note: null };
    expect(checkHalt({ ...inp, halt: day, account: acc() }).halt.halted).toBe(true);
    const lifted = checkHalt({ ...inp, halt: day, today: '2026-09-08', account: acc() });
    expect(lifted.lifted).toBe(true);
    expect(lifted.halt.halted).toBe(false);
    const dd: HaltState = { halted: true, reason: 'drawdown', since: 1, until: null, note: null };
    expect(checkHalt({ ...inp, halt: dd, today: '2027-01-01', account: acc() }).halt.halted).toBe(true);
  });

  it('misst auch im Halt weiter und eskaliert (HALT-Datei darf die Notbremse nicht abschalten)', () => {
    const manual: HaltState = { halted: true, reason: 'manual', since: 1, until: null, note: null };
    const r = checkHalt({ ...inp, halt: manual, account: acc({ equity: 9_500 }) });
    expect(r.triggered).toBe(true);
    expect(r.halt.reason).toBe('daily_loss');
    // im Tages-Halt löst derselbe Tagesverlust nicht erneut aus, ein Drawdown aber schon
    const day: HaltState = { halted: true, reason: 'daily_loss', since: 1, until: '2026-09-08', note: null };
    expect(checkHalt({ ...inp, halt: day, account: acc({ equity: 9_500 }) }).triggered).toBe(false);
    const esc = checkHalt({ ...inp, halt: day, account: acc({ equity: 8_900, peakEquity: 10_000 }) });
    expect(esc.triggered).toBe(true);
    expect(esc.halt.reason).toBe('drawdown');
    // im Drawdown-Halt wird nichts mehr eskaliert
    const dd: HaltState = { halted: true, reason: 'drawdown', since: 1, until: null, note: null };
    expect(checkHalt({ ...inp, halt: dd, account: acc({ equity: 5_000, peakEquity: 10_000 }) }).triggered).toBe(false);
  });

  it('resumeHalt setzt den Peak neu', () => {
    const dd: HaltState = { halted: true, reason: 'drawdown', since: 1, until: null, note: null };
    const r = resumeHalt(dd, acc({ equity: 9_000, peakEquity: 10_000 }), 2, 'Owner');
    expect(r.halt.halted).toBe(false);
    expect(r.account.peakEquity).toBe(9_000);
  });
});

describe('PDT', () => {
  const base = { respect: true, minEquity: 25_000, maxDayTrades: 3, equity: 10_000, brokerCount: 0, localCount: 0, plannedIntradayEntries: 0, intraday: true, assetClass: 'us_equity' as const };

  it('greift nur unter der Equity-Schwelle und nicht bei Krypto', () => {
    expect(pdtCheck({ ...base, equity: 25_000, brokerCount: 3 }).allowed).toBe(true);
    expect(pdtCheck({ ...base, assetClass: 'crypto', brokerCount: 3 }).allowed).toBe(true);
    expect(pdtCheck({ ...base, respect: false, brokerCount: 3 }).allowed).toBe(true);
  });

  it('zählt Broker, lokal und geplante Einstiege', () => {
    expect(pdtCheck({ ...base, brokerCount: 2 }).remaining).toBe(1);
    expect(pdtCheck({ ...base, brokerCount: 2, plannedIntradayEntries: 1 }).allowed).toBe(false);
    expect(pdtCheck({ ...base, localCount: 3 }).allowed).toBe(false);
    expect(pdtCheck({ ...base, brokerCount: 3, intraday: false }).allowed).toBe(false);
    expect(pdtCheck({ ...base, brokerCount: 2, intraday: false }).allowed).toBe(true);
  });

  it('countDayTrades zählt Round-Trips am selben Tag im 5-Tage-Fenster', () => {
    const t = (d: number, sameDay: boolean): Trade => ({
      symbol: 'A',
      side: 'long',
      qty: 1,
      entryTime: msFromET(2026, 9, d, 10, 0),
      entryPrice: 1,
      exitTime: sameDay ? msFromET(2026, 9, d, 15, 0) : msFromET(2026, 9, d + 1, 10, 0),
      exitPrice: 1,
      grossPnl: 0,
      fees: 0,
      netPnl: 0,
      rMultiple: null,
      exitReason: 'signal',
      strategy: 's',
      barsHeld: 1,
      mae: null,
      mfe: null,
    });
    // Fenster bis 04.09.: 28.08., 31.08., 01.09., 02.09., 03.09., 04.09. (28.08. ist der 5. Handelstag zurück inkl.)
    const trades = [t(4, true), t(3, true), t(2, false), t(1, true), t(1, true)];
    expect(countDayTrades(trades, '2026-09-04', 'us_equity')).toBe(4);
    // Fenster bis 14.09. beginnt am 08.09. (07.09. Labor Day) ⇒ der 04.09. liegt draußen
    expect(countDayTrades([t(4, true)], '2026-09-14', 'us_equity')).toBe(0);
    expect(countDayTrades([t(4, true)], '2026-09-11', 'us_equity')).toBe(1);
  });
});
