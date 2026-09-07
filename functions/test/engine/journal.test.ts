import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../../../src/core/journal.ts';
import { registerSecret, setLogSink } from '../../../src/core/log.ts';
import { DAY, msFromET } from '../../../src/core/time.ts';
import type { Trade } from '../../../src/core/types.ts';
import { FirestoreJournal, keepEvent, riskExitOf, tradeDocsFor } from '../../src/engine/journal.ts';
import { FakeFirestore, FakeTimestamp } from '../fakes/firestore.ts';

setLogSink(() => undefined);

const T0 = msFromET(2026, 9, 1, 10, 0);

function trade(over: Partial<Trade> = {}): Trade {
  return {
    symbol: 'AAPL',
    side: 'long',
    qty: 10,
    entryTime: T0,
    entryPrice: 100,
    exitTime: T0 + 2 * DAY,
    exitPrice: 98,
    grossPnl: -20,
    fees: 0,
    netPnl: -20,
    rMultiple: -1,
    exitReason: 'stop',
    strategy: 'trend_donchian',
    barsHeld: 5,
    mae: null,
    mfe: null,
    ...over,
  };
}

const fxOk = async (iso: string) => ({ fxRate: iso.startsWith('2026-09-01') ? 1.1 : 1.2, fxDate: iso.slice(0, 10), fxSource: 'ecb' });

function journal(db: FakeFirestore, fx = fxOk, warnings: string[] = []): FirestoreJournal {
  return new FirestoreJournal({
    db,
    mode: 'paper',
    assetClass: 'us_equity',
    fx,
    timestampNow: () => FakeTimestamp.now(),
    log: { debug: () => undefined, info: () => undefined, warn: (m) => void warnings.push(m), error: () => undefined },
  });
}

describe('FirestoreJournal — Filter', () => {
  const ev = (kind: JournalEvent['kind'], data: Record<string, unknown> = {}): JournalEvent => ({ ...data, ts: 1, kind });
  it('Takt-Rauschen bleibt draußen, alles andere kommt durch', () => {
    expect(keepEvent(ev('start'))).toBe(false);
    expect(keepEvent(ev('stop'))).toBe(false);
    expect(keepEvent(ev('reconcile', { action: 'summary' }))).toBe(false);
    expect(keepEvent(ev('reconcile', { action: 'missing' }))).toBe(true);
    expect(keepEvent(ev('decision', { note: 'blocked', text: 'Halt aktiv (manual)' }))).toBe(false);
    expect(keepEvent(ev('decision', { note: 'blocked', text: 'Positionslimit erreicht' }))).toBe(true);
    expect(keepEvent(ev('decision', { note: 'decision', text: 'Enter long 199' }))).toBe(true);
    expect(keepEvent(ev('note'))).toBe(true);
    expect(keepEvent(ev('trade_closed'))).toBe(true);
  });
  it('riskExit nur bei Stop, Tages-Notbremse und Drawdown', () => {
    expect(riskExitOf('stop')).toBe('stop_loss');
    expect(riskExitOf('kill_switch')).toBe('daily_loss');
    expect(riskExitOf('drawdown')).toBe('drawdown');
    for (const r of ['target', 'signal', 'eod', 'time', 'manual', 'reconcile'] as const) expect(riskExitOf(r)).toBeNull();
  });
});

describe('FirestoreJournal — flush', () => {
  it('schreibt gefilterte Ereignisse als Docs (ts, kind, mode) in einem Batch und leert den Puffer', async () => {
    const db = new FakeFirestore();
    const j = journal(db);
    j.append('start', { mode: 'paper' }, 10);
    j.append('intent', { symbol: 'AAPL', intent: { kind: 'enter' } }, 11);
    j.append('decision', { symbol: 'AAPL', note: 'blocked', text: 'Halt aktiv (manual)' }, 12);
    j.append('note', { text: 'hallo' }, 13);
    expect(j.pending()).toBe(4);
    const r = await j.flush('u1');
    expect(r).toEqual({ events: 2, trades: 0 });
    expect(j.pending()).toBe(0);
    const docs = db.list('users/u1/journal').map((d) => d.data);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.kind).sort()).toEqual(['intent', 'note']);
    expect(docs.every((d) => d.mode === 'paper' && typeof d.ts === 'number')).toBe(true);
    expect(db.commits).toBe(1);
    expect(db.list('users/u1/trades')).toHaveLength(0);
  });

  it('trade_closed (long, Stop) ⇒ Einstiegs- und Ausstiegs-Doc im alten Schema, EZB-Kurs je Seite eingefroren', async () => {
    const db = new FakeFirestore();
    const j = journal(db);
    j.append('trade_closed', { trade: trade(), partial: false, dayTrade: false, orderId: 'o-1-sl' }, T0 + 2 * DAY);
    const r = await j.flush('u1');
    expect(r).toEqual({ events: 1, trades: 1 });
    const docs = db.list('users/u1/trades').map((d) => d.data);
    expect(docs).toHaveLength(2);
    const entry = docs.find((d) => d.side === 'buy')!;
    const exit = docs.find((d) => d.side === 'sell')!;
    expect(entry).toMatchObject({
      symbol: 'AAPL',
      qty: 10,
      price: 100,
      rawPrice: 100,
      executedAt: new Date(T0).toISOString(),
      source: 'engine',
      paper: true,
      assetClass: 'us_equity',
      currency: 'USD',
      fee: 0,
      strategy: 'trend_donchian',
      preisQuelle: 'broker',
      fxRate: 1.1,
      fxDate: '2026-09-01',
      fxSource: 'ecb',
    });
    expect(entry.short).toBeUndefined();
    expect(entry.pnl).toBeUndefined();
    expect(exit).toMatchObject({
      symbol: 'AAPL',
      qty: 10,
      price: 98,
      rawPrice: 98,
      executedAt: new Date(T0 + 2 * DAY).toISOString(),
      source: 'engine',
      paper: true,
      fee: 0,
      pnl: -20,
      entryPrice: 100,
      acquiredAt: new Date(T0).toISOString(),
      holdingDays: 2,
      riskExit: 'stop_loss',
      exitReason: 'stop',
      brokerOrderId: 'o-1-sl',
      fxRate: 1.2,
      fxDate: '2026-09-03',
    });
    expect(exit.cover).toBeUndefined();
    expect(exit.teilSchluss).toBeUndefined();
    expect(exit.at).toMatchObject({ seconds: expect.any(Number) });
    // Das Journal-Doc des Trades existiert daneben.
    expect(db.list('users/u1/journal').map((d) => d.data.kind)).toEqual(['trade_closed']);
  });

  it('Short ⇒ Einstieg sell+short, Ausstieg buy+cover; Ziel-Exit ohne riskExit; Teilschluss markiert', async () => {
    const db = new FakeFirestore();
    const j = journal(db);
    j.append('trade_closed', { trade: trade({ side: 'short', exitPrice: 95, grossPnl: 50, netPnl: 50, exitReason: 'target' }), partial: true }, T0 + DAY);
    await j.flush('u1');
    const docs = db.list('users/u1/trades').map((d) => d.data);
    const entry = docs.find((d) => d.short === true)!;
    const exit = docs.find((d) => d.cover === true)!;
    expect(entry).toMatchObject({ side: 'sell', price: 100 });
    expect(exit).toMatchObject({ side: 'buy', price: 95, pnl: 50, exitReason: 'target', teilSchluss: true });
    expect(exit.riskExit).toBeUndefined();
  });

  it('EZB-Kurs nicht belegbar oder Abruf-Fehler ⇒ null-Felder und Warnung — nie ein Ersatzwert', async () => {
    const db = new FakeFirestore();
    const warnings: string[] = [];
    const j = journal(db, async (iso) => (iso.startsWith('2026-09-01') ? {} : Promise.reject(new Error('API down'))), warnings);
    j.append('trade_closed', { trade: trade() }, T0 + 2 * DAY);
    await j.flush('u1');
    const docs = db.list('users/u1/trades').map((d) => d.data);
    expect(docs).toHaveLength(2);
    for (const d of docs) expect(d).toMatchObject({ fxRate: null, fxDate: null, fxSource: null });
    expect(warnings.some((w) => w.includes('nicht belegbar'))).toBe(true);
    expect(warnings.some((w) => w.includes('fehlgeschlagen'))).toBe(true);
  });

  it('Schwärzung: ein registriertes Secret landet nicht in Firestore', async () => {
    registerSecret('PKGEHEIM1234567890');
    const db = new FakeFirestore();
    const j = journal(db);
    j.append('error', { where: 'tick', error: 'HTTP 401 mit PKGEHEIM1234567890 im Header' }, 1);
    await j.flush('u1');
    const doc = db.list('users/u1/journal')[0]!.data;
    expect(String(doc.error)).not.toContain('PKGEHEIM1234567890');
    expect(String(doc.error)).toContain('«geschwärzt»');
  });

  it('tradeDocsFor: geschätzter Kurs (Abgleich) wird als Modellpreis gekennzeichnet', () => {
    const { exit } = tradeDocsFor(trade({ exitReason: 'reconcile' }), { mode: 'live', assetClass: 'us_equity', partial: false, estimated: true, fxEntry: null, fxExit: null, at: 't', orderId: null });
    expect(exit).toMatchObject({ preisQuelle: 'modell', kursGeschaetzt: true, paper: false, at: 't' });
  });

  it('bei Batch-Fehler bleibt der Puffer stehen und der Fehler fliegt', async () => {
    const db = new FakeFirestore();
    db.batch = () => {
      throw new Error('Firestore down');
    };
    const j = journal(db);
    j.append('note', { text: 'x' }, 1);
    await expect(j.flush('u1')).rejects.toThrow('Firestore down');
    expect(j.pending()).toBe(1);
  });
});
