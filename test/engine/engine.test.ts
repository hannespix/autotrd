import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaError } from '../../src/alpaca/types.ts';
import { readJson, type EngineState } from '../../src/core/journal.ts';
import { MIN, msFromET } from '../../src/core/time.ts';
import type { PositionState, Trade } from '../../src/core/types.ts';
import { Book } from '../../src/engine/book.ts';
import { entryClientId, exitClientId } from '../../src/engine/ids.ts';
import { DAY1, OPEN1, TEN_CLOSES, minuteBars, openPositionViaFill, scriptedStrategy, startScenario, testConfig } from '../fakes/harness.ts';

const T_TICK1 = OPEN1 + 10 * MIN + 5_000; // 09:40:05 ET — Bucket 09:35 ist seit 5 s zu (Karenz 4 s)
const BARS_10_14 = () => minuteBars(OPEN1 + 10 * MIN, [100.5, 100.6, 100.7, 100.8, 100.9]);

describe('Engine — ein Zyklus', () => {
  it('Minuten-Bars → geschlossene 5-Min-Bar → Entscheidung → Bracket-Order mit gerundeten Beinen; zweiter Tick sendet nichts', async () => {
    const sc = await startScenario();
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T_TICK1);

    const submits = sc.fake.callsOf('submitOrder');
    expect(submits).toHaveLength(1);
    const parent = sc.fake.ordersFor('AAPL').find((o) => o.orderClass === 'bracket' && o.legs.length > 0)!;
    expect(parent.clientOrderId).toBe(entryClientId('paper', 'AAPL', OPEN1 + 10 * MIN));
    expect(parent.side).toBe('buy');
    expect(parent.type).toBe('market');
    expect(parent.qty).toBe(199);
    expect(parent.timeInForce).toBe('day'); // Intraday-Strategie
    const sl = parent.legs.find((l) => l.type === 'stop')!;
    const tp = parent.legs.find((l) => l.type === 'limit')!;
    expect(sl.stopPrice).toBe(98.36); // 100.37 · 0.98 = 98.3626 → abgerundet (vom Kurs weg)
    expect(tp.limitPrice).toBe(104.38); // 100.37 · 1.04 = 104.3848 → abgerundet (zum Kurs hin)
    expect(sc.events('order_submitted')).toHaveLength(1);
    expect(sc.events('decision').some((e) => e.kind === 'decision' && String(e.text).startsWith('Enter long 199'))).toBe(true);
    // Bars-Cache wurde geschrieben
    expect(existsSync(join(sc.home, 'bars', 'us_equity', 'iex', 'AAPL_1Min.json'))).toBe(true);
    expect(sc.state()?.lastBarAt.AAPL).toBe(OPEN1 + 5 * MIN);
    expect(sc.state()?.pendingEntries.AAPL).toBe(parent.clientOrderId);

    await sc.engine.tick(T_TICK1 + 1_000);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(1);
    expect(sc.engine.status().pendingEntries).toEqual(['AAPL']);
  });

  it('Übernacht-Strategie ⇒ Bracket mit gtc', async () => {
    const sc = await startScenario({ defaultStrategy: scriptedStrategy({ enterAt: 1, holdsOvernight: true }) });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T_TICK1);
    expect(sc.fake.ordersFor('AAPL')[0]?.timeInForce).toBe('gtc');
  });

  it('Fill ⇒ Position im Buch (stop/target/initialStop), State auf Platte, nach Neustart identisch', async () => {
    const sc = await startScenario();
    await openPositionViaFill(sc);

    const pos = sc.engine.status().positions[0]!;
    expect(pos).toMatchObject<Partial<PositionState>>({ symbol: 'AAPL', side: 'long', qty: 199, entryPrice: 100.4, stop: 98.36, target: 104.38, initialStop: 98.36, strategy: 'test_enter', entryDay: DAY1, barsHeld: 0 });
    expect(sc.engine.status().pendingEntries).toEqual([]);
    expect(sc.engine.status().protectiveOrders.AAPL).toBe('leg-o-1-sl');
    expect(sc.events('fill')).toHaveLength(1);

    const saved = readJson<EngineState>(sc.paths.state)!;
    expect(saved.positions.AAPL).toEqual(pos);
    expect(saved.protectiveOrders.AAPL).toBe('leg-o-1-sl');
    expect(Book.fromState(saved).positions.get('AAPL')).toEqual(pos);

    // Neustart mit demselben Home und Broker: Buch identisch, Schutz-Stop-Verweis wieder mit Broker-ID.
    await sc.engine.stop();
    const again = await startScenario({ home: sc.home, fake: sc.fake, now: sc.now() + 60_000 });
    expect(again.engine.status().positions[0]).toEqual(pos);
    expect(again.engine.status().halt.halted).toBe(false);
    expect(again.fake.callsOf('submitOrder')).toHaveLength(1); // kein neuer Stop: das Bracket-Bein liegt noch
  });

  it('Stop-Bein-Fill ⇒ Trade "stop" im Journal, Position weg, Daytrade gezählt', async () => {
    const sc = await startScenario();
    await openPositionViaFill(sc);
    sc.fake.fill('o-1-sl', 98.3);
    await sc.engine.idle();

    const closed = sc.events('trade_closed');
    expect(closed).toHaveLength(1);
    const trade = closed[0]!.trade as Trade;
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBe(98.3);
    expect(trade.qty).toBe(199);
    expect(trade.grossPnl).toBeCloseTo((98.3 - 100.4) * 199);
    expect(trade.rMultiple).toBeCloseTo((98.3 - 100.4) / (100.4 - 98.36));
    expect(sc.engine.status().positions).toEqual([]);
    expect(sc.state()?.dayTrades[DAY1]).toBe(1);
    expect(sc.engine.status().localDayTrades).toBe(1);
    // Das Ziel-Bein hat der Broker (OCO) storniert.
    expect(sc.fake.find('o-1-tp')?.status).toBe('canceled');
  });

  it('HALT-Datei ⇒ keine Einstiege, Exits laufen; Datei weg ⇒ wieder Einstiege', async () => {
    const sc = await startScenario();
    writeFileSync(sc.paths.haltFlag, 'test\n');
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T_TICK1);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(0);
    expect(sc.engine.status().halt).toMatchObject({ halted: true, reason: 'manual' });
    expect(sc.events('halt').some((e) => e.reason === 'manual')).toBe(true);
    expect(sc.events('decision').some((e) => e.kind === 'blocked' && String(e.text).includes('Halt aktiv (manual)'))).toBe(true);

    unlinkSync(sc.paths.haltFlag);
    sc.pushBars('AAPL', BARS_10_14());
    await sc.engine.tick(OPEN1 + 15 * MIN + 5_000);
    expect(sc.engine.status().halt.halted).toBe(false);
    expect(sc.events('resume')).toHaveLength(1);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(1);

    // Exits trotz HALT: Position eröffnen, dann HALT setzen, Exit-Signal ⇒ Marktorder mit Exit-Kennung.
    const sc2 = await startScenario({ defaultStrategy: scriptedStrategy({ enterAt: 1, exitAt: 2 }) });
    await openPositionViaFill(sc2);
    writeFileSync(sc2.paths.haltFlag, 'test\n');
    sc2.pushBars('AAPL', BARS_10_14());
    await sc2.engine.tick(OPEN1 + 15 * MIN + 5_000);
    const entryTime = sc2.engine.status().positions[0]?.entryTime ?? sc2.events('fill')[0]!.ts;
    const exit = sc2.fake.ordersFor('AAPL').find((o) => o.clientOrderId === exitClientId('paper', 'AAPL', entryTime));
    expect(exit).toBeDefined();
    expect(exit?.side).toBe('sell');
    expect(exit?.qty).toBe(199);
    expect(sc2.engine.status().halt.reason).toBe('manual');
  });

  it('Fehlerserie ⇒ Halt "errors" nach Schwelle und Benachrichtigung; Halt bleibt, Zähler fällt', async () => {
    const sc = await startScenario();
    sc.fake.throwOn('getOrderByClientId', new AlpacaError('Alpaca 500: kaputt', 500, null, true));
    let now = T_TICK1;
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    for (let i = 0; i < 3; i++) {
      await sc.engine.tick(now);
      if (i < 2) expect(sc.engine.status().halt.halted).toBe(false);
      sc.pushBars('AAPL', minuteBars(OPEN1 + (10 + 5 * i) * MIN, [101, 101.1, 101.2, 101.3, 101.4]));
      now += 5 * MIN;
    }
    expect(sc.engine.status().consecutiveErrors).toBe(3);
    expect(sc.engine.status().halt).toMatchObject({ halted: true, reason: 'errors' });
    expect(sc.notifications.some((n) => n.level === 'error' && n.text.includes('errors'))).toBe(true);
    expect(sc.events('error')).toHaveLength(3);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(0);
    // Nächster Tick ohne Fehler: Zähler zurück, Halt bleibt (kein Selbstheilen einer Fehlerserie).
    await sc.engine.tick(now);
    expect(sc.engine.status().consecutiveErrors).toBe(0);
    expect(sc.engine.status().halt.reason).toBe('errors');
    expect(sc.state()?.halt.reason).toBe('errors');
  });

  it('Datenfrische: alter Strom ⇒ Einstieg blockiert (Notiz), Exit läuft trotzdem', async () => {
    const sc = await startScenario();
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES)); // Frische = 09:40
    await sc.engine.tick(OPEN1 + 10 * MIN + 200_000); // 09:43:20 ⇒ 200 s alt > 180 s
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(0);
    expect(sc.events('decision').some((e) => e.kind === 'blocked' && e.text === 'Daten nicht frisch')).toBe(true);

    const sc2 = await startScenario({ defaultStrategy: scriptedStrategy({ enterAt: 1, exitAt: 2 }) });
    await openPositionViaFill(sc2);
    sc2.pushBars('AAPL', BARS_10_14()); // Frische = 09:45
    await sc2.engine.tick(OPEN1 + 15 * MIN + 200_000); // 09:48:20 ⇒ alt
    const entryTime = sc2.engine.status().positions[0]?.entryTime;
    expect(entryTime).toBeDefined();
    expect(sc2.fake.ordersFor('AAPL').some((o) => o.clientOrderId === exitClientId('paper', 'AAPL', entryTime!))).toBe(true);
  });

  it('status() und stop(): Timer registriert, Streams abonniert, Journal start/stop, Positionen bleiben', async () => {
    const sc = await startScenario({ benchmark: 'SPY' });
    expect(sc.intervals.map((i) => i.ms)).toEqual([1000, 60_000, 60_000]);
    expect(sc.data.subscribed).toEqual(['AAPL', 'SPY']);
    expect(sc.trade.connected).toBe(true);
    const s = sc.engine.status();
    expect(s.mode).toBe('paper');
    expect(s.running).toBe(true);
    expect(s.equity).toBe(100_000);
    expect(s.day).toBe(DAY1);
    expect(s.streamStatus.data).toBe('subscribed');
    expect(sc.events('start')).toHaveLength(1);
    expect(sc.events('reconcile').some((e) => e.action === 'summary')).toBe(true);
    await openPositionViaFill(sc);
    await sc.engine.stop();
    expect(sc.data.closed).toBe(true);
    expect(sc.trade.closed).toBe(true);
    expect(sc.events('stop')).toHaveLength(1);
    expect(sc.state()?.positions.AAPL?.qty).toBe(199);
    expect(sc.fake.positions.get('AAPL')?.qty).toBe(199);
  });

  it('verweigert den Start mit einem State aus dem anderen Modus', async () => {
    const sc = await startScenario();
    await sc.engine.stop();
    await expect(startScenario({ home: sc.home, mode: 'live', fake: sc.fake })).rejects.toThrow(/Modus/);
  });

  it('Tagesbars (1440): Tagesbar vom Broker wird auf die Sitzungseröffnung normiert und nach Schluss entschieden', async () => {
    const daily = (y: number, m: number, d: number, c: number) => ({ t: msFromET(y, m, d), o: c - 1, h: c + 1, l: c - 2, c, v: 1_000_000 });
    const sc = await startScenario({
      config: testConfig({ timeframe: 1440 }),
      defaultStrategy: scriptedStrategy({ enterAt: 1, holdsOvernight: true }),
      preload: { AAPL: [daily(2026, 8, 28, 99), daily(2026, 8, 31, 100), daily(2026, 9, 1, 100.37)] },
      now: msFromET(2026, 9, 1, 16, 0) + 5_000,
    });
    sc.data.touch(sc.now() - 1_000);
    await sc.engine.tick(sc.now());
    const order = sc.fake.ordersFor('AAPL')[0];
    expect(order?.orderClass).toBe('bracket');
    expect(order?.timeInForce).toBe('gtc');
    expect(order?.clientOrderId).toBe(entryClientId('paper', 'AAPL', msFromET(2026, 9, 1)));
    expect(sc.state()?.lastBarAt.AAPL).toBe(msFromET(2026, 9, 1, 9, 30));
    expect(sc.fake.barRequests[0]?.timeframe).toBe('1Day');
  });
});
