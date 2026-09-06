/**
 * SECREVIEW2 #6 — Reihenfolge im Nutzer-Takt (tick.ts L493-533): Engine `start/tick/stop` speichern den
 * State (Position geschlossen, `trade_closed` nur im Speicher-Puffer des FirestoreJournal), DANACH
 * `journal.flush(uid)`. Scheitert der Flush (Firestore-Fehler) oder wird die Function davor beendet
 * (55-s-Timeout), ist der Puffer mit dem Prozess weg: Der State kennt die Position nicht mehr, das
 * Journal hat weder `fill` noch `trade_closed`, und die zwei Trade-Docs (Steuer, Live-Reife,
 * stats/main) werden NIE geschrieben. journal.ts L189 verspricht „bei Fehler bleibt er stehen" —
 * in einem Prozess, der jede Minute stirbt, ist das leer.
 *
 * Gegenbeispiel: Stop-Fill wird im Takt gebucht, der Journal-Batch schlägt genau einmal fehl,
 * der Folgetakt ist gesund — die Trade-Docs müssen dann nachgeholt sein.
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { engineStatePath } from '../../src/engine/state.ts';
import { engineSpiegel, stateDoc, T1, welt, type Welt } from './_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: Trade-Docs gehen verloren, wenn der Journal-Batch nach dem State-Save scheitert', () => {
  it('Stop-Fill ⇒ State ohne Position; Flush scheitert einmal ⇒ Trade-Docs müssen im Folgetakt nachkommen', async () => {
    const w = welt();
    welten.push(w);
    await w.run(T1);
    const parent = w.trading.ordersFor('AAPL').find((o) => o.orderClass === 'bracket')!;
    w.trading.fill(parent.id, 100.4);
    await w.run(T1 + 60_000);
    expect(stateDoc(w.db)?.positions.AAPL).toBeDefined();

    // Stop-Bein füllt; im nächsten Takt wird der Trade gebucht — und der Journal-Batch scheitert.
    w.trading.fill(`${parent.id}-sl`, 98.3);
    let scharf = false;
    const fxOrig = w.deps.fx;
    w.deps.fx = async (at, wg) => {
      scharf = true; // fx wird nur im Flush aufgerufen — der nächste Batch ist der Journal-Batch
      w.deps.fx = fxOrig; // genau EIN Batch scheitert; der Nachschreib-Flush im Folgetakt ruft fx erneut
      return fxOrig(at, wg);
    };
    const batchOrig = w.db.batch.bind(w.db);
    w.db.batch = () => {
      if (scharf) {
        scharf = false;
        throw new Error('Firestore: UNAVAILABLE');
      }
      return batchOrig();
    };
    const r3 = await w.run(T1 + 120_000);
    expect(r3.failed.map((f) => f.error)).toEqual([expect.stringContaining('Journal')]);
    expect(String(engineSpiegel(w.db).lastError)).toContain('Journal');
    // Der State ist bereits fortgeschrieben: die Position ist weg.
    expect(w.db.get(engineStatePath('u1'))?.positions).toEqual({});

    // Der Puffer liegt im State-Doc (Secreview 2, M5) — nichts ist verloren.
    const buffered = (w.db.get(engineStatePath('u1')) as { journalBuffer?: Array<{ kind: string }> }).journalBuffer ?? [];
    expect(buffered.map((e) => e.kind)).toEqual(expect.arrayContaining(['fill', 'trade_closed']));

    // Takt 4: alles gesund. Der Trade muss jetzt im Journal und als Trade-Docs stehen — genau einmal.
    const r4 = await w.run(T1 + 180_000);
    expect(r4.failed).toEqual([]);
    const trades = w.db.list('users/u1/trades');
    expect(trades.length, 'trade_closed/fill sind mit dem Prozess verloren — keine Trade-Docs, keine Journal-Spur').toBe(2);
    expect(w.db.list('users/u1/journal').filter((d) => d.data.kind === 'trade_closed')).toHaveLength(1);
    expect((w.db.get(engineStatePath('u1')) as { journalBuffer?: unknown[] }).journalBuffer).toEqual([]);

    // Takt 5: nichts wird doppelt geschrieben.
    await w.run(T1 + 240_000);
    expect(w.db.list('users/u1/trades')).toHaveLength(2);
  });
});
