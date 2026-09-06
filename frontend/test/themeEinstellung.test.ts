/**
 * Theme-Wahl in Optionen → Anzeige (Owner 15.08.).
 *
 * Der Kopfleisten-Knopf ◐ wurde ständig aus Versehen getippt — die Wahl
 * wohnt im Options-Modal unter „Anzeige", mit drei Zuständen:
 * 'system' (Standard — folgt prefers-color-scheme, auch live beim
 * Geräte-Umschalten), 'light' und 'dark' als feste manuelle Wahlen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');

describe('Theme-Einstellung — Quelltext-Wächter', () => {
  it('kein Theme-Knopf mehr in der Kopfleiste', () => {
    expect(dashboard).not.toContain('id="themeBtn"');
  });

  it('die Auswahl sitzt in Optionen → Anzeige mit drei Zuständen', () => {
    const anzeige = dashboard.indexOf('data-opane="anzeige"');
    const select = dashboard.indexOf('id="ouTheme"');
    expect(select).toBeGreaterThan(anzeige);
    for (const opt of ['value="system"', 'value="light"', 'value="dark"']) {
      expect(dashboard.slice(select, select + 400)).toContain(opt);
    }
  });

  it("Standard ist 'system' — alles außer manueller Wahl fällt darauf zurück", () => {
    expect(dashboard).toContain("return w === 'light' || w === 'dark' ? w : 'system';");
    // Frühinit in main.ts folgt derselben Regel (kein Falsch-Blitz beim Laden).
    expect(main).toContain("themeWahl === 'light' || themeWahl === 'dark'");
    expect(main).toContain("'(prefers-color-scheme: dark)'");
  });

  it('Systemwechsel schaltet live um — nur im System-Modus', () => {
    const stelle = dashboard.indexOf("systemDunkel?.addEventListener?.('change'");
    expect(stelle, 'matchMedia-Listener fehlt').toBeGreaterThan(0);
    const block = dashboard.slice(stelle, stelle + 300);
    expect(block).toContain("if (themeWahl() !== 'system') return;");
    expect(block).toContain('wendeThemeAn();');
  });

  it('manuelle Wahl wird gespeichert und sofort angewandt', () => {
    expect(dashboard).toContain("localStorage.setItem('autotrd-theme', ouTheme.value);");
    const stelle = dashboard.indexOf("localStorage.setItem('autotrd-theme', ouTheme.value);");
    expect(dashboard.slice(stelle, stelle + 200)).toContain('wendeThemeAn();');
  });

  it('die Sprachwahl sitzt daneben und lädt die App neu', () => {
    // Ein Reload statt Soft-Re-Render: Das Dashboard hält Listener und
    // Zustand — ein halb neu gerendertes UI wäre die fehleranfälligste Variante.
    expect(dashboard).toContain('<option value="de">Deutsch</option>');
    expect(dashboard).toContain('<option value="en">English</option>');
    expect(dashboard).toContain("setzeSprache(ouLang.value === 'en' ? 'en' : 'de');");
    expect(dashboard).toContain('location.reload();');
  });
});
