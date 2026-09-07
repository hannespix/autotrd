/**
 * Anschluss-Wächter: Hängt die Regler-ENTSCHEIDUNG wirklich am
 * haltedauer-gerechten Schatten? (17.08.)
 *
 * Die pure Mechanik steht in `shared/src/classShadow.ts` und ist dort
 * getestet. Was diese Datei prüft, ist, dass `snapshotEquity` das RICHTIGE
 * Aggregat liest (`klassenHalte`, nicht die alte Fünf-Minuten-Reihe). Der
 * Schreiber dieses Aggregats war der alte Scan; solange kein neuer Schreiber
 * existiert, bleibt der Schatten-Beleg leer und `rateKlasse` lässt die
 * Gewichte stehen — die STRENGERE Seite.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');

describe('snapshotEquity: die Entscheidung liest die richtige Reihe', () => {
  it('der Schatten-BELEG kommt aus klassenHalte', () => {
    expect(snapshot).toContain(
      "const roh = (doc.get('klassenHalte') as Record<string, SchattenKlasse> | undefined) ?? {};",
    );
    // Genau eine Zeile darf `schattenGlobal` füllen, und sie muss aus `roh`
    // kommen — die alte Reihe steht nur noch zum Auffüllen der Liste bereit.
    expect(snapshot).toContain('schattenGlobal = Object.fromEntries(\n      Object.entries(roh).map');
  });

  it('die alte Reihe darf die Liste füllen, aber nichts belegen', () => {
    expect(snapshot).toContain('schattenKlassenBekannt = [...new Set([...Object.keys(roh), ...Object.keys(rohAlt)])];');
    expect(snapshot).toContain('ergebnisse[klasse] ??= { n: 0, kantePct: null, ...(s ? { schatten: s } : {}) };');
  });

  it('der Schatten geht unverändert als `schatten` in die Bewertung', () => {
    // Er darf ausschließlich ZURÜCKHOLEN (classAdvisor Schritt 2) — diese
    // Zeile ist der einzige Weg dorthin.
    expect(snapshot).toContain('...(schattenGlobal[klasse] ? { schatten: schattenGlobal[klasse] } : {}),');
  });
});
