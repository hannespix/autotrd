/**
 * Wächter der Panel-Kopf-Ergonomie (Owner 21.08.: „Der Aufklapp-Knopf ist
 * immer direkt neben dem Schließen-Knopf — dadurch wird oft versehentlich
 * geschlossen").
 *
 * Seit dem Umbau auf den Auto-Trader gibt es kein ✕ und keinen Grip mehr —
 * die Karten sind fest. Was bleibt: Klapp-Pfeil ganz LINKS vor dem Titel
 * (sect.prepend), die GANZE Titelzeile klappt (mit Filter für echte
 * Bedienelemente), Seitenspalten sind Akkordeons (nur eine Karte offen),
 * der Zustand spricht ARIA (aria-expanded), und das Klappen ist weich
 * animiert mit hartem Sicherheitsnetz.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const css = lese('../src/theme.css');
const chrome = dashboard.match(/function wirePanelChrome[\s\S]*?\n\}/)?.[0] ?? '';
const klapp = dashboard.match(/function klappUm[\s\S]*?\n\}/)?.[0] ?? '';

describe('Panel-Kopf — Pfeil links, Titelzeile klappt', () => {
  it('der Klapp-Pfeil wird VOR den Titel gesetzt', () => {
    expect(chrome).toMatch(/^\s*sect\.prepend\(fold\);/m);
    expect(chrome).toContain("fold.className = 'sect-btn sect-fold';");
  });

  it('kein ✕ und kein Grip mehr — die Karten des Auto-Traders sind fest', () => {
    expect(chrome).not.toContain('data-x');
    expect(chrome).not.toContain('data-grip');
    expect(dashboard).not.toContain('startePanelDrag');
  });

  it('die ganze Titelzeile togglet — echte Bedienelemente bleiben unberührt', () => {
    expect(chrome).toContain("sect.addEventListener('click'");
    expect(chrome).toContain("ziel.closest('button, input, select, label, a, .ibtn')");
    // Der Pfeil selbst stoppt die Propagation — sonst doppelt der Titel-Klick.
    expect(chrome).toContain('ev.stopPropagation();');
    // Nie doppeltes Chrome bei erneutem Aufruf.
    expect(chrome).toContain("if (sect.querySelector(':scope > .sect-fold')) return;");
  });

  it('Sidebar-Akkordeon: nur eine Karte je Seitenspalte offen, Mitte bleibt frei', () => {
    expect(klapp).toContain("spalte?.id === 'leftCol' || spalte?.id === 'rightCol'");
    // Nur beim AUFklappen — Zuklappen lässt die Nachbarn in Ruhe.
    expect(klapp).toContain('if (aufklappen && akkordeon && spalte)');
    expect(klapp).not.toContain('centerCol');
  });

  it('der Klapp-Zustand ist Gerät-lokal und überlebt den Reload', () => {
    expect(klapp).toContain("localStorage.setItem('autotrd-collapsed', [...st.collapsed].join(','));");
    expect(dashboard).toContain("collapsed: new Set((localStorage.getItem('autotrd-collapsed') ?? '').split(',').filter(Boolean)),");
  });

  it('ARIA: der Klapp-Zustand steht als aria-expanded am Knopf', () => {
    const apply = dashboard.match(/function applyCollapse[\s\S]*?\n\}/)?.[0] ?? '';
    expect(apply).toContain("btn.setAttribute('aria-expanded', String(!on));");
    expect(chrome).toContain("fold.setAttribute('aria-label'");
  });

  it('Klappen ist weich animiert — hidden bleibt die Wahrheit, Boot bleibt hart', () => {
    const setz = dashboard.match(/function setzeKlappzustand[\s\S]*?\n\}/)?.[0] ?? '';
    expect(setz).toContain('body.getAnimations().forEach((a) => a.cancel());');
    expect(setz).toContain('if (!animiert || reduzierteBewegung');
    expect(setz).toContain('body.animate(');
    expect(setz).toContain('anim.onfinish = abschliessen;');
    // Sicherheitsnetz gegen stehende Animations-Uhren (gedrosselte Tabs):
    // der Timer zieht nach — aber nur, wenn kein neuerer Toggle übernahm.
    expect(setz).toContain('if (aktuelleKlappAnim.get(body) !== anim) return;');
    // Doppel-Toggle: der Early-Return räumt den overflow-Rest.
    expect(setz).toMatch(/if \(body\.hidden === zu\) \{[\s\S]*?body\.style\.overflow = '';\s*return;/);
    expect(dashboard).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)')");
    // Nutzer-Toggle animiert, der Boot-Aufruf am Ende von wirePanelChrome nicht.
    expect(klapp).toContain('applyCollapse(true);');
    expect(chrome).toMatch(/^\s*applyCollapse\(\);\n\}/m);
    // Der Pfeil dreht per CSS statt Zeichen-Tausch.
    expect(css).toContain('.sect-fold[aria-expanded="false"] { transform: rotate(-90deg); }');
  });

  it('CSS: Titelzeile zeigt Zeiger-Cursor, Pfeil hat Abstand zum Titel', () => {
    expect(css).toContain('.card[data-panel] > .sect { cursor: pointer;');
    expect(css).toMatch(/\.sect-fold \{ margin-right: \d+px; transition: transform/);
  });

  it('Kopf-Ordnung: Titel- und Meta-Gruppe werden gebaut, Flex nur mit Chrome', () => {
    expect(chrome).toContain("titel.className = 'sect-titel';");
    expect(chrome).toContain("meta.className = 'sect-meta';");
    // Text und ⓘ gehören zum Titel — alles andere (Zähler, Stand-Badges) ist Meta.
    expect(chrome).toContain("kind instanceof HTMLElement && kind.classList.contains('ibtn')");
    expect(chrome).toContain('if (meta.childNodes.length > 0) sect.appendChild(meta);');
    // Flex NUR für Köpfe mit Chrome — die Admin-Karte (ohne data-panel)
    // behält flow-root samt Floats.
    expect(chrome).toContain("sect.classList.add('sect-flex');");
    expect(css).toContain('.sect.sect-flex { display: flex; flex-wrap: wrap; align-items: center;');
    expect(dashboard).toContain('<div class="card" id="adminCard" hidden>');
  });
});
