/**
 * Freie Symbol-Eingabe gegen das Alpaca-Universum (Stufe 3, Task 121).
 *
 * Die Kette hat drei Glieder, und jedes einzelne fehlende Glied macht das
 * Feature still unbrauchbar — deshalb je ein Wächter:
 *
 *  1. `saveStrategy` lässt Universums-Symbole auf die Watchlist (sonst kommt
 *     das Symbol nie ins System),
 *  2. der Scan beobachtet sie (`watchlistUnion` mit erweitertem Set — sonst
 *     gibt es nie einen Kurs und `trade` lehnt mit „kein zentraler Kurs" ab),
 *  3. das `trade`-Callable akzeptiert sie (sonst hilft der Kurs nichts).
 *
 * Kein Guard wird weicher: Das Universum ist broker-verifiziert (nur
 * US-Börsen + Krypto, OTC raus), bei Lesefehlern LEER (dann gilt nur der
 * Katalog), und Kurs-Pflicht, Kurs-Zeitdeckel, Konto-Tore und Quota laufen
 * für beide Wege identisch.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { symboleAusBloecken } from '../src/core/universumLeser.js';

const hier = dirname(fileURLToPath(import.meta.url));
const leser = readFileSync(join(hier, '../src/core/universumLeser.ts'), 'utf8');
const trade = readFileSync(join(hier, '../src/callable/trade.ts'), 'utf8');
const strategie = readFileSync(join(hier, '../src/callable/strategy.ts'), 'utf8');
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

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
    const fehler = strategie.indexOf('weder Katalog noch Alpaca-Universum');
    expect(filter, 'Universums-Nachprüfung fehlt in saveStrategy').toBeGreaterThan(0);
    expect(fehler).toBeGreaterThan(filter);
  });

  it('(2) Scan: watchlistUnion bekommt Katalog ∪ Universum', () => {
    expect(scan).toContain('new Set([...allSymbols(), ...(await ladeUniversumSymbole())])');
  });

  it('(3) trade: Universum als Fallback NACH dem Katalog, mit Klartext-Absage', () => {
    const katalog = trade.indexOf('new Set(tradableSymbols()).has(symbol)');
    const fallback = trade.indexOf('(await ladeUniversumSymbole()).has(symbol)');
    expect(katalog, 'Katalog-Prüfung fehlt').toBeGreaterThan(0);
    expect(fallback, 'Universums-Fallback fehlt').toBeGreaterThan(katalog);
    expect(trade).toContain('weder im Katalog noch im Alpaca-Universum');
  });

  it('Fail-safe: Lesefehler liefert letzten Stand oder LEER — nie eine Freischaltung', () => {
    expect(leser).toContain('return cache?.symbole ?? new Set<string>();');
  });
});
