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

  describe('Zielgewicht (Allokations-Familien)', () => {
    // Weiter Katastrophen-Stop (20 %): über die Stop-Distanz wären das 2,5 Stück —
    // das Gewicht bemisst stattdessen den Anteil an der Equity.
    const weit = { ...base, stop: 80, maxPositionPct: 100 };

    it('bemisst den Anteil an der Equity statt der Stop-Distanz', () => {
      expect(sizePosition(weit).qty).toBe(2); // Risiko-Budget: 50 $ / 20 $
      expect(sizePosition({ ...weit, weight: 0.3 }).qty).toBe(30); // 3 000 $ / 100 $
    });

    it('Deckel, Exposure und Bargeld gelten weiter', () => {
      expect(sizePosition({ ...weit, weight: 0.3, maxPositionPct: 20 }).qty).toBe(20);
      expect(sizePosition({ ...weit, weight: 0.3, exposureBudget: 1_050 }).qty).toBe(10);
      expect(sizePosition({ ...weit, weight: 0.3, cash: 550 }).qty).toBe(5);
      expect(sizePosition({ ...weit, weight: 0.3, price: 5_000, maxPositionPct: 100 }).reason).toMatch(/Zielgewicht/);
    });

    it('ein Gewicht außerhalb (0, 1] ist ein Fehler, keine Position', () => {
      for (const w of [0, -0.1, 1.5, Number.NaN]) {
        const r = sizePosition({ ...weit, weight: w });
        expect(r.qty, String(w)).toBe(0);
        expect(r.reason, String(w)).toMatch(/Gewicht/);
      }
    });

    it('der Stop bleibt Pflicht und muss auf der Verlustseite liegen', () => {
      expect(sizePosition({ ...weit, weight: 0.3, stop: 101 }).reason).toMatch(/Stop/);
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
