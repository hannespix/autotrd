/**
 * SECREVIEW3 — K2 persistiert `pendingExits` (journal.ts L114-123, book.ts L113-116), aber NICHT die je Order
 * bereits gebuchte Exit-Menge (`OrderExecutor.bookedExitQty`, orders.ts L190 — prozesslokal). Ein Teilfill,
 * der im alten Prozess/Takt gebucht wurde, wird nach jedem Neustart erneut gebucht:
 *
 * (a) Exit-Order offen, 50/199 gefüllt und gebucht (Buch 149). Neustart ⇒ `syncOrders` (c) (orders.ts
 *     L977-991) sieht über die persistierte `orderId` filledQty 50 und bucht sie ein zweites Mal (Buch 99,
 *     zweiter `trade_closed`); der Abgleich hebt die Menge still auf den Broker-Stand. Der Phantom-Trade
 *     bleibt im Journal (Trade-Docs, Live-Reife, Daytrade-Zählung) — und im Takt kommt je Minute einer dazu,
 *     solange die Order teilgefüllt offen ist.
 * (b) Exit-Order nach dem Teilfill gestorben (Tagesorder abgelaufen/storniert): `syncExitFillsFor`
 *     (L1013-1026) bucht den Teilfill im Neustart erneut. Dass die Wiederholung dann 149 statt 99 verkauft,
 *     verdankt sie allein der Mengen-Reparatur des Abgleichs in `start()`; scheitert der Abgleich in diesem
 *     Takt (Broker-Fehler ⇒ State mit 99 gespeichert), ist auch die Menge falsch.
 *
 * (a) ist eine Regression durch K2 (vor d744fde gab es nach dem Neustart keinen Exit-Verweis; der Fill der
 * offenen Order wurde am Ende über min(delta, qty) korrekt gebucht); (b) bestand schon vorher.
 * Beide Tests SCHLAGEN FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import type { PositionState } from '../../src/core/types.ts';
import { exitClientId } from '../../src/engine/ids.ts';
import { minuteBars, OPEN1, openPositionViaFill, scriptedStrategy, startScenario } from '../fakes/harness.ts';

async function teilfillSzenario() {
  const strat = scriptedStrategy({ enterAt: 1, exitAt: 2 });
  const sc = await startScenario({ defaultStrategy: strat });
  await openPositionViaFill(sc); // 199 @ 100.4, Einstieg 09:40:05
  const pos = sc.engine.status().positions[0] as PositionState;
  expect(pos.qty).toBe(199);
  // Bucket 09:40 zu ⇒ Signal-Exit: Beine stornieren, Marktorder 199 (füllt nicht sofort).
  sc.pushBars('AAPL', minuteBars(OPEN1 + 10 * MIN, [100.5, 100.6, 100.7, 100.6, 100.5]));
  sc.setNow(OPEN1 + 15 * MIN + 5_000);
  await sc.engine.tick(sc.now());
  const exit = sc.fake.find(exitClientId('paper', 'AAPL', pos.entryTime))!;
  expect(exit).toMatchObject({ side: 'sell', type: 'market', qty: 199 });
  // Teilfill 50 @ 100.5 — über den Trade-Stream gebucht, State gespeichert (pendingExits mit orderId).
  sc.fake.fill(exit.id, 100.5, 50);
  await sc.engine.idle();
  expect(sc.engine.status().positions[0]?.qty).toBe(149);
  expect(sc.events('trade_closed')).toHaveLength(1);
  expect(sc.state()?.pendingExits?.AAPL?.orderId).toBe(exit.id);
  return { sc, pos, exit, strat };
}

describe('secreview3: gebuchte Teilfill-Menge überlebt den Neustart nicht', () => {
  it('(a) Exit-Order offen, 50/199 gefüllt ⇒ nach jedem Neustart/Takt bleibt es bei EINEM Trade und Buch 149', async () => {
    const { sc, strat } = await teilfillSzenario();
    await sc.engine.stop();
    const again = await startScenario({ home: sc.home, fake: sc.fake, defaultStrategy: strat, now: OPEN1 + 16 * MIN + 5_000 });
    expect(again.engine.status().positions[0]?.qty).toBe(149); // der Abgleich repariert die Menge …
    expect(again.events('trade_closed'), 'Teilfill nach Neustart ein zweites Mal gebucht (Phantom-Trade)').toHaveLength(1);
    expect(again.events('reconcile').some((e) => e.action === 'qty'), 'Abgleich musste die doppelt reduzierte Menge reparieren').toBe(false);
    // Takt-Betrieb: jeder Takt ist ein Neustart — je Takt ein weiterer Phantom-Trade.
    await again.engine.stop();
    const dritter = await startScenario({ home: sc.home, fake: sc.fake, defaultStrategy: strat, now: OPEN1 + 17 * MIN + 5_000 });
    expect(dritter.events('trade_closed')).toHaveLength(1);
  });

  it('(b) Exit-Order nach dem Teilfill gestorben ⇒ die Wiederholung darf den Teilfill nicht erneut buchen', async () => {
    const { sc, pos, exit, strat } = await teilfillSzenario();
    await sc.fake.cancelOrder(exit.id); // Tagesorder storniert/abgelaufen — 50 gefüllt, 149 offen
    await sc.engine.idle();
    expect(sc.engine.status().positions[0]?.qty).toBe(149);
    expect(sc.state()?.pendingExits?.AAPL?.lastError).toContain('Wiederholung');
    await sc.engine.stop();

    const again = await startScenario({ home: sc.home, fake: sc.fake, defaultStrategy: strat, now: OPEN1 + 16 * MIN + 5_000 });
    await again.engine.tick(again.now()); // retryPendingExits
    const retry = again.fake.find(exitClientId('paper', 'AAPL', pos.entryTime, 1));
    expect(retry, 'kein Wiederholungs-Exit gesendet').toBeDefined();
    expect(again.events('trade_closed').filter((e) => e.ts >= OPEN1 + 16 * MIN), 'Teilfill im Neustart erneut gebucht (Phantom-Trade); die Menge 149 rettet nur der Abgleich').toHaveLength(0);
    expect(again.events('reconcile').some((e) => e.action === 'qty')).toBe(false);
    expect(retry?.qty).toBe(149);
  });
});
