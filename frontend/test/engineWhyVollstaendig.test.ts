/**
 * Was der Server zählt, muss die Karte auch zeigen (Kapital-Panel 21.08.).
 *
 * Die Engine-Why-Karte listet Ablehnungsgründe aus `EntryGateStats`. Kommt
 * serverseitig ein Grund dazu, ohne dass die Liste im Dashboard nachzieht,
 * zählt die Engine ihn still mit — und die Karte behauptet weiter, es sei
 * „nichts abgelehnt" worden. Genau diese Lücke war der Grund, warum die
 * Frage „warum nur 1–2 Positionen?" monatelang unbeantwortbar blieb.
 *
 * Dieser Test liest BEIDE Dateien und vergleicht sie.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lese = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', '..', ...teile), 'utf8');

const scan = lese('functions', 'src', 'scheduled', 'scanMarket.ts');
const dashboard = lese('frontend', 'src', 'dashboard.ts');

/** Felder der EntryGateStats-Struktur (ohne Kommentare). */
function gateFelder(): string[] {
  const start = scan.indexOf('export interface EntryGateStats {');
  const ende = scan.indexOf('\n}', start);
  return [...scan.slice(start, ende).matchAll(/^\s{2}(\w+): number;$/gm)].map((m) => m[1]!);
}

describe('Engine-Why-Karte zeigt jeden Grund, den der Scan zählt', () => {
  it('kein Ablehnungsgrund fehlt in GATE_TEXT', () => {
    /* Ausgenommen sind die Zähler, die KEINE Ablehnung sind: die
     * Bezugsgröße, zwei Durchlass-/Schatten-Zahlen und die Leih-Teilmenge
     * von unter_kosten (sie würde doppelt zählen). */
    const keineAblehnung = new Set([
      'geprueft',
      'ohne_atr_durchgelassen',
      'kante_wuerde_blocken',
      'short_zins_blockt',
    ]);
    const block = dashboard.slice(
      dashboard.indexOf('const GATE_TEXT'),
      dashboard.indexOf('const REGIME_TEXT'),
    );
    const fehlend = gateFelder().filter((f) => !keineAblehnung.has(f) && !block.includes(`'${f}'`));
    expect(fehlend, `ohne Anzeige-Text: ${fehlend.join(', ')}`).toEqual([]);
  });

  it('die drei stillen Bremsen stehen in der Liste', () => {
    for (const f of ['pos_limit', 'cooldown_aktiv', 'sockel_besitz']) {
      expect(gateFelder(), `${f} wird gar nicht gezählt`).toContain(f);
      expect(dashboard, `${f} ohne Anzeige`).toContain(`['${f}', t(`);
    }
  });

  it('„knapp verfehlt" und die Trend-Regel stehen nebeneinander in der Ampel-Zeile', () => {
    /* Einzeln sind beide Zahlen mehrdeutig: Viele Grenzfälle können heißen
     * „Schwelle zu hoch" ODER „Ampel selten grün". Erst zusammen sagen sie,
     * ob die Trend-Regel greift. */
    expect(dashboard).toContain('const knapp = h.knappVerfehlt ?? 0;');
    expect(dashboard).toContain("const soloAn = h.trendSolo?.erzeugt ?? 0;");
    expect(dashboard).toContain("t('ew.knappVerfehlt')");
    expect(dashboard).toContain("t('ew.trendSoloErzeugt')");
    // Eine Null wäre Rauschen — der Chip erscheint nur bei echten Grenzfällen.
    expect(dashboard).toContain('if (knapp > 0) {');
  });
});
