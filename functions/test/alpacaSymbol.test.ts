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
    expect(zuAlpacaSymbol('BF-B')).not.toContain('/');
    expect(zuAlpacaSymbol('BRK-B')).not.toContain('/');
  });

  /* ── Korrektur einer falschen Regel in diesem Test (10.08.) ──────────────
   *
   * Hier stand vorher `expect(zuAlpacaSymbol('BRK-B')).toBe('BRK-B')` — die
   * Sorge war richtig (kein „BF/B"), der Schluss falsch: gar nicht anfassen.
   * Alpaca schreibt Anteilsklassen mit PUNKT. Der Katalog führt `BRK-B`,
   * also fragte die Vorprüfung `/v2/assets/BRK-B`, bekam 404 und blockierte
   * jeden Einstieg mit „kennt Alpaca nicht" — für ein Papier, das dort ganz
   * normal handelbar ist. Der Test hat den Fehler nicht nur verpasst, er hat
   * ihn festgeschrieben. */
  it('übersetzt Anteilsklassen in die Punkt-Schreibweise', () => {
    expect(zuAlpacaSymbol('BRK-B')).toBe('BRK.B');
    expect(zuAlpacaSymbol('BF-B')).toBe('BF.B');
    expect(zuAlpacaSymbol('PBR-A')).toBe('PBR.A');
  });

  it('fasst Endungen mit MEHR als einem Buchstaben nicht an', () => {
    // Warrants, Rechte und Units folgen bei Yahoo eigenen Regeln (`-WT`,
    // `-RT`, `-UN`), die kein Zeichentausch trifft. Ein falsch übersetztes
    // Symbol wäre schlimmer als ein unübersetztes: Letzteres fällt sichtbar
    // als Fremdbestand auf, ersteres handelt unter erfundenem Namen.
    for (const s of ['ABC-WT', 'ABC-RT', 'ABC-UN']) expect(zuAlpacaSymbol(s)).toBe(s);
  });

  it('fasst lange Basen nicht an — Anteilsklassen-Ticker sind kurz', () => {
    expect(zuAlpacaSymbol('GOOGL-B')).toBe('GOOGL-B');
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

  it('und Anteilsklassen ebenso — sonst meldet der Abgleich Phantome', () => {
    // Ohne die Rückrichtung stünde `BRK.B` beim Broker und `BRK-B` bei uns:
    // eine Position, zwei Meldungen — ein Fehlbestand und ein Fremdbestand.
    expect(vonAlpacaSymbol('BRK.B')).toBe('BRK-B');
    expect(vonAlpacaSymbol('BF.B')).toBe('BF-B');
  });

  /* ── Krypto hat bei Alpaca ZWEI Schreibweisen (10.08.) ──────────────────
   *
   * Belegt in Alpacas eigener Hilfe („Why am I seeing BTCUSD after I bought
   * BTC/USD?"): Bestellt wird das PAAR mit Schrägstrich, im Bestand steht
   * der HALTEWERT ohne. Wer nur die Paar-Form zurückübersetzt, hat für jede
   * offene Krypto-Position zwei Meldungen im Abgleich — Fehlbestand
   * `BTC-USD` und Fremdbestand `BTCUSD` —, und der Fehlbestand sperrt
   * Einstiege. */
  it('erkennt auch die kompakte Bestandsform', () => {
    expect(vonAlpacaSymbol('BTCUSD')).toBe('BTC-USD');
    expect(vonAlpacaSymbol('ETHUSD')).toBe('ETH-USD');
    expect(vonAlpacaSymbol('DOGEUSD')).toBe('DOGE-USD');
  });

  it('rät die kompakte Form NICHT — sie muss im Katalog stehen', () => {
    // „Alles was auf USD endet ist Krypto" hätte einen Aktienticker mit
    // dieser Endung zu einem Währungspaar umgedeutet, das es nicht gibt.
    expect(vonAlpacaSymbol('FAKEUSD')).toBe('FAKEUSD');
    expect(vonAlpacaSymbol('XYZUSDT')).toBe('XYZUSDT');
  });

  it('lässt alles andere, wie es ist', () => {
    for (const s of ['AAPL', 'SPY', '', 'ABC.WS']) expect(vonAlpacaSymbol(s)).toBe(s);
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

  /**
   * Die entscheidende Eigenschaft ist NICHT „bleibt unverändert" — das stand
   * hier vorher und hat den BRK-B-Fehler mitgedeckt. Entscheidend ist, dass
   * der Rundweg zurückführt: Was wir senden, erkennen wir wieder, wenn es
   * als Position oder Fill zurückkommt.
   */
  it('jedes Katalog-Symbol übersteht den Rundweg unverändert', () => {
    for (const s of allSymbols()) {
      expect(vonAlpacaSymbol(zuAlpacaSymbol(s)), s).toBe(s);
    }
  });

  it('und nur Krypto und Anteilsklassen werden dabei überhaupt umgeschrieben', () => {
    const geaendert = allSymbols().filter((s) => zuAlpacaSymbol(s) !== s);
    const erwartet = allSymbols().filter((s) => classify(s) === 'crypto' || s === 'BRK-B');
    expect(geaendert.sort()).toEqual(erwartet.sort());
  });
});
