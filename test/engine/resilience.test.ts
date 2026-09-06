import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, MIN, msFromET } from '../../src/core/time.ts';
import { BarStore, barStoreRoot } from '../../src/data/store.ts';
import { resumeFlagPath } from '../../src/engine/engine.ts';
import { DAY1, OPEN1, TEN_CLOSES, minuteBars, openPositionViaFill, scriptedStrategy, startScenario, testConfig, tmpHome } from '../fakes/harness.ts';

const T1 = OPEN1 + 10 * MIN + 5_000;

describe('RESUME-Datei', () => {
  it('hebt einen Drawdown-Halt im Tick auf, setzt den Peak auf die aktuelle Equity und löscht die Datei', async () => {
    const sc = await startScenario();
    sc.fake.account.equity = 85_000;
    await sc.engine.reconcileNow(sc.now());
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(sc.engine.status().halt.reason).toBe('drawdown');
    writeFileSync(resumeFlagPath(sc.home), 'Operator: Drawdown geprüft\n');
    await sc.engine.tick(T1 + 1_000);
    expect(sc.engine.status().halt.halted).toBe(false);
    expect(sc.state()?.peakEquity).toBe(85_000);
    expect(existsSync(resumeFlagPath(sc.home))).toBe(false);
    const resume = sc.events('resume');
    expect(resume).toHaveLength(1);
    expect(String(resume[0]!.note)).toContain('Operator: Drawdown geprüft');
  });

  it('wird auch beim Start verarbeitet (manueller Halt aus dem State)', async () => {
    const sc = await startScenario();
    writeFileSync(sc.paths.haltFlag, 'x\n');
    await sc.engine.tick(T1);
    expect(sc.engine.status().halt.reason).toBe('manual');
    await sc.engine.stop();
    writeFileSync(resumeFlagPath(sc.home), 'weiter\n');
    // HALT-Datei bleibt absichtlich liegen: Sie setzt den Halt im ersten Tick erneut — die Ursache ist nicht behoben.
    const again = await startScenario({ home: sc.home, fake: sc.fake, now: T1 + 60_000 });
    expect(again.engine.status().halt.halted).toBe(false);
    expect(existsSync(resumeFlagPath(sc.home))).toBe(false);
    expect(again.events('resume').some((e) => String(e.note).includes('weiter'))).toBe(true);
    await again.engine.tick(T1 + 61_000);
    expect(again.engine.status().halt.reason).toBe('manual');
  });

  it('lässt einen Tages-Halt stehen (endet von selbst) und räumt die Datei trotzdem weg', async () => {
    const sc = await startScenario();
    sc.fake.account.equity = 97_000; // −3 % am Tag, aber nur 3 % vom Hoch
    await sc.engine.reconcileNow(sc.now());
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(sc.engine.status().halt.reason).toBe('daily_loss');
    writeFileSync(resumeFlagPath(sc.home), 'bitte\n');
    await sc.engine.tick(T1 + 1_000);
    expect(sc.engine.status().halt.reason).toBe('daily_loss');
    expect(existsSync(resumeFlagPath(sc.home))).toBe(false);
    expect(sc.events('note').some((e) => String(e.text).includes('RESUME ignoriert'))).toBe(true);
  });
});

describe('HALT-Datei fail-closed', () => {
  it('ein Fehler außer ENOENT beim Prüfen gilt als Halt (manual) mit Notiz', async () => {
    const eacces = () => {
      const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      throw e;
    };
    const sc = await startScenario({ statSync: eacces });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(sc.engine.status().halt).toMatchObject({ halted: true, reason: 'manual' });
    expect(String(sc.engine.status().halt.note)).toContain('fail-closed');
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(0);
  });

  it('ENOENT heißt: keine Datei, kein Halt', async () => {
    const enoent = () => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    };
    const sc = await startScenario({ statSync: enoent });
    await sc.engine.tick(T1);
    expect(sc.engine.status().halt.halted).toBe(false);
  });
});

describe('Prozess-Fehler', () => {
  it('unhandledRejection ⇒ Halt (errors) + Journal + Benachrichtigung; uncaughtException ⇒ zusätzlich Stopp; Handler beim Stopp abgemeldet', async () => {
    const ee = new EventEmitter();
    const sc = await startScenario({ processEvents: ee });
    expect(ee.listenerCount('unhandledRejection')).toBe(1);
    ee.emit('unhandledRejection', new Error('Promise ohne Fänger'));
    await sc.engine.idle();
    expect(sc.engine.status().halt).toMatchObject({ halted: true, reason: 'errors' });
    expect(sc.events('error').some((e) => e.where === 'unhandledRejection')).toBe(true);
    expect(sc.notifications.some((n) => n.level === 'error' && n.text.includes('unhandledRejection'))).toBe(true);
    expect(sc.state()?.halt.reason).toBe('errors');

    ee.emit('uncaughtException', new Error('Absturz'));
    await sc.engine.idle();
    expect(sc.engine.status().running).toBe(false);
    expect(sc.events('stop')).toHaveLength(1);
    expect(sc.events('error').some((e) => e.where === 'uncaughtException')).toBe(true);
    expect(ee.listenerCount('unhandledRejection')).toBe(0);
    expect(ee.listenerCount('uncaughtException')).toBe(0);
  });
});

describe('Bars-Cache: Schreiblast und Kürzung', () => {
  const countBars = (home: string) => (JSON.parse(readFileSync(join(home, 'bars', 'us_equity', 'iex', 'AAPL_1Min.json'), 'utf8')) as { t: number[] }).t.length;

  it('schreibt höchstens alle 5 Minuten, beim Stopp erzwungen', async () => {
    const sc = await startScenario();
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(countBars(sc.home)).toBe(10);
    sc.pushBars('AAPL', minuteBars(OPEN1 + 10 * MIN, [100.5]));
    await sc.engine.tick(T1 + 60_000);
    expect(countBars(sc.home)).toBe(10); // gedrosselt
    sc.pushBars('AAPL', minuteBars(OPEN1 + 11 * MIN, [100.6, 100.7]));
    await sc.engine.tick(T1 + 5 * MIN + 1_000);
    expect(countBars(sc.home)).toBe(13);
    expect(sc.engine.status().lastFlushAt).toBe(T1 + 5 * MIN + 1_000);
    sc.pushBars('AAPL', minuteBars(OPEN1 + 13 * MIN, [100.8]));
    await sc.engine.tick(T1 + 5 * MIN + 2_000);
    expect(countBars(sc.home)).toBe(13);
    await sc.engine.stop();
    expect(countBars(sc.home)).toBe(14);
  });

  it('kürzt den Cache beim Tagesrollover auf optimizer.lookbackDays + 30 Tage', async () => {
    const home = tmpHome();
    const store = new BarStore(barStoreRoot(join(home, 'bars'), 'us_equity', 'iex'));
    const ancient = OPEN1 - 500 * DAY;
    store.upsert('AAPL', '1Min', [{ t: ancient, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    const sc = await startScenario({ home, store });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(store.load('AAPL', '1Min').some((b) => b.t === ancient)).toBe(true);
    await sc.engine.tick(msFromET(2026, 9, 2, 9, 31));
    const bars = store.load('AAPL', '1Min');
    expect(bars.some((b) => b.t === ancient)).toBe(false);
    expect(bars.length).toBe(10);
  });
});

describe('Datenstrom-Reconnect', () => {
  it('lädt nach dem Wiederverbinden ab letzter Nachricht − 2 min exakt nach', async () => {
    const sc = await startScenario();
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES)); // letzte Nachricht 09:40
    await sc.engine.tick(T1);
    const before = sc.fake.barRequests.length;
    sc.data.emitStatus('disconnected', 'socket zu');
    sc.data.emitStatus('connected');
    sc.data.emitStatus('subscribed');
    await sc.engine.tick(T1 + 30_000);
    const req = sc.fake.barRequests.slice(before);
    expect(req).toHaveLength(1);
    expect(req[0]?.start).toBe(OPEN1 + 10 * MIN - 2 * MIN);
    expect(req[0]?.end).toBe(T1 + 30_000);
    expect(sc.events('note').some((e) => String(e.text).includes('wieder verbunden'))).toBe(true);
    // Ohne erneuten Abriss kein weiterer Nachlauf.
    await sc.engine.tick(T1 + 31_000);
    expect(sc.fake.barRequests.length).toBe(before + 1);
  });
});

describe('Offene Einstiegs-Orders belegen Exposure-Budget', () => {
  it('zweites Symbol bekommt nur den Rest des Brutto-Budgets, solange die erste Order ungefüllt ist', async () => {
    const sc = await startScenario({
      config: testConfig({ universe: { symbols: ['AAPL', 'MSFT'] }, risk: { maxGrossExposurePct: 25, maxPositionPct: 20 } }),
      defaultStrategy: scriptedStrategy({ enterAt: 1 }),
    });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(sc.fake.ordersFor('AAPL')[0]?.qty).toBe(199); // 199 × 100.37 ≈ 19 974 $ belegt
    sc.pushBars('MSFT', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1 + 1_000);
    expect(sc.fake.ordersFor('MSFT')[0]?.qty).toBe(50); // Rest: 25 000 − 19 974 = 5 026 $ ⇒ 50 Stück
    expect(sc.engine.status().pendingEntries).toEqual(['AAPL', 'MSFT']);
    expect(sc.state()?.day).toBe(DAY1);
  });
});

describe('Positionen ohne Intent nach Neustart', () => {
  it('werden gebucht, sobald der Fill kommt (Nominal unbekannt ⇒ nicht gezählt, aber nie verloren)', async () => {
    const sc = await startScenario();
    await openPositionViaFill(sc);
    expect(sc.engine.status().positions[0]?.qty).toBe(199);
  });
});
