import { describe, expect, it } from 'vitest';
import {
  encodePathSymbol,
  fromPositionSymbol,
  normalizeUserSymbol,
  splitCryptoPair,
  toPositionSymbol,
} from '../../src/alpaca/symbols.ts';

describe('normalizeUserSymbol', () => {
  it('Aktien: Großschreibung, Anteilsklasse Bindestrich → Punkt', () => {
    expect(normalizeUserSymbol('aapl', 'us_equity')).toBe('AAPL');
    expect(normalizeUserSymbol(' brk-b ', 'us_equity')).toBe('BRK.B');
    expect(normalizeUserSymbol('BRK-B', 'us_equity')).toBe('BRK.B');
    expect(normalizeUserSymbol('BRK.B', 'us_equity')).toBe('BRK.B');
    expect(normalizeUserSymbol('a-b', 'us_equity')).toBe('A.B');
  });

  it('Aktien: Units/Warrants und Nicht-Anteilsklassen-Muster bleiben unangetastet', () => {
    expect(normalizeUserSymbol('SPAC.U', 'us_equity')).toBe('SPAC.U');
    expect(normalizeUserSymbol('abc.w', 'us_equity')).toBe('ABC.W');
    // fünf Buchstaben vor dem Bindestrich: kein Anteilsklassen-Muster
    expect(normalizeUserSymbol('ABCDE-B', 'us_equity')).toBe('ABCDE-B');
    // mehr als ein Buchstabe dahinter: auch nicht
    expect(normalizeUserSymbol('BTC-USD', 'us_equity')).toBe('BTC-USD');
  });

  it('Krypto: alle üblichen Schreibweisen → BASE/QUOTE', () => {
    expect(normalizeUserSymbol('btc-usd', 'crypto')).toBe('BTC/USD');
    expect(normalizeUserSymbol('BTCUSD', 'crypto')).toBe('BTC/USD');
    expect(normalizeUserSymbol('btc/usd', 'crypto')).toBe('BTC/USD');
    expect(normalizeUserSymbol(' eth usdt ', 'crypto')).toBe('ETH/USDT');
    expect(normalizeUserSymbol('ethbtc', 'crypto')).toBe('ETH/BTC');
    expect(normalizeUserSymbol('SOLUSDC', 'crypto')).toBe('SOL/USDC');
  });

  it('Krypto: unbekannte Endung wird nicht geraten', () => {
    expect(normalizeUserSymbol('XYZ', 'crypto')).toBe('XYZ');
  });
});

describe('splitCryptoPair', () => {
  it('längste passende Quote-Endung gewinnt', () => {
    expect(splitCryptoPair('BTCUSDT')).toEqual(['BTC', 'USDT']);
    expect(splitCryptoPair('BTCUSD')).toEqual(['BTC', 'USD']);
    expect(splitCryptoPair('ETHBTC')).toEqual(['ETH', 'BTC']);
  });
  it('leere Basis oder unbekannte Endung ⇒ null', () => {
    expect(splitCryptoPair('USDT')).toBeNull();
    expect(splitCryptoPair('ABCDEF')).toBeNull();
  });
});

describe('fromPositionSymbol', () => {
  it('Krypto aus dem Bestand: BTCUSD → BTC/USD, idempotent', () => {
    expect(fromPositionSymbol('BTCUSD', 'crypto')).toBe('BTC/USD');
    expect(fromPositionSymbol('BTC/USD', 'crypto')).toBe('BTC/USD');
    expect(fromPositionSymbol('ETHUSDT', 'crypto')).toBe('ETH/USDT');
  });
  it('Aktien unverändert', () => {
    expect(fromPositionSymbol('BRK.B', 'us_equity')).toBe('BRK.B');
    expect(fromPositionSymbol('AAPL', 'us_equity')).toBe('AAPL');
  });
});

describe('toPositionSymbol / encodePathSymbol', () => {
  it('kanonisch → Bestand und URL-Pfad', () => {
    expect(toPositionSymbol('BTC/USD')).toBe('BTCUSD');
    expect(toPositionSymbol('AAPL')).toBe('AAPL');
    expect(encodePathSymbol('BTC/USD')).toBe('BTC%2FUSD');
    expect(encodePathSymbol('BRK.B')).toBe('BRK.B');
  });
});
