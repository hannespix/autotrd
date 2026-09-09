import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaError } from '../../src/alpaca/types.ts';
import { setLogSink } from '../../src/core/log.ts';
import { DAY, MIN, msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { BACKFILL_MAX_SPAN_MS, backfill, backfillStart, findGaps, splitSpan } from '../../src/data/backfill.ts';
import { BarStore } from '../../src/data/store.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';

setLogSink(() => undefined);

const T0 = Date.UTC(2026, 8, 1, 13, 30);
const bar = (t: number, c = 100): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1 });

function store(): BarStore {
  return new BarStore(mkdtempSync(join(tmpdir(), 'autotrd-backfill-')));
}

describe('backfill', () => {
  it('lädt inkrementell ab lastTime + 1 (Minutenbars) und gibt den Gesamtstand ab `from` zurück', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    s.upsert('AAPL', '1Min', [bar(T0), bar(T0 + MIN)]);
    fake.bars.set('AAPL', [bar(T0 - MIN, 1), bar(T0), bar(T0 + MIN), bar(T0 + 2 * MIN, 5), bar(T0 + 3 * MIN, 6)]);
    const res = await backfill({ client: fake, store: s, symbols: ['AAPL'], tf: '1Min', from: T0 - DAY, to: T0 + 3 * MIN, feed: 'iex' });
    // ZWEI Anfragen: der Rückstand vor dem Cache (from … erste Bar) und der
    // inkrementelle Teil dahinter. Die erste fehlte bis zum 09.09.2026 — ein
    // gefüllter Cache konnte deshalb nie nach hinten wachsen.
    expect(fake.barRequests).toHaveLength(2);
    const rueck = fake.barRequests[0];
    expect(rueck?.start).toBe(T0 - DAY);
    expect(rueck?.end).toBe(T0);
    const vor = fake.barRequests[1];
    expect(vor?.start).toBe(T0 + MIN + 1);
    expect(vor?.end).toBe(T0 + 3 * MIN);
    expect(vor?.feed).toBe('iex');
    // Die Bar VOR dem Cache ist jetzt dabei (c = 1) — genau die, die der
    // reine Vorwärtslauf nie geholt hätte.
    expect(res.get('AAPL')?.map((b) => b.c)).toEqual([1, 100, 100, 5, 6]);
    expect(s.lastTime('AAPL', '1Min')).toBe(T0 + 3 * MIN);
  });

  it('Tagesbars: lädt die letzte Bar erneut (der laufende Tag kann unfertig sein)', () => {
    const s = store();
    s.upsert('AAPL', '1Day', [bar(T0)]);
    s.upsert('AAPL', '1Min', [bar(T0)]);
    expect(backfillStart(s, 'AAPL', '1Day', T0 - DAY)).toBe(T0);
    expect(backfillStart(s, 'AAPL', '1Min', T0 - DAY)).toBe(T0 + 1);
    expect(backfillStart(s, 'MSFT', '1Min', T0 - DAY)).toBe(T0 - DAY);
  });

  it('zerlegt Minuten-Anfragen in Blöcke von höchstens 30 Tagen und 50 Symbolen', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    const symbols = Array.from({ length: 60 }, (_, i) => `S${i}`);
    const from = T0 - 70 * DAY;
    await backfill({ client: fake, store: s, symbols, tf: '1Min', from, to: T0, feed: 'sip' });
    // 2 Symbolgruppen (50 + 10) × 3 Zeitfenster (70 Tage / 30)
    expect(fake.barRequests).toHaveLength(6);
    for (const r of fake.barRequests) {
      expect(r.symbols.length).toBeLessThanOrEqual(50);
      expect((r.end ?? 0) - r.start).toBeLessThan(BACKFILL_MAX_SPAN_MS);
    }
    expect(splitSpan(0, 3 * BACKFILL_MAX_SPAN_MS - 1, BACKFILL_MAX_SPAN_MS)).toHaveLength(3);
    expect(splitSpan(0, 0, BACKFILL_MAX_SPAN_MS)).toEqual([{ start: 0, end: 0 }]);
  });

  it('Tagesbars: ein Fenster für den ganzen Bereich', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    await backfill({ client: fake, store: s, symbols: ['AAPL'], tf: '1Day', from: T0 - 400 * DAY, to: T0, feed: 'iex' });
    expect(fake.barRequests).toHaveLength(1);
    expect(fake.barRequests[0]?.timeframe).toBe('1Day');
  });

  it('heilt Lücken innerhalb der Sitzung genau einmal (Marker) und hält das Budget je Lauf ein', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    const open = msFromET(2026, 9, 1, 10, 0);
    s.save('AAPL', '1Min', [bar(open), bar(open + 15 * MIN), bar(open + 30 * MIN)]); // zwei Löcher: 10:01–10:14, 10:16–10:29
    const args = { client: fake, store: s, symbols: ['AAPL'], tf: '1Min' as const, from: open, to: open + 30 * MIN, feed: 'iex' as const, maxGapRanges: 1 };
    await backfill(args);
    expect(fake.barRequests.map((r) => [r.start, r.end])).toEqual([[open + MIN, open + 14 * MIN]]);
    expect(s.gapMarks('AAPL', '1Min').has(`${open + MIN}-${open + 14 * MIN}`)).toBe(true);
    await backfill(args);
    expect(fake.barRequests).toHaveLength(2);
    expect(fake.barRequests[1]).toMatchObject({ start: open + 16 * MIN, end: open + 29 * MIN });
    await backfill(args);
    expect(fake.barRequests).toHaveLength(2); // beide Lücken geprüft (IEX ohne Trades) — nie wieder angefordert
    expect(s.load('AAPL', '1Min')).toHaveLength(3);
  });

  it('exact: lädt genau [from, to], unabhängig vom Cache-Stand (Reconnect-Nachlauf)', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    const open = msFromET(2026, 9, 1, 10, 0);
    s.save('AAPL', '1Min', [bar(open), bar(open + 20 * MIN)]);
    fake.bars.set('AAPL', Array.from({ length: 21 }, (_, i) => bar(open + i * MIN, 50 + i)));
    const res = await backfill({ client: fake, store: s, symbols: ['AAPL'], tf: '1Min', from: open + 5 * MIN, to: open + 20 * MIN, feed: 'iex', exact: true, maxGapRanges: 0 });
    expect(fake.barRequests[0]).toMatchObject({ start: open + 5 * MIN, end: open + 20 * MIN });
    expect(res.get('AAPL')?.map((b) => b.c)).toEqual(Array.from({ length: 16 }, (_, i) => 55 + i));
  });

  it('findGaps: Sitzungsrand und Tageswechsel sind keine Lücken, eine fehlende Minute auch nicht', () => {
    const open = msFromET(2026, 9, 1, 9, 30);
    const nextOpen = msFromET(2026, 9, 2, 9, 30);
    const bars = [bar(open - 5 * MIN), bar(open), bar(open + 2 * MIN), bar(open + 6 * MIN), bar(nextOpen)];
    expect(findGaps(bars, open - DAY, nextOpen + DAY, 'us_equity')).toEqual([{ start: open + 3 * MIN, end: open + 5 * MIN }]);
    expect(findGaps(bars, open + 4 * MIN, nextOpen + DAY, 'us_equity')).toEqual([]);
  });

  /*
   * Der Fall, der am 09.09.2026 einen Produktivlauf gekostet hat: Die
   * Plattform ging von 5-Minuten- auf Tagesbars. Im Cache lagen nur die ~130
   * Tage Tagesbars, die die Universumswahl für ihr Umsatzfenster lädt.
   * `fetch` verlangte 1400 Tage — und holte NICHTS nach, weil der Backfill
   * nur ab der letzten Bar vorwärts lief. Der Optimierer fand 127 statt der
   * nötigen 815 Tage und meldete für jede Strategie „nicht bewertbar", bei
   * grünem Workflow. Ein Loch, das sich als Erfolg meldet.
   */
  it('ein tieferes `from` wächst den Cache nach HINTEN — sonst bliebe lookbackDays wirkungslos', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    // Cache: nur die jüngsten drei Tage (wie nach der Universumswahl).
    s.upsert('AAPL', '1Day', [bar(T0 - 2 * DAY), bar(T0 - DAY), bar(T0)]);
    // Broker hat zehn Tage.
    fake.bars.set('AAPL', Array.from({ length: 10 }, (_, i) => bar(T0 - (9 - i) * DAY, 50 + i)));
    const res = await backfill({ client: fake, store: s, symbols: ['AAPL'], tf: '1Day', from: T0 - 9 * DAY, to: T0, feed: 'iex' });
    const rueck = fake.barRequests.find((r) => r.start === T0 - 9 * DAY);
    expect(rueck, 'keine Rückstands-Anfrage gestellt').toBeDefined();
    expect(rueck?.end).toBe(T0 - 2 * DAY); // bis zur ersten bekannten Bar
    // Entscheidend ist nicht die Anfrage, sondern das Ergebnis: Der Cache
    // reicht jetzt wirklich bis `from` zurück.
    expect(s.firstTime('AAPL', '1Day')).toBe(T0 - 9 * DAY);
    expect(res.get('AAPL')).toHaveLength(10);
  });

  it('reicht der Cache schon weit genug zurück, wird KEINE Rückstands-Anfrage gestellt', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    s.upsert('AAPL', '1Day', [bar(T0 - 5 * DAY), bar(T0)]);
    fake.bars.set('AAPL', [bar(T0)]);
    await backfill({ client: fake, store: s, symbols: ['AAPL'], tf: '1Day', from: T0 - 3 * DAY, to: T0, feed: 'iex' });
    // `from` liegt INNERHALB des Caches — ein Abruf davor wäre reine Last.
    expect(fake.barRequests.every((r) => r.start >= T0 - 3 * DAY)).toBe(true);
  });

  it('überspringt Symbole ohne Nachladebedarf und macht bei Fehlern je Block weiter', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    s.upsert('AAPL', '1Min', [bar(T0)]);
    fake.bars.set('MSFT', [bar(T0 - MIN, 7)]);
    fake.throwOn('getBars', new AlpacaError('boom', 500, null, true), 1);
    const logs: string[] = [];
    const res = await backfill({ client: fake, store: s, symbols: ['AAPL', 'MSFT'], tf: '1Min', from: T0 - 2 * MIN, to: T0, feed: 'iex', log: (m) => logs.push(m) });
    // AAPL: lastTime = to ⇒ vorwärts nichts mehr, aber `from` liegt VOR der
    // ersten Bar ⇒ Rückstands-Anfrage. MSFT: hat gar keine Bars ⇒ der
    // Vorwärtslauf holt alles; seine erste Anfrage scheitert ⇒ geloggt,
    // Ergebnis leer, kein Wurf.
    expect(fake.callsOf('getBars').map((c) => (c.args[0] as { symbols: string[] }).symbols)).toEqual([['AAPL'], ['MSFT']]);
    // Der eingebaute Fehler trifft die erste Anfrage — das ist jetzt AAPLs
    // Rückstand. Entscheidend bleibt: Ein gescheiterter Block hält die
    // anderen nicht auf, MSFT bekommt seine Bar trotzdem.
    expect(logs.some((l) => l.includes('fehlgeschlagen'))).toBe(true);
    expect(res.get('AAPL')).toHaveLength(1);
    expect(res.get('MSFT')?.map((b) => b.c)).toEqual([7]);
  });
});
