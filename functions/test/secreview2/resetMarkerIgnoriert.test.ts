/**
 * SECREVIEW2 #11 — `resetWallet` setzt `risk.resetLaeuftSeit` und verlässt sich darauf, dass der Takt
 * ihn über die Konto-Tore prüft (reset.ts L242-255: „Der Takt prüft den Marker über die Konto-Tore
 * (kontoTore.handel === 'reset_laeuft')"). Der neue Takt importiert `kontoTore` nicht und liest den
 * Marker nirgends (tick.ts): Während `archiviereTrades`/`recursiveDelete` laufen, sendet die Engine
 * weiter Orders, schreibt Trade-Docs hinter den Archiv-Schnitt und überschreibt am Ende
 * `wallet.paperBalance`, das der Reset gerade gesetzt hat.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { iso, T1, welt, type Welt } from './_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: Reset-Marker sperrt den Takt nicht', () => {
  it('risk.resetLaeuftSeit vor 1 min ⇒ der Takt darf für diesen Nutzer keine Order senden', async () => {
    const w = welt();
    welten.push(w);
    await w.db.doc('users/u1').set({ risk: { resetLaeuftSeit: iso(T1 - 60_000) } }, { merge: true });
    const r = await w.run(T1);
    expect(w.trading.callsOf('submitOrder').length, 'Order während eines laufenden Resets gesendet').toBe(0);
    expect(r.skippedUsers.map((s) => s.uid)).toContain('u1');
  });
});
