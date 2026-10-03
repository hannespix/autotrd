/**
 * Reibungs-Anzeige (Task #146) — die Messung aus #144 wird sichtbar.
 *
 * Ohne diese Karte lägen die gemessenen Basispunkte nur in Firestore, und
 * die Maker-Entscheidung (Aktien-Einstiege als Limit-Order?) würde wieder
 * aus dem Bauch getroffen — exakt das Raten, das die Messung abschaffen
 * sollte. Die Pins halten die drei Dinge fest, an denen die Karte hängt:
 * die Verdrahtung (Daten → Render), die ENTSCHEIDUNGSSCHWELLEN (5/10 bp)
 * und die Wörterbuch-Zeilen in beiden Sprachen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const data = readFileSync(join(import.meta.dirname, '..', 'src', 'data.ts'), 'utf8');

describe('Reibungs-Anzeige — Verdrahtung', () => {
  it('renderReibung liest stats.reibung und hängt am selben Pfad wie renderCosts', () => {
    const fn = dashboard.indexOf('function renderReibung');
    expect(fn, 'renderReibung fehlt').toBeGreaterThan(0);
    expect(dashboard.slice(fn, fn + 400)).toContain('s.reibung');
    // Beide Renderer laufen im selben Stats-Update — fällt der Aufruf raus,
    // bleibt die Karte für immer auf dem Platzhalter stehen.
    const costs = dashboard.indexOf('renderCosts(s);');
    const reibung = dashboard.indexOf('renderReibung(s);');
    expect(costs).toBeGreaterThan(0);
    expect(reibung).toBeGreaterThan(costs);
  });

  it('PortfolioStatsDoc kennt das reibung-Feld, das snapshotEquity schreibt', () => {
    expect(data).toContain('reibung?: Record<string, ReibungJeKlasse>;');
  });

  it('die Ampel trägt die Entscheidungsschwellen 5 und 10 bp am US-Aktien-Einstieg', () => {
    /* Die Regel aus Task #144: <5 bp kein Maker-Umbau, 5–10 Schatten,
     * >10 Umbau fällig. Wer die Schwellen verstellt, verstellt die
     * Entscheidung — das gehört in einen Commit mit Begründung, nicht in
     * eine stille Änderung. */
    const fn = dashboard.slice(dashboard.indexOf('function renderReibung'));
    const kopf = fn.slice(0, 1200);
    expect(kopf).toContain("k === 'stocks_us'");
    expect(kopf).toContain('z.einstieg.avgBp > 10');
    expect(kopf).toContain('z.einstieg.avgBp >= 5');
  });

  it('alle vier Anzeige-Zeilen stehen DE und EN im Wörterbuch', () => {
    for (const k of [
      'pf.fillReibung',
      'pf.reibungKeineFills',
      'pf.reibungEinstieg',
      'pf.reibungAusstieg',
    ] as const) {
      expect(DE[k], `${k} ohne DE`).toBeTruthy();
      expect(EN[k], `${k} ohne EN`).toBeTruthy();
    }
  });
});
