import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaError } from '../../src/alpaca/types.ts';
import { setLogSink } from '../../src/core/log.ts';
import { ensureCalendar, loadCalendarFile, saveCalendarFile } from '../../src/data/calendar.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';

setLogSink(() => undefined);

const NOW = Date.UTC(2026, 8, 1, 14, 0);
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ date: `2026-09-${String(from + i).padStart(2, '0')}`, open: '09:30', close: '16:00' }));

function path(): string {
  return join(mkdtempSync(join(tmpdir(), 'autotrd-cal-')), 'calendar.json');
}

describe('Kalender-Datei', () => {
  it('speichert und lädt als Map date → CalendarDay; fehlende/kaputte Datei ⇒ null', () => {
    const p = path();
    expect(loadCalendarFile(p)).toBeNull();
    saveCalendarFile(p, [days(2, 2)[0]!, days(1, 1)[0]!]);
    const cal = loadCalendarFile(p);
    expect([...cal!.keys()]).toEqual(['2026-09-01', '2026-09-02']);
    expect(cal!.get('2026-09-01')).toEqual({ date: '2026-09-01', open: '09:30', close: '16:00' });
    writeFileSync(p, 'nicht json');
    expect(loadCalendarFile(p)).toBeNull();
  });

  it('ensureCalendar lädt nach, wenn die Datei fehlt oder zu früh endet, und nutzt sie sonst ohne Broker-Aufruf', async () => {
    const p = path();
    const fake = new FakeAlpaca();
    fake.calendarDays = days(1, 30);
    const cal = await ensureCalendar(fake, p, '2026-09-01', '2026-09-10', NOW);
    expect(cal.size).toBe(10);
    expect(fake.callsOf('getCalendar')).toHaveLength(1);
    // Bereich gedeckt ⇒ kein zweiter Aufruf.
    await ensureCalendar(fake, p, '2026-09-02', '2026-09-09', NOW);
    expect(fake.callsOf('getCalendar')).toHaveLength(1);
    // Ende < toDay ⇒ nachladen und zusammenführen.
    const more = await ensureCalendar(fake, p, '2026-09-01', '2026-09-20', NOW);
    expect(more.size).toBe(20);
    expect(fake.callsOf('getCalendar')).toHaveLength(2);
    expect(loadCalendarFile(p)?.size).toBe(20);
  });

  it('zieht den Bereich bis heute und liefert bei Broker-Fehler den vorhandenen Stand (oder eine leere Map)', async () => {
    const p = path();
    const fake = new FakeAlpaca();
    fake.calendarDays = days(1, 30);
    await ensureCalendar(fake, p, '2026-08-20', '2026-08-25', NOW);
    expect(fake.callsOf('getCalendar')[0]?.args[1]).toBe('2026-09-01');
    fake.throwOn('getCalendar', new AlpacaError('down', 503, null, true));
    const kept = await ensureCalendar(fake, p, '2026-08-20', '2026-09-30', NOW);
    expect(kept.size).toBe(1);
    const empty = await ensureCalendar(fake, path(), '2026-08-20', '2026-09-30', NOW);
    expect(empty.size).toBe(0);
  });
});
