/**
 * Symbolschreibweise an der Broker-Grenze.
 *
 * ── Der Fehler, den das verhindert ────────────────────────────────────────
 *
 * Der Katalog führt Krypto als `BTC-USD` (yfinance, dort kommen die Kurse
 * her), Alpaca schreibt dieselbe Münze `BTC/USD`. Ohne Übersetzung ging jede
 * Krypto-Order mit einem Symbol raus, das der Broker nicht kennt — und
 * `isTradable()` hält alle 13 Krypto-Symbole des Katalogs für handelbar. Die
 * Engine hätte sie also angeboten, geplant, gebucht und erst beim Broker eine
 * Ablehnung kassiert.
 *
 * ── Warum die Rückrichtung genauso wichtig ist ────────────────────────────
 *
 * Alpaca liefert Positionen und Orders mit SEINER Schreibweise zurück. Wer
 * nur beim Senden übersetzt, hat hinterher zwei Schreibweisen im Bestand:
 * Der Broker-Abgleich sieht `BTC/USD` beim Broker und `BTC-USD` bei uns und
 * meldet beides als Abweichung — einen Fehlbestand und einen Fremdbestand,
 * für ein und dieselbe Position.
 */
import { describe, expect, it } from 'vitest';
import { vonAlpacaSymbol, zuAlpacaSymbol } from '../src/core/alpacaBroker.js';
import { allSymbols, classify } from '../../shared/src/index.js';

describe('zuAlpacaSymbol', () => {
  it('übersetzt Krypto-Paare in die Alpaca-Schreibweise', () => {
    expect(zuAlpacaSymbol('BTC-USD')).toBe('BTC/USD');
    expect(zuAlpacaSymbol('ETH-USD')).toBe('ETH/USD');
    expect(zuAlpacaSymbol('DOGE-USD')).toBe('DOGE/USD');
  });

  it('lässt Aktien und ETFs unberührt', () => {
    for (const s of ['AAPL', 'SPY', 'TLT', 'BRK.B']) expect(zuAlpacaSymbol(s)).toBe(s);
  });

  it('deutet Ticker MIT Bindestrich nicht zu Krypto um', () => {
    // Der eigentliche Grund für die Gegenwährungs-Liste: „alles mit
    // Bindestrich" hätte BF-B zu „BF/B" gemacht — ein Symbol, das es nicht
    // gibt, für ein Papier, das Alpaca sehr wohl handelt.
    expect(zuAlpacaSymbol('BF-B')).toBe('BF-B');
    expect(zuAlpacaSymbol('BRK-B')).toBe('BRK-B');
  });

  it('lässt Indizes und Devisen unberührt — sie gehen ohnehin nie zum Broker', () => {
    expect(zuAlpacaSymbol('^GSPC')).toBe('^GSPC');
    expect(zuAlpacaSymbol('EURUSD=X')).toBe('EURUSD=X');
  });
});

describe('vonAlpacaSymbol', () => {
  it('übersetzt zurück in die Katalog-Schreibweise', () => {
    expect(vonAlpacaSymbol('BTC/USD')).toBe('BTC-USD');
    expect(vonAlpacaSymbol('SOL/USDT')).toBe('SOL-USDT');
  });

  it('lässt alles andere, wie es ist', () => {
    for (const s of ['AAPL', 'SPY', 'BF-B', '']) expect(vonAlpacaSymbol(s)).toBe(s);
  });
});

describe('Hin und zurück', () => {
  it('jedes Krypto-Symbol des Katalogs übersteht den Rundweg unverändert', () => {
    const krypto = allSymbols().filter((s) => classify(s) === 'crypto');
    expect(krypto.length).toBeGreaterThan(5); // sonst prüft der Test nichts
    for (const s of krypto) {
      expect(zuAlpacaSymbol(s), s).toContain('/');
      expect(vonAlpacaSymbol(zuAlpacaSymbol(s)), s).toBe(s);
    }
  });

  it('und jedes NICHT-Krypto-Symbol bleibt auf beiden Wegen unverändert', () => {
    for (const s of allSymbols().filter((x) => classify(x) !== 'crypto')) {
      expect(zuAlpacaSymbol(s), s).toBe(s);
      expect(vonAlpacaSymbol(s), s).toBe(s);
    }
  });
});
