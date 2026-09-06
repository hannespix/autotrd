/**
 * SECREVIEW3 — M9: `Engine.start()` prüft ZUERST den Modus (engine.ts L255-257, gewöhnlicher `Error`) und erst
 * danach die Konto-ID (L261-263, `StateAccountMismatchError`). Der Takt archiviert nur bei
 * `StateAccountMismatchError` (tick.ts runUser). Wechselt ein Nutzer von Paper (PK) auf Live (AK), stimmt
 * weder Modus noch Konto — der Modus-Fehler gewinnt, es wird nichts archiviert, und der Nutzer scheitert in
 * JEDEM Takt („gehört zum Modus …"): keine Exits, kein Abgleich. Genau der Fall (b) aus Secreview 2 #13.
 *
 * `connectBroker` archiviert zwar beim Verbinden — aber „nicht fatal" (connectBroker.ts L73-79) und im
 * Rennen mit einem laufenden Takt, dessen `saveState()` das alte Doc danach wieder anlegt. Der Takt-Fallback
 * („der Takt holt es nach") existiert für den Moduswechsel nicht.
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { engineStatePath } from '../../src/engine/state.ts';
import { stateMitPosition, T1, welt, type Welt } from '../secreview2/_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview3: Moduswechsel Paper ⇒ Live ohne Archiv', () => {
  it('alter Paper-State eines anderen Kontos + Live-Schlüssel ⇒ Takt muss archivieren, statt jeden Takt am Modus zu scheitern', async () => {
    const w = welt({ verriegelt: ['u1'] }); // u1: AK-Schlüssel ⇒ mode 'live' (verriegelt, Einstiegs-Sperre)
    welten.push(w);
    w.db.seed(engineStatePath('u1'), { ...stateMitPosition({}, 'paper'), accountId: 'konto-alt' });

    const r1 = await w.run(T1);
    expect(r1.failed.map((f) => f.error), 'Modus-Fehler statt Archiv — der Nutzer scheitert in jedem Takt, Exits laufen nicht').toEqual([expect.stringContaining('archiviert')]);
    expect(w.db.get(engineStatePath('u1'))).toBeUndefined();
    expect(w.db.list('users/u1/private/archiv/engineStates')).toHaveLength(1);

    const r2 = await w.run(T1 + 60_000);
    expect(r2.ok, 'auch der Folgetakt scheitert').toBe(1);
    expect((w.db.get(engineStatePath('u1')) as { mode?: string } | undefined)?.mode).toBe('live');
  });
});
