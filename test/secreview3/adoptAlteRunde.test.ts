/**
 * SECREVIEW3 — M6 `Engine.adoptOwnEntryOrders()` (engine.ts L941-966) prüft nur, ob der Broker eine
 * Position GLEICHER SEITE hält — nicht, ob die Runde der eigenen Einstiegs-Order noch offen ist. Alpaca
 * liefert `listOrders` mit `direction: 'asc'` (rest.ts L413), der Fake in Einfügereihenfolge: die
 * ÄLTESTE gefüllte Einstiegs-Order des 6-h-Fensters gewinnt.
 *
 * (a) Zwei eigene Runden im selben Symbol binnen 6 h (Runde 1 per Stop-Bein geschlossen, Runde 2 offen),
 *     Absturz vor dem Speichern der zweiten: adoptiert wird Runde 1 — falscher Einstandskurs, falsche
 *     Einstiegszeit (Anker der Exit-Kennungen) und als Schutz-Stop das GEFÜLLTE Bein von Runde 1. Der nächste
 *     Abgleich (`syncOrders` → `syncExitFillsFor`, orders.ts L1013-1026) bucht den alten Stop-Fill als Exit
 *     der Runde-2-Position (Phantom-Trade), `cleanupClosed` (L1029) storniert danach die Beine der echten
 *     Runde 2 — die Position steht nackt beim Broker; im Takt wiederholt sich das jede Minute.
 * (b) Eigene Runde sauber geschlossen, danach kauft der Nutzer von Hand (Fremdbestand gleicher Seite):
 *     die alte Order adoptiert den Fremdbestand — entgegen „Fremdbestand nie adoptiert" (K1) und
 *     `onOrphan: 'halt'`; `ensureProtectiveStops` legt dann sogar eine Stop-Order auf die Handposition.
 *
 * Beide Tests SCHLAGEN FEHL, solange der Bug existiert.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import { minuteBars, OPEN1, openPositionViaFill, startScenario } from '../fakes/harness.ts';

describe('secreview3: adoptOwnEntryOrders übernimmt eine abgeschlossene Runde', () => {
  it('(a) zwei Runden binnen 6 h, Absturz vor dem Speichern der zweiten ⇒ die OFFENE Runde gehört ins Buch, ihre Beine bleiben', async () => {
    const sc = await startScenario();
    // Runde 1: Bucket 09:35, Tick 09:40:05, Fill 100.0
    await openPositionViaFill(sc, 'AAPL', 100.0);
    const o1 = sc.fake.ordersFor('AAPL').find((o) => o.orderClass === 'bracket')!;
    expect(sc.engine.status().positions[0]?.entryPrice).toBe(100.0);
    // 09:41:05: Stop-Bein füllt ⇒ Runde 1 geschlossen, State ohne Position gespeichert.
    sc.setNow(OPEN1 + 11 * MIN + 5_000);
    sc.fake.fill(`${o1.id}-sl`, 98.0);
    await sc.engine.idle();
    expect(sc.engine.status().positions).toEqual([]);
    expect(sc.events('trade_closed')).toHaveLength(1);
    const stateVorRunde2 = readFileSync(sc.paths.state, 'utf8');

    // Runde 2: Bucket 09:40 (zu ab 09:45), Tick 09:45:05, Fill 101.0
    sc.pushBars('AAPL', minuteBars(OPEN1 + 10 * MIN, [100.5, 100.6, 100.7, 100.8, 100.9]));
    sc.setNow(OPEN1 + 15 * MIN + 5_000);
    await sc.engine.tick(sc.now());
    const o2 = sc.fake.openOrders('AAPL').find((o) => o.orderClass === 'bracket')!;
    expect(o2.id).not.toBe(o1.id);
    sc.fake.fill(o2.id, 101.0);
    await sc.engine.idle();
    expect(sc.engine.status().positions[0]?.entryPrice).toBe(101.0);
    expect(sc.fake.find(`${o2.id}-sl`)?.status).toBe('new');

    // Absturz vor saveState: auf Platte liegt der Stand von VOR Runde 2 (stop() speichert — danach zurücksetzen).
    await sc.engine.stop();
    writeFileSync(sc.paths.state, stateVorRunde2);

    const again = await startScenario({ home: sc.home, fake: sc.fake, now: OPEN1 + 16 * MIN + 5_000 });
    const tradesNachStart = again.events('trade_closed').length;
    // Abgleich-Pfad: Timer im Dauerprozess bzw. `start()` des nächsten Takts (syncOrders → syncExitFillsFor → cleanupClosed).
    await again.engine.reconcileNow();
    expect(again.fake.find(`${o2.id}-sl`)?.status, 'Schutz-Stop der offenen Runde storniert (Rest-Order-Abräumen nach Phantom-Exit) — Position nackt beim Broker').toBe('new');
    expect(again.engine.status().positions.map((p) => p.symbol), 'Runde-2-Position mit dem Stop-Fill von Runde 1 ausgebucht').toEqual(['AAPL']);
    expect(again.events('trade_closed').length, 'Phantom-Trade: alter Stop-Fill als Exit der neuen Runde gebucht').toBe(tradesNachStart);
    expect(again.engine.status().positions[0]?.entryPrice, 'die alte (geschlossene) Runde wurde adoptiert, nicht die offene').toBe(101.0);
    expect(again.engine.status().halt.reason).not.toBe('reconcile');
  });

  it('(b) eigene Runde geschlossen, danach Handposition gleicher Seite ⇒ kein Adoptieren über die alte Einstiegs-Order', async () => {
    const sc = await startScenario();
    await openPositionViaFill(sc, 'AAPL', 100.0);
    const o1 = sc.fake.ordersFor('AAPL').find((o) => o.orderClass === 'bracket')!;
    sc.setNow(OPEN1 + 11 * MIN + 5_000);
    sc.fake.fill(`${o1.id}-sl`, 98.0);
    await sc.engine.idle();
    expect(sc.engine.status().positions).toEqual([]);
    await sc.engine.stop();
    const ordersVorher = sc.fake.callsOf('submitOrder').length;

    // Nutzer kauft von Hand 50 Stück — Fremdbestand, Config `onOrphan: 'halt'` (Default, und im Takt bei Sperre erzwungen).
    sc.fake.setPosition('AAPL', 'long', 50, 99.0, 99.0);
    const again = await startScenario({ home: sc.home, fake: sc.fake, now: OPEN1 + 12 * MIN + 5_000 });
    expect(again.engine.status().positions, 'Fremdbestand über die alte, längst geschlossene eigene Einstiegs-Order adoptiert').toEqual([]);
    expect(again.engine.status().halt.reason).toBe('reconcile');
    expect(again.fake.callsOf('submitOrder').length, 'Stop-Order auf eine Handposition gelegt').toBe(ordersVorher);
  });
});
