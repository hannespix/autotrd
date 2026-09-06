/**
 * SECREVIEW #1 — Exits, die auf der LETZTEN Bar des Tages entschieden werden,
 * gehen erst nach Sitzungsschluss (16:00:04 ET) zum Broker: Der Executor
 * storniert dafür zuerst die Bracket-Beine (Schutz-Stop!) und sendet dann eine
 * Marktorder mit TIF `day`. Alpaca nimmt Marktorders nach 16:00 an und stellt
 * sie in die Warteschlange für die NÄCHSTE Eröffnung — die Position liegt die
 * Nacht über OHNE Stop beim Broker. Der Simulator füllt denselben Intent als
 * "Market-on-Close" zum Schluss der Bar (backtest/simulator.ts ~L533).
 *
 * Betroffen: EOD-Flatten bei tf ∈ {10,15,30,60} (orb_breakout erlaubt 10/15/30),
 * Signal-Exits jeder Strategie auf der letzten Bar (alle tf), Halt-Exits
 * (daily_loss/drawdown) nach dem letzten Bar-Schluss.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { isOpenStatus } from '../../src/alpaca/types.ts';
import { MIN } from '../../src/core/time.ts';
import { CLOSE1, OPEN1, minuteBars, scriptedStrategy, startScenario, testConfig } from '../fakes/harness.ts';

function flatMinutes(from: number, minutes: number, price: number) {
  return minuteBars(from, Array.from({ length: minutes }, () => price));
}

describe('secreview: Exit auf der letzten Tagesbar', () => {
  it('EOD-Flatten bei tf=15 (Intraday-Strategie) darf nicht NACH Schluss die Schutz-Stops stornieren und eine day-Marktorder in die Nacht legen', async () => {
    const sc = await startScenario({
      config: testConfig({ timeframe: 15 }),
      defaultStrategy: scriptedStrategy({ enterAt: 1, holdsOvernight: false }),
      now: OPEN1 + 30 * MIN + 5_000,
    });
    // Zwei 15-Min-Buckets (09:30, 09:45) → Einstieg auf Bar 1, dann Fill.
    sc.pushBars('AAPL', flatMinutes(OPEN1, 30, 100));
    await sc.engine.tick(OPEN1 + 30 * MIN + 5_000);
    const parent = sc.fake.openOrders('AAPL').find((o) => o.orderClass === 'bracket')!;
    expect(parent).toBeDefined();
    sc.fake.fill(parent.id, 100.05);
    await sc.engine.idle();
    expect(sc.engine.status().positions).toHaveLength(1);

    // Rest des Tages bis 15:59 einspeisen; erster Tick, der die 15:45-Bar geschlossen sieht: 16:00:04.
    sc.pushBars('AAPL', flatMinutes(OPEN1 + 30 * MIN, 360, 100));
    const afterClose = CLOSE1 + 4_000;
    sc.setNow(afterClose);
    await sc.engine.tick(afterClose);

    const exitIntents = sc.events('intent').filter((e) => (e.intent as { kind: string; reason?: string }).kind === 'exit');
    expect(exitIntents.length, 'EOD-Exit wurde entschieden').toBeGreaterThan(0);
    expect(Number(exitIntents[0]!.ts), 'der EOD-Exit wird erst NACH Sitzungsschluss entschieden').toBeGreaterThanOrEqual(CLOSE1);

    const orders = sc.fake.ordersFor('AAPL');
    const stopLeg = orders.find((o) => o.id === `${parent.id}-sl`)!;
    const marketExit = orders.find((o) => o.type === 'market' && o.side === 'sell' && o.orderClass === 'simple');
    const openStops = sc.fake.openOrders('AAPL').filter((o) => o.type === 'stop' || o.type === 'stop_limit');

    // Beobachtet: Stop-Bein storniert, Marktorder (day) nach 16:00 gesendet, Broker-Position ohne offenen Stop.
    // Erwartet (Owner-Regel „Stops liegen beim Broker, auch wenn der Prozess nicht läuft"): Nach Schluss
    // keinen Exit senden, der die Schutz-Stops abräumt — oder gar nicht erst nach Schluss entscheiden.
    expect(sc.fake.positions.has('AAPL'), 'Position liegt weiter beim Broker (Marktorder füllt erst morgen)').toBe(true);
    expect(stopLeg.status, 'Schutz-Stop-Bein darf nach Schluss nicht storniert sein').not.toBe('canceled');
    expect(marketExit && isOpenStatus(marketExit.status) && Number(marketExit.submittedAt) >= CLOSE1, 'keine day-Marktorder nach Sitzungsschluss').toBeFalsy();
    expect(openStops.length, 'Position muss über Nacht einen offenen Stop beim Broker haben').toBeGreaterThan(0);
  });

  it('Signal-Exit einer Übernacht-Strategie auf der 15:55-Bar (tf=5) landet ebenfalls nach Schluss — gleicher Pfad', async () => {
    // Bar-Index der 15:55-Bar bei 5-Min-Buckets: (390/5) − 1 = 77.
    const sc = await startScenario({
      defaultStrategy: scriptedStrategy({ enterAt: 1, exitAt: 77, holdsOvernight: true }),
    });
    sc.pushBars('AAPL', flatMinutes(OPEN1, 10, 100));
    await sc.engine.tick(OPEN1 + 10 * MIN + 5_000);
    const parent = sc.fake.openOrders('AAPL').find((o) => o.orderClass === 'bracket')!;
    sc.fake.fill(parent.id, 100.05);
    await sc.engine.idle();

    sc.pushBars('AAPL', flatMinutes(OPEN1 + 10 * MIN, 380, 100));
    const afterClose = CLOSE1 + 4_000;
    sc.setNow(afterClose);
    await sc.engine.tick(afterClose);

    const stopLeg = sc.fake.ordersFor('AAPL').find((o) => o.id === `${parent.id}-sl`)!;
    const openStops = sc.fake.openOrders('AAPL').filter((o) => o.type === 'stop' || o.type === 'stop_limit');
    expect(sc.fake.positions.has('AAPL')).toBe(true);
    expect(stopLeg.status, 'gtc-Schutz-Stop darf für einen Exit nach Schluss nicht storniert werden').not.toBe('canceled');
    expect(openStops.length, 'Übernacht-Position ohne Broker-Stop').toBeGreaterThan(0);
  });
});
