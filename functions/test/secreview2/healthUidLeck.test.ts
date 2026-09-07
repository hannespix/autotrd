/**
 * SECREVIEW2 #1 — `meta/health` ist öffentlich lesbar (firestore.rules: match /meta/{doc=**} allow read: if true).
 * tick.ts L115 verspricht: „dort stehen keine uids, nur ein kurzer Hash". Der Fehlertext je gescheitertem
 * Nutzer wird aber ungefiltert übernommen (tick.ts L255 `failed: … error: f.error`) — und
 * `FirestoreStateStore.load()` (state.ts L34) baut die volle Doc-Pfadangabe `users/<uid>/private/engineState`
 * in seine Fehlermeldung. Ergebnis: Die Klartext-uid steht neben ihrem Hash im öffentlichen Health-Doc.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_PATH } from '../../src/engine/tick.ts';
import { engineStatePath, T1, welt, type Welt } from './_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: uid im öffentlichen meta/health', () => {
  it('ein unlesbares State-Doc darf die Klartext-uid nicht ins öffentliche Health-Doc tragen', async () => {
    const w = welt();
    welten.push(w);
    // Fremdes/altes State-Doc (falsche Version) — fail-closed ist richtig, der Fehlertext nicht.
    w.db.seed(engineStatePath('u1'), { version: 2, mode: 'paper' });
    const r = await w.run(T1);
    expect(r.failed.map((f) => f.uid)).toEqual(['u1']);

    const health = JSON.stringify(w.db.get(HEALTH_PATH));
    expect(health, 'meta/health (public) enthält die Klartext-uid im Fehlertext').not.toContain('users/u1/');
    expect(health).not.toMatch(/"u1"/);
  });
});
