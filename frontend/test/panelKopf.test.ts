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
    // Nachklick eines Grip-Drags darf nicht klappen — der Stempel fällt im
    // Pointer-Drag (startePanelDrag, panelDrag.test.ts), der Filter hier.
    expect(dashboard).toMatch(/dragEndeUm = Date\.now\(\);/);
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

  it('Akkordeon-Schalter (Owner 21.08.): Optionen→Anzeige kann das Mitschließen abstellen', () => {
    // klappUm respektiert den Schalter; fehlendes Feld bleibt AN.
    expect(klapp).toContain('st.ui.akkordeon !== false &&');
    // Checkbox im Options-Modal, geladen und über die Toggle-Schleife gespeichert.
    expect(dashboard).toContain('id="ouAkk"');
    expect(dashboard).toContain("($('ouAkk') as HTMLInputElement).checked = st.ui.akkordeon !== false;");
    expect(dashboard).toContain("['ouAkk', 'akkordeon'],");
    // Beim Laden aus settings.ui MITFÜHREN — saveUiPrefs schreibt das ganze
    // Objekt, ein fehlendes Feld wäre beim nächsten Speichern gelöscht.
    expect(dashboard).toContain('akkordeon: ui?.akkordeon !== false,');
  });

  it('ARIA: der Klapp-Zustand steht als aria-expanded am Knopf', () => {
    const apply = dashboard.match(/function applyCollapse[\s\S]*?\n\}/)?.[0] ?? '';
    expect(apply).toContain("btn.setAttribute('aria-expanded', String(!on));");
    expect(chrome).toContain("fold.setAttribute('aria-label'");
  });

  it('Klappen ist weich animiert — hidden bleibt die Wahrheit, Boot bleibt hart', () => {
    // Owner 21.08.: „richtig schick animieren". Die Animation ist Kosmetik
    // OBENDRAUF: Zuklappen setzt hidden erst am Ende (onfinish), schnelles
    // Doppel-Toggle cancelt laufende Animationen, reduzierte Bewegung und
    // der Boot-Restore bekommen den harten Schnitt.
    const setz = dashboard.match(/function setzeKlappzustand[\s\S]*?\n\}/)?.[0] ?? '';
    expect(setz).toContain('body.getAnimations().forEach((a) => a.cancel());');
    expect(setz).toContain('if (!animiert || reduzierteBewegung');
    expect(setz).toContain('body.animate(');
    expect(setz).toContain('anim.onfinish = abschliessen;');
    // Sicherheitsnetz gegen stehende Animations-Uhren (gedrosselte Tabs):
    // der Timer zieht nach — aber nur, wenn kein neuerer Toggle übernahm.
    expect(setz).toContain('if (aktuelleKlappAnim.get(body) !== anim) return;');
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

  /**
   * Kopf-Ordnung (Owner-Screenshot 21.08.): Grip und ✕ rutschten mobil in
   * eine zweite Zeile, Badges standen mal vor, mal hinter dem ✕. Der
   * Chrome-Bau sortiert jeden Panel-Kopf in die feste Flex-Folge
   * [Pfeil][Titel+ⓘ+Chip][Meta-Badges][Werkzeuge]; nur .sect-meta darf
   * (als Ganzes, rechtsbündig) umbrechen.
   */
  it('Kopf-Ordnung: Titel- und Meta-Gruppe werden gebaut, Flex nur mit Chrome', () => {
    expect(chrome).toContain("titel.className = 'sect-titel';");
    expect(chrome).toContain("meta.className = 'sect-meta';");
    // Text, ⓘ und Link-Chip gehören zum Titel — alles andere ist Meta.
    expect(chrome).toContain("kind.classList.contains('ibtn') || kind.classList.contains('lchip')");
    expect(chrome).toContain('sect.insertBefore(titel, box);');
    expect(chrome).toContain('if (meta.childNodes.length > 0) sect.insertBefore(meta, box);');
    // Flex NUR für Köpfe mit Chrome — Alt-Köpfe (Admin, Modals) behalten
    // flow-root samt Floats (19-%-Karten-Bug, Owner 20.08.).
    expect(chrome).toContain("sect.classList.add('sect-flex');");
    expect(css).toContain('.sect.sect-flex { display: flex; flex-wrap: wrap; align-items: center;');
    expect(css).toContain('.sect-flex > .sect-tools { flex: 0 0 auto; margin-left: auto; float: none; }');
    expect(css).toContain('.sect-flex > .sect-meta ~ .sect-tools { margin-left: 0; }');
  });

  it('Titel-Straffung: kurze Substantiv-Titel, das Kurzdatum trägt den Stand', () => {
    // Die Erklärung der ehemals fragenden Titel lebt im ⓘ-Tip weiter.
    expect(dashboard).toContain('`Stand ${d.at.slice(8, 10)}.${d.at.slice(5, 7)}.`');
    expect(dashboard).toContain('`Stand ${c.date.slice(8, 10)}.${c.date.slice(5, 7)}.`');
  });
});
