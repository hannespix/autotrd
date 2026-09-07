/**
 * SECREVIEW #4 — Der Backfill lädt nur ab `letzte Bar + 1 ms`
 * (data/backfill.ts backfillStart L52-56). Ein Loch in der Mitte des Caches —
 * z. B. Stream-Abriss 10:01–10:14 mit Bars ab 10:15 — wird NIE mehr geschlossen:
 * weder beim Engine-Start noch durch `autotrd fetch`. Die Engine aggregiert den
 * betroffenen Bucket aus den Rest-Minuten (falsches O/H/L), der Optimierer
 * trainiert dauerhaft auf einer Serie mit Lücke. BETRIEB §7 verspricht: „fehlende
 * Minuten seit der letzten bekannten Bar nachgeladen" — die Lücke DAVOR nicht.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import { backfill } from '../../src/data/backfill.ts';
import { BarStore } from '../../src/data/store.ts';
import { OPEN1, minuteBars } from '../fakes/harness.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';

describe('secreview: Backfill heilt Lücken im Cache nicht', () => {
  it('Cache hat 10:00 und 10:15, Broker kennt alle Minuten ⇒ nach backfill müssen 10:01–10:14 im Cache sein', async () => {
    const store = new BarStore(mkdtempSync(join(tmpdir(), 'secreview-bars-')));
    const t0 = OPEN1 + 30 * MIN; // 10:00 ET
    const all = minuteBars(t0, Array.from({ length: 21 }, (_, i) => 100 + i / 100)); // 10:00 … 10:20
    store.save('AAPL', '1Min', [all[0]!, all[15]!]); // Loch 10:01–10:14 (Stream-Abriss)

    const fake = new FakeAlpaca();
    fake.bars.set('AAPL', all);
    await backfill({ client: fake, store, symbols: ['AAPL'], tf: '1Min', from: t0, to: t0 + 20 * MIN, feed: 'iex' });

    const times = store.load('AAPL', '1Min').map((b) => b.t);
    const requestedFrom = Math.min(...fake.barRequests.map((r) => r.start));
    expect(requestedFrom, 'Backfill fragt erst ab letzter Bar + 1 ms — die Lücke davor wird nie angefordert').toBeLessThanOrEqual(t0 + MIN);
    expect(times, 'Minute 10:05 fehlt dauerhaft im Cache').toContain(t0 + 5 * MIN);
    expect(times).toHaveLength(21);
  });
});
