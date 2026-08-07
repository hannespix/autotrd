/**
 * PnL-Nachrechnung der Depot-Übernahme (Owner-Frage 07.08.: „die
 * Handelsanalyse soll nach der Broker-Synchronisation automatisch Daten
 * beinhalten — auch nach Reset"). Die Analyse zählt nur Trades MIT pnl;
 * importPnls liefert es für jede Verkaufs-Order mit bekannter Deckung —
 * dieselbe Durchschnittskosten-Rechnung wie der Live-Pfad, kein Raten bei
 * Einständen vor dem Import-Fenster.
 */
import { describe, expect, it } from 'vitest';
import { importPnls } from '../src/callable/adoptBroker.js';
import type { AlpacaGeschlosseneOrder } from '../src/core/alpacaBroker.js';

const o = (
  id: string,
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  kurs: number,
  filledAt: string,
): AlpacaGeschlosseneOrder => ({ id, clientOrderId: `u1-${id}`, symbol, side, qty, kurs, filledAt });

describe('importPnls', () => {
  it('Kauf → Verkauf ergibt PnL gegen den Durchschnitts-Einstand', () => {
    const pnls = importPnls([
      o('k1', 'AAPL', 'buy', 10, 100, '2026-08-01T14:00:00Z'),
      o('k2', 'AAPL', 'buy', 10, 110, '2026-08-02T14:00:00Z'),
      o('v1', 'AAPL', 'sell', 20, 120, '2026-08-03T14:00:00Z'),
    ]);
    // Durchschnitt 105, Verkauf 120 × 20 = +300
    expect(pnls.get('v1')).toBe(300);
    expect(pnls.size).toBe(1);
  });

  it('Teilverkauf rechnet nur die verkaufte Menge; der Rest behält den Einstand', () => {
    const pnls = importPnls([
      o('k1', 'SMH', 'buy', 10, 200, '2026-08-01T14:00:00Z'),
      o('v1', 'SMH', 'sell', 4, 210, '2026-08-02T14:00:00Z'),
      o('v2', 'SMH', 'sell', 6, 190, '2026-08-03T14:00:00Z'),
    ]);
    expect(pnls.get('v1')).toBe(40); // (210−200)×4
    expect(pnls.get('v2')).toBe(-60); // (190−200)×6
  });

  it('Verkauf OHNE Deckung im Fenster bekommt KEIN PnL (kein Raten)', () => {
    const pnls = importPnls([
      o('v0', 'NVDA', 'sell', 5, 130, '2026-08-01T14:00:00Z'), // Einstand vor dem Fenster
      o('k1', 'NVDA', 'buy', 3, 120, '2026-08-02T14:00:00Z'),
      o('v1', 'NVDA', 'sell', 3, 125, '2026-08-03T14:00:00Z'),
    ]);
    expect(pnls.has('v0')).toBe(false); // unbekannte Basis → ehrlich auslassen
    expect(pnls.get('v1')).toBe(15); // frische Eröffnung nach dem Fremd-Verkauf
  });

  it('Symbole führen getrennte Bücher', () => {
    const pnls = importPnls([
      o('a1', 'AAPL', 'buy', 1, 100, '2026-08-01T14:00:00Z'),
      o('b1', 'TAN', 'buy', 1, 50, '2026-08-01T15:00:00Z'),
      o('a2', 'AAPL', 'sell', 1, 90, '2026-08-02T14:00:00Z'),
      o('b2', 'TAN', 'sell', 1, 60, '2026-08-02T15:00:00Z'),
    ]);
    expect(pnls.get('a2')).toBe(-10);
    expect(pnls.get('b2')).toBe(10);
  });
});

describe('importPnls mit shortsMoeglich (Short-Audit 07.08.)', () => {
  it('ABNAHME: Short-Roundtrip erzeugt KEIN Phantom-Long-Buch', () => {
    // sell (Short auf) → buy (Cover) → sell (neuer Short). Vorher eröffnete
    // der Cover ein Phantom-Long zu 120, gegen das der nächste Verkauf ein
    // erfundenes PnL (+25) gebucht hätte.
    const pnls = importPnls(
      [
        o('s1', 'NVDA', 'sell', 5, 130, '2026-08-01T14:00:00Z'),
        o('c1', 'NVDA', 'buy', 5, 120, '2026-08-02T14:00:00Z'),
        o('s2', 'NVDA', 'sell', 5, 125, '2026-08-03T14:00:00Z'),
      ],
      { shortsMoeglich: true },
    );
    expect(pnls.size).toBe(0); // strittige Basis → ehrlich kein PnL
  });

  it('Kauf-Überschuss über die ungedeckte Menge eröffnet frisch', () => {
    const pnls = importPnls(
      [
        o('s1', 'AMD', 'sell', 3, 150, '2026-08-01T14:00:00Z'), // ungedeckt
        o('k1', 'AMD', 'buy', 10, 140, '2026-08-02T14:00:00Z'), // 3 neutral, 7 frisch
        o('v1', 'AMD', 'sell', 7, 145, '2026-08-03T14:00:00Z'),
      ],
      { shortsMoeglich: true },
    );
    expect(pnls.get('v1')).toBe(35); // (145−140)×7 — Basis der frischen 7
    expect(pnls.size).toBe(1);
  });

  it('Long-only-Konten behalten das alte Verhalten (Default)', () => {
    const pnls = importPnls([
      o('v0', 'NVDA', 'sell', 5, 130, '2026-08-01T14:00:00Z'),
      o('k1', 'NVDA', 'buy', 3, 120, '2026-08-02T14:00:00Z'),
      o('v1', 'NVDA', 'sell', 3, 125, '2026-08-03T14:00:00Z'),
    ]);
    expect(pnls.has('v0')).toBe(false);
    expect(pnls.get('v1')).toBe(15); // frische Eröffnung zählt wie bisher
  });
});
