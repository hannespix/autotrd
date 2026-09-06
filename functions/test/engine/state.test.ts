import { describe, expect, it } from 'vitest';
import { emptyState, type EngineState } from '../../../src/core/journal.ts';
import { engineStatePath, FirestoreStateStore } from '../../src/engine/state.ts';
import { FakeFirestore } from '../fakes/firestore.ts';

describe('FirestoreStateStore', () => {
  it('load ohne Doc ⇒ null; save/load ist eine Rundreise (zurückgestellte Intents, Krypto-Symbole mit Schrägstrich)', async () => {
    const db = new FakeFirestore();
    const store = new FirestoreStateStore(db, 'u1');
    expect(await store.load()).toBeNull();

    const st = emptyState('paper', '2026-09-01', 100_000) as EngineState & { deferredIntents: Record<string, unknown> };
    st.positions['BTC/USD'] = { symbol: 'BTC/USD', side: 'long', qty: 0.5, entryPrice: 60_000, entryTime: 1, stop: 58_000, target: null, initialStop: 58_000, highWater: 60_000, strategy: 'x', barsHeld: 2, entryDay: '2026-09-01' };
    st.deferredIntents = { 'BTC/USD': { kind: 'exit', symbol: 'BTC/USD', reason: 'signal', decidedAt: 5 } };
    st.halt = { halted: true, reason: 'manual', since: 3, until: null, note: 'Test' };
    await store.save(st);

    const doc = db.get(engineStatePath('u1'));
    expect(doc?.mode).toBe('paper');
    expect(typeof doc?.updatedAt).toBe('number');
    const loaded = (await store.load()) as EngineState & { deferredIntents: Record<string, unknown> };
    expect(loaded).toEqual(st);
    expect(loaded.deferredIntents['BTC/USD']).toMatchObject({ kind: 'exit' });
  });

  it('fremdes Doc (falsche Version) ⇒ Fehler statt leerem Buch — fail-closed', async () => {
    const db = new FakeFirestore();
    db.seed(engineStatePath('u1'), { version: 2, mode: 'paper' });
    await expect(new FirestoreStateStore(db, 'u1').load()).rejects.toThrow(/unlesbar/);
    db.seed(engineStatePath('u1'), { version: 1, mode: 'echtgeld' });
    await expect(new FirestoreStateStore(db, 'u1').load()).rejects.toThrow(/unlesbar/);
  });

  it('save schreibt kein undefined nach Firestore', async () => {
    const db = new FakeFirestore();
    const st = emptyState('live', '2026-09-01', 1) as EngineState & { extra?: unknown };
    st.extra = undefined;
    await new FirestoreStateStore(db, 'u2').save(st);
    expect(Object.keys(db.get(engineStatePath('u2')) ?? {})).not.toContain('extra');
  });
});
