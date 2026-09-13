/**
 * Die Engine führt die Equity-Historie, aus der das Vola-Ziel rechnet —
 * und sie führt die Stufen-Sperren so, dass sie auch wieder enden können.
 *
 * Wächter, die Geld kosten, wenn sie fehlen:
 *  (a) Je Handelstag EINE Marke, und zwar der Vortagesschluss (`last_equity`)
 *      — dieselbe Marke, mit der der Simulator seine Tagesrendite bildet
 *      (backtest/simulator.ts). Zwei Definitionen wären zwei Welten.
 *  (b) Der Faktor steht im JOURNAL, sobald er sich ändert. Eine Größe, die
 *      jede Positionsgröße multipliziert, darf nicht unsichtbar sein.
 *  (c) Eine Drawdown-Sperre je Stufe endet über `resume` — sonst stünde sie
 *      für immer, während der Konto-Halt längst weg ist (§0.5: über die
 *      Ursache, nie per Override; `resume` IST die Aufhebung der Ursache).
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { msFromET } from '../../src/core/time.ts';
import { minuteBars, scriptedStrategy, startScenario, testConfig } from '../fakes/harness.ts';

const daily = (y: number, m: number, d: number, c: number) => ({ t: msFromET(y, m, d), o: c - 1, h: c + 1, l: c - 2, c, v: 1_000_000 });

/** Tagesbar-Welt mit Vola-Ziel: minBeobachtungen 2, damit die Historie in drei Tagen reicht. */
function welt(volTarget: Record<string, unknown> | null) {
  return startScenario({
    config: testConfig({
      timeframe: 1440,
      risk: {
        maxDailyLossPct: 50,
        maxDrawdownPct: 90,
        ...(volTarget ? { volTarget } : {}),
      },
    }),
    defaultStrategy: scriptedStrategy({ enterAt: 99, holdsOvernight: true }), // kein Einstieg: hier zählt nur die Buchführung
    preload: { AAPL: [daily(2026, 8, 28, 99), daily(2026, 8, 31, 100), daily(2026, 9, 1, 100.37)] },
    now: msFromET(2026, 9, 1, 16, 0) + 5_000,
  });
}

/** Einen Handelstag weiterdrehen: Broker meldet neuen Schluss, Engine rollt über und entscheidet nach Schluss. */
async function tagWeiter(sc: Awaited<ReturnType<typeof welt>>, tag: [number, number, number], schlussVortag: number, equity: number, kurs: number) {
  const [y, m, d] = tag;
  sc.fake.account.lastEquity = schlussVortag;
  sc.fake.account.equity = equity;
  sc.fake.setPrice('AAPL', kurs);
  const morgen = msFromET(y, m, d, 9, 31);
  sc.setNow(morgen);
  await sc.engine.reconcileNow(morgen);
  await sc.engine.tick(morgen);
  sc.pushBars('AAPL', minuteBars(msFromET(y, m, d, 9, 30), [kurs, kurs, kurs, kurs, kurs]));
  const abend = msFromET(y, m, d, 16, 0) + 5_000;
  sc.setNow(abend);
  await sc.engine.tick(abend);
}

describe('Equity-Historie und Vola-Ziel in der Engine', () => {
  it('WÄCHTER (a): je Handelstag genau eine Marke = Vortagesschluss; ein zweiter Tick am selben Tag hängt nichts an', async () => {
    const sc = await welt(null);
    sc.data.touch(sc.now() - 1_000);
    await sc.engine.tick(sc.now());
    expect(sc.state()?.equityHistory ?? []).toEqual([]); // vor dem ersten Rollover gibt es keine Marke

    await tagWeiter(sc, [2026, 9, 2], 100_000, 99_000, 99);
    expect(sc.state()?.equityHistory).toEqual([100_000]);
    // Zweiter Tick desselben Tags: kein Rollover, keine zweite Marke.
    await sc.engine.tick(sc.now() + 1_000);
    expect(sc.state()?.equityHistory).toEqual([100_000]);

    await tagWeiter(sc, [2026, 9, 3], 99_000, 98_500, 98);
    await tagWeiter(sc, [2026, 9, 4], 98_500, 98_700, 98.5);
    expect(sc.state()?.equityHistory).toEqual([100_000, 99_000, 98_500]);
  });

  it('WÄCHTER (b): der Faktor landet im Journal, sobald er sich ändert — mit Vola und Grund', async () => {
    const sc = await welt({ enabled: true, zielVolPct: 10, halbwertszeitTage: 20, minFaktor: 0.25, maxFaktor: 2, minBeobachtungen: 2 });
    sc.data.touch(sc.now() - 1_000);
    await sc.engine.tick(sc.now());
    // Noch keine Renditen ⇒ Aufwärmphase, Faktor 1,0.
    expect(sc.events('note').some((e) => String(e.text).startsWith('Vola-Ziel') && /Aufwärmphase/.test(String(e.text)))).toBe(true);

    await tagWeiter(sc, [2026, 9, 2], 100_000, 99_000, 99);
    await tagWeiter(sc, [2026, 9, 3], 99_000, 98_500, 98);
    await tagWeiter(sc, [2026, 9, 4], 98_500, 98_700, 98.5);
    const notiz = sc.events('note').filter((e) => String(e.text).startsWith('Vola-Ziel')).at(-1);
    expect(notiz).toBeDefined();
    expect(typeof notiz?.volFaktor).toBe('number');
    expect(notiz?.beobachtungen).toBe(2);
    expect(String(notiz?.text)).toMatch(/realisiert/);
    // Der Status trägt ihn ebenfalls (fürs Frontend/`autotrd status`).
    expect(sc.engine.status().volZiel?.faktor).toBeGreaterThan(0);
    // Aus ⇒ gar keine Notiz.
    const ohne = await welt(null);
    ohne.data.touch(ohne.now() - 1_000);
    await ohne.engine.tick(ohne.now());
    expect(ohne.events('note').some((e) => String(e.text).startsWith('Vola-Ziel'))).toBe(false);
    expect(ohne.engine.status().volZiel).toBe(null);
  });

  it('WÄCHTER (c): `resume` hebt auch eine Drawdown-Sperre der Stufe auf — Tages-Sperren bleiben (sie enden von selbst)', async () => {
    const sc = await welt(null);
    // Stufen-Sperren in den State auf Platte legen und neu starten: So sähe die Engine
    // sie nach einem Neustart (und so sieht sie der Functions-Takt aus Firestore).
    await sc.engine.stop();
    const st = sc.state()!;
    st.stufenHalt = {
      alpha: { halted: true, reason: 'drawdown', since: 1, until: null, note: 'Drawdown 12 %' },
      basis: { halted: true, reason: 'daily_loss', since: 1, until: '2026-09-02', note: 'Tagesverlust' },
    };
    writeFileSync(sc.paths.state, JSON.stringify(st));
    await sc.engine.start();
    expect(sc.state()?.stufenHalt?.alpha?.halted).toBe(true);

    await sc.engine.resume('Prüfung');
    expect(sc.state()?.stufenHalt?.alpha?.halted).toBe(false);
    expect(sc.state()?.stufenHalt?.alpha?.note).toMatch(/resume/);
    expect(sc.state()?.stufenHalt?.basis?.halted, 'Tages-Sperre endet am nächsten Handelstag von selbst').toBe(true);
    const resume = sc.events('resume').at(-1);
    expect(resume?.stufen).toEqual(['alpha']);
  });
});
