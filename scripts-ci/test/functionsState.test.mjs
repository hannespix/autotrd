/**
 * Functions-Zustands-Check: „Deploy complete!" ist kein Beleg, dass der Code
 * läuft.
 *
 * Der Befund vom 13.08.: Ein Google-seitig abgebrochener Deploy (Cloud Builds
 * CANCELLED) hinterließ neue Quell-Hash-Metadaten auf allen 37 Functions. Der
 * nächste Deploy verglich Hashes, übersprang ALLE Functions („Skipped — No
 * changes detected") und wurde grün — produktiv lief weiter der alte Stand.
 * Der Zustands-Check fragt deshalb die GCF-API: Eine Function, deren letzter
 * Rollout scheiterte, steht dort nicht auf ACTIVE.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { bewerteFunktionsZustaende } from '../check-functions-state.mjs';

const hier = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(hier, '../../.github/workflows/deploy-functions.yml'), 'utf8');
const gitignore = readFileSync(join(hier, '../../.gitignore'), 'utf8');

describe('bewerteFunktionsZustaende — die pure Bewertung', () => {
  it('alle ACTIVE ⇒ nichts kaputt', () => {
    const fns = [
      { name: 'projects/p/locations/us-central1/functions/healthz', state: 'ACTIVE' },
      { name: 'projects/p/locations/us-central1/functions/trade', state: 'ACTIVE' },
    ];
    expect(bewerteFunktionsZustaende(fns)).toEqual({ gesamt: 2, kaputt: [] });
  });

  it('FAILED wird mit Kurzname und Meldung gemeldet', () => {
    const fns = [
      { name: 'projects/p/locations/us-central1/functions/healthz', state: 'ACTIVE' },
      {
        name: 'projects/p/locations/us-central1/functions/scanMarket',
        state: 'FAILED',
        stateMessages: [{ severity: 'ERROR', message: 'Build failed' }, { message: 'siehe Logs' }],
      },
    ];
    const { gesamt, kaputt } = bewerteFunktionsZustaende(fns);
    expect(gesamt).toBe(2);
    expect(kaputt).toEqual([{ name: 'scanMarket', state: 'FAILED', meldung: 'Build failed | siehe Logs' }]);
  });

  it('fehlender oder leerer Zustand ist KEIN Beleg fürs Laufen ⇒ kaputt', () => {
    const { kaputt } = bewerteFunktionsZustaende([
      { name: 'projects/p/locations/us-central1/functions/wachhund' },
      { name: 'projects/p/locations/us-central1/functions/riskPulse', state: '' },
    ]);
    expect(kaputt.map((k) => k.state)).toEqual(['UNBEKANNT', 'UNBEKANNT']);
  });

  it('defensiv gegen kaputte API-Antworten (kein Array, kaputte Einträge)', () => {
    expect(bewerteFunktionsZustaende(undefined)).toEqual({ gesamt: 0, kaputt: [] });
    const { kaputt } = bewerteFunktionsZustaende([{}]);
    expect(kaputt).toEqual([{ name: '(unbenannt)', state: 'UNBEKANNT', meldung: '' }]);
  });
});

describe('Verdrahtung (Quelltext-Wächter)', () => {
  it('der Workflow prüft den Zustand nach dem Deploy UND nach der Heilung', () => {
    // Zweimal: einmal als Auslöser, einmal als Beleg, dass die Heilung wirkte.
    // Nur der zweite Aufruf macht aus „wir haben es nochmal versucht" ein
    // „der Code läuft jetzt wirklich".
    const aufrufe = workflow.match(/check-functions-state\.mjs/g) ?? [];
    expect(aufrufe.length).toBe(2);
  });

  it('die Heilung erzwingt den Rollout über die Stempel-Datei im Functions-Paket', () => {
    // Ohne Stempel wäre der Heilungs-Deploy derselbe Tarball-Hash — und würde
    // exakt wie der Auslöser wieder alles überspringen.
    expect(workflow).toContain('> functions/deploy-stamp.txt');
    expect(workflow).toContain('npx firebase-tools deploy --only functions --non-interactive --force');
  });

  it('auch der Heilungs-Deploy geht durchs Verdikt (transient ⇒ Retry, hart ⇒ rot)', () => {
    const verdikte = workflow.match(/deploy-verdict\.mjs/g) ?? [];
    expect(verdikte.length).toBe(2);
  });

  it('die Stempel-Datei ist git-ignoriert (CI-Artefakt, nie committen)', () => {
    expect(gitignore).toContain('functions/deploy-stamp.txt');
  });
});
