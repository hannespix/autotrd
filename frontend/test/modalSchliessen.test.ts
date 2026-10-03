/**
 * Modal-Schließen per Delegation (Owner-Screenshot 20.08.).
 *
 * Der Befund: Der ✕ des Markt-Detail-Sheets hatte am Smartphone keine
 * Funktion. Ursache war KEIN Touch-Problem, sondern eine Einmal-Bindung —
 * `querySelectorAll('[data-close]')` beim Init verfehlt jeden Knopf, der
 * später per innerHTML entsteht (openDetail baut das Sheet bei jedem
 * Öffnen neu). Am Desktop kaschierte der große, statisch gebundene
 * Backdrop den toten Knopf; am Telefon füllt das Sheet den Schirm.
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
    // closest statt e.target-Vergleich: Ein Tipp landet gern auf einem
    // Kind-Knoten (Textknoten/Icon) — ohne closest wäre der Knopf nur an
    // seinen Rändern klickbar, exakt das „geht manchmal nicht"-Gefühl.
    expect(dashboard).toContain(".closest<HTMLElement>('[data-close]')");
    expect(dashboard).toContain('if (name && name in MODAL_IDS) closeModal(name as ModalName);');
  });

  it('der dynamische ✕ im Detail-Sheet trägt data-close="detail"', () => {
    /* openDetail schreibt das Sheet komplett neu — verliert der Knopf sein
     * data-close-Attribut, ist er wieder tot, egal wie gut die Delegation
     * ist. Der Pin hält beide Enden des Vertrags fest. */
    const fn = dashboard.slice(dashboard.indexOf('function openDetail'));
    expect(fn.slice(0, 2500)).toContain('<button class="dclose" data-close="detail">');
  });
});
