/**
 * Die Tages-Notbremse rechnet vom VORTAGESSCHLUSS (Prüfbefund K1, 09.09.2026).
 *
 * Der Fehler, den dieser Test verhindert: `dayStartEquity` war die Equity beim
 * ERSTEN Tick nach dem Tageswechsel — also NACH dem Übernacht-Gap. Ein Gap
 * von −5 % über Nacht maß dann 0 %: Auf der Plattform (erster Takt 09:30,
 * `decide()` im selben Takt) war die Bremse bei Tagesbars damit ein Placebo,
 * während die Messung sie close-to-close anwendet (simulator.ts). Jetzt ist
 * die Marke Alpacas `last_equity` (Schluss-Equity des Vortags), Rückfall die
 * aktuelle Equity — im Rollover und im ersten State.
 */
import { describe, expect, it } from 'vitest';
import { msFromET } from '../../src/core/time.ts';
import { minuteBars, scriptedStrategy, startScenario, testConfig } from '../fakes/harness.ts';

/** Tagesbars, Übernacht-Strategie, Tagesbremse 5 %. */
function tagesbarWelt() {
  const daily = (y: number, m: number, d: number, c: number) => ({ t: msFromET(y, m, d), o: c - 1, h: c + 1, l: c - 2, c, v: 1_000_000 });
  return startScenario({
    config: testConfig({ timeframe: 1440, risk: { maxDailyLossPct: 5, maxDrawdownPct: 50 } }),
    defaultStrategy: scriptedStrategy({ enterAt: 1, holdsOvernight: true, stopPct: 0.2, targetPct: null }),
    preload: { AAPL: [daily(2026, 8, 28, 99), daily(2026, 8, 31, 100), daily(2026, 9, 1, 100.37)] },
    now: msFromET(2026, 9, 1, 16, 0) + 5_000,
  });
}

describe('Tages-Notbremse — Marke ist der Vortagesschluss (last_equity)', () => {
  it('WÄCHTER (K1): Gap über Nacht −5 % bei maxDailyLossPct 5 ⇒ Halt daily_loss und Glattstellung im ersten Zyklus des Folgetags', async () => {
    const sc = await tagesbarWelt();
    sc.data.touch(sc.now() - 1_000);
    // Tag 1 (01.09., nach Schluss): Einstieg auf die Tagesbar, Fill.
    await sc.engine.tick(sc.now());
    const parent = sc.fake.openOrders('AAPL').find((o) => o.type === 'market')!;
    expect(parent.orderClass, 'ohne Ziel: oto (K3)').toBe('oto');
    sc.fake.fill(parent.id, 100.4);
    await sc.engine.idle();
    expect(sc.engine.status().positions.map((p) => p.symbol)).toEqual(['AAPL']);

    // Über Nacht: Schluss-Equity 100 000, am Morgen 95 000 (−5 %). Alpaca meldet `last_equity` = Vortagesschluss.
    sc.fake.account.equity = 95_000;
    sc.fake.account.cash = 75_000;
    sc.fake.account.lastEquity = 100_000;
    sc.fake.setPrice('AAPL', 75);
    // Tag 2 (02.09.): Der erste Tick des Tages macht den Rollover; die Tagesbar des 02.09. schließt um 16:00.
    const t2 = msFromET(2026, 9, 2, 9, 31);
    sc.setNow(t2);
    await sc.engine.reconcileNow(t2);
    await sc.engine.tick(t2);
    expect(sc.state()?.day).toBe('2026-09-02');
    expect(sc.state()?.dayStartEquity, 'Marke = Vortagesschluss, nicht die Equity nach dem Gap').toBe(100_000);

    // Tagesbar des 02.09. aus Stream-Minuten; nach Schluss entscheidet decide() — und die Bremse misst −5 %.
    sc.pushBars('AAPL', minuteBars(msFromET(2026, 9, 2, 9, 30), [75, 75.1, 75.2, 75.1, 75.15]));
    const t3 = msFromET(2026, 9, 2, 16, 0) + 5_000;
    sc.setNow(t3);
    await sc.engine.tick(t3);
    const halt = sc.engine.status().halt;
    expect(halt).toMatchObject({ halted: true, reason: 'daily_loss', until: '2026-09-03' });
    expect(halt.note).toMatch(/Tagesverlust -5\.00 %/);
    // Die Glattstellung ist entschieden (kill_switch) — nach Schluss zurückgestellt bis zur Eröffnung, Stop bleibt liegen.
    const intents = sc.events('intent').map((e) => e.intent as { kind: string; symbol: string; reason?: string });
    expect(intents.some((i) => i.kind === 'exit' && i.symbol === 'AAPL' && i.reason === 'kill_switch')).toBe(true);
    expect(sc.engine.status().deferredIntents).toEqual(['AAPL']);
    expect(sc.fake.find(`${parent.id}-sl`)?.status).not.toBe('canceled');
  });

  it('mit der alten Rechnung (Equity nach dem Gap) fiele der Halt nicht — Rückfall nur, wenn last_equity fehlt', async () => {
    const sc = await tagesbarWelt();
    sc.data.touch(sc.now() - 1_000);
    await sc.engine.tick(sc.now());
    sc.fake.fill(sc.fake.openOrders('AAPL').find((o) => o.type === 'market')!.id, 100.4);
    await sc.engine.idle();
    // Broker ohne last_equity (0): Rückfall auf die aktuelle Equity — dann ist das Gap unsichtbar (alte Rechnung).
    sc.fake.account.equity = 95_000;
    sc.fake.account.lastEquity = 0;
    const t2 = msFromET(2026, 9, 2, 9, 31);
    sc.setNow(t2);
    await sc.engine.reconcileNow(t2);
    await sc.engine.tick(t2);
    expect(sc.state()?.dayStartEquity).toBe(95_000);
    sc.pushBars('AAPL', minuteBars(msFromET(2026, 9, 2, 9, 30), [75, 75.1, 75.2, 75.1, 75.15]));
    const t3 = msFromET(2026, 9, 2, 16, 0) + 5_000;
    sc.setNow(t3);
    await sc.engine.tick(t3);
    expect(sc.engine.status().halt.halted).toBe(false);
  });

  it('erster State: Tagesstart ist ebenfalls der Vortagesschluss', async () => {
    const sc = await startScenario({ start: false });
    sc.fake.account.equity = 98_000;
    sc.fake.account.lastEquity = 100_000;
    await sc.engine.start();
    expect(sc.state()?.dayStartEquity).toBe(100_000);
    // Der Peak zählt beide Marken — der Drawdown misst vom Schluss, nie unter der aktuellen Equity.
    expect(sc.state()?.peakEquity).toBe(100_000);
  });
});
