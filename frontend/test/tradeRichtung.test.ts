/**
 * Wächter der Richtungs-Marken im Trade-Verlauf (Owner 21.08., 21:3x:
 * „im Trade Verlauf sollen Shorts und Longs besser markiert werden").
 *
 * Der springende Punkt: BUY/SELL allein ist ZWEIDEUTIG — ein Leerverkauf
 * ist ein SELL, sein Eindecken ein BUY. Ein Short-Einstieg sah in der alten
 * Anzeige exakt aus wie ein Long-Ausstieg.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DE, EN } from '../src/i18n.js';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const css = lese('../src/theme.css');
const data = lese('../src/data.ts');

describe('Trade-Verlauf — vier Geschäftsarten, vier Marken', () => {
  it('die Broker-Marken short/cover sind im Frontend-Typ angekommen', () => {
    // Ohne diese Felder KANN die Anzeige die Richtung nicht kennen — der
    // Broker schreibt sie seit dem Short-Umbau mit.
    expect(data).toContain('short?: boolean;');
    expect(data).toContain('cover?: boolean;');
  });

  it('tradeRichtung unterscheidet Short-Eröffnung, Cover und beide Long-Seiten', () => {
    expect(dashboard).toContain('function tradeRichtung(zeile: {');
    // Short-Eröffnung und Cover werden VOR side geprüft — sonst gewinnt
    // die zweideutige buy/sell-Verzweigung.
    expect(dashboard).toContain("if (zeile.short === true) {");
    expect(dashboard).toContain("if (zeile.cover === true) {");
    expect(dashboard).toContain("return zeile.side === 'buy'");
    // Nur die FARB-Klasse — das `stag` steht schon im Zellen-Template
    // (doppeltes stag wäre stiller Klassen-Müll).
    for (const teil of ["klasse: 't-short'", "klasse: 't-cover'", "klasse: 't-buy'", "klasse: 't-sell'"]) {
      expect(dashboard, `Marke fehlt: ${teil}`).toContain(teil);
    }
    expect(dashboard).not.toContain("klasse: 'stag ");
    // Der Parametername darf t() nicht verschatten (Falle aus renderMomentum).
    expect(dashboard).toContain('// `zeile`, nicht `t`: Der Parametername würde die Übersetzungsfunktion');
  });

  it('die Marke steht in der Zeile — mit Pfeil, Text und Erklär-Titel', () => {
    expect(dashboard).toContain('const ri = tradeRichtung(t);');
    expect(dashboard).toContain('<span class="stag ${ri.klasse}" title="${escText(ri.titel)}" aria-label="${escText(ri.titel)}">${ri.pfeil} ${escText(ri.text)}</span>');
  });

  it('nicht nur Farbe: Pfeil UND Wort tragen die Richtung (Barrierefreiheit)', () => {
    // Screenreader bekommen die volle Erklärung, nicht nur „▲ Short".
    expect(dashboard).toContain('aria-label="${escText(ri.titel)}"');
    // ▲ für Käufe (Long auf, Short zu), ▼ für Verkäufe (Long zu, Short auf).
    expect((dashboard.match(/pfeil: '▲'/g) ?? []).length).toBe(2);
    expect((dashboard.match(/pfeil: '▼'/g) ?? []).length).toBe(2);
  });

  it('CSS: Short-Seiten tragen zusätzlich einen gestrichelten Rahmen', () => {
    expect(css).toContain('.t-short { background: var(--rd-soft); color: var(--rd); border: 1px dashed var(--rd); }');
    expect(css).toContain('.t-cover { background: var(--gn-soft); color: var(--gn); border: 1px dashed var(--gn); }');
  });

  it('alle vier Marken und ihre Titel gibt es auf Deutsch UND Englisch', () => {
    // Die Marken-Wörter sind in beiden Sprachen Fachbegriffe (Long/Short) —
    // dort ist Gleichheit KORREKT; die Erklär-Titel müssen sich unterscheiden.
    for (const k of ['jn.long', 'jn.short'] as const) {
      expect(DE[k], `${k} ohne deutschen Text`).toBeTruthy();
      expect(EN[k], `${k} ohne englische Fassung`).toBeTruthy();
    }
    for (const k of ['jn.longAufTitel', 'jn.longZuTitel',
      'jn.shortAufTitel', 'jn.shortZuTitel'] as const) {
      expect(DE[k], `${k} ohne deutschen Text`).toBeTruthy();
      expect(EN[k], `${k} ohne englische Fassung`).toBeTruthy();
      expect(EN[k], `${k}: EN ist nur die deutsche Kopie`).not.toBe(DE[k]);
    }
  });
});
