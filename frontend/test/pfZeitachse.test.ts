/**
 * Performance mit Zeitachse (Owner-Thema b, 13.08.).
 *
 * Die Equity-Kurve der Performance-Karte bekommt dieselben Zeitraum-Chips
 * wie die Handels-Analyse (7T/30T/90T/1J/Alles). Das Fenster beschneidet NUR
 * die Eingabe von `depotKurve` (Snapshots + Trades) — Kurvenwahl-Logik und
 * Erklärung bleiben an einer Stelle, und die Kennzahlen im Raster darunter
 * bleiben die Server-Zahlen (Sharpe 30/90, Max-DD tragen ihren Bezugsraum im
 * Namen; eine clientseitig gefensterte Zweitfassung wäre zwei Wahrheiten).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Performance-Zeitachse — Markup und Logik', () => {
  it('die Chip-Leiste sitzt an der Equity-Kurve (zwischen Label und Sparkline)', () => {
    const label = dashboard.indexOf("Equity-Kurve ${iBtn('equityCurve')}");
    const chips = dashboard.indexOf('id="pfZeit"');
    const spark = dashboard.indexOf('id="pfSpark"');
    expect(chips, 'pfZeit fehlt im Markup').toBeGreaterThan(label);
    expect(chips).toBeLessThan(spark);
  });

  it('die Chips nutzen die geteilten ZEITRAEUME und rendern die Karte neu', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderPfZeitChips'));
    expect(fn.slice(0, 700)).toContain('ZEITRAEUME.map');
    expect(fn.slice(0, 1000)).toContain('st.pfZeitraum = Number(b.dataset');
    expect(fn.slice(0, 1000)).toContain('renderPfStats();');
  });

  it('das Fenster beschneidet die depotKurve-EINGABE (Snapshots + Trades)', () => {
    const render = dashboard.slice(dashboard.indexOf('function renderPfStats'));
    expect(render).toContain('const ab = zeitraumBeginn(zr, new Date());');
    expect(render).toContain('snapshots: (st.equitySeries ?? []).filter((p) => Date.parse(p.date) >= ab.getTime())');
    expect(render).toContain('trades: imZeitraum((st.trades ?? []) as HistoryTrade[], zr, new Date())');
    // Alles (0) bleibt exakt der bisherige Weg — kein Fenster, keine Kopie.
    expect(render).toContain('? depotKurve()');
  });

  it('die Meta-Zeile nennt das gewählte Fenster', () => {
    expect(dashboard).toContain("(zr === 0 ? '' : `${zeitraumLabel(zr)} · `) + wahl.hinweis");
  });
});
