/**
 * Wächter: Die KI-Stimme (Slice 1, 25.08.) darf NICHTS am Handel ändern.
 *
 * Das ist keine Nebenbedingung, sondern der ganze Punkt (Begründung in
 * `shared/src/kiStimme.ts`): Eine Stimme ohne Beweislast darf keine
 * Entscheidungsquelle sein. Zwei Eigenschaften lassen sich nicht per
 * Unit-Test auf der reinen Funktion prüfen, weil sie über die GANZE
 * Trading-Schicht gehen — deshalb Quelltext-Wächter, dieselbe Begründung
 * wie bei `k2Loop.test.ts`.
 *
 *   1. Kein Trading-Pfad liest `aiVoteShadow` — sonst wäre die Stimme
 *      keine Messung mehr, sondern eine zweite Entscheidungsquelle ohne
 *      Evidenzpflicht (genau das, wogegen der Auto-Tuner gebaut ist).
 *   2. `erhebeKiStimme` liest ausschließlich `meta/momentum` und
 *      `meta/health` — kein Nutzertext, keine News, nichts aus dem Netz.
 *      Das ist die einzige belastbare Art, den Prompt gegen eingeschleuste
 *      Anweisungen zu schützen (dieselbe Begründung wie bei `kiBericht.ts`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const kiStimme = lies('scheduled', 'kiStimme.ts');

describe('kiStimme liest ausschließlich eigene, selbst berechnete Zahlen', () => {
  it('nur meta/momentum und meta/health werden gelesen', () => {
    const fn = kiStimme.slice(
      kiStimme.indexOf('export async function erhebeKiStimme'),
      kiStimme.indexOf('const e = entscheideKiStimmeLauf'),
    );
    expect(fn).toContain("db.doc('meta/momentum')");
    expect(fn).toContain("db.doc('meta/health')");
    // Kein news/user-Text, keine Fremd-Collection.
    expect(fn).not.toContain('news');
    expect(fn).not.toContain("collection('users')");
  });

  it('schreibt genau EIN Dokument — meta/aiVoteShadow', () => {
    expect(kiStimme).toContain("db.doc('meta/aiVoteShadow')");
    // Kein zweiter .doc(-Schreibziel außerhalb der Fehler-/Erfolgs-Zweige
    // desselben Dokuments — grobe Schranke: `ref.set(` taucht nur mit
    // dem einen `ref` auf, keine zweite Doc-Referenz wird erzeugt.
    expect((kiStimme.match(/db\.doc\(/g) ?? []).length).toBe(3); // aiVoteShadow, momentum, health
  });
});

describe('Wächter: Trading-Pfade kennen aiVoteShadow NICHT (Root-Trennung der Stimme)', () => {
  const pfade = [
    ['core', 'engine.ts'],
    ['core', 'broker.ts'],
    ['core', 'orderRouting.ts'],
    ['core', 'schutzStop.ts'],
    ['scheduled', 'scanMarket.ts'],
    ['scheduled', 'riskPulse.ts'],
    ['scheduled', 'momentumRun.ts'],
    ['callable', 'trade.ts'],
  ];

  it.each(pfade)('%s/%s referenziert aiVoteShadow nicht', (...teile) => {
    const text = lies(...teile);
    expect(text).not.toContain('aiVoteShadow');
  });
});

describe('Wächter: dieselben Kosten-Leitplanken wie beim Lagebericht', () => {
  it('Modell, Secret-Bindung und Denk-Tiefe stimmen mit kiBericht überein', () => {
    expect(kiStimme).toContain("const MODELL = 'claude-opus-5';");
    expect(kiStimme).toContain("secrets: ['ANTHROPIC_API_KEY']");
    expect(kiStimme).toContain("output_config: { effort: 'low' }");
  });

  it('der manuelle Auslöser ist nur im Emulator erreichbar', () => {
    const ab = kiStimme.indexOf('export const kiStimmeNow');
    expect(ab).toBeGreaterThan(-1);
    const block = kiStimme.slice(ab);
    expect(block).toContain("process.env.FUNCTIONS_EMULATOR !== 'true'");
    expect(block).toContain('403');
  });

  it('eine Ablehnung und eine unauswertbare Antwort werden wie ein Fehler behandelt, nie als Teilerfolg', () => {
    expect(kiStimme).toContain("antwort.stop_reason === 'refusal'");
    expect(kiStimme).toContain('parseKiStimmeAntwort(text, symbole)');
    const ab = kiStimme.indexOf('if (!votes) {');
    expect(ab).toBeGreaterThan(-1);
    expect(kiStimme.slice(ab, ab + 300)).toContain("stand: 'fehler'");
  });
});
