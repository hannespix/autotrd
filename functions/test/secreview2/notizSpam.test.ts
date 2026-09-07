/**
 * SECREVIEW2 #4 — tick.ts L492 schreibt `p.strategy.notes` (z. B. „kein Champion …",
 * „AAPL: Champion-Zeitrahmen 15 ≠ Config 5") als 'note'-Ereignis in JEDEM Takt ins Journal;
 * `keepEvent` (journal.ts L44) filtert nur start/stop/summary/„Halt aktiv". Ergebnis: je Notiz und
 * Nutzer ein Firestore-Dokument pro Minute — 390 Docs/Handelstag für die Information „nichts
 * passiert", genau das Rauschen, das der Modulkopf von journal.ts ausschließen will.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { T1, welt, type Welt } from './_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: Strategie-Notizen als Takt-Rauschen', () => {
  it('drei Takte ohne Champion erzeugen höchstens EIN „kein Champion"-Dokument', async () => {
    const w = welt({ champion: false });
    welten.push(w);
    await w.run(T1);
    await w.run(T1 + 60_000);
    await w.run(T1 + 120_000);
    const notizen = w.db.list('users/u1/journal').filter((d) => String(d.data.text ?? '').includes('kein Champion'));
    expect(notizen.length, 'dieselbe Notiz landet in jedem Takt erneut in Firestore').toBeLessThanOrEqual(1);
  });
});
