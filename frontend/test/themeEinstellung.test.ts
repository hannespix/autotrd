/**
 * Theme-Wahl in Optionen → Anzeige (Owner 15.08.).
 *
 * Der Kopfleisten-Knopf ◐ wurde ständig aus Versehen getippt — die Wahl
 * wohnt jetzt im Options-Modal unter „Anzeige", mit drei Zuständen:
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

  it('Systemwechsel schaltet live um — nur im System-Modus, mit Chart-Neubau', () => {
    const stelle = dashboard.indexOf("systemDunkel?.addEventListener?.('change'");
    expect(stelle, 'matchMedia-Listener fehlt').toBeGreaterThan(0);
    const block = dashboard.slice(stelle, stelle + 300);
    expect(block).toContain("if (themeWahl() !== 'system') return;");
    expect(block).toContain('void rebuildChart();');
  });

  it('manuelle Wahl wird gespeichert und baut die Charts neu', () => {
    expect(dashboard).toContain("localStorage.setItem('autotrd-theme', ouTheme.value);");
    const stelle = dashboard.indexOf("localStorage.setItem('autotrd-theme', ouTheme.value);");
    expect(dashboard.slice(stelle, stelle + 200)).toContain('void rebuildChart();');
  });
});
