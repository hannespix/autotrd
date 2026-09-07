/**
 * Anschluss-Wächter für die Vergleichslinie (18.08.).
 *
 * Der pure Kern — `benchmarkKurve` — ist in `shared/test/` geprüft. Was hier
 * geprüft wird, ist das, was eine Funktions-Prüfung nie sieht: ob er
 * überhaupt gefüttert wird.
 *
 * Bei `live_tag` ist genau das zwölf Tage lang schiefgegangen: Die Mechanik
 * war richtig, nur hat sie nie jemand mit Daten versorgt, und es gab keinen
 * roten Balken.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const lies = (rel: string): string => readFileSync(join(hier, rel), 'utf8');
const snapshot = lies('../src/scheduled/snapshotEquity.ts');

describe('snapshotEquity füttert die Vergleichslinie', () => {
  it('holt den Indexkurs EINMAL je Lauf, nicht je Konto', () => {
    // Derselbe Kurs für alle Konten — ein Abruf je Konto wäre dieselbe Zahl
    // zum n-fachen Preis.
    expect(snapshot).toContain("const BENCH_SYMBOL = '^GSPC';");
    expect(snapshot).toContain('let benchClose: number | null = null;');
    // Aus `market/{sym}.quote` — derselbe Weg wie für die Positionen; kein
    // Kursabruf nach außen mehr (der alte Marktdatenpfad ist weg).
    const holen = snapshot.indexOf('await lastPrice(BENCH_SYMBOL)');
    expect(snapshot).not.toContain('getQuickQuote');
    const schleife = snapshot.indexOf('for (const userDoc of users.docs');
    expect(holen, 'Indexabruf fehlt').toBeGreaterThan(0);
    if (schleife > 0) expect(holen).toBeLessThan(schleife);
  });

  it('schreibt den ROHEN Kurs in die Tageszeile', () => {
    // Nicht die fertige Kurve: Die hängt an der Basis, und die wandert bei
    // jedem Depot-Schnitt mit.
    expect(snapshot).toContain('...(benchClose !== null ? { benchClose } : {}),');
  });

  it('ein Fehlschlag lässt das Feld weg statt zu raten', () => {
    // Eine erfundene Zahl verfälscht die Linie unsichtbar; eine Lücke ist
    // sichtbar und ehrlich.
    expect(snapshot).toContain('Benchmark-Linie hat heute eine Lücke');
  });
});
