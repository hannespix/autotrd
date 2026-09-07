import { describe, expect, it } from 'vitest';
import type { HaltState } from '../../../src/core/types.ts';
import { MIN } from '../../../src/core/time.ts';
import { minuteBars, OPEN1, startScenario, TEN_CLOSES } from '../../../test/fakes/harness.ts';
import { FirestoreJournal } from '../../src/engine/journal.ts';
import { applyCommands, claimCommands, commandDocFrom, commandPatch, commandsPath, parseCommandRequest, type CommandTarget } from '../../src/engine/commands.ts';
import { haltFlagStat } from '../../src/engine/tick.ts';
import { FakeFirestore, FakeTimestamp } from '../fakes/firestore.ts';

const NOW = Date.UTC(2026, 8, 1, 14, 0, 0);
const ISO = new Date(NOW).toISOString();

function fakeTarget(halt: Partial<HaltState> = {}) {
  const calls: string[] = [];
  let h: HaltState = { halted: false, reason: null, since: null, until: null, note: null, ...halt };
  const t: CommandTarget & { calls: string[] } = {
    calls,
    async halt(note) {
      calls.push(`halt:${note}`);
      h = { halted: true, reason: 'manual', since: NOW, until: null, note };
    },
    async resume(note) {
      calls.push(`resume:${note}`);
      h = { halted: false, reason: null, since: null, until: null, note };
    },
    async flatten(reason) {
      calls.push(`flatten:${reason}`);
    },
    status: () => ({ halt: h }),
  };
  return t;
}

function journal(db = new FakeFirestore()) {
  return new FirestoreJournal({ db, mode: 'paper', assetClass: 'us_equity', fx: async () => ({}), timestampNow: () => FakeTimestamp.now(), log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } });
}

describe('Kommandos — Callable-Seite', () => {
  it('parseCommandRequest prüft action/reason/ackDrawdown', () => {
    expect(parseCommandRequest({ action: 'halt', reason: ' Wartung ' })).toEqual({ action: 'halt', reason: 'Wartung' });
    expect(parseCommandRequest({ action: 'resume', ackDrawdown: true })).toEqual({ action: 'resume', ackDrawdown: true });
    expect(parseCommandRequest({ action: 'flatten' })).toEqual({ action: 'flatten' });
    expect(() => parseCommandRequest({ action: 'kaufen' })).toThrow(/action/);
    expect(() => parseCommandRequest(null)).toThrow(/Objekt/);
    expect(() => parseCommandRequest({ action: 'halt', reason: 5 })).toThrow(/reason/);
    expect(() => parseCommandRequest({ action: 'resume', ackDrawdown: 'ja' })).toThrow(/ackDrawdown/);
    expect(parseCommandRequest({ action: 'halt', reason: 'x'.repeat(500) }).reason).toHaveLength(200);
  });

  it('commandPatch: {halt:{at,reason}} · {resume:{at,ack}} · {flatten:{at}}', () => {
    expect(commandPatch({ action: 'halt', reason: 'W' }, NOW)).toEqual({ halt: { at: ISO, reason: 'W' } });
    expect(commandPatch({ action: 'resume' }, NOW)).toEqual({ resume: { at: ISO, ack: false, reason: null } });
    expect(commandPatch({ action: 'resume', ackDrawdown: true }, NOW)).toEqual({ resume: { at: ISO, ack: true, reason: null } });
    expect(commandPatch({ action: 'flatten' }, NOW)).toEqual({ flatten: { at: ISO, reason: null } });
  });

  it('claimCommands liest UND löscht das Doc in einer Transaktion; leer/fehlend ⇒ null', async () => {
    const db = new FakeFirestore();
    expect(await claimCommands(db, 'u1')).toBeNull();
    db.seed(commandsPath('u1'), { halt: { at: ISO, reason: 'W' }, quatsch: 1 });
    expect(await claimCommands(db, 'u1')).toEqual({ halt: { at: ISO, reason: 'W' } });
    expect(db.get(commandsPath('u1'))).toBeUndefined();
    db.seed(commandsPath('u1'), { halt: { reason: 'ohne at' } });
    expect(await claimCommands(db, 'u1')).toBeNull();
    expect(db.get(commandsPath('u1'))).toBeUndefined();
    expect(commandDocFrom({ resume: { at: ISO, ack: 'nein' } })).toEqual({ resume: { at: ISO, ack: false, reason: null } });
  });
});

describe('Kommandos — Takt-Seite', () => {
  it('halt setzt den manuellen Halt; ein zweites halt ist wirkungslos', async () => {
    const t = fakeTarget();
    const j = journal();
    const r = await applyCommands(t, { halt: { at: ISO, reason: 'Wartung' } }, j, NOW);
    expect(r).toEqual([{ action: 'halt', applied: true, note: expect.stringContaining('Halt (manual) gesetzt') }]);
    expect(t.calls).toEqual(['halt:Kommando halt: Wartung']);
    const again = await applyCommands(t, { halt: { at: ISO } }, j, NOW);
    expect(again[0]).toMatchObject({ applied: false, note: expect.stringContaining('bereits gesperrt (manual)') });
    expect(j.readAll().filter((e) => e.kind === 'note' && e.command === 'halt')).toHaveLength(2);
  });

  it('resume: kein Halt ⇒ nichts; Tages-Halt ⇒ nie; Drawdown nur mit ack; manual/errors/reconcile ⇒ aufheben', async () => {
    const j = journal();
    const none = fakeTarget();
    expect((await applyCommands(none, { resume: { at: ISO } }, j, NOW))[0]).toMatchObject({ applied: false, note: expect.stringContaining('kein Halt aktiv') });
    expect(none.calls).toEqual([]);

    const daily = fakeTarget({ halted: true, reason: 'daily_loss', until: '2026-09-02' });
    expect((await applyCommands(daily, { resume: { at: ISO, ack: true } }, j, NOW))[0]).toMatchObject({ applied: false, note: expect.stringContaining('Tages-Halt') });
    expect(daily.calls).toEqual([]);

    const dd = fakeTarget({ halted: true, reason: 'drawdown' });
    expect((await applyCommands(dd, { resume: { at: ISO, ack: false } }, j, NOW))[0]).toMatchObject({ applied: false, note: expect.stringContaining('ackDrawdown') });
    expect(dd.calls).toEqual([]);
    expect((await applyCommands(dd, { resume: { at: ISO, ack: true, reason: 'geprüft' } }, j, NOW))[0]).toMatchObject({ applied: true });
    expect(dd.calls).toEqual(['resume:Kommando resume (drawdown): geprüft']);

    for (const reason of ['manual', 'errors', 'reconcile'] as const) {
      const t = fakeTarget({ halted: true, reason });
      expect((await applyCommands(t, { resume: { at: ISO } }, j, NOW))[0]).toMatchObject({ applied: true });
      expect(t.calls).toEqual([`resume:Kommando resume (${reason})`]);
    }
  });

  it('flatten ruft engine.flatten("manual"); Kommandos laufen in der Reihenfolge ihres Absetzens', async () => {
    const t = fakeTarget({ halted: true, reason: 'manual' });
    const j = journal();
    const r = await applyCommands(t, { halt: { at: '2026-09-01T14:00:02.000Z' }, flatten: { at: '2026-09-01T14:00:00.000Z' }, resume: { at: '2026-09-01T14:00:01.000Z' } }, j, NOW);
    expect(r.map((x) => x.action)).toEqual(['flatten', 'resume', 'halt']);
    expect(t.calls).toEqual(['flatten:manual', 'resume:Kommando resume (manual)', 'halt:Kommando halt']);
    expect(r.every((x) => x.applied)).toBe(true);
  });

  it('ein Fehler der Engine wird als Ergebnis gemeldet, nicht geworfen', async () => {
    const t = fakeTarget();
    t.flatten = async () => {
      throw new Error('Broker 500');
    };
    const r = await applyCommands(t, { flatten: { at: ISO } }, journal(), NOW);
    expect(r[0]).toMatchObject({ action: 'flatten', applied: false, note: 'Fehler: Broker 500' });
  });
});

describe('Kommandos — echte Engine', () => {
  it('haltFlagStat: ein manueller Halt überlebt den Tick (keine HALT-Datei nötig), resume hebt ihn auf', async () => {
    const holder: { engine: { status(): { halt: HaltState } } | null } = { engine: null };
    const sc = await startScenario({ statSync: () => haltFlagStat(holder.engine) });
    holder.engine = sc.engine;
    const j = journal();
    await applyCommands(sc.engine, { halt: { at: ISO, reason: 'Test' } }, j, sc.now());
    expect(sc.engine.status().halt).toMatchObject({ halted: true, reason: 'manual' });

    // Tick mit Entscheidungs-Bar: Halt bleibt, kein Einstieg.
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(OPEN1 + 10 * MIN + 5_000);
    expect(sc.engine.status().halt).toMatchObject({ halted: true, reason: 'manual' });
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(0);
    expect(sc.state()?.halt.reason).toBe('manual');

    const r = await applyCommands(sc.engine, { resume: { at: ISO } }, j, sc.now());
    expect(r[0]).toMatchObject({ applied: true });
    await sc.engine.tick(OPEN1 + 10 * MIN + 6_000);
    expect(sc.engine.status().halt.halted).toBe(false);
    await sc.engine.stop();
  });
});
