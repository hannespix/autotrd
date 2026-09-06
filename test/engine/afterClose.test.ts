import { describe, expect, it } from 'vitest';
import { isOpenStatus } from '../../src/alpaca/types.ts';
import { MIN, msFromET } from '../../src/core/time.ts';
import type { OrderIntent } from '../../src/core/types.ts';
import { exitClientId, stopClientId } from '../../src/engine/ids.ts';
import { CLOSE1, OPEN1, minuteBars, scriptedStrategy, startScenario, testConfig, type Scenario } from '../fakes/harness.ts';

const flat = (from: number, minutes: number, price: number) => minuteBars(from, Array.from({ length: minutes }, () => price));
const OPEN2 = msFromET(2026, 9, 2, 9, 30);

/** Übernacht-Strategie (tf=5): Einstieg auf Bar 1, Signal-Exit auf der 15:55-Bar ⇒ Entscheidung um 16:00:04. */
async function exitDecidedAfterClose(): Promise<{ sc: Scenario; parentId: string; entryTime: number }> {
  const sc = await startScenario({ defaultStrategy: scriptedStrategy({ enterAt: 1, exitAt: 77, holdsOvernight: true }) });
  sc.pushBars('AAPL', flat(OPEN1, 10, 100));
  await sc.engine.tick(OPEN1 + 10 * MIN + 5_000);
  const parent = sc.fake.openOrders('AAPL').find((o) => o.orderClass === 'bracket')!;
  sc.fake.fill(parent.id, 100.05);
  await sc.engine.idle();
  sc.pushBars('AAPL', flat(OPEN1 + 10 * MIN, 380, 100));
  sc.setNow(CLOSE1 + 4_000);
  await sc.engine.tick(CLOSE1 + 4_000);
  return { sc, parentId: parent.id, entryTime: sc.engine.status().positions[0]!.entryTime };
}

describe('Engine — Exits nach Sitzungsschluss', () => {
  it('zurückgestellter Exit steht in state.json, Beine bleiben liegen; beim ersten Tick nach Eröffnung + Karenz läuft er (Storno → Marktorder)', async () => {
    const { sc, parentId, entryTime } = await exitDecidedAfterClose();
    const cancelsBefore = sc.fake.callsOf('cancelOrder').length;
    expect(cancelsBefore).toBe(0);
    expect(sc.engine.status().deferredIntents).toEqual(['AAPL']);
    const stored = sc.state() as unknown as { deferredIntents: Record<string, OrderIntent> };
    expect(stored.deferredIntents.AAPL?.kind).toBe('exit');
    expect(sc.events('note').some((e) => String(e.text).includes('zurückgestellt'))).toBe(true);
    expect(sc.fake.find(`${parentId}-sl`)?.status).toBe('new');

    // 09:30:02 am nächsten Tag: innerhalb der Karenz ⇒ noch nichts.
    sc.setNow(OPEN2 + 2_000);
    await sc.engine.tick(OPEN2 + 2_000);
    expect(sc.fake.callsOf('cancelOrder')).toHaveLength(0);
    expect(sc.engine.status().deferredIntents).toEqual(['AAPL']);

    // 09:30:05: Sitzung offen ⇒ Beine stornieren, Marktorder mit Exit-Kennung, Rückstellung weg.
    sc.setNow(OPEN2 + 5_000);
    await sc.engine.tick(OPEN2 + 5_000);
    expect(sc.fake.find(`${parentId}-sl`)?.status).toBe('canceled');
    const exit = sc.fake.find(exitClientId('paper', 'AAPL', entryTime));
    expect(exit).toMatchObject({ side: 'sell', type: 'market', qty: 200 });
    expect(Number(exit?.submittedAt)).toBe(OPEN2 + 5_000);
    expect(sc.engine.status().deferredIntents).toEqual([]);
    expect(sc.events('note').some((e) => String(e.text).startsWith('Zurückgestellter exit ausgeführt'))).toBe(true);
    expect(sc.state()?.day).toBe('2026-09-02');
  });

  it('Rückstellung überlebt einen Neustart', async () => {
    const { sc, parentId, entryTime } = await exitDecidedAfterClose();
    await sc.engine.stop();
    const again = await startScenario({ home: sc.home, fake: sc.fake, defaultStrategy: scriptedStrategy({ enterAt: 1, exitAt: 77, holdsOvernight: true }), now: OPEN2 + 5_000 });
    expect(again.engine.status().deferredIntents).toEqual(['AAPL']);
    expect(again.fake.find(`${parentId}-sl`)?.status).toBe('new');
    await again.engine.tick(OPEN2 + 5_000);
    expect(again.fake.find(exitClientId('paper', 'AAPL', entryTime))).toBeDefined();
    expect(again.engine.status().deferredIntents).toEqual([]);
  });

  it('flatten nach Schluss räumt keine Stops ab, sondern stellt je Position einen Exit zurück', async () => {
    const sc = await startScenario({ defaultStrategy: scriptedStrategy({ enterAt: 1, holdsOvernight: true }) });
    sc.pushBars('AAPL', flat(OPEN1, 10, 100));
    await sc.engine.tick(OPEN1 + 10 * MIN + 5_000);
    const parent = sc.fake.openOrders('AAPL').find((o) => o.orderClass === 'bracket')!;
    sc.fake.fill(parent.id, 100.05);
    await sc.engine.idle();
    sc.setNow(CLOSE1 + 60_000);
    await sc.engine.flatten('manual');
    expect(sc.fake.callsOf('cancelAllOrders')).toHaveLength(0);
    expect(sc.fake.callsOf('closeAllPositions')).toHaveLength(0);
    expect(sc.fake.find(`${parent.id}-sl`)?.status).toBe('new');
    expect(sc.engine.status().deferredIntents).toEqual(['AAPL']);
    sc.setNow(OPEN2 + 5_000);
    await sc.engine.tick(OPEN2 + 5_000);
    expect(sc.events('order_submitted').some((e) => e.purpose === 'exit' && e.reason === 'manual')).toBe(true);
    expect(sc.fake.positions.has('AAPL')).toBe(true); // Marktorder liegt, Fill folgt
    // In der Sitzung dagegen: sofort alles glatt.
    sc.fake.fill(sc.fake.openOrders('AAPL').find((o) => o.type === 'market')!.id, 100);
    await sc.engine.idle();
    expect(sc.engine.status().positions).toEqual([]);
  });

  it('Intraday-Beine (day) laufen um 16:00 aus ⇒ Abgleich setzt nach Schluss einen GTC-Stop, der Exit kommt bei Eröffnung', async () => {
    const sc = await startScenario({ config: testConfig({ timeframe: 15 }), defaultStrategy: scriptedStrategy({ enterAt: 1, holdsOvernight: false }), now: OPEN1 + 30 * MIN + 5_000 });
    sc.pushBars('AAPL', flat(OPEN1, 30, 100));
    await sc.engine.tick(OPEN1 + 30 * MIN + 5_000);
    const parent = sc.fake.openOrders('AAPL').find((o) => o.orderClass === 'bracket')!;
    sc.fake.fill(parent.id, 100.05);
    await sc.engine.idle();
    sc.pushBars('AAPL', flat(OPEN1 + 30 * MIN, 360, 100));
    sc.setNow(CLOSE1 + 4_000);
    await sc.engine.tick(CLOSE1 + 4_000);
    expect(sc.engine.status().deferredIntents).toEqual(['AAPL']);
    // Alpaca lässt day-Beine um 16:00 auslaufen.
    sc.fake.find(`${parent.id}-sl`)!.status = 'expired';
    sc.fake.find(`${parent.id}-tp`)!.status = 'expired';
    sc.setNow(CLOSE1 + 60_000);
    await sc.engine.reconcileNow(CLOSE1 + 60_000);
    const entryTime = sc.engine.status().positions[0]!.entryTime;
    const gtcStop = sc.fake.find(stopClientId('paper', 'AAPL', entryTime));
    expect(gtcStop).toMatchObject({ type: 'stop', timeInForce: 'gtc', side: 'sell', qty: 200 });
    expect(isOpenStatus(gtcStop!.status)).toBe(true);
    expect(sc.engine.status().halt.halted).toBe(false);
    // Nächste Eröffnung: Exit storniert den GTC-Stop und verkauft.
    sc.setNow(OPEN2 + 5_000);
    await sc.engine.tick(OPEN2 + 5_000);
    expect(sc.fake.find(gtcStop!.id)?.status).toBe('canceled');
    expect(sc.fake.find(exitClientId('paper', 'AAPL', entryTime))).toBeDefined();
  });

  it('Krypto kennt keinen Schluss: Exits laufen sofort', async () => {
    const sc = await startScenario({
      config: testConfig({ universe: { assetClass: 'crypto', symbols: ['BTC/USD'] } }),
      defaultStrategy: scriptedStrategy({ enterAt: 1, exitAt: 2, holdsOvernight: true }),
    });
    sc.fake.autoFillMarket = true;
    sc.pushBars('BTC/USD', flat(OPEN1, 10, 100));
    await sc.engine.tick(OPEN1 + 10 * MIN + 5_000);
    expect(sc.engine.status().positions).toHaveLength(1);
    sc.pushBars('BTC/USD', flat(OPEN1 + 10 * MIN, 5, 100));
    sc.setNow(CLOSE1 + 4_000);
    // Die Bar 09:40 ist längst zu — die Entscheidung fällt jetzt, nach „Schluss", und wird trotzdem ausgeführt.
    await sc.engine.tick(CLOSE1 + 4_000);
    expect(sc.engine.status().deferredIntents).toEqual([]);
    expect(sc.engine.status().positions).toEqual([]);
  });
});
