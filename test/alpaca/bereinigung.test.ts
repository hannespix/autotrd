/**
 * Der Alpaca-Parameter `adjustment` an der API-Grenze.
 *
 * Regel: Nur Tagesbars werden bereinigt angefordert. Minutenbars gehen IMMER
 * roh raus — aus ihnen aggregiert die Engine die Bars für die Ausführung, und
 * die läuft zu echten Kursen. Der Client erzwingt das selbst, egal was ein
 * Aufrufer in die Anfrage schreibt; Krypto kennt den Parameter gar nicht.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createAlpacaClient, type AlpacaClientOptions } from '../../src/alpaca/rest.ts';
import { setLogSink } from '../../src/core/log.ts';

beforeAll(() => {
  setLogSink(() => {});
});

const T0 = Date.UTC(2024, 4, 6);

function clientMit(over: Partial<AlpacaClientOptions> = {}) {
  const urls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
    urls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url));
    return new Response(JSON.stringify({ bars: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = createAlpacaClient({
    mode: 'paper',
    keyId: 'PKTESTKEY0000000001',
    secret: 'test-secret-value-0123456789',
    feed: 'iex',
    assetClass: 'us_equity',
    fetchFn,
    sleep: async () => undefined,
    ...over,
  });
  return { client, urls };
}

describe('getBars: adjustment', () => {
  it('Tagesbars: der gewünschte Wert geht an Alpaca (all)', async () => {
    const { client, urls } = clientMit();
    await client.getBars({ symbols: ['TLT'], timeframe: '1Day', start: T0, adjustment: 'all' });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.pathname).toBe('/v2/stocks/bars');
    expect(urls[0]!.searchParams.get('timeframe')).toBe('1Day');
    expect(urls[0]!.searchParams.get('adjustment')).toBe('all');
  });

  it('Tagesbars ohne Angabe: raw (bisheriges Verhalten)', async () => {
    const { client, urls } = clientMit();
    await client.getBars({ symbols: ['TLT'], timeframe: '1Day', start: T0 });
    expect(urls[0]!.searchParams.get('adjustment')).toBe('raw');
  });

  it('Minutenbars: IMMER raw — auch wenn die Anfrage all verlangt', async () => {
    const { client, urls } = clientMit();
    await client.getBars({ symbols: ['TLT'], timeframe: '1Min', start: T0, adjustment: 'all' });
    await client.getBars({ symbols: ['TLT'], timeframe: '1Min', start: T0, adjustment: 'dividend' });
    await client.getBars({ symbols: ['TLT'], timeframe: '1Min', start: T0 });
    expect(urls).toHaveLength(3);
    for (const u of urls) {
      expect(u.searchParams.get('timeframe')).toBe('1Min');
      expect(u.searchParams.get('adjustment')).toBe('raw');
    }
  });

  it('Krypto: kein adjustment-Parameter, auch nicht bei all', async () => {
    const { client, urls } = clientMit({ assetClass: 'crypto' });
    await client.getBars({ symbols: ['BTC/USD'], timeframe: '1Day', start: T0, adjustment: 'all' });
    expect(urls[0]!.pathname).toBe('/v1beta3/crypto/us/bars');
    expect(urls[0]!.searchParams.has('adjustment')).toBe(false);
  });
});
