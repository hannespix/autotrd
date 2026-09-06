/**
 * Leser des gespeicherten Alpaca-Universums (`universumLeser`, Stufe 3,
 * Task 121).
 *
 * Der tägliche Sync, der den Stand schrieb, ist mit der Handelsplattform
 * gegangen; seit dem Umbau von `saveStrategy` auf `settings.auto` prüft
 * auch die Einstellungs-Speicherung nicht mehr dagegen (Symbole kommen aus
 * dem Plattform-Universum in `meta/engineConfig`). Der Leser hat damit
 * derzeit keinen Aufrufer — solange er im Baum liegt, bleibt sein Vertrag
 * gepinnt: Bei Lesefehlern ist das Universum LEER, nie eine Freischaltung.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { symboleAusBloecken } from '../src/core/universumLeser.js';

const hier = dirname(fileURLToPath(import.meta.url));
const leser = readFileSync(join(hier, '../src/core/universumLeser.ts'), 'utf8');

describe('symboleAusBloecken — defensives Lesen der Block-Dokumente', () => {
  it('zieht die Symbole aus wohlgeformten Blöcken', () => {
    const out = symboleAusBloecken([
      { symbole: [{ symbol: 'PLTR' }, { symbol: 'BTC-USD' }] },
      { symbole: [{ symbol: 'BRK-B' }] },
    ]);
    expect([...out].sort()).toEqual(['BRK-B', 'BTC-USD', 'PLTR']);
  });

  it('übergeht kaputte Formen, statt zu werfen', () => {
    const out = symboleAusBloecken([
      null,
      undefined,
      42,
      { symbole: 'kein array' },
      { symbole: [null, {}, { symbol: 7 }, { symbol: '' }, { symbol: 'OK' }] },
    ]);
    expect([...out]).toEqual(['OK']);
  });
});

describe('Quelltext-Wächter', () => {
  it('Fail-safe: Lesefehler liefert letzten Stand oder LEER — nie eine Freischaltung', () => {
    expect(leser).toContain('return cache?.symbole ?? new Set<string>();');
  });
});
