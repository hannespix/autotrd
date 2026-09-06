/**
 * SECREVIEW2 #10 — `firestore.rules` L15-18: `match /meta/{doc=**} { allow read: if true }` — ohne Anmeldung.
 * `core/brokerBindung.ts` L136 schreibt nach `meta/brokerBindungen` je Depot-Fingerabdruck
 * `{ uid, at, mode }`: Jeder Unangemeldete kann damit die uids aller Nutzer mit verbundenem Broker
 * samt Modus (paper/live!) auflisten. Dasselbe `meta/**`-Muster trägt seit dem Engine-Takt auch
 * `meta/health.engine.failed[].error` (Fehlertexte je Nutzer) und die Lease.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(hier, '../../../firestore.rules'), 'utf8');
const bindung = readFileSync(join(hier, '../../src/core/brokerBindung.ts'), 'utf8');

describe('secreview2: Nutzerdaten unter dem öffentlichen meta/**', () => {
  it('meta/brokerBindungen trägt uids — dann darf meta/** nicht pauschal öffentlich lesbar sein', () => {
    const schreibtUid = /meta\/brokerBindungen/.test(bindung) && /\{\s*uid,\s*at:/.test(bindung);
    expect(schreibtUid).toBe(true);
    const pauschalOeffentlich = /match \/meta\/\{doc=\*\*\}\s*\{\s*allow read: if true;/.test(rules);
    const eigeneRegel = /match \/meta\/brokerBindungen/.test(rules);
    expect(pauschalOeffentlich && !eigeneRegel, 'uids aller Broker-Nutzer sind ohne Anmeldung lesbar').toBe(false);
  });
});
