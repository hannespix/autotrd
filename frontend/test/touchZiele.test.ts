/**
 * Wächter der Touch-Trefferflächen (UI-Audit 21.08., Agent „TOUCH").
 *
 * Die coarse-Pointer-Polster (::after) vergrößern kleine Ziele unsichtbar —
 * aber überlappende Polster sind schlimmer als kleine Ziele: elementFromPoint
 * gibt der SPÄTER gemalten Fläche den Punkt. Zwei gemessene Folgen:
 *
 * - H1: Die ✕-Fläche reichte über die ⠿-Grip-MITTE (gap 2 px, Polster
 *   ±13 px) — Tap auf den Grip blendete die Karte aus (destruktiv), ein
 *   Touch-Drag ab Grip-Mitte startete nie.
 * - M1: Bei umbrechenden Chip-Leisten (Zeilen-Pitch 25 px, Polster ±10 px)
 *   gehörte die Unterkante jedes Chips dem Chip der NÄCHSTEN Zeile —
 *   „1J" löste ⛶ Vollbild aus.
 *
 * Die Fixes: echte Distanz statt Überlappung. Kopf-Werkzeuge auf Touch mit
 * gap 12 px und horizontal ±5 px (10 < 12 — nie Überlagerung); Chips mit
 * row-gap 8 px und vertikal ±4 px (8 = 8 — berühren, nie klauen).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/theme.css', import.meta.url)), 'utf8');
const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));

describe('Touch-Trefferflächen — Polster dürfen sich nie überlagern', () => {
  it('H1: Kopf-Werkzeuge bekommen echten Abstand und knappes Horizontal-Polster', () => {
    expect(coarse).toContain('.sect-tools { gap: 12px; }');
    expect(coarse).toContain('.sect-tools .sect-btn::after { inset: -13px -5px; }');
  });

  it('M1: Chip-Polster ist an den Zeilen-Pitch gekoppelt', () => {
    expect(coarse).toContain('.tf-bar { row-gap: 8px; }');
    const chip = coarse.match(/\.tf-btn::after \{[\s\S]*?\}/)?.[0] ?? '';
    expect(chip).toContain('inset: -4px -2px;');
    // Das alte Zeilen-Klau-Polster darf nicht zurückkommen.
    expect(chip).not.toContain('inset: -10px');
  });
});
