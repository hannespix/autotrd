import { describe, expect, it } from 'vitest';
import { emptyState } from '../../src/core/journal.ts';
import { openPosition } from '../../src/core/logic.ts';
import { msFromET, MIN } from '../../src/core/time.ts';
import { Book, buildTrade } from '../../src/engine/book.ts';

const T = msFromET(2026, 9, 1, 10, 0);

function pos(over: Partial<ReturnType<typeof openPosition>> = {}) {
  return { ...openPosition({ symbol: 'AAPL', side: 'long', qty: 10, fillPrice: 100, fillTime: T, stop: 98, target: 104, strategy: 's', entryDay: '2026-09-01' }), ...over };
}

describe('Book', () => {
  it('geht verlustfrei durch State (Positionen, Pending-IDs, Schutz-Stops, Daytrades)', () => {
    const b = new Book();
    b.open(pos());
    b.markPending('MSFT', { clientId: 'atd-paper-MSFT-1-e', orderId: 'o-9', intent: null, submittedAt: T });
    b.protectiveOrders.set('AAPL', { orderId: 'o-1-sl', clientId: 'leg-o-1-sl', stop: 98 });
    b.recordDayTrade('2026-09-01');
    const st = { ...emptyState('paper', '2026-09-01', 1000), ...b.toState() };
    const back = Book.fromState(st);
    expect(back.positions.get('AAPL')).toEqual(pos());
    expect(back.pendingEntries.get('MSFT')?.clientId).toBe('atd-paper-MSFT-1-e');
    expect(back.pendingEntries.get('MSFT')?.intent).toBeNull();
    expect(back.protectiveOrders.get('AAPL')).toEqual({ orderId: null, clientId: 'leg-o-1-sl', stop: 98 });
    expect(back.dayTrades.get('2026-09-01')).toBe(1);
  });

  it('schließt Trades mit Brutto, R-Multiple und zählt Daytrades nur beim Vollschluss am selben Tag', () => {
    const b = new Book();
    b.open(pos());
    const part = b.closeTrade('AAPL', 4, 102, T + 5 * MIN, 'target', 'us_equity');
    expect(part?.fullyClosed).toBe(false);
    expect(part?.dayTrade).toBe(false);
    expect(part?.trade.grossPnl).toBeCloseTo(8);
    expect(part?.trade.rMultiple).toBeCloseTo(8 / (2 * 4));
    expect(b.positions.get('AAPL')?.qty).toBe(6);
    const rest = b.closeTrade('AAPL', 6, 97, T + 10 * MIN, 'stop', 'us_equity');
    expect(rest?.fullyClosed).toBe(true);
    expect(rest?.dayTrade).toBe(true);
    expect(rest?.trade.netPnl).toBeCloseTo(-18);
    expect(b.positions.has('AAPL')).toBe(false);
    expect(b.dayTrades.get('2026-09-01')).toBe(1);
  });

  it('zählt einen Übernacht-Schluss nicht als Daytrade und liefert rMultiple null ohne Erst-Stop', () => {
    const b = new Book();
    b.open(pos({ initialStop: null }));
    const next = msFromET(2026, 9, 2, 10, 0);
    const closed = b.closeTrade('AAPL', 10, 101, next, 'signal', 'us_equity');
    expect(closed?.dayTrade).toBe(false);
    expect(closed?.trade.rMultiple).toBeNull();
    expect(b.dayTrades.size).toBe(0);
  });

  it('schreibt Positionen je geschlossener Bar fort (Haltedauer, Hochwasser)', () => {
    const b = new Book();
    b.open(pos());
    b.advanceAll(new Map([['AAPL', 103]]));
    b.advanceAll(new Map([['AAPL', 101]]));
    expect(b.positions.get('AAPL')?.barsHeld).toBe(2);
    expect(b.positions.get('AAPL')?.highWater).toBe(103);
  });

  it('buildTrade: Short-Gewinn ist Einstand minus Ausstieg', () => {
    const t = buildTrade(pos({ side: 'short', stop: 102, initialStop: 102 }), 10, 95, T + MIN, 'target');
    expect(t.grossPnl).toBeCloseTo(50);
    expect(t.rMultiple).toBeCloseTo(50 / 20);
    expect(t.fees).toBe(0);
  });
});
