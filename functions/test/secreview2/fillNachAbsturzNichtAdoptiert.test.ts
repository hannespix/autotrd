/**
 * SECREVIEW2 #7 — Function stirbt zwischen `submitOrder` und `saveState()` (55-s-Timeout; die Lease hält
 * dann 90 s, der Takt danach läuft ohne Pending-Eintrag im State). Ist die Bracket-Order bis dahin
 * GEFÜLLT, findet `adoptOpenEntryOrders()` (engine.ts L888) sie nicht mehr — es listet nur
 * `status: 'open'`. Der Abgleich sieht die eigene Position als Fremdbestand und zieht mit
 * `onOrphan: 'halt'` (Default) die Sperre 'reconcile' (reconcile.ts L173). Weil die Sperre alle
 * Einstiege blockt, entsteht auch nie der `enter`-Intent, dessen `getOrderByClientId` die Order
 * adoptiert hätte (orders.ts L258): Die Position bleibt dauerhaft „fremd" — ohne Trailing, ohne
 * Signal-/EOD-Exit, mit Dauer-Halt für alle Einstiege des Nutzers.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { engineStatePath } from '../../src/engine/state.ts';
import { engineSpiegel, stateDoc, T1, welt, type Welt } from './_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: eigener Fill nach Absturz wird nicht adoptiert', () => {
  it('Bracket gesendet, State nie gespeichert, Order gefüllt ⇒ nächster Takt muss die Position übernehmen', async () => {
    const w = welt();
    welten.push(w);
    await w.run(T1);
    const parent = w.trading.ordersFor('AAPL').find((o) => o.orderClass === 'bracket')!;
    expect(parent.clientOrderId.startsWith('atd-paper-AAPL-')).toBe(true);

    // Absturz vor saveState: kein State-Doc — der Broker hat die Order und füllt sie.
    w.db.docs.delete(engineStatePath('u1'));
    w.trading.fill(parent.id, 100.4);

    const r = await w.run(T1 + 120_000);
    expect(r.ok).toBe(1);
    const st = stateDoc(w.db)!;
    expect(Object.keys(st.positions), 'eigene, gefüllte Einstiegs-Order (eigene client_order_id) nicht ins Buch übernommen').toContain('AAPL');
    expect(st.halt.reason, 'eigene Position gilt als Fremdbestand ⇒ Dauer-Halt reconcile').not.toBe('reconcile');
    expect(engineSpiegel(w.db).positions).toEqual(['AAPL']);
  });
});
