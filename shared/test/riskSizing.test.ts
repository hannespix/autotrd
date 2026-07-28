/**
 * Positionsgröße nach Risiko.
 *
 * Die entscheidende Eigenschaft, die hier festgehalten wird: Zwei Positionen
 * mit unterschiedlicher Volatilität müssen im Stop-Fall DENSELBEN Betrag
 * kosten. Genau das leistet die pauschale Prozent-Tranche nicht — und genau
 * deshalb war die Streuung des Depots vorher eine Behauptung.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RISK_PER_TRADE_PCT,
  MAX_RISK_PER_TRADE_PCT,
  riskBasedQty,
  stopDistancePct,
} from '../src/riskSizing.js';

const basis = {
  equity: 100_000,
  riskPerTradePct: 1,
  effPrice: 100,
  maxPositionPct: 100, // Deckel bewusst weit, um die Rechnung zu sehen
};

describe('riskBasedQty', () => {
  it('bei 1 % Risiko und 2 % Stop-Abstand ergeben sich 50 % Einsatz', () => {
    // 1 000 $ Risiko ÷ 2 % = 50 000 $ Einsatz = 500 Stück zu 100 $.
    expect(riskBasedQty({ ...basis, stopDistancePct: 2 })).toBe(500);
  });

  it('DER Punkt: gleicher Verlust im Stop-Fall, egal wie volatil', () => {
    const ruhig = riskBasedQty({ ...basis, stopDistancePct: 1 });
    const wild = riskBasedQty({ ...basis, stopDistancePct: 5 });
    // Der ruhige Titel bekommt die fünffache Stückzahl …
    expect(ruhig).toBe(5 * wild);
    // … und beide verlieren im Stop-Fall exakt 1 000 $.
    expect(ruhig * 100 * 0.01).toBeCloseTo(1_000, 6);
    expect(wild * 100 * 0.05).toBeCloseTo(1_000, 6);
  });

  it('gegen die alte Pauschale gerechnet: der Unterschied ist groß', () => {
    // Pauschal 10 % wären 100 Stück — unabhängig vom Instrument. Mit
    // Risiko-Sizing bekommt der ruhige Titel 500, der wilde 100.
    const pauschal = (basis.equity * 10) / 100 / basis.effPrice;
    expect(pauschal).toBe(100);
    expect(riskBasedQty({ ...basis, stopDistancePct: 1, maxPositionPct: 100 })).toBe(1_000);
  });

  it('maxPositionPct bleibt die harte Obergrenze', () => {
    // 0,1 % Stop ergäbe rechnerisch das Zehnfache des Eigenkapitals.
    // Ein enger Stop ist eben nicht dasselbe wie wenig Risiko.
    const q = riskBasedQty({ ...basis, stopDistancePct: 0.1, maxPositionPct: 10 });
    expect(q * basis.effPrice).toBeLessThanOrEqual((basis.equity * 10) / 100);
  });

  it('die Kaufkraft deckelt zusätzlich', () => {
    const q = riskBasedQty({ ...basis, stopDistancePct: 2, buyingPower: 5_000 });
    expect(q).toBe(50);
  });

  it('ohne Stop-Abstand ⇒ 0, damit der Aufrufer zurückfallen kann', () => {
    // Ohne Stop ist der Verlust im Ernstfall unbekannt. Eine Größe, die auf
    // einer unbekannten Zahl beruht, darf nicht gehandelt werden.
    expect(riskBasedQty({ ...basis, stopDistancePct: 0 })).toBe(0);
    expect(riskBasedQty({ ...basis, stopDistancePct: Number.NaN })).toBe(0);
  });

  it('ohne eingeschaltetes Risiko ⇒ 0 (Voreinstellung ist AUS)', () => {
    expect(DEFAULT_RISK_PER_TRADE_PCT).toBe(0);
    expect(riskBasedQty({ ...basis, riskPerTradePct: 0, stopDistancePct: 2 })).toBe(0);
  });

  it('Krypto in Bruchteilen', () => {
    const q = riskBasedQty({
      equity: 100_000, riskPerTradePct: 1, stopDistancePct: 6,
      effPrice: 64_000, maxPositionPct: 100, fractional: true,
    });
    expect(q).toBeCloseTo(0.260416, 5);
    // Ganze Stücke ergäben hier 0 — der teure Coin wäre unkaufbar.
    expect(riskBasedQty({
      equity: 100_000, riskPerTradePct: 1, stopDistancePct: 6,
      effPrice: 64_000, maxPositionPct: 100,
    })).toBe(0);
  });

  it('unsinnige Eingaben ergeben 0, nicht NaN', () => {
    expect(riskBasedQty({ ...basis, equity: 0, stopDistancePct: 2 })).toBe(0);
    expect(riskBasedQty({ ...basis, effPrice: 0, stopDistancePct: 2 })).toBe(0);
  });

  it('die Obergrenze für das Risiko je Trade ist nicht großzügig', () => {
    expect(MAX_RISK_PER_TRADE_PCT).toBeLessThanOrEqual(5);
  });
});

describe('stopDistancePct', () => {
  it('ATR-Vielfaches schlägt den festen Prozentwert', () => {
    // Dieselbe Vorrangregel wie riskExitReason — sonst würde die Position mit
    // einem anderen Abstand DIMENSIONIERT als sie später GESTOPPT wird.
    expect(stopDistancePct({ stopLossPct: 2, atrStopMult: 2 }, 1.5)).toBe(3);
  });

  it('ohne ATR gilt der Prozentwert', () => {
    expect(stopDistancePct({ stopLossPct: 2, atrStopMult: 2 }, null)).toBe(2);
    expect(stopDistancePct({ stopLossPct: 2, atrStopMult: 2 }, 0)).toBe(2);
  });

  it('ohne ATR-Multiplikator gilt der Prozentwert', () => {
    expect(stopDistancePct({ stopLossPct: 2 }, 1.5)).toBe(2);
    expect(stopDistancePct({ stopLossPct: 2, atrStopMult: 0 }, 1.5)).toBe(2);
  });

  it('gar kein Stop ⇒ 0 (Risiko-Sizing greift dann nicht)', () => {
    expect(stopDistancePct({ stopLossPct: 0 }, null)).toBe(0);
  });
});
