/** Task 21, Phase 2: „Warum NICHT gekauft" in Alltagssprache. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ABSAGE_GRUENDE, absageGespeichert } from '@autotrd/shared';
import { absageText, absageWeitere } from '../src/absageText.js';
import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const e = (grund: string, z: Record<string, unknown> = {}, je: Record<string, number> = {}) =>
  absageGespeichert('AAPL', { grund, seite: 'long', weg: 'konfluenz', zuletzt: '2026-10-09T15:00:00.000Z', n: 4, je, z })!;

describe('absageText', () => {
  it('Kostenhürde nennt die Zahlen, die entschieden haben', () => {
    expect(absageText(e('unter_kosten', { erwartetPct: 0.41, noetigPct: 0.9 }))).toBe('Erwartete Bewegung zu klein für die Gebühren: erwarteter Gewinn 0,41 %, nötig 0,9 %');
    expect(absageText(e('unter_kosten'))).toBe('Erwartete Bewegung zu klein für die Gebühren');
  });

  it('Deckel, Wartezeit, Steckbrief mit Zahlen; weitere Gründe des Tages', () => {
    expect(absageText(e('pos_limit', { offen: 5, limit: 5 }))).toBe('Höchstzahl offener Positionen erreicht (5/5)');
    expect(absageText(e('cooldown_aktiv', { cooldownMin: 30 }))).toBe('Wartezeit nach dem letzten Trade in diesem Wert (30 Min.)');
    expect(absageText(e('filter_blockiert', { steckbriefN: 42 }))).toBe('Diese Art Einstieg hat bisher nachweislich Geld verloren (42 frühere Trades)');
    expect(absageWeitere(e('unter_kosten', {}, { unter_kosten: 3, cooldown_aktiv: 1 }))).toBe('außerdem: 1× Wartezeit nach dem letzten Trade in diesem Wert');
  });

  it('gescheiterte Ausführung und „nicht handelbar" sagen, was wirklich passiert ist', () => {
    expect(absageText(e('ausfuehrung_abgelehnt'))).toContain('Alle Prüfungen bestanden, aber der Auftrag kam nicht zustande');
    expect(absageText(e('nicht_handelbar'))).not.toContain('Markt geschlossen');
  });

  it('jeder Grund hat einen Text auf Deutsch und Englisch', () => {
    for (const g of ABSAGE_GRUENDE) {
      expect(DE[`abs.${g}` as keyof typeof DE], g).toBeTruthy();
      expect(EN[`abs.${g}` as keyof typeof EN], g).toBeTruthy();
    }
  });

  it('Anzeige nur über textContent/escText — kein gespeicherter Wert roh im Markup', () => {
    expect(dashboard).toContain("el.querySelector('.abs-grund')!.textContent = weitere ? `${grund} — ${weitere}` : grund;");
    expect(dashboard).toContain("el.querySelector('.abs-sym')!.textContent = e.symbol;");
  });
});
