/**
 * Freie Symbol-Eingabe gegen das Alpaca-Universum (Stufe 3, Task 121).
 *
 * Übrig geblieben ist das erste Glied der alten Kette: `saveStrategy` lässt
 * Universums-Symbole auf die Watchlist. Der Leser (`universumLeser`) liest
 * den letzten gespeicherten Stand — der tägliche Sync, der ihn schrieb, ist
 * mit der Handelsplattform gegangen.
 *
 * Kein Guard wird weicher: Bei Lesefehlern ist das Universum LEER (dann
 * gilt nur der Katalog).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { symboleAusBloecken } from '../src/core/universumLeser.js';

const hier = dirname(fileURLToPath(import.meta.url));
const leser = readFileSync(join(hier, '../src/core/universumLeser.ts'), 'utf8');
const strategie = readFileSync(join(hier, '../src/callable/strategy.ts'), 'utf8');

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

describe('die Kette — Quelltext-Wächter', () => {
  it('(1) saveStrategy: Nicht-Katalog-Symbole werden gegen das Universum geprüft', () => {
    const filter = strategie.indexOf('unknown.filter((sym) => !universum.has(sym))');
    // Wortlaut wohnt seit #145 im Frontend-Wörterbuch (serverCodes.test.ts
    // pinnt DE+EN) — der Anker hier ist der geworfene Code.
    const fehler = strategie.indexOf('srv.unbekannteSymbole');
    expect(filter, 'Universums-Nachprüfung fehlt in saveStrategy').toBeGreaterThan(0);
    expect(fehler).toBeGreaterThan(filter);
  });

  it('Fail-safe: Lesefehler liefert letzten Stand oder LEER — nie eine Freischaltung', () => {
    expect(leser).toContain('return cache?.symbole ?? new Set<string>();');
  });
});
