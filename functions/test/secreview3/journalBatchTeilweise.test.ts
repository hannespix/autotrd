/**
 * SECREVIEW3 — M5: `FirestoreJournal.flush` (journal.ts L205-244) teilt > 450 Schreibvorgänge auf mehrere
 * Batches; `bufferClearOp` liegt nur im LETZTEN. Scheitert ein späterer Batch (oder stirbt die Function
 * dazwischen), sind die Docs der früheren Batches committed, der Puffer im State-Doc aber noch voll — der
 * Folgetakt spielt ihn zurück (`load()` → `restore`) und schreibt ALLES erneut: doppelte Journal-Docs und
 * doppelte Trade-Docs (`users/{uid}/trades` — Steuer, Live-Reife, stats/main). Die Atomarität gilt nur
 * für den letzten Batch. Der Puffer wächst genau in der Lage, in der das passiert (Firestore-Störung über
 * mehrere Takte, bis 2000 Ereignisse).
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { emptyState } from '../../../src/core/journal.ts';
import type { Trade } from '../../../src/core/types.ts';
import { DAY1, OPEN1 } from '../../../test/fakes/harness.ts';
import { FirestoreJournal } from '../../src/engine/journal.ts';
import { FirestoreStateStore } from '../../src/engine/state.ts';
import { FakeFirestore, FakeTimestamp } from '../fakes/firestore.ts';

const SILENT = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const T = OPEN1 + 10 * 60_000;

function trade(i: number): Trade {
  return { symbol: 'AAPL', side: 'long', qty: 1, entryTime: T + i, entryPrice: 100, exitTime: T + 1000 + i, exitPrice: 101, grossPnl: 1, fees: 0, netPnl: 1, rMultiple: 1, exitReason: 'stop', strategy: 't', barsHeld: 1, mae: null, mfe: null };
}

function takt(db: FakeFirestore) {
  const journal = new FirestoreJournal({ db, mode: 'paper', assetClass: 'us_equity', fx: async (at) => ({ fxRate: 1.1, fxDate: at.slice(0, 10), fxSource: 'ecb' }), log: SILENT, timestampNow: () => FakeTimestamp.now() });
  const store = new FirestoreStateStore(db, 'u1', { journal });
  return { journal, store };
}

describe('secreview3: Journal-Batch teilweise committed', () => {
  it('160 Trades ⇒ 481 Ops in 2 Batches; Batch 2 scheitert ⇒ das Nachschreiben darf Batch 1 nicht wiederholen', async () => {
    const db = new FakeFirestore();
    const a = takt(db);
    expect(await a.store.load()).toBeNull();
    for (let i = 0; i < 160; i++) a.journal.append('trade_closed', { trade: trade(i), partial: false }, T + 1000 + i);
    await a.store.save(emptyState('paper', DAY1, 100_000));

    let commits = 0;
    const batchOrig = db.batch.bind(db);
    db.batch = () => {
      const b = batchOrig();
      const commit = b.commit.bind(b);
      b.commit = async () => {
        commits++;
        if (commits === 2) throw new Error('Firestore: UNAVAILABLE');
        return commit();
      };
      return b;
    };
    await expect(a.journal.flush('u1', a.store.bufferClearOp())).rejects.toThrow('UNAVAILABLE');
    db.batch = batchOrig;
    // Batch 1 ist committed (160 Journal-Docs + 290 Trade-Docs), der Puffer im State-Doc steht noch.
    expect(db.list('users/u1/journal')).toHaveLength(160);
    expect(db.list('users/u1/trades')).toHaveLength(290);
    expect((db.get('users/u1/private/engineState') as { journalBuffer: unknown[] }).journalBuffer).toHaveLength(160);

    // Folgetakt (gesund): Puffer zurücklesen und nachschreiben.
    const b = takt(db);
    await b.store.load();
    await b.journal.flush('u1', b.store.bufferClearOp());
    expect(db.list('users/u1/trades').length, 'Trade-Docs des bereits committeten ersten Batches doppelt geschrieben').toBe(320);
    expect(db.list('users/u1/journal').length, 'Journal-Docs des ersten Batches doppelt geschrieben').toBe(160);
    expect((db.get('users/u1/private/engineState') as { journalBuffer: unknown[] }).journalBuffer).toEqual([]);
  });
});
