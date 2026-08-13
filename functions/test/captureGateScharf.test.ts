/**
 * Quelltext-Wächter: Die Einfangquote entscheidet die Kostenschwelle —
 * Opt-out statt Opt-in (Task 94, 13.08.).
 *
 * Der Flip ist eine einzige Zeile in scanMarket; genau deshalb braucht er
 * einen Wächter. Rutscht die Entscheidung zurück auf `=== true` (die alte
 * Opt-in-Fassung), handeln alle Konten ohne gesetztes Feld wieder ohne
 * Kanten-Prüfung — und die Klassen-Attribution hat live gezeigt, was das
 * kostet (Krypto −625 $ bei 1 316 $ Gebühren, Forex −245 $). Der Test
 * kodiert die Semantik, nicht nur die Zeichenkette: unset ⇒ Kante zählt,
 * `false` ⇒ ausdrückliches Opt-out je Konto.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_STRATEGY } from '../../shared/src/index.js';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

describe('captureGate scharf — Opt-out statt Opt-in', () => {
  it('die Entscheidungszeile wertet `!== false` (unset ⇒ Kante zählt)', () => {
    const treffer = scan.match(/captureGate !== false \? mitKante : kostenOhneKante/g) ?? [];
    expect(treffer, 'Entscheidungszeile fehlt oder ist dupliziert').toHaveLength(1);
  });

  it('die alte Opt-in-Fassung (`=== true`) ist restlos verschwunden', () => {
    expect(scan).not.toContain('captureGate === true');
  });

  it('der Schattenzähler bleibt und zählt weiter NACH der Entscheidung', () => {
    // Für Opt-out-Konten bleibt `kante_wuerde_blocken` die einzige Sicht
    // darauf, was die Kante verhindert hätte; für alle anderen steht er
    // konstruktionsbedingt auf 0 (kosten === mitKante). Beides ist nur
    // ehrlich, solange die Zeile exakt so gebaut bleibt.
    const zaehler = scan.indexOf('if (kosten.ok && !mitKante.ok) gate.kante_wuerde_blocken += 1;');
    const entscheidung = scan.indexOf('captureGate !== false');
    expect(zaehler, 'Schattenzähler fehlt').toBeGreaterThan(0);
    expect(entscheidung).toBeGreaterThan(0);
    expect(zaehler).toBeGreaterThan(entscheidung);
  });

  it('DEFAULT_STRATEGY dokumentiert den Standard AN', () => {
    expect(DEFAULT_STRATEGY.signals.captureGate).toBe(true);
  });
});
