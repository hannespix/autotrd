/**
 * Wächter der Panel-Kopf-Ergonomie (Owner 21.08.: „Der Aufklapp-Knopf ist
 * immer direkt neben dem Schließen-Knopf — dadurch wird oft versehentlich
 * geschlossen").
 *
 * Die Regeln: Klapp-Pfeil ganz LINKS vor dem Titel (sect.prepend), die
 * GANZE Titelzeile klappt (mit Filter für echte Bedienelemente), das ✕
 * bleibt allein rechts in .sect-tools, Sidebar-Spalten sind Akkordeons
 * (nur eine Karte offen, wsHidden zählt nicht mit), und der Zustand
 * spricht ARIA (aria-expanded).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const css = lese('../src/theme.css');
const chrome = dashboard.match(/function wirePanelChrome[\s\S]*?\n\}/)?.[0] ?? '';
const klapp = dashboard.match(/function klappUm[\s\S]*?\n\}/)?.[0] ?? '';

describe('Panel-Kopf — Pfeil links, Titelzeile klappt, ✕ isoliert rechts', () => {
  it('der Klapp-Pfeil wird VOR den Titel gesetzt, nicht in die Tools-Box', () => {
    expect(chrome).toMatch(/^\s*sect\.prepend\(fold\);/m);
    // Die rechte Tools-Box enthält KEINEN Klapp-Knopf mehr — nur Grip + ✕.
    const boxHtml = chrome.match(/box\.innerHTML =[\s\S]*?;/)?.[0] ?? '';
    expect(boxHtml).not.toContain('data-col');
    expect(boxHtml).toContain('data-x');
  });

  it('die ganze Titelzeile togglet — echte Bedienelemente bleiben unberührt', () => {
    expect(chrome).toContain("sect.addEventListener('click'");
    expect(chrome).toContain("ziel.closest('button, input, select, label, a, .ibtn, .lchip')");
    // Nachklick eines Grip-Drags darf nicht klappen.
    expect(chrome).toMatch(/dragEndeUm = Date\.now\(\);/);
    expect(chrome).toContain('Date.now() - dragEndeUm < 400');
    // Der Pfeil selbst stoppt die Propagation — sonst doppelt der Titel-Klick.
    expect(chrome).toContain('ev.stopPropagation();');
    // Nie doppeltes Chrome bei erneutem Aufruf.
    expect(chrome).toContain("if (sect.querySelector(':scope > .sect-tools')) return;");
  });

  it('Sidebar-Akkordeon: nur eine Karte je Spalte offen, wsHidden zählt nicht', () => {
    expect(klapp).toContain("spalte?.id === 'leftCol' || spalte?.id === 'rightCol'");
    expect(klapp).toContain('!st.wsHidden.has(gid)');
    // Nur beim AUFklappen — Zuklappen lässt die Nachbarn in Ruhe.
    expect(klapp).toContain('if (aufklappen && akkordeon && spalte)');
  });

  it('ARIA: der Klapp-Zustand steht als aria-expanded am Knopf', () => {
    const apply = dashboard.match(/function applyCollapse[\s\S]*?\n\}/)?.[0] ?? '';
    expect(apply).toContain("btn.setAttribute('aria-expanded', String(!on));");
    expect(chrome).toContain("fold.setAttribute('aria-label'");
  });

  it('CSS: Titelzeile zeigt Zeiger-Cursor, Pfeil hat Abstand zum Titel', () => {
    expect(css).toContain('.card[data-panel] > .sect { cursor: pointer;');
    expect(css).toMatch(/\.sect-fold \{ margin-right: \d+px; \}/);
  });
});
