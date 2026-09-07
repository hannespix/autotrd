/**
 * SECREVIEW #6 — `symbols.ts` besitzt `normalizeUserSymbol`, aber die Config
 * ruft sie nirgends (grep: einzige Nutzung ist der Re-Export in alpaca/index.ts).
 * Eine Config mit `BTCUSD` (Alpaca akzeptiert das für Orders und /v2/assets;
 * `doctor` ist grün) wird unverändert zum Buch-Schlüssel. Positionen und Orders
 * kommen vom Broker aber als `BTC/USD` zurück (raw.ts fromPositionSymbol):
 *   - Fill-Buchung öffnet die Position unter `BTC/USD`; decide() läuft auf
 *     `BTCUSD` und sieht KEINE Position ⇒ nächster Einstieg (Doppelposition).
 *   - reconcile: Buch `BTCUSD` „fehlt beim Broker" (Trade mit geschätztem Kurs),
 *     `BTC/USD` ist „Fremdbestand" ⇒ Halt reconcile — in jedem Zyklus neu.
 * Gleiches Muster bei Aktien (`brk-b`), dort fängt es immerhin `doctor`.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { mapPosition } from '../../src/alpaca/raw.ts';
import { normalizeUserSymbol } from '../../src/alpaca/symbols.ts';
import { parseConfig } from '../../src/core/config.ts';

describe('secreview: Config-Symbole werden nicht normalisiert', () => {
  it('universe.symbols: "BTCUSD" wird weder normalisiert noch abgelehnt — der Broker meldet die Position aber als "BTC/USD"', () => {
    const cfg = parseConfig({ universe: { assetClass: 'crypto', symbols: ['BTCUSD'] } });
    const broker = mapPosition({ symbol: 'BTCUSD', qty: '1', side: 'long', asset_class: 'crypto' }, 'crypto');
    expect(normalizeUserSymbol('BTCUSD', 'crypto')).toBe('BTC/USD'); // die Funktion existiert …
    // … und müsste hier gewirkt haben: Buch-Schlüssel == Broker-Schlüssel.
    expect(cfg.universe.symbols[0], 'Config-Symbol muss der kanonischen Broker-Schreibweise entsprechen (oder abgelehnt werden)').toBe(broker.symbol);
  });

  it('universe.symbols: "brk-b" wird ebenfalls unverändert übernommen', () => {
    const cfg = parseConfig({ universe: { symbols: ['brk-b'] } });
    expect(cfg.universe.symbols[0]).toBe(normalizeUserSymbol('brk-b', 'us_equity'));
  });
});
