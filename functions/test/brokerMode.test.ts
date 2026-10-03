/**
 * Tests des Broker-Modus — die Stelle, an der echtes Geld freigegeben wird.
 *
 * `resolveBrokerMode` ist die EINZIGE Funktion im System, die „live" zurück-
 * geben kann. Alles, was danach echtes Geld bewegt, hängt an ihrem Ergebnis.
 * Entsprechend prüfen diese Tests jede Kombination der drei Bedingungen —
 * und vor allem, dass keine einzelne davon allein reicht.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, liveReife, type Strategy } from '../../shared/src/index.js';
import { resolveBrokerMode } from '../src/core/broker.js';

const strategie = (mode: 'paper' | 'live'): Strategy => ({
  ...DEFAULT_STRATEGY,
  broker: { ...DEFAULT_STRATEGY.broker, mode },
});

/** Kennzahlen, die das Reife-Gate bestehen. */
const REIF = liveReife({
  trades: 250,
  profitFactor: 1.4,
  feeShare: 0.3,
  netPnl: 1200,
  tageStrecke: 45,
});

/** Der reale Zustand vom 04.08. — fällt durch. */
const UNREIF = liveReife({
  trades: 514,
  profitFactor: 0.6107,
  feeShare: 2.0944,
  netPnl: -1593.19,
  tageStrecke: 7,
});

beforeEach(() => {
  delete process.env.ALPACA_ALLOW_LIVE;
});

afterEach(() => {
  delete process.env.ALPACA_ALLOW_LIVE;
});

describe('resolveBrokerMode — keine einzelne Bedingung reicht', () => {
  it('bleibt Paper, wenn nur die Strategie auf live steht', () => {
    expect(resolveBrokerMode(strategie('live'))).toBe('paper');
  });

  it('bleibt Paper, wenn nur die Umgebungs-Freigabe gesetzt ist', () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    expect(resolveBrokerMode(strategie('paper'))).toBe('paper');
  });

  it('bleibt Paper, wenn nur die Reife bestanden ist', () => {
    expect(resolveBrokerMode(strategie('paper'), REIF)).toBe('paper');
  });

  it('geht live, wenn Strategie und Freigabe stimmen und keine Reife übergeben wird', () => {
    // Rückwärtskompatibel: Aufrufer ohne Kennzahlen bekommen den bisherigen
    // Doppel-Guard. Fehlende Kennzahlen dürfen keine Prüfung ENTFERNEN.
    process.env.ALPACA_ALLOW_LIVE = '1';
    expect(resolveBrokerMode(strategie('live'))).toBe('live');
  });

  it('geht live, wenn alle drei Bedingungen stehen', () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    expect(resolveBrokerMode(strategie('live'), REIF)).toBe('live');
  });
});

describe('resolveBrokerMode — die Reife ist ein echter Riegel', () => {
  it('degradiert auf Paper, obwohl beide Schalter stehen', () => {
    // Das ist der Kern der Owner-Maxime: „bis man sicher nur noch Gewinn
    // schreibt, dann erst den Schalter umlegen." Der Schalter ist umgelegt,
    // die Freigabe steht — und trotzdem fließt kein echtes Geld.
    process.env.ALPACA_ALLOW_LIVE = '1';
    expect(resolveBrokerMode(strategie('live'), UNREIF)).toBe('paper');
  });

  it('sperrt auch bei knapp verfehlter Reife', () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    const fastReif = liveReife({
      trades: 250,
      profitFactor: 1.19, // Schwelle 1.20
      feeShare: 0.3,
      netPnl: 1200,
      tageStrecke: 45,
    });
    expect(fastReif.bereit).toBe(false);
    expect(resolveBrokerMode(strategie('live'), fastReif)).toBe('paper');
  });

  it('sperrt bei leerer Historie — ein frisches Konto ist nie live-reif', () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    const leer = liveReife({ trades: 0, profitFactor: null, feeShare: null, netPnl: null });
    expect(resolveBrokerMode(strategie('live'), leer)).toBe('paper');
  });
});

describe('resolveBrokerMode — Voreinstellung', () => {
  it('ist im Auslieferungszustand Paper', () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    expect(DEFAULT_STRATEGY.broker.mode).toBe('paper');
    expect(resolveBrokerMode(DEFAULT_STRATEGY)).toBe('paper');
  });

  it('wertet nur die exakte Zeichenkette „1" als Freigabe', () => {
    // 'true', 'yes' oder '0' sind KEINE Freigabe. Eine versehentlich
    // gesetzte Variable soll nicht scharf schalten.
    for (const wert of ['true', 'yes', '0', '', 'TRUE']) {
      process.env.ALPACA_ALLOW_LIVE = wert;
      expect(resolveBrokerMode(strategie('live'), REIF)).toBe('paper');
    }
  });
});
