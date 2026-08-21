/**
 * Wächter der Layout-Befunde aus dem großen UI-Audit 21.08. (Agenten
 * VIEWPORTS, TEXTE, DYNAMIK):
 *
 * - Optionen-Raster: Die Spalten-Flexbox machte JEDES Label-Kind zum
 *   eigenen Item — das ⓘ stand allein zwischen Beschriftung und Feld,
 *   Selects schrumpften auf 72 px („1× — k" statt „1× — kein Hebel").
 * - Reset-Feld: flex:1 quetschte das Feld neben dem breiten Knopf auf
 *   ~65 px — der Placeholder (die einzige Erklärung, WAS zu tippen ist)
 *   war abgeschnitten. Der Text selbst bleibt wörtlich unangetastet.
 * - Doppel-Toggle: Der Early-Return nach dem Animations-Cancel ließ
 *   overflow:hidden dauerhaft stehen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const css = lese('../src/theme.css');
const dashboard = lese('../src/dashboard.ts');

describe('Audit-Layout-Fixes 21.08.', () => {
  it('Optionen-Raster: Label ist Block, das Feld nimmt die volle Spaltenbreite', () => {
    expect(css).toContain('.opt-grid label { display: block; font-size: 11px; color: var(--t2); }');
    expect(css).toContain('.opt-grid label:not(.opt-check) .inp { display: block; width: 100%; margin-top: 4px; }');
    // Mobil braucht die Ein-Zeilen-Optik jetzt explizites flex.
    const mobil = css.slice(css.indexOf('@media (max-width: 560px)'));
    expect(mobil).toContain('display: flex;');
    expect(mobil).toContain('width: 118px; margin-top: 0;');
  });

  it('Reset-Feld: Mindestbreite statt Quetschung, Zeile darf umbrechen', () => {
    expect(dashboard).toContain('style="flex:1;min-width:150px;max-width:220px"');
    expect(dashboard).toContain('margin-top:6px;flex-wrap:wrap');
  });

  it('Doppel-Toggle: der Early-Return räumt den overflow-Rest', () => {
    const fn = dashboard.match(/function setzeKlappzustand[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/if \(body\.hidden === zu\) \{[\s\S]*?body\.style\.overflow = '';[\s\S]*?return;/);
  });
});
