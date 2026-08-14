/**
 * Handels-Analyse: Die Kurve muss dasselbe Fenster decken wie die Kennzahlen
 * (Owner-Screenshot 14.08.).
 *
 * Am Morgen nach dem Depot-Schnitt existierten genau zwei Snapshot-Tage
 * (13.+14.08.) — `waehleKurve` bevorzugte die Snapshot-Kurve, obwohl die
 * neun geschlossenen Trades des 30-Tage-Fensters alle VOR dem Schnitt
 * liegen. Die Karte zeigte „−0,04 % · 13.→14.08." (die Margin-Zinsen einer
 * Nacht) über Kennzahlen aus 30 Tagen, eine gerade Linie ohne
 * Trade-Bänder, WOMIT leer. Seitdem gilt: Beginnen die Snapshots erst NACH
 * dem ersten Abschluss des Fensters, erzwingt die Analyse die realisierte
 * Trade-Kurve — sie deckt dieselben Trades wie die Kennzahlen darunter.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Analyse-Kurvenfenster — Quelltext-Wächter', () => {
  it('depotKurve kann die realisierte Kurve erzwingen (minSnapshots = ∞)', () => {
    expect(dashboard).toContain('erzwingeRealisiert = false,');
    expect(dashboard).toContain('erzwingeRealisiert ? Number.POSITIVE_INFINITY : undefined,');
  });

  it('shareDatenBauen prüft die Deckung: erster Snapshot ≤ erster Abschluss', () => {
    const fn = dashboard.slice(dashboard.indexOf('function shareDatenBauen'));
    expect(fn).toContain('const snapshotsDeckenFenster =');
    expect(fn).toContain('ersterSnapshotTag !== null && ersterSnapshotTag <= ersterAbschlussTag');
    // Ohne Abschlüsse im Fenster bleibt die Snapshot-Kurve erste Wahl.
    expect(fn).toContain('ersterAbschlussTag === null');
  });

  it('die Deckungs-Entscheidung ist an die Kurvenwahl ANGESCHLOSSEN', () => {
    // „Funktion korrekt, nur nicht angeschlossen" ist der Serienfehler dieser
    // Woche — der Wächter pinnt den Aufruf, nicht nur die Rechnung.
    const fn = dashboard.slice(dashboard.indexOf('function shareDatenBauen'));
    expect(fn).toContain('{ snapshots: fenster.equity, trades: fenster.trades },\n    !snapshotsDeckenFenster,');
  });
});
