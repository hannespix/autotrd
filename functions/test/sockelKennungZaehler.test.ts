/**
 * Task 32, Messung zuerst: Sockel-Positionen ohne `core`-Kennung zählen.
 *
 * Vor #566 verloren nachgebuchte Sockel-Fills die Kennung; solche
 * Positionen laufen weiter mit 2-%-Stop und Doppelkauf-Sperre. Bevor
 * irgendetwas repariert wird, muss feststehen, wie viele es gibt — und
 * nur die ANZAHL ist öffentlich, die Symbolliste bleibt im privaten
 * Konto-Dokument.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');

describe('Sockel ohne Kennung zählen (Task 32)', () => {
  it('zählt je Position: Kern ODER Sockel-Quelle ohne Kern, nie beides', () => {
    expect(snapshot).toContain('if (pos.core === true) sockelKennung.mitKern += 1;');
    expect(snapshot).toContain("else if (pos.quelle === 'sockel') sockelOhneKennung.push(pos.symbol ?? id);");
    expect(snapshot).toContain('sockelKennung.ohneKennung += sockelOhneKennung.length;');
    expect(snapshot).toContain('if (sockelOhneKennung.length > 0) sockelKennung.konten += 1;');
  });

  it('öffentlich nur Anzahlen, die Symbolliste nur im privaten Konto-Dokument', () => {
    const health = snapshot.indexOf("await db.doc('meta/health').set(\n");
    const oeffentlich = snapshot.indexOf('        sockelKennung,\n', health);
    expect(health).toBeGreaterThan(-1);
    expect(oeffentlich).toBeGreaterThan(health);
    expect(snapshot.indexOf('sockelOhneKennung,', health)).toBe(-1);
    expect(snapshot).toContain('        sockelOhneKennung,\n        costs,\n');
  });

  it('repariert nichts — kein Schreiben von core im Abendlauf', () => {
    // Objekt-Literal UND Zuweisung — `core === true` (Vergleich) bleibt erlaubt.
    expect(snapshot).not.toMatch(/core\s*(?::|=(?!=))\s*true/);
  });
});
