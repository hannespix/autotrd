/**
 * Task 36 — Quelltext-Wächter: Das Momentum-Schattenbuch wird als GANZES
 * ersetzt, nie gemischt. `set(…, {merge: true})` mischt verschachtelte Maps:
 * ein verkauftes Symbol blieb in `holdings` stehen, sein Erlös lag schon im
 * Bargeld — aus 25.000 $ wurden 1,26 Mio. Und ein Buch, dessen Bilanz nicht
 * aufgeht, wird vor jeder Verwendung erkannt.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const lauf = readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'momentumRun.ts'), 'utf8');

describe('Momentum-Schattenbuch schreiben', () => {
  it('kein merge auf meta/momentumBook', () => {
    const schreibstellen = [...lauf.matchAll(/bookRef\.set\(([\s\S]*?)\);/g)].map((m) => m[1] ?? '');
    expect(schreibstellen.length).toBeGreaterThanOrEqual(2);
    for (const s of schreibstellen) expect(s).not.toMatch(/merge/);
    expect(lauf).not.toMatch(/bookRef\.update\(/);
  });

  it('Bilanz wird geprüft, bevor das gelesene Buch weiterverwendet wird', () => {
    const lesen = lauf.indexOf("bookSnap.get('book')");
    const pruefen = lauf.indexOf('momentumBuchStimmig(gelesen)');
    const rebalance = lauf.indexOf('istRebalanceFaellig(book.lastRebalance');
    expect(lesen).toBeGreaterThan(0);
    expect(pruefen).toBeGreaterThan(lesen);
    expect(rebalance).toBeGreaterThan(pruefen);
  });
});
