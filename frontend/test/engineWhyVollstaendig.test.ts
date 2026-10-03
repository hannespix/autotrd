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
     * Bezugsgröße, Durchlass-/Schatten-Zahlen und die Leih-Teilmenge
     * von unter_kosten (sie würde doppelt zählen).
     *
     * Eine Ausnahme ist kein Freibrief. `quote_wuerde_blocken` steht hier
     * NUR, weil es keine Ablehnung ist — sichtbar sein muss es trotzdem,
     * und genau das prüft der Test darunter. Wer einen Zähler hier einträgt
     * und ihn nirgends zeigt, baut wieder die Lücke, gegen die diese Datei
     * geschrieben wurde. */
    const keineAblehnung = new Set([
      'geprueft',
      'ohne_atr_durchgelassen',
      'kante_wuerde_blocken',
      'short_zins_blockt',
      'quote_wuerde_blocken',
    ]);
    const block = dashboard.slice(
      dashboard.indexOf('const GATE_TEXT'),
      dashboard.indexOf('const REGIME_TEXT'),
    );
    const fehlend = gateFelder().filter((f) => !keineAblehnung.has(f) && !block.includes(`'${f}'`));
    expect(fehlend, `ohne Anzeige-Text: ${fehlend.join(', ')}`).toEqual([]);
  });

  it('der Quoten-Schatten hat einen eigenen Chip statt einer GATE_TEXT-Zeile', () => {
    /* Hebel 1a (22.08.): Die gemessene Einfangquote stand seit dem 11.08.
     * im Herzschlag und wirkte nie — weil sie niemand ansah. Der Zähler,
     * der das beziffert, darf nicht dasselbe Schicksal erleiden. */
    expect(gateFelder(), 'Zähler wird gar nicht erhoben').toContain('quote_wuerde_blocken');
    expect(dashboard).toContain("h.entryGate?.quote_wuerde_blocken ?? 0");
    expect(dashboard).toContain("t('ew.quoteSchatten')");
    expect(dashboard).toContain("t('ew.quoteTitel')");
    // Nur bei echten Grenzfällen — eine Null wäre Rauschen.
    expect(dashboard).toContain('if (quoteSchatten > 0) {');
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

/* ── Nachbuchungs-Rückstand (Owner-Fund 21.08.) ────────────────────────── */

describe('Der Nachbuchungs-Rückstand erreicht die Karte', () => {
  /* Derselbe Fehlertyp wie oben, eine Ebene tiefer: Der Scan zählt seit
   * heute mit, wie viele Fills die Heilung aufgegeben hat. Bliebe die Zahl
   * im Herzschlag-Dokument stehen, wäre exakt nichts gewonnen — dass
   * niemand den Rückstand sah, WAR der Fehler, nicht nur seine Begleitung.
   * Der Owner fragte „funktioniert die Selbstheilung nicht?", weil die App
   * die Antwort nicht anzeigte. */
  it('der Scan schreibt ihn in den Herzschlag', () => {
    expect(scan).toContain('nachbuchung: nachbuchungLaufGesamt,');
  });

  it('das Dashboard liest ihn und zeigt einen Chip, wenn etwas feststeckt', () => {
    expect(dashboard).toContain('const steckt = h.nachbuchung?.steckt ?? 0;');
    expect(dashboard).toContain("whyChip(`${steckt} ${t('ew.nachbuchungSteckt')}`, 'var(--rd)')");
  });

  it('eine Null erzeugt KEINEN Chip — sonst steht dauerhaft eine Beruhigung da', () => {
    const stelle = dashboard.indexOf('const steckt = h.nachbuchung?.steckt ?? 0;');
    expect(stelle).toBeGreaterThan(-1);
    expect(dashboard.slice(stelle, stelle + 200)).toContain('if (steckt > 0) {');
  });

  it('der Typ kennt das Feld — inklusive „nicht gemessen"', () => {
    const daten = lese('frontend', 'src', 'data.ts');
    expect(daten).toMatch(/nachbuchung\?: \{[\s\S]{0,200}steckt\?: number;/);
    // `| null` trennt „nicht gemessen" von „nichts gefunden".
    expect(daten).toMatch(/konten\?: number;\s*\n\s*\} \| null;/);
  });
});
