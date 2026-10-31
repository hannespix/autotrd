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

describe('meta/positioning schreiben', () => {
  const start = lauf.indexOf('async function messePositionierung(');
  const rumpf = lauf.slice(start, lauf.indexOf('\n}\n', start));

  it('ersetzt das Dokument als Ganzes — kein merge der Maps oi/auffaellig/zustaende', () => {
    expect(start).toBeGreaterThan(0);
    const aufrufe = [...rumpf.matchAll(/ref\.set\(([\s\S]*?)\n {4}\);/g)].map((m) => m[1] ?? '');
    expect(aufrufe.length).toBe(1);
    expect(aufrufe[0]).toMatch(/auffaellig/);
    expect(aufrufe[0]).not.toMatch(/merge/);
  });

  it('schreibt nicht, wenn Kraken gar nichts liefert', () => {
    const leer = rumpf.indexOf('readings.size === 0 && oiJetzt.size === 0');
    expect(leer).toBeGreaterThan(0);
    expect(rumpf.indexOf('ref.set(')).toBeGreaterThan(leer);
  });
});

describe('Archiv vor dem Überschreiben', () => {
  it('ohne Archiv kein Schreiben des Buchs', () => {
    expect(lauf).toMatch(/if \(buchSchreiben\) await bookRef\.set\(\{ book, updatedAt: now\.toISOString\(\), neustart \}\)/);
    expect(lauf).toMatch(/if \(buchSchreiben\) await bookRef\.set\(\{\n/);
  });
});

describe('weitere Schreibstellen derselben Fehlerklasse (Sweep 31.10.)', () => {
  const scan = readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'scanMarket.ts'), 'utf8');
  const adopt = readFileSync(join(import.meta.dirname, '..', 'src', 'callable', 'adoptBroker.ts'), 'utf8');

  it('Regelbaum-Schatten: shadow.positions per Feldpfad, nicht per merge', () => {
    expect(scan).toMatch(/patch\['shadow\.positions'\] = book\.positions;/);
    const ab = scan.indexOf("patch['shadow.positions']");
    const schreiben = scan.indexOf('await ref.', ab);
    expect(scan.slice(schreiben, schreiben + 40)).toMatch(/^await ref\.update\(patch\)/);
  });

  it('adoptBroker ersetzt risk.abgleich als Ganzes (keine stehenbleibenden abweichungSymbole)', () => {
    expect(adopt).toMatch(/b\.update\(userRef, new FieldPath\('risk', 'abgleich'\), \{/);
    expect(adopt).not.toMatch(/risk: \{\s*abgleich: \{/);
  });
});
