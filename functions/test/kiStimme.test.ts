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
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const kiStimme = lies('scheduled', 'kiStimme.ts');

/** Alle .ts-Quelldateien unter src/ — rekursiv, dasselbe Muster wie in
 *  `schattenKosten.test.ts`. */
function alleQuellen(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...alleQuellen(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

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

  it('Rangliste zählt nur als vorhanden, wenn sie von HEUTE ist (Red-Team-Befund 25.08.)', () => {
    // Nicht bloß `top.length > 0`: Ein gescheiterter momentumRun-Lauf lässt
    // `meta/momentum` mit GESTRIGEM `date` liegen — ohne den Datumsvergleich
    // würde die Stimme lautlos auf veralteten Daten erhoben, aber unter dem
    // heutigen Datum abgelegt.
    const ab = kiStimme.indexOf('const heute = ');
    expect(ab).toBeGreaterThan(-1);
    const bis = kiStimme.indexOf('const e = entscheideKiStimmeLauf', ab);
    const block = kiStimme.slice(ab, bis);
    expect(block).toContain('momentum?.date === heute');
    expect(block).toMatch(/const datenDa = top\.length > 0 && momentum\?\.date === heute;/);
  });
});

describe('Wächter: Trading-Pfade kennen aiVoteShadow NICHT (Root-Trennung der Stimme)', () => {
  /* Ganz `src/` scannen statt eine Namensliste zu pflegen (Red-Team-Befund
   * 25.08.): Eine feste Liste beweist nur „heute isoliert" — sie bricht
   * NICHT, wenn eine künftige, heute noch ungeschriebene Datei
   * `aiVoteShadow` liest. Der Scan über den ganzen Baum fängt das
   * strukturell, ohne dass jemand die Liste pflegen muss. */
  const srcRoot = join(import.meta.dirname, '..', 'src');
  const andereQuellen = alleQuellen(srcRoot).filter(
    (p) => relative(srcRoot, p) !== join('scheduled', 'kiStimme.ts'),
  );

  it('mindestens die erwarteten Trading-Kerndateien sind im Scan enthalten', () => {
    // Schranke gegen einen kaputten Scan (leeres Verzeichnis, falscher Pfad):
    // Ohne diese Zusicherung würde ein still leerer `andereQuellen`-Array
    // jeden folgenden `it.each` als „bestanden" zeigen, ohne je geprüft zu
    // haben.
    expect(andereQuellen.length).toBeGreaterThan(40);
    const relPfade = andereQuellen.map((p) => relative(srcRoot, p));
    for (const erwartet of [
      join('core', 'engine.ts'),
      join('core', 'broker.ts'),
      join('scheduled', 'scanMarket.ts'),
      join('callable', 'trade.ts'),
    ]) {
      expect(relPfade).toContain(erwartet);
    }
  });

  it.each(andereQuellen.map((p) => [relative(srcRoot, p), p] as const))(
    '%s referenziert aiVoteShadow nicht',
    (_rel, pfad) => {
      expect(readFileSync(pfad, 'utf8')).not.toContain('aiVoteShadow');
    },
  );
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
