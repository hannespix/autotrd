/**
 * Wächter für das helle Theme (Owner-Meldung 17.08.).
 *
 * „das helle Theme gefällt mir aktuell von den Farben her (Kombination)
 * überhaupt nicht!"
 *
 * ── Was hier eigentlich geprüft wird ──────────────────────────────────────
 *
 * Nicht, ob die Farben schön sind — das kann kein Test, dafür gibt es
 * `frontend/e2e/theme-shot.mjs` und Augen. Geprüft wird die STRUKTUR, an der
 * die Unstimmigkeit hing: Das helle Theme überschrieb nur die Farbtokens,
 * während ein Dutzend Werte fest im Regelwerk stand — Schrift auf
 * Akzentflächen, Hover-Flächen, Chip-Gründe, Neon-Schein, die Aurora.
 *
 * Solche Werte sind still: Sie erzeugen keinen Fehler, keinen roten Test und
 * keine Warnung. Sie sehen im Dunkeln richtig aus und im Hellen falsch, und
 * genau deshalb kommen sie beim nächsten Feature zurück — jemand schreibt
 * `color: #04121a` auf einen türkisen Knopf, weil es im Dunkeln stimmt.
 *
 * Dieser Test macht daraus einen roten Balken.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/theme.css'),
  'utf8',
);

/** Der Block `:root[data-theme='light'] { … }` — die Umschaltung selbst. */
const hellBlock = ((): string => {
  const start = css.indexOf(":root[data-theme='light'] {");
  expect(start, 'Der helle Theme-Block fehlt').toBeGreaterThan(0);
  return css.slice(start, css.indexOf('\n}', start));
})();

describe('das helle Theme schaltet ALLE Farbrollen um', () => {
  /* Jedes dieser Tokens war einmal nur im Dunkeln definiert und schlug
   * unverändert ins Helle durch. `--vi` etwa ist ein Neon-Violett für
   * schwarzen Grund; auf Papier gehört es einer anderen Palette an als das
   * gedämpfte Petrol daneben — und genau solche Fremdkörper sind es, die
   * eine Kombination „beißen" lassen. */
  const rollen = [
    '--bg0', '--bg', '--card', '--card-solid',
    '--t1', '--t2', '--t3',
    '--ac', '--ac2', '--ac-soft',
    '--gn', '--gn2', '--gn-soft',
    '--rd', '--rd2', '--rd-soft',
    '--vi', '--vi-soft',
    '--glow-ac', '--glow-gn', '--glow-rd',
    '--on-ac', '--on-gn', '--on-rd',
    '--fill-in', '--hover', '--chip-bg', '--scrim',
    '--sh-card', '--sh-pop', '--sh-pop2', '--rim', '--blur',
  ];
  for (const rolle of rollen) {
    it(`${rolle} ist im Hellen eigens gesetzt`, () => {
      expect(hellBlock, `${rolle} fehlt im hellen Theme`).toContain(`${rolle}:`);
    });
  }
});

describe('keine Dunkel-Werte mehr im Regelwerk', () => {
  /** Alles außerhalb der beiden Token-Blöcke — dort dürfen sie stehen. */
  const regelwerk = css.slice(css.indexOf('html { background: var(--bg0); }'));

  it('Schrift auf Akzentflächen kommt aus Rollen, nicht als Fast-Schwarz', () => {
    // #04121a auf leuchtendem Türkis ist richtig, auf tiefem Petrol ein
    // grauer Fleck. Die Rolle entscheidet je Theme.
    expect(regelwerk).not.toMatch(/color:\s*#04121a/);
    expect(regelwerk).not.toMatch(/color:\s*#04140e/);
  });

  it('Hover-Flächen sind eine Rolle — „Weiß mit 3 %" ist auf Weiß nichts', () => {
    expect(regelwerk).not.toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*\.0[35]\)/);
  });

  it('Chip-Gründe und Verdunkelungen sind Rollen', () => {
    expect(regelwerk).not.toMatch(/background:\s*rgba\(26,\s*34,\s*53/); // dunkles Marineblau
    expect(regelwerk).not.toMatch(/background:\s*rgba\(3,\s*6,\s*12/); // Modal-Schleier
    expect(regelwerk).toContain('var(--scrim)');
  });

  it('Akzent-Tönungen kommen aus den *-soft-Rollen', () => {
    // Feste rgba des Dunkel-Türkis (37,208,238) in einer Hover-Fläche
    // ergibt im Hellen eine Farbe, die zu keinem anderen Element passt.
    expect(regelwerk).not.toMatch(/background:\s*rgba\(37,\s*208,\s*238/);
  });
});

describe('die Aurora hat eine eigene helle Fassung', () => {
  it('sie ist überschrieben — und zwar gedämpft', () => {
    // Der auffälligste Einzelbefund: Türkis + Violett + Grün bei 50 %
    // Deckkraft wuschen die Seite von Mint über Lila nach Blassblau, und die
    // halbtransparenten Karten nahmen den Farbstich mit.
    const auroraHell = css.slice(css.indexOf(":root[data-theme='light'] .aurora {"));
    expect(auroraHell, 'Aurora hat keine helle Fassung').toContain('opacity');
    const deckkraft = /opacity:\s*\.(\d+)/.exec(auroraHell);
    expect(deckkraft, 'Deckkraft der hellen Aurora nicht lesbar').not.toBeNull();
    expect(Number(`0.${deckkraft![1]}`)).toBeLessThan(0.5);
  });

  it('sie ist NICHT gestrichen — die Aurora ist das Gesicht der App', () => {
    // Der bequeme Weg wäre `display: none`. Dann wäre das helle Theme aber
    // ein anderes Produkt, nicht dasselbe bei Tageslicht (CLAUDE.md §6).
    const auroraHell = css.slice(css.indexOf(":root[data-theme='light'] .aurora {"));
    expect(auroraHell.slice(0, 400)).not.toContain('display: none');
    expect(auroraHell.slice(0, 400)).toContain('radial-gradient');
  });
});

describe('Grün und Rot bleiben Geschwister', () => {
  /** Helligkeit nach Rec. 709 — grob, aber für „wer schreit lauter" genug. */
  const helligkeit = (hex: string): number => {
    const n = Number.parseInt(hex.slice(1), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  const token = (name: string): string => {
    const t = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(hellBlock);
    expect(t, `${name} nicht lesbar`).not.toBeNull();
    return t![1]!;
  };

  it('liegen im selben Helligkeitsband', () => {
    /* Vorher: gn #00a67a (0,50) gegen rd #e5384b (0,36) — Rot war die
     * hellere, sattere Farbe und sprang bei jedem Verlust ins Auge, während
     * Gewinne unauffällig blieben. Beide tragen dieselbe Rolle
     * (Vorzeichen eines Ergebnisses) und sollen dasselbe Gewicht haben. */
    const d = Math.abs(helligkeit(token('--gn')) - helligkeit(token('--rd')));
    expect(d, 'Grün und Rot sind unterschiedlich laut').toBeLessThan(0.12);
  });

  it('sind dunkel genug für weiße Schrift auf gefüllten Flächen', () => {
    // `--on-*` steht im Hellen auf Weiß; das trägt nur, wenn die Fläche
    // wirklich dunkel ist.
    for (const name of ['--ac', '--gn', '--rd']) {
      expect(helligkeit(token(name)), `${name} ist zu hell für weiße Schrift`).toBeLessThan(0.45);
    }
  });
});
