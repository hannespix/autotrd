/**
 * Warnung am Klassen-Regler (Owner-Befund 15.08.).
 *
 * „Krypto auf 1 gesetzt, gespeichert — beim nächsten Öffnen wieder 0.
 * Options broken?" Kaputt war nichts: Der Auto-Regler stellt eine
 * strukturell verlierende Klasse beim Tageslauf sofort zurück auf 0.
 * Nur sagte das Modal es nirgends im Moment des Verstellens. Diese Tests
 * pinnen die Warnung UND ihren Anschluss — eine Warnfunktion, die niemand
 * aufruft, wäre exakt der alte Zustand mit besserem Gewissen.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reglerWarnung } from '../src/reglerHinweis';

const hier = dirname(fileURLToPath(import.meta.url));
const dashboard = readFileSync(join(hier, '../src/dashboard.ts'), 'utf8');

describe('reglerWarnung (pur)', () => {
  it('schweigt, wenn die Automatik aus ist — der Handwert hält dann', () => {
    expect(reglerWarnung(false, { empfehlung: 'abschalten', vorschlag: 0 }, 1, 'Krypto')).toBe('');
  });

  it('schweigt ohne belegte Empfehlung — die Automatik rührt das Gewicht nicht an', () => {
    expect(reglerWarnung(true, undefined, 1, 'Krypto')).toBe('');
    expect(reglerWarnung(true, { empfehlung: 'zu_wenig_daten', vorschlag: 1 }, 1, 'Krypto')).toBe('');
  });

  it('schweigt, wenn Handwert und Vorschlag übereinstimmen', () => {
    expect(reglerWarnung(true, { empfehlung: 'abschalten', vorschlag: 0 }, 0, 'Krypto')).toBe('');
  });

  it('warnt beim Owner-Fall: Krypto von Hand auf 1, Empfehlung „abschalten"', () => {
    const w = reglerWarnung(true, { empfehlung: 'abschalten', vorschlag: 0 }, 1, 'Krypto');
    expect(w).toContain('wieder auf 0');
    expect(w).toContain('sofort');
    expect(w).toContain('„Automatisch nachregeln" abwählen');
  });

  it('warnt bei Schritt-Empfehlungen mit Ziel im deutschen Zahlenformat', () => {
    const w = reglerWarnung(true, { empfehlung: 'drosseln', vorschlag: 0.5 }, 1, 'Aktien');
    expect(w).toContain('Richtung 0,5');
    expect(w).toContain('0,25er-Schritten');
  });
});

describe('Anschluss im Options-Modal (Quelltext-Wächter)', () => {
  it('jeder Regler-Input ruft die Warnung auf', () => {
    expect(dashboard).toContain("zeigeReglerWarnung(k, Number(r.value));");
  });

  it('die Warnung liest dieselbe Empfehlung wie der Tageslauf (classAdvice)', () => {
    expect(dashboard).toContain('classAdvice?.raete.find((r) => r.klasse === klasse)');
    expect(dashboard).toMatch(/reglerWarnung\(autoAn, rat, wert, CLASS_LABELS\[klasse\] \?\? klasse\)/);
  });

  it('Abwählen der Automatik räumt eine stehen gebliebene Warnung weg', () => {
    expect(dashboard).toContain(
      "if (!($('owClsAuto') as HTMLInputElement).checked) $('owClsMsg').textContent = '';",
    );
  });
});
