/**
 * Anschluss-Wächter für die Vergleichslinie und ihre Nachbarn (18.08.).
 *
 * Die drei puren Kerne — `benchmarkKurve`, `messeBreite` und die
 * Slot-Mechanik — sind in `shared/test/` geprüft. Was hier geprüft wird, ist
 * das, was eine Funktions-Prüfung nie sieht: ob sie überhaupt gefüttert und
 * gefragt werden.
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
const momentum = lies('../src/scheduled/momentumRun.ts');
const scan = lies('../src/scheduled/scanMarket.ts');

describe('snapshotEquity füttert die Vergleichslinie', () => {
  it('holt den Indexkurs EINMAL je Lauf, nicht je Konto', () => {
    // Derselbe Kurs für alle Konten — ein Abruf je Konto wäre dieselbe Zahl
    // zum n-fachen Preis.
    expect(snapshot).toContain("const BENCH_SYMBOL = '^GSPC';");
    expect(snapshot).toContain('let benchClose: number | null = null;');
    const holen = snapshot.indexOf('await getQuickQuote(BENCH_SYMBOL)');
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

describe('die Marktbreite wird gemessen — und bleibt ein Beobachter', () => {
  it('sie entsteht aus dem Ranking, das ohnehin läuft', () => {
    expect(momentum).toContain('const breite = messeBreite(rankedAlle.map((r) => r.score));');
    expect(momentum).toContain('      breite,');
  });

  it('sie steuert NICHTS', () => {
    /* Der Riegel dieses PRs. An `regime.state` hängen fünf Mechanismen —
     * Einstiegssperre, Cooldown, Positionsgröße, Journal-Kontext und seit
     * dem 17.08. die Trendstimme. Ein neuer Eingang dort verstellte alle
     * fünf gleichzeitig, und die wahrscheinlichste Folge wäre, dass „Trend"
     * seltener wird und `trendSolo` wieder verstummt. */
    expect(scan).not.toContain('messeBreite');
    expect(momentum).not.toMatch(/if\s*\([^)]*breite\./);
  });
});

describe('die Trendstimme wird ab jetzt einzeln abgerechnet', () => {
  it('ein Kauf unter der Konfluenz-Schwelle trägt sein Herkunfts-Etikett', () => {
    // Ein Feature, dessen Ertrag man nicht isolieren kann, kann man auch
    // nicht verantworten — und seit dem 17.08. steht genau diese Frage im
    // Raum (Gebührenanteil 57 % → 68 %).
    expect(scan).toContain(
      '...(konfluenz < clamped.signals.minConfluence ? { soloTrend: true } : {}),',
    );
  });

  it('nur EINSTIEGE tragen es, nicht die Ausstiege', () => {
    // Ein Ausstieg hat keine Herkunft in diesem Sinn; ihn mitzuetikettieren
    // würde die spätere Auswertung verdoppeln.
    const treffer = scan.split('soloTrend: true').length - 1;
    expect(treffer).toBe(1);
  });
});
