import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaError } from '../../src/alpaca/types.ts';
import { setLogSink } from '../../src/core/log.ts';
import { DAY, MIN } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { BACKFILL_MAX_SPAN_MS, backfill, backfillStart, splitSpan } from '../../src/data/backfill.ts';
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
    expect(fake.barRequests).toHaveLength(1);
    expect(fake.barRequests[0]?.start).toBe(T0 + MIN + 1);
    expect(fake.barRequests[0]?.end).toBe(T0 + 3 * MIN);
    expect(fake.barRequests[0]?.feed).toBe('iex');
    expect(res.get('AAPL')?.map((b) => b.c)).toEqual([100, 100, 5, 6]);
    expect(s.lastTime('AAPL', '1Min')).toBe(T0 + 3 * MIN);
  });

  it('Tagesbars: lädt die letzte Bar erneut (der laufende Tag kann unfertig sein)', () => {
    const s = store();
    s.upsert('AAPL', '1Day', [bar(T0)]);
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

  it('überspringt Symbole ohne Nachladebedarf und macht bei Fehlern je Block weiter', async () => {
    const s = store();
    const fake = new FakeAlpaca();
    s.upsert('AAPL', '1Min', [bar(T0)]);
    fake.bars.set('MSFT', [bar(T0 - MIN, 7)]);
    fake.throwOn('getBars', new AlpacaError('boom', 500, null, true), 1);
    const logs: string[] = [];
    const res = await backfill({ client: fake, store: s, symbols: ['AAPL', 'MSFT'], tf: '1Min', from: T0 - 2 * MIN, to: T0, feed: 'iex', log: (m) => logs.push(m) });
    // AAPL: lastTime = to ⇒ start > to ⇒ keine Anfrage. MSFT: erste Anfrage scheitert ⇒ geloggt, Ergebnis leer, kein Wurf.
    expect(fake.barRequests.map((r) => r.symbols)).toEqual([['MSFT']]);
    expect(logs.some((l) => l.includes('fehlgeschlagen'))).toBe(true);
    expect(res.get('AAPL')).toHaveLength(1);
    expect(res.get('MSFT')).toEqual([]);
  });
});
