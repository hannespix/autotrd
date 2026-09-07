/**
 * Modal-Schließen per Delegation (Owner-Screenshot 20.08.).
 *
 * Der Befund damals: Ein ✕, das per innerHTML entsteht, verfehlt eine
 * Einmal-Bindung beim Init. Am Desktop kaschierte der große, statisch
 * gebundene Backdrop den toten Knopf; am Telefon füllt das Sheet den Schirm.
 * Deshalb ein delegierter Handler über `closest('[data-close]')` — und
 * jedes Modal des Auto-Traders (Optionen, Bericht, Kommando-Bestätigung)
 * hängt an genau dieser Delegation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('data-close — ein delegierter Handler statt Einmal-Bindung', () => {
  it('die Einmal-Bindung ist weg — sie verfehlt dynamisch erzeugte Knöpfe', () => {
    expect(dashboard).not.toContain("querySelectorAll('[data-close]')");
  });

  it('die Delegation läuft über closest, damit auch das ✕-INNERE trifft', () => {
    expect(dashboard).toContain(".closest<HTMLElement>('[data-close]')");
    expect(dashboard).toContain('if (name && name in MODAL_IDS) closeModal(name as ModalName);');
  });

  it('jedes Modal ist in MODAL_IDS registriert und trägt Backdrop und ✕ mit data-close', () => {
    const ids = dashboard.match(/const MODAL_IDS = \{[\s\S]*?\} as const;/)?.[0] ?? '';
    for (const [name, id] of [['options', 'optModal'], ['report', 'reportModal'], ['cmd', 'cmdModal']] as const) {
      expect(ids, `${name} fehlt in MODAL_IDS`).toContain(`${name}: '${id}'`);
      expect(dashboard).toContain(`<div class="dmodal" id="${id}">`);
      expect(dashboard).toContain(`<div class="dmodal-bg" data-close="${name}"></div>`);
      expect(dashboard).toContain(`<button class="dclose" data-close="${name}">✕</button>`);
    }
  });

  it('Escape schließt alle drei — und die mobilen Schubladen', () => {
    const fn = dashboard.slice(dashboard.indexOf('function onEscape'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    for (const name of ['options', 'report', 'cmd']) expect(block).toContain(`closeModal('${name}');`);
    expect(block).toContain("document.getElementById('olv')?.classList.remove('show');");
  });

  it('das Schließen der Kommando-Bestätigung vergisst das offene Kommando', () => {
    // Sonst feuerte ein späteres „Ausführen" das Kommando von vorhin.
    const fn = dashboard.slice(dashboard.indexOf('function closeModal'));
    expect(fn.slice(0, 300)).toContain("if (which === 'cmd') cmdOffen = null;");
  });
});
