/**
 * Der Bericht eines Laufs, der NICHTS gemessen hat, muss überleben.
 *
 * `optimize` beendet sich mit Code 3, wenn keine Einheit bewertbar war
 * (test/optimize/nichtsGemessen.test.ts). Damit wird der Workflow rot — gut.
 * Aber ein roter Schritt überspringt alles danach, und darunter läge auch das
 * Artefakt mit dem Bericht. Genau der Lauf, den man lesen MUSS, hätte dann
 * keinen. Deshalb trägt der Artefakt-Schritt `always()`.
 *
 * Die Gegenrichtung ist genauso wichtig: Die Veröffentlichungs-Schritte nach
 * Firestore dürfen dieses `always()` NICHT tragen. Aus einem Lauf ohne
 * Messung darf nichts auf die Plattform — auch nicht ein unveränderter
 * Champion mit frischem Zeitstempel.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Step {
  name?: string;
  if?: string | boolean;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
}

const steps = (pfad: string, job: string): Step[] => {
  const wf = parseYaml(readFileSync(pfad, 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
  const j = wf.jobs[job];
  if (!j) throw new Error(`Job ${job} fehlt in ${pfad}`);
  return j.steps;
};
const schritt = (s: Step[], name: string): Step => {
  const st = s.find((x) => x.name === name);
  if (!st) throw new Error(`Schritt „${name}" fehlt`);
  return st;
};

const WORKFLOWS: [string, string][] = [
  ['.github/workflows/probe.yml', 'probe'],
  ['.github/workflows/optimize.yml', 'optimize'],
];

describe.each(WORKFLOWS)('%s', (pfad, job) => {
  const s = steps(pfad, job);

  it('lädt den Bericht auch hoch, wenn der Optimierer rot war', () => {
    const art = schritt(s, 'Bericht als Artefakt');
    expect(art.uses).toMatch(/upload-artifact/);
    expect(String(art.if)).toMatch(/always\(\)/);
    // Fehlende Dateien (Abbruch vor dem Bericht) machen den Upload nicht rot —
    // dann meldet schon der Optimierer-Schritt den Fehler.
    expect(art.with?.['if-no-files-found']).toBe('warn');
  });

  it('lässt den Rückgabecode von `optimize` durch — nichts schluckt ihn', () => {
    const opt = schritt(s, 'Walk-Forward-Optimierung');
    expect(opt.run).toMatch(/src\/cli\.ts optimize/);
    expect(opt['continue-on-error']).toBeUndefined();
    expect(opt.run).not.toMatch(/\|\|\s*true/);
    expect(opt.run).not.toMatch(/set \+e/);
  });
});

describe('.github/workflows/optimize.yml: Veröffentlichung NICHT unter always()', () => {
  const s = steps('.github/workflows/optimize.yml', 'optimize');

  it.each(['Champion und Bericht nach Firestore', 'Plattform-Config nach Firestore'])('„%s" läuft nur nach Erfolg', (name) => {
    const st = schritt(s, name);
    expect(String(st.if)).not.toMatch(/always\(\)/);
    expect(String(st.if)).not.toMatch(/failure\(\)/);
  });
});
