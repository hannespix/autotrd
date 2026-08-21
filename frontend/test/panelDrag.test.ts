/**
 * Wächter des Pointer-Drags (Owner 21.08.: „Karten an den Mauszeiger oder
 * Finger anheften und animiert an die neue Stelle gleiten; im Tool
 * rumschieben").
 *
 * Die Regeln: KEIN HTML5-DnD mehr (kann weder Touch noch eigenen Clone),
 * das Original bleibt als Platzhalter im Fluss, ein ID-bereinigter Clone
 * folgt dem Zeiger, Nachbarn gleiten per FLIP, Karten dürfen zwischen
 * leftCol und rightCol wechseln (Spalte wird im Workspace persistiert),
 * und reduzierte Bewegung bekommt harte Schnitte bei voller Funktion.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const data = lese('../src/data.ts');
const css = lese('../src/theme.css');
const drag = dashboard.match(/function startePanelDrag[\s\S]*?\n\}/)?.[0] ?? '';

describe('Pointer-Drag — Anheften, FLIP-Gleiten, Spaltenwechsel', () => {
  it('HTML5-DnD ist vollständig ersetzt', () => {
    expect(dashboard).not.toContain('dragstart');
    expect(dashboard).not.toContain('dataTransfer');
    expect(dashboard).not.toContain('draggable');
    expect(dashboard).toContain('startePanelDrag(card, ev);');
  });

  it('ein Klick bleibt ein Klick — Drag erst ab 5 px Bewegung', () => {
    expect(drag).toContain('if (Math.hypot(px - start.clientX, py - start.clientY) < 5) return;');
    // Nie bewegt → kein Commit, kein Klick-Guard — der Titelzeilen-Handler übernimmt.
    expect(drag).toContain('if (!clone) return;');
  });

  it('der Clone ist ID-bereinigt — Renderer dürfen nie in den Geist malen', () => {
    expect(drag).toContain("c.removeAttribute('id');");
    expect(drag).toContain("c.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));");
    expect(drag).toContain("c.classList.add('panel-fliegt');");
  });

  it('Nachbarn gleiten per FLIP, reduzierte Bewegung bekommt den harten Schnitt', () => {
    expect(drag).toContain('const vorher = messeAlle();');
    expect(drag).toMatch(/\{ transform: `translate\(\$\{dx\}px, \$\{dy\}px\)` \}, \{ transform: 'translate\(0, 0\)' \}/);
    // Beide Animations-Pfade prüfen die Systempräferenz.
    expect(drag).toContain('if (reduzierteBewegung) return;');
    expect(drag).toContain('if (reduzierteBewegung) {');
    // Sicherheitsnetz gegen stehende Animations-Uhren (gleiche Lehre wie #382).
    expect(drag).toContain('window.setTimeout(weg, 400);');
  });

  it('Spaltenwechsel: Ziel ist die Sidebar unter dem Zeiger, sonst bleibt alles', () => {
    expect(drag).toContain('px >= r.left && px <= r.right;');
    expect(drag).toContain("const anker = next ?? ziel.querySelector(':scope > .sb-rs');");
    // Drop friert Reihenfolge UND Spalte ein; der Klick-Guard fällt hier.
    expect(drag).toContain('commitPanelOrder();');
    expect(drag).toContain('dragEndeUm = Date.now();');
  });

  it('die Spalte wird persistiert und beim Laden streng validiert', () => {
    expect(dashboard).toContain("st!.wsCol[c.dataset.panel ?? ''] = colId;");
    expect(dashboard).toContain("...(st!.wsCol[id] !== undefined ? { col: st!.wsCol[id] } : {}),");
    expect(dashboard).toContain("cfg?.col === 'leftCol' || cfg?.col === 'rightCol'");
    // applyPanelOrder stellt Karten mit gespeicherter Spalte um, bevor sortiert wird.
    expect(dashboard).toContain('for (const [id, colId] of Object.entries(st.wsCol)) {');
    expect(data).toContain("col?: 'leftCol' | 'rightCol'");
  });

  it('CSS: der fliegende Clone existiert, der Grip blockt Touch-Scroll', () => {
    expect(css).toContain('.panel-fliegt { position: fixed;');
    expect(css).toContain('.sect-grip { touch-action: none; }');
  });
});
