import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/core/time.ts';
import type { Trade } from '../src/core/types.ts';
import { DEFAULT_READINESS_THRESHOLDS, assessReadiness, calendarDaysBetween, maxDrawdownFromTrades } from '../src/readiness.ts';

/** 2026-01-05 10:00 ET (EST = UTC−5). */
const T0 = Date.UTC(2026, 0, 5, 15, 0);
const NOW = T0 + 40 * DAY;

function mk(o: Partial<Trade> = {}): Trade {
  return {
    symbol: 'SPY',
    side: 'long',
    qty: 1,
    entryTime: T0,
    entryPrice: 100,
    exitTime: T0 + HOUR,
    exitPrice: 101,
    grossPnl: 1,
    fees: 0.1,
    netPnl: 0.9,
    rMultiple: null,
    exitReason: 'signal',
    strategy: 'test',
    barsHeld: 1,
    mae: null,
    mfe: null,
    ...o,
  };
}

/**
 * 200 Trades exakt an allen Schwellen: 120 Gewinner (brutto +20, Kosten 8,
 * netto +12) und 80 Verlierer (brutto −12, Kosten 3, netto −15).
 *   Profit-Faktor = 1440 / 1200 = 1.2 · Gebührenanteil = 1200 / 2400 = 0.5
 *   Netto = +240 · Spanne erster Einstieg → letzter Ausstieg = 30 Kalendertage
 */
function atThreshold(): Trade[] {
  const out: Trade[] = [];
  for (let i = 0; i < 200; i++) {
    const entry = T0 + i * 3 * HOUR;
    const win = i < 120;
    out.push(
      mk({
        entryTime: entry,
        exitTime: i === 199 ? T0 + 30 * DAY : entry + HOUR,
        grossPnl: win ? 20 : -12,
        fees: win ? 8 : 3,
        netPnl: win ? 12 : -15,
      }),
    );
  }
  return out;
}

const check = (r: ReturnType<typeof assessReadiness>, name: string) => r.checks.find((c) => c.name === name)!;

describe('assessReadiness', () => {
  it('0 Trades ⇒ nicht bereit, alle Kriterien fallen durch', () => {
    const r = assessReadiness([], NOW);
    expect(r.ready).toBe(false);
    expect(r.checks).toHaveLength(5);
    expect(r.checks.every((c) => !c.pass)).toBe(true);
    expect(check(r, 'trades').value).toBe(0);
    expect(check(r, 'days').value).toBeNull();
    expect(check(r, 'profitFactor').value).toBeNull();
    expect(check(r, 'feeShare').value).toBeNull();
    expect(check(r, 'netProfit').value).toBe(0);
    expect(r.maxDrawdown).toBe(0);
    expect(r.evaluated).toBe(0);
    expect(r.summary).toContain('NICHT ERREICHT (0/5');
    expect(r.summary).toContain('Stand 2026-02-14');
    expect(r.summary).toContain('broker.mode=live NICHT setzen');
  });

  it('genau an allen Schwellen ⇒ bereit (≥ / ≤ sind inklusiv, Netto strikt > 0)', () => {
    const r = assessReadiness(atThreshold(), NOW);
    expect(r.checks.map((c) => [c.name, c.pass])).toEqual([
      ['trades', true],
      ['days', true],
      ['profitFactor', true],
      ['feeShare', true],
      ['netProfit', true],
    ]);
    expect(r.ready).toBe(true);
    expect(check(r, 'trades').value).toBe(200);
    expect(check(r, 'days').value).toBe(30);
    expect(check(r, 'profitFactor').value).toBeCloseTo(1.2, 12);
    expect(check(r, 'feeShare').value).toBe(0.5);
    expect(check(r, 'netProfit').value).toBe(240);
    expect(r.checks.map((c) => c.threshold)).toEqual([200, 30, 1.2, 0.5, 0]);
    expect(r.summary).toContain('ERREICHT (5/5');
    expect(r.summary).not.toContain('NICHT ERREICHT');
  });

  it('ein Trade unter der Mindestanzahl ⇒ nur das Kriterium „trades" fällt', () => {
    const trades = atThreshold();
    trades.splice(120, 1); // ersten Verlierer entfernen: PF/feeShare/Netto bleiben über den Schwellen
    const r = assessReadiness(trades, NOW);
    expect(r.ready).toBe(false);
    expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(['trades']);
    expect(check(r, 'trades').value).toBe(199);
  });

  it('Gebührenanteil unter der Schwelle scheitert wie beim Vorgänger (feeShare 0.57)', () => {
    const trades = atThreshold().map((t) => (t.grossPnl > 0 ? { ...t, fees: 9.4, netPnl: 10.6 } : t));
    const r = assessReadiness(trades, NOW);
    const fs = check(r, 'feeShare');
    expect(fs.value).toBeCloseTo((120 * 9.4 + 80 * 3) / 2400, 12);
    expect(fs.pass).toBe(false);
    expect(r.ready).toBe(false);
  });

  it('Netto genau 0 ⇒ fällt durch (strikt größer)', () => {
    const trades = [mk({ grossPnl: 5, fees: 2, netPnl: 3 }), mk({ grossPnl: -1, fees: 2, netPnl: -3 })];
    const r = assessReadiness(trades, NOW, { minTrades: 1, minDays: 0 });
    expect(check(r, 'netProfit').value).toBe(0);
    expect(check(r, 'netProfit').pass).toBe(false);
  });

  it('ohne Brutto-Gewinne ist der Gebührenanteil null und fällt durch', () => {
    const trades = [mk({ grossPnl: -1, fees: 1, netPnl: -2 }), mk({ grossPnl: 0, fees: 1, netPnl: -1 })];
    const r = assessReadiness(trades, NOW, { minTrades: 1, minDays: 0 });
    expect(check(r, 'feeShare').value).toBeNull();
    expect(check(r, 'feeShare').pass).toBe(false);
    expect(check(r, 'profitFactor').value).toBeNull();
    expect(check(r, 'profitFactor').pass).toBe(false);
    expect(r.summary).toContain('Gebührenanteil');
    expect(r.summary).toContain(': –');
  });

  it('ohne Verlierer ist der Profit-Faktor unendlich und besteht', () => {
    const trades = [mk({ grossPnl: 5, fees: 1, netPnl: 4 }), mk({ grossPnl: 3, fees: 1, netPnl: 2 })];
    const r = assessReadiness(trades, NOW, { minTrades: 1, minDays: 0 });
    expect(check(r, 'profitFactor').value).toBe(Number.POSITIVE_INFINITY);
    expect(check(r, 'profitFactor').pass).toBe(true);
    expect(r.summary).toContain('∞');
  });

  it('Trades mit Exit nach `now` oder kaputten Feldern werden ignoriert (kein Lookahead)', () => {
    const future = mk({ entryTime: NOW + HOUR, exitTime: NOW + 2 * HOUR, grossPnl: 1000, fees: 0, netPnl: 1000 });
    const broken = mk({ netPnl: Number.NaN });
    const reversed = mk({ entryTime: T0 + HOUR, exitTime: T0 });
    const r = assessReadiness([mk(), future, broken, reversed], NOW, { minTrades: 1, minDays: 0 });
    expect(r.ignored).toBe(3);
    expect(r.evaluated).toBe(1);
    expect(check(r, 'netProfit').value).toBeCloseTo(0.9, 12);
    expect(r.summary).toContain('3 ignoriert');
  });

  it('Schwellen sind überschreibbar; Defaults bleiben unverändert', () => {
    const r = assessReadiness([mk()], NOW, { minTrades: 1, minDays: 0, minProfitFactor: 1, maxFeeShare: 0.2, minNetProfit: 0.5 });
    expect(r.ready).toBe(true);
    expect(DEFAULT_READINESS_THRESHOLDS).toEqual({ minTrades: 200, minDays: 30, minProfitFactor: 1.2, maxFeeShare: 0.5, minNetProfit: 0 });
  });
});

describe('maxDrawdownFromTrades', () => {
  it('rechnet den größten Rückgang der kumulierten Netto-PnL in Exit-Reihenfolge', () => {
    // Reihenfolge nach Exit: +10, −5, −8, +20 ⇒ Kurve 10, 5, −3, 17 ⇒ Peak 10, Tief −3 ⇒ 13
    const trades = [
      mk({ exitTime: T0 + 4 * HOUR, netPnl: 20 }),
      mk({ exitTime: T0 + 1 * HOUR, netPnl: 10 }),
      mk({ exitTime: T0 + 3 * HOUR, netPnl: -8 }),
      mk({ exitTime: T0 + 2 * HOUR, netPnl: -5 }),
    ];
    expect(maxDrawdownFromTrades(trades)).toBe(13);
    expect(maxDrawdownFromTrades([])).toBe(0);
    expect(maxDrawdownFromTrades([mk({ netPnl: 5 })])).toBe(0);
  });
});

describe('calendarDaysBetween', () => {
  it('zählt ET-Kalendertage, auch über den DST-Wechsel', () => {
    expect(calendarDaysBetween(T0, T0 + 5 * HOUR)).toBe(0);
    expect(calendarDaysBetween(T0, T0 + 30 * DAY)).toBe(30);
    // 2026-03-01 10:00 ET (EST) → 2026-03-31 10:00 ET (EDT): DST-Beginn am 8. März dazwischen
    const mar1 = Date.UTC(2026, 2, 1, 15, 0);
    const mar31 = Date.UTC(2026, 2, 31, 14, 0);
    expect(calendarDaysBetween(mar1, mar31)).toBe(30);
    // 23:30 ET am 5.1. ist in UTC schon der 6.1. — ET zählt
    const lateEt = Date.UTC(2026, 0, 6, 4, 30);
    expect(calendarDaysBetween(T0, lateEt)).toBe(0);
  });
});
