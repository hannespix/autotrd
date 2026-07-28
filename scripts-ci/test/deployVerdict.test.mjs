/**
 * Deploy-Verdikt: Welcher Log-Text führt zu welchem Ausgang?
 *
 * Diese Unterscheidung ist sicherheitsrelevant für den Betrieb, und zwar in
 * BEIDE Richtungen. Wird ein echter Fehler als „transient" eingestuft,
 * wiederholt die CI dreimal denselben kaputten Deploy und meldet am Ende
 * einen irreführenden Grund. Wird umgekehrt ein Google-Aussetzer als hart
 * gewertet, bleibt ein fertiger Deploy liegen — genau das passierte am
 * 27.07. (#104): HTTP 503 von serviceusage.googleapis, und der komplette
 * Auto-Tuner ging deswegen nicht live.
 *
 * Die Log-Ausschnitte unten sind ECHT, nicht erfunden — aus den Actions-Logs
 * dieses Projekts. Erfundene Fehlertexte hätten den 503 nie gefangen, weil
 * er nicht als „- Error"-Zeile kommt, sondern als nacktes „Error:".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SKRIPT = fileURLToPath(new URL('../deploy-verdict.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'verdict-'));

/** Führt das Verdikt auf einem Log aus und liefert nur den Exit-Code. */
function verdikt(name, inhalt) {
  const pfad = join(dir, `${name}.log`);
  writeFileSync(pfad, inhalt, 'utf8');
  try {
    execFileSync(process.execPath, [SKRIPT, pfad], { stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status;
  }
}

describe('deploy-verdict', () => {
  it('wiederholt bei einem 503 der GCP-Steuerungs-APIs (Deploy #104)', () => {
    const log = [
      'i  firestore: deploying indexes...',
      '✔  firestore: deployed indexes in firestore.indexes.json successfully',
      '',
      'Error: Request to https://serviceusage.googleapis.com/v1/projects/autotrd-653b0/services/' +
        'cloudbilling.googleapis.com had HTTP Error: 503, The service is currently unavailable.',
    ].join('\n');
    expect(verdikt('t503', log)).toBe(2);
  });

  it('toleriert den Schedule-Upsert, solange die Scheduler-Rolle fehlt', () => {
    const log = [
      'Functions deploy had errors with the following functions:',
      '- Error Failed to upsert schedule function scanMarket in region us-central1',
    ].join('\n');
    expect(verdikt('tsched', log)).toBe(0);
  });

  it('bleibt bei einem echten Funktions-Fehler hart rot', () => {
    const log = '- Error Failed to update function trade in region us-central1';
    expect(verdikt('thard', log)).toBe(1);
  });

  it('lässt einen transienten Fehler den tolerierbaren überstimmen', () => {
    // Sonst würde der Job grün, obwohl der Code wegen des 502 gar nicht live
    // ist — die gefährlichste der drei Verwechslungen.
    const log = [
      '- Error Failed to upsert schedule function autoTune in region us-central1',
      '- Error Request had HTTP Error: 502, Bad Gateway',
    ].join('\n');
    expect(verdikt('tmix', log)).toBe(2);
  });

  it('behandelt einen 4xx NICHT als transient', () => {
    // 400/403 heißt „so wie du fragst, geht es nie" — wiederholen ändert
    // daran nichts und verschleiert nur die Ursache.
    expect(verdikt('t400', 'Error: HTTP Error: 400, Precondition check failed.')).toBe(1);
    expect(verdikt('t403', '- Error HTTP Error: 403, Permission denied')).toBe(1);
  });

  it('bleibt rot, wenn im Log gar kein erkennbarer Fehler steht', () => {
    expect(verdikt('tleer', 'i  functions: preparing codebase default\n')).toBe(1);
  });
});
