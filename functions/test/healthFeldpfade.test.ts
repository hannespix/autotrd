/**
 * Task 38 — Quelltext-Wächter: meta/health.trading wird je Feld per
 * Feldpfad ersetzt. `set(…, {merge: true})` ließ Ausstiegsgründe und
 * Klassen, die aus dem 7-Tage-Fenster gefallen waren, mit alten Zahlen
 * stehen (06.11.: Anteile in exits7t summierten sich auf 1,41).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const snap = readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'snapshotEquity.ts'), 'utf8');

describe('meta/health.trading schreiben', () => {
  it('Feldpfade auf oberster trading-Ebene, update statt set(merge)', () => {
    expect(snap).toMatch(/for \(const \[k, wert\] of Object\.entries\(trading\)\) felder\[`trading\.\$\{k\}`\] = wert;/);
    expect(snap).toMatch(/\.doc\('meta\/health'\)\n\s+\.update\(felder\)/);
  });

  it('set(merge) mit dem ganzen trading-Objekt nur als Erst-Anlage (NOT_FOUND)', () => {
    const treffer = [...snap.matchAll(/set\(\{ equitySnapshot, trading \}, \{ merge: true \}\)/g)];
    expect(treffer.length).toBe(1);
    const vor = snap.slice(Math.max(0, (treffer[0]?.index ?? 0) - 120), treffer[0]?.index ?? 0);
    expect(vor).toMatch(/code !== 5\) throw err;/);
    expect(snap).not.toMatch(/trading: \{\n\s+\.\.\.health,/);
  });
});
