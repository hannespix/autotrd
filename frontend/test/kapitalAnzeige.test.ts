/**
 * Investitionsquote-Anzeige (Owner 20.08.: „das Ziel ist, Depot und Geld
 * arbeiten zu lassen — es geht nicht darum, alles als Bargeld liegen zu
 * lassen").
 *
 * Die Karte ist die Sichtbarkeits-Hälfte des Sockel-Nachschubs (#345):
 * Der Hebel kauft gehaltene Positionen ans Zielgewicht zurück — ob das
 * Bargeld dadurch wirklich schrumpft, muss ablesbar sein, sonst ist der
 * Umbau ein Blindflug. Die Pins halten die Verdrahtung (Daten → Render),
 * die Ampel-Schwellen (50/25 % Bargeld) und die Wörterbuch-Zeilen fest.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DE, EN } from '../src/i18n.js';
import { INFO_DE, INFO_EN } from '../src/infotips.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const data = readFileSync(join(import.meta.dirname, '..', 'src', 'data.ts'), 'utf8');

describe('Investitionsquote — Verdrahtung', () => {
  it('renderKapital liest stats.kapital und läuft im selben Stats-Update wie renderReibung', () => {
    const fn = dashboard.indexOf('function renderKapital');
    expect(fn, 'renderKapital fehlt').toBeGreaterThan(0);
    expect(dashboard.slice(fn, fn + 400)).toContain('s.kapital');
    // Fällt der Aufruf raus, bleibt die Karte für immer auf dem Platzhalter.
    const reibung = dashboard.indexOf('renderReibung(s);');
    const kapital = dashboard.indexOf('renderKapital(s);');
    expect(reibung).toBeGreaterThan(0);
    expect(kapital).toBeGreaterThan(reibung);
  });

  it('PortfolioStatsDoc kennt das kapital-Feld, das snapshotEquity schreibt', () => {
    expect(data).toContain('kapital?: {');
    expect(data).toContain('investiertPct: number;');
    expect(data).toContain('cashPct: number;');
  });

  it('die Ampel hängt am Bargeld-Anteil mit den Schwellen 50 und 25', () => {
    /* Über 50 % Bargeld arbeitet weniger als die Hälfte des Depots (rot),
     * unter 25 % ist das Kapital im Einsatz (grün). Dazwischen neutral —
     * ein geschlossener Marktfilter parkt den Sockel BEWUSST in Cash, und
     * Schutz darf nicht wie ein Fehler aussehen. Wer die Schwellen
     * verstellt, verstellt diese Aussage — Commit mit Begründung. */
    const fn = dashboard.slice(dashboard.indexOf('function renderKapital'));
    const kopf = fn.slice(0, 1200);
    expect(kopf).toContain('k.cashPct > 50');
    expect(kopf).toContain('k.cashPct > 25');
  });

  it('NEGATIVES Cash (Margin-Schulden) ist ROT, nie grün', () => {
    /* Red-Team-Befund 3 (20.08.): Ein Margin-Konto hat cashPct < 0 — die
     * alte Ampel (`< 25 → grün`) färbte Schulden als „Kapital im Einsatz".
     * Kredit ist der teuerste Zustand der Karte, nicht der beste. */
    const fn = dashboard.slice(dashboard.indexOf('function renderKapital'));
    expect(fn.slice(0, 1200)).toContain("k.cashPct < 0 || k.cashPct > 50 ? 'c-rd'");
  });

  it('alle Anzeige-Zeilen stehen DE und EN im Wörterbuch, der ⓘ-Tipp in beiden Sprachen', () => {
    for (const k of [
      'pf.kapitalEinsatz',
      'pf.kapitalKeineDaten',
      'pf.kapitalInvestiert',
      'pf.kapitalSockel',
      'pf.kapitalAktiv',
      'pf.kapitalBargeld',
    ] as const) {
      expect(DE[k], `${k} ohne DE`).toBeTruthy();
      expect(EN[k], `${k} ohne EN`).toBeTruthy();
    }
    expect(INFO_DE['kapitalEinsatz'], 'Infotip DE fehlt').toBeTruthy();
    expect(INFO_EN['kapitalEinsatz'], 'Infotip EN fehlt').toBeTruthy();
  });
});
