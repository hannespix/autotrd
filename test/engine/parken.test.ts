/**
 * Wächter des ORDERPFADS der Treasury (src/engine/orders.ts, engine.ts).
 *
 * Die Rechnung steht in test/risk/parken.test.ts, die Entscheidung in
 * test/core/parken.test.ts. Hier geht es um das, was beim Broker landet:
 * eine schlichte Marktorder OHNE Stop-Bein, ein Fill, der KEIN Trade wird,
 * eine Position, die kein Aufräumer liquidiert, und ein `flatten`, das die
 * Kasse stehen lässt.
 */
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import type { PersistedState } from '../../src/engine/engine.ts';
import { PARK_STRATEGY_ID } from '../../src/risk/parken.ts';
import { DAY1, OPEN1, TEN_CLOSES, minuteBars, scriptedStrategy, startScenario, testConfig, type Scenario } from '../fakes/harness.ts';

const PARK = 'BIL';
const T_TICK1 = OPEN1 + 10 * MIN + 5_000;
/** Der Park-Stand liegt im erweiterten State (engine.ts, `PersistedState`). */
const parkStand = (sc: Scenario) => (sc.state() as PersistedState | null)?.park;
const parkConfig = (over: Record<string, unknown> = {}) => testConfig({ risk: { cashParking: { enabled: true, symbol: PARK, bandPct: 5, bufferPct: 2 }, ...over } });

/** Szenario mit Parksymbol: AAPL wird gehandelt, BIL gehört der Treasury (keine Strategie). */
async function parkSzenario(o: { config?: ReturnType<typeof testConfig>; enterAt?: number } = {}): Promise<Scenario> {
  const sc = await startScenario({
    config: o.config ?? parkConfig(),
    defaultStrategy: scriptedStrategy(o.enterAt === undefined ? {} : { enterAt: o.enterAt, holdsOvernight: true }),
    strategies: { [PARK]: null },
  });
  sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
  sc.pushBars(PARK, minuteBars(OPEN1, TEN_CLOSES.map(() => 91.5)));
  return sc;
}

/** Park-Order des Fakes (Marktorder im Parksymbol). */
function parkOrders(sc: Scenario) {
  return sc.fake.ordersFor(PARK);
}

describe('Park-Order', () => {
  it('ist eine schlichte Marktorder ohne Stop- und Ziel-Bein (Eigenschaft 3)', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);

    const orders = parkOrders(sc);
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.side).toBe('buy');
    expect(o.type).toBe('market');
    expect(o.orderClass).toBe('simple');
    expect(o.legs).toHaveLength(0);
    expect(o.stopPrice).toBeNull();
    expect(o.limitPrice).toBeNull();
    expect(o.timeInForce).toBe('day');
    // 100 000 $ Equity, 2 % Puffer, Kurs 91,50 ⇒ 98 000 / (91,50 · 1,002) = 1068 Stück
    expect(o.qty).toBe(1068);
    expect(sc.events('order_submitted').some((e) => e.purpose === 'park')).toBe(true);
  });

  it('bucht den Fill als Parkposition ohne Stop — und NICHT als Trade', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);
    sc.fake.fill(parkOrders(sc)[0]!.id, 91.5);
    await sc.engine.idle();

    const pos = sc.engine.status().positions.find((p) => p.symbol === PARK)!;
    expect(pos).toMatchObject({ symbol: PARK, side: 'long', qty: 1068, strategy: PARK_STRATEGY_ID, stop: null, target: null, initialStop: null, stufe: 'cash' });
    expect(sc.events('trade_closed')).toHaveLength(0);
    expect(sc.events('fill').some((e) => e.purpose === 'park')).toBe(true);
    // Kein Schutz-Stop, auch nicht über den Abgleich (der ihn sonst nachsetzt).
    await sc.engine.reconcileNow(T_TICK1 + 1_000);
    expect(sc.engine.status().protectiveOrders[PARK]).toBeUndefined();
    expect(parkOrders(sc).filter((o) => o.type === 'stop' || o.type === 'stop_limit')).toHaveLength(0);
    expect(sc.engine.status().halt.halted).toBe(false); // kein Fremdbestand: die Position steht im Buch
  });

  it('sendet im selben Bucket keine zweite Order (Idempotenz an der logischen Einheit)', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(1);
    await sc.engine.tick(T_TICK1 + 1_000);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(1);
    expect(parkOrders(sc)).toHaveLength(1);
  });

  it('schichtet am selben Handelstag kein zweites Mal um', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);
    sc.fake.fill(parkOrders(sc)[0]!.id, 91.5);
    await sc.engine.idle();
    expect(parkStand(sc)?.tag).toBe(DAY1);

    // Neue Bar, neuer Bucket — aber derselbe Handelstag.
    sc.pushBars('AAPL', minuteBars(OPEN1 + 10 * MIN, [100.5, 100.6, 100.7, 100.8, 100.9]));
    sc.pushBars(PARK, minuteBars(OPEN1 + 10 * MIN, [91.5, 91.5, 91.5, 91.5, 91.5]));
    await sc.engine.tick(OPEN1 + 15 * MIN + 5_000);
    expect(parkOrders(sc)).toHaveLength(1);
  });

  it('der Stand überlebt den Neustart (Plattform: jeder Takt ein neuer Prozess)', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);
    sc.fake.fill(parkOrders(sc)[0]!.id, 91.5);
    await sc.engine.idle();
    await sc.engine.stop();

    const wieder = await startScenario({ config: parkConfig(), home: sc.home, fake: sc.fake, now: sc.now() + 60_000, defaultStrategy: scriptedStrategy({}), strategies: { [PARK]: null } });
    expect(parkStand(wieder)?.tag).toBe(DAY1);
    const pos = wieder.engine.status().positions.find((p) => p.symbol === PARK)!;
    expect(pos.strategy).toBe(PARK_STRATEGY_ID);
    expect(pos.stop).toBeNull();
    expect(wieder.engine.status().halt.halted).toBe(false);
  });
});

describe('Die Parkposition wird nicht bewirtschaftet', () => {
  it('kein „unmanaged"-Exit, obwohl keine Strategie das Parksymbol führt', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);
    sc.fake.fill(parkOrders(sc)[0]!.id, 91.5);
    await sc.engine.idle();

    sc.pushBars('AAPL', minuteBars(OPEN1 + 10 * MIN, [100.5, 100.6, 100.7, 100.8, 100.9]));
    sc.pushBars(PARK, minuteBars(OPEN1 + 10 * MIN, [91.5, 91.5, 91.5, 91.5, 91.5]));
    await sc.engine.tick(OPEN1 + 15 * MIN + 5_000);

    expect(sc.events('note').some((e) => String(e.text).includes('ohne führende Strategie'))).toBe(false);
    expect(sc.engine.status().positions.some((p) => p.symbol === PARK)).toBe(true);
    expect(sc.events('trade_closed')).toHaveLength(0);
  });

  it('flatten lässt die Parkposition ausdrücklich stehen und schließt nur das Strategie-Buch', async () => {
    const sc = await parkSzenario({ enterAt: 1 });
    await sc.engine.tick(T_TICK1);
    // Beide Orders füllen: die Strategie-Position und die Parkposition.
    for (const o of sc.fake.openOrders('AAPL')) if (o.type === 'market') sc.fake.fill(o.id, 100.4);
    sc.fake.fill(parkOrders(sc)[0]!.id, 91.5);
    await sc.engine.idle();
    expect(sc.engine.status().positions.map((p) => p.symbol).sort()).toEqual(['AAPL', PARK]);

    await sc.engine.flatten('manual');
    expect(sc.engine.status().pendingExits).toEqual(['AAPL']);
    expect(sc.events('note').some((e) => String(e.text).includes('Parkposition bleibt stehen'))).toBe(true);
    // Kein Exit-Auftrag im Parksymbol.
    expect(parkOrders(sc).filter((o) => o.side === 'sell')).toHaveLength(0);
  });

  it('mit `enabled: false` räumt die Treasury ihre Position selbst (Rückzug, kein Trade)', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);
    sc.fake.fill(parkOrders(sc)[0]!.id, 91.5);
    await sc.engine.idle();
    await sc.engine.stop();

    // Parken aus — dieselbe Home, dieselbe Position.
    const aus = await startScenario({
      config: testConfig({ risk: { cashParking: { enabled: false, symbol: PARK } } }),
      home: sc.home,
      fake: sc.fake,
      now: OPEN1 + 20 * MIN + 5_000,
      defaultStrategy: scriptedStrategy({}),
      strategies: { [PARK]: null },
    });
    aus.pushBars('AAPL', minuteBars(OPEN1 + 15 * MIN, [100.5, 100.6, 100.7, 100.8, 100.9]));
    aus.pushBars(PARK, minuteBars(OPEN1 + 15 * MIN, [91.5, 91.5, 91.5, 91.5, 91.5]));
    await aus.engine.tick(OPEN1 + 20 * MIN + 5_000);

    const verkauf = parkOrders(aus).find((o) => o.side === 'sell');
    expect(verkauf).toBeDefined();
    expect(verkauf!.qty).toBe(1068);
    expect(verkauf!.type).toBe('market');
    aus.fake.fill(verkauf!.id, 91.5);
    await aus.engine.idle();
    expect(aus.engine.status().positions.some((p) => p.symbol === PARK)).toBe(false);
    // Ein Rückzug ist kein Trade — sonst verschöbe die Treasury die Live-Reife.
    expect(aus.events('trade_closed')).toHaveLength(0);
  });
});

describe('Symbolwechsel', () => {
  it('räumt erst das alte Papier — dafür wird es weiter bewertet', async () => {
    const sc = await parkSzenario();
    await sc.engine.tick(T_TICK1);
    sc.fake.fill(parkOrders(sc)[0]!.id, 91.5);
    await sc.engine.idle();
    await sc.engine.stop();

    const neu = await startScenario({
      config: parkConfig({ cashParking: { enabled: true, symbol: 'SHV', bandPct: 5, bufferPct: 2 } }),
      home: sc.home,
      fake: sc.fake,
      now: OPEN1 + 20 * MIN + 5_000,
      defaultStrategy: scriptedStrategy({}),
      strategies: { [PARK]: null, SHV: null },
    });
    neu.pushBars('AAPL', minuteBars(OPEN1 + 15 * MIN, [100.5, 100.6, 100.7, 100.8, 100.9]));
    neu.pushBars(PARK, minuteBars(OPEN1 + 15 * MIN, [91.5, 91.5, 91.5, 91.5, 91.5]));
    await neu.engine.tick(OPEN1 + 20 * MIN + 5_000);

    const verkauf = parkOrders(neu).find((o) => o.side === 'sell');
    expect(verkauf).toBeDefined();
    expect(verkauf!.qty).toBe(1068);
    // Und im neuen Symbol wird noch nichts gekauft, solange das alte liegt.
    expect(neu.fake.ordersFor('SHV')).toHaveLength(0);
  });
});

describe('Das Parken nimmt dem Handelsbuch nie den Datenstrom', () => {
  it('reißt das Abonnement-Limit des IEX-Stroms, bleibt das Parksymbol draußen — nicht das Universum', async () => {
    // 30 Symbole (IEX-Limit) plus Parksymbol: Ein 31. Abonnement beantwortet
    // Alpaca mit 405, der Strom käme nie zustande und JEDER Einstieg wäre
    // still gesperrt (Prüfbefund M10). Also fällt die Treasury hinten runter.
    const viele = Array.from({ length: 30 }, (_, i) => `SYM${String(i).padStart(2, '0')}`);
    const sc = await startScenario({
      config: testConfig({ universe: { symbols: viele }, risk: { cashParking: { enabled: true, symbol: PARK } } }),
      defaultStrategy: scriptedStrategy({}),
      strategies: { [PARK]: null },
    });
    expect(sc.data.subscribed).toHaveLength(30);
    expect(sc.data.subscribed).not.toContain(PARK);
    expect(sc.data.subscribed).toContain('SYM00');
    expect(sc.events('note').some((e) => String(e.text).includes('nicht im Datenstrom'))).toBe(true);
  });

  it('unterhalb des Limits wird das Parksymbol abonniert', async () => {
    const sc = await parkSzenario();
    expect(sc.data.subscribed).toContain(PARK);
    expect(sc.data.subscribed).toContain('AAPL');
  });
});

describe('Ohne Parken bleibt alles, wie es war', () => {
  it('keine Config ⇒ keine Park-Order, kein Feld im State', async () => {
    const sc = await startScenario({ defaultStrategy: scriptedStrategy({}) });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T_TICK1);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(0);
    expect(parkStand(sc)).toBeUndefined();
  });
});
