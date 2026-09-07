import { describe, expect, it } from 'vitest';
import { MIN, msFromET } from '../../src/core/time.ts';
import { CLIENT_ID_MAX_LEN, clientIdMatchesSymbol, decisionBucketStart, entryClientId, exitClientId, isOwnClientId, parseClientId, stopClientId, symbolSafe } from '../../src/engine/ids.ts';

const T = msFromET(2026, 9, 1, 9, 35);

describe('Client-Order-Kennungen', () => {
  it('haben das Format atd-<mode>-<symbol>-<ms>-<e|x|s> und nur erlaubte Zeichen', () => {
    const id = entryClientId('paper', 'AAPL', T);
    expect(id).toBe(`atd-paper-AAPL-${T}-e`);
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
    expect(exitClientId('live', 'BRK.B', T)).toBe(`atd-live-BRK-B-${T}-x`);
    expect(stopClientId('paper', 'BTC/USD', T)).toBe(`atd-paper-BTC-USD-${T}-s`);
    expect(stopClientId('paper', 'BTC/USD', T, 2)).toBe(`atd-paper-BTC-USD-${T}-s2`);
    expect(symbolSafe('BTC/USD')).toBe('BTC-USD');
  });

  it('bleiben unter 48 Zeichen — auch bei langen Symbolen (Symbol wird gekappt, Schwanz bleibt)', () => {
    const id = entryClientId('paper', 'AVERYLONGSYMBOLNAME/WITHSLASHES', T);
    expect(id.length).toBeLessThanOrEqual(CLIENT_ID_MAX_LEN);
    expect(id.endsWith(`-${T}-e`)).toBe(true);
  });

  it('sind dieselbe Kennung für dieselbe logische Einheit', () => {
    expect(entryClientId('paper', 'AAPL', T)).toBe(entryClientId('paper', 'AAPL', T));
    expect(exitClientId('paper', 'AAPL', T)).toBe(exitClientId('paper', 'AAPL', T));
    expect(entryClientId('paper', 'AAPL', T)).not.toBe(entryClientId('live', 'AAPL', T));
    expect(entryClientId('paper', 'AAPL', T)).not.toBe(entryClientId('paper', 'AAPL', T + 1));
  });

  it('lassen sich zerlegen — auch mit Bindestrich im Symbol und Sequenz', () => {
    expect(parseClientId(exitClientId('paper', 'BTC/USD', T, 3))).toEqual({ mode: 'paper', symbolSafe: 'BTC-USD', ms: T, kind: 'exit', seq: 3 });
    expect(parseClientId(entryClientId('live', 'AAPL', T))).toEqual({ mode: 'live', symbolSafe: 'AAPL', ms: T, kind: 'entry', seq: 0 });
    expect(parseClientId('leg-o-1-sl')).toBeNull();
    expect(parseClientId('3f2a7c1e-9b1d-4c1a-8f0e-1234567890ab')).toBeNull();
    expect(parseClientId('atd-paper-AAPL-x')).toBeNull();
    expect(isOwnClientId(entryClientId('paper', 'AAPL', T), 'paper')).toBe(true);
    expect(isOwnClientId(entryClientId('paper', 'AAPL', T), 'live')).toBe(false);
    expect(clientIdMatchesSymbol(entryClientId('paper', 'BTC/USD', T), 'BTC/USD')).toBe(true);
    expect(clientIdMatchesSymbol(entryClientId('paper', 'BTC/USD', T), 'ETH/USD')).toBe(false);
  });
});

describe('decisionBucketStart', () => {
  it('richtet die Entscheidungszeit am Sitzungs-Bucket aus (zwei Ticks im selben Bucket ⇒ derselbe Anker)', () => {
    const open = msFromET(2026, 9, 1, 9, 30);
    const a = decisionBucketStart(open + 10 * MIN + 5_000, 5, 'us_equity');
    const b = decisionBucketStart(open + 14 * MIN + 59_000, 5, 'us_equity');
    expect(a).toBe(open + 10 * MIN);
    expect(b).toBe(a);
    expect(decisionBucketStart(open + 15 * MIN, 5, 'us_equity')).toBe(open + 15 * MIN);
  });

  it('fällt außerhalb der Sitzung auf ein festes Raster zurück und ist nie null', () => {
    const afterClose = msFromET(2026, 9, 1, 16, 0) + 5_000;
    const anchor = decisionBucketStart(afterClose, 5, 'us_equity');
    expect(anchor).toBe(Math.floor(afterClose / (5 * MIN)) * 5 * MIN);
    expect(decisionBucketStart(afterClose, 1440, 'us_equity')).toBe(msFromET(2026, 9, 1));
  });

  it('Krypto: UTC-Tag-ausgerichtet, rund um die Uhr', () => {
    const t = Date.UTC(2026, 8, 1, 3, 7);
    expect(decisionBucketStart(t, 5, 'crypto')).toBe(Date.UTC(2026, 8, 1, 3, 5));
    expect(decisionBucketStart(t, 1440, 'crypto')).toBe(Date.UTC(2026, 8, 1));
  });
});
