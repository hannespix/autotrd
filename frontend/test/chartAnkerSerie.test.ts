/**
 * Wächter für die Anker-Serie im Chart-Modul.
 *
 * ── Was dieser Test IST und was er NICHT ist ──────────────────────────────
 *
 * Er liest den QUELLTEXT von `chart.ts` und prüft, dass Marker, Preislinien
 * und die Koordinaten-Umrechnung an `lineHost` hängen statt an `candle`. Er
 * beweist damit NICHT, dass der Chart zeichnet — dafür braucht es einen
 * Browser, und den liefert `frontend/e2e/chart-shot.mjs` (zählt Marker-Pixel
 * je Chart-Typ in Signalfarben, 25 Prüfungen).
 *
 * Warum er trotzdem hier steht: Der Prüfstand braucht Chromium und läuft
 * deshalb nicht in CI. Dieser Wächter ist die billige Rückfall-Sperre, die
 * bei jedem `npx vitest run` mitläuft — nicht mehr, aber auch nicht weniger.
 *
 * ── Der Fehler, den er sperrt ─────────────────────────────────────────────
 *
 * Lightweight Charts zeichnet nichts, was an einer `visible: false`-Serie
 * hängt. Die Kerzen-Serie ist genau dann unsichtbar, wenn der Nutzer
 * Linie/Berg/Baseline/Bars wählt oder den Vektor-Look einschaltet. Owner
 * 11.08.: „bei Linie, Berg, baseline, Bars … werden die Punkte und die ganzen
 * anderen Nachrichten-Zeichnungen einfach nicht im Chart gerendert!"
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const quelle = readFileSync(new URL('../src/chart.ts', import.meta.url), 'utf8');

/** Der Rumpf einer Methode aus dem zurückgegebenen Handle-Objekt. */
function rumpf(name: string): string {
  const start = quelle.indexOf(`    ${name}(`);
  expect(start, `Methode ${name} nicht gefunden`).toBeGreaterThan(-1);
  const ende = quelle.indexOf('\n    },', start);
  return quelle.slice(start, ende === -1 ? start + 800 : ende);
}

describe('Chart: Anker-Serie trägt alles, was nicht der Kurs ist', () => {
  it('setMarkers hängt an lineHost, nicht an der Kerzen-Serie', () => {
    const body = rumpf('setMarkers');
    expect(body).toContain('lineHost.setMarkers(');
    expect(body).not.toContain('candle.setMarkers(');
  });

  it('coords rechnet über lineHost um', () => {
    const body = rumpf('coords');
    expect(body).toContain('lineHost.priceToCoordinate(');
    expect(body).not.toContain('candle.priceToCoordinate(');
  });

  it('onClick rechnet über lineHost um', () => {
    const body = rumpf('onClick');
    expect(body).toContain('lineHost.coordinateToPrice(');
    expect(body).not.toContain('candle.coordinateToPrice(');
  });

  it('setPriceLines hängt an lineHost', () => {
    const body = rumpf('setPriceLines');
    expect(body).toContain('lineHost.createPriceLine(');
    expect(body).not.toContain('candle.createPriceLine(');
  });

  it('die Anker-Serie wird bedingungslos gefüttert', () => {
    // Eine leere Serie kennt weder Zeitpunkte (Marker verschwinden) noch eine
    // Preisskala (priceToCoordinate liefert null). Frühere Fassung fütterte
    // nur, solange Preislinien hingen — für Marker zu wenig.
    const start = quelle.indexOf('const feedLineHost');
    expect(start).toBeGreaterThan(-1);
    const body = quelle.slice(start, start + 300);
    expect(body).toContain('lineHost.setData(');
    expect(body).not.toContain('lineHostFed');
    expect(quelle).not.toContain('lineHostFed');
  });

  it('setBars füttert die Anker-Serie mit', () => {
    expect(rumpf('setBars')).toContain('feedLineHost()');
  });
});
