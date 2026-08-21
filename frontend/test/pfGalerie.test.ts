/**
 * Wächter der Performance-Galerie (Owner 21.08.: „kann man den depotverlauf
 * nicht unter Performance einpflegen? … dann hätte man eine card weniger").
 *
 * Der Depot-Verlauf ist als blätterbare Ansicht in die Performance-Karte
 * eingezogen: Chips #pfAnsicht wechseln zwischen Kurve (#pfSeiteKurve) und
 * Depot-Verlauf (#pfSeiteDepot); die eigene Karte existiert nicht mehr.
 * Entscheidend: Die dc-Ids (dcChart/dcLegende/dcMeta/dcWrap/dcMSym) bleiben
 * unverändert — renderDepotVerlauf und wireDepotVerlauf zeichnen weiter an
 * dieselben Halter, ohne eine Zeile Logik-Änderung.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const css = lese('../src/theme.css');

// Markup der Performance-Karte (gleicher Schnitt wie der i18n-Wächter).
const karte = dashboard.slice(
  dashboard.indexOf('data-panel="performance"'),
  dashboard.indexOf('data-panel="manualtrade"'),
);

describe('Performance-Galerie — Depot-Verlauf wohnt in der Performance-Karte', () => {
  it('die eigene Depot-Verlauf-Karte existiert nicht mehr', () => {
    expect(dashboard).not.toContain('data-panel="depotVerlauf"');
  });

  it('beide Seiten und der Umschalter stehen in der Performance-Karte', () => {
    expect(karte).toContain('id="pfAnsicht"');
    expect(karte).toContain('<div id="pfSeiteKurve" class="pf-seite">');
    expect(karte).toContain('<div id="pfSeiteDepot" class="pf-seite" hidden>');
    // Die dc-Halter liegen IN der Karte — die Renderer bleiben unverändert.
    for (const id of ['dcWrap', 'dcChart', 'dcLegende', 'dcMeta', 'dcMSym', 'dcMTrade']) {
      expect(karte).toContain(`id="${id}"`);
    }
    // Kurven-Werkzeuge sind Teil der Kurven-Seite geblieben.
    expect(karte).toContain('id="pfZeit"');
    expect(karte).toContain('id="pfDetail"');
    // Der ⓘ des Depot-Verlaufs ist mit umgezogen, nicht verloren.
    expect(karte).toContain("iBtn('depotVerlauf')");
  });

  it('der Umschalter merkt sich die Wahl Gerät-lokal und animiert mit Guard', () => {
    expect(dashboard).toContain("localStorage.setItem('autotrd-pf-ansicht', seite);");
    expect(dashboard).toContain("localStorage.getItem('autotrd-pf-ansicht') === 'depot'");
    // Einblende-Animation nur ohne prefers-reduced-motion; Reflow-Trick
    // startet dieselbe Animation auch beim zweiten Wechsel.
    expect(dashboard).toContain('if (animiert && !reduzierteBewegung) {');
    expect(dashboard).toContain('void ziel.offsetWidth;');
    expect(css).toContain('.pf-seite.pf-rein { animation: pfSeiteRein');
    expect(css).toContain('@media (prefers-reduced-motion: reduce) { .pf-seite.pf-rein { animation: none; } }');
  });

  it('renderStats zeichnet den Depot-Verlauf weiter mit — die Galerie ändert nur den Ort', () => {
    expect(dashboard).toMatch(/renderDepotVerlauf\(\);/);
    // Modus-Buttons bleiben an ihren Ids verdrahtet.
    expect(dashboard).toContain("$('dcMSym')?.addEventListener('click', () => setzeModus('symbol'));");
  });
});
