import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, parseDotenv, resolveMode, type Env } from '../../src/core/config.ts';

const minimal = { universe: { symbols: ['AAPL', 'MSFT'] } };

function env(over: Partial<Env> = {}): Env {
  return {
    ALPACA_API_KEY: 'PKTESTKEY000000000000',
    ALPACA_SECRET_KEY: 'secret-secret-secret',
    ALPACA_ALLOW_LIVE: '0',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    AUTOTRD_HOME: '',
    ...over,
  };
}

describe('parseConfig', () => {
  it('füllt Defaults und ist paper/iex/5min', () => {
    const cfg = parseConfig(minimal);
    expect(cfg.broker.mode).toBe('paper');
    expect(cfg.broker.feed).toBe('iex');
    expect(cfg.timeframe).toBe(5);
    expect(cfg.risk.allowShort).toBe(false);
    expect(cfg.risk.pdt.respect).toBe(true);
    expect(cfg.optimizer.strategies.length).toBeGreaterThan(0);
  });

  it('lehnt unbekannte Zeitrahmen und leere Universen ab', () => {
    expect(() => parseConfig({ ...minimal, timeframe: 7 })).toThrow(ConfigError);
    expect(() => parseConfig({ universe: { symbols: [] } })).toThrow(ConfigError);
  });

  it('stepDays muss gleich oosDays sein (weder Lücken noch Doppelzählung)', () => {
    expect(() => parseConfig({ ...minimal, optimizer: { oosDays: 30, stepDays: 45 } })).toThrow(/stepDays/);
    expect(() => parseConfig({ ...minimal, optimizer: { oosDays: 30, stepDays: 10 } })).toThrow(/stepDays/);
    expect(parseConfig({ ...minimal, optimizer: { oosDays: 20, stepDays: 20 } }).optimizer.stepDays).toBe(20);
  });

  it('normalisiert Symbole auf die Alpaca-Schreibweise und entfernt Duplikate', () => {
    const cfg = parseConfig({ universe: { symbols: ['brk-b', 'aapl', 'AAPL'], benchmark: 'spy' } });
    expect(cfg.universe.symbols).toEqual(['BRK.B', 'AAPL']);
    expect(cfg.universe.benchmark).toBe('SPY');
    const crypto = parseConfig({ universe: { assetClass: 'crypto', symbols: ['btcusd', 'ETH-USD'] } });
    expect(crypto.universe.symbols).toEqual(['BTC/USD', 'ETH/USD']);
  });
});

describe('parseConfig — Basis-Korb im Kandidatenpool (Prüfbefund M11)', () => {
  const basis = { fixedCandidates: [{ strategy: 'regime_allocation', tier: 'basis' as const }] };

  it('WÄCHTER: basisUniverse außerhalb von universe.candidates ∪ universe.symbols ist ein ConfigError, der die Fremden nennt', () => {
    expect(() => parseConfig({ universe: { symbols: ['AAA'], candidates: ['SPY', 'IEF'] }, optimizer: { ...basis, basisUniverse: ['SPY', 'IEF', 'GLD', 'TLT'] } })).toThrow(
      /basisUniverse außerhalb des Kandidatenpools.*GLD, TLT/,
    );
  });

  it('im Pool (Kandidaten oder gehandelte Symbole, kanonisch) ⇒ gültig; ohne Pool ist der Korb eine eigene Einheit', () => {
    const cfg = parseConfig({ universe: { symbols: ['AAA', 'brk-b'], candidates: ['SPY', 'IEF'] }, optimizer: { ...basis, basisUniverse: ['SPY', 'BRK.B', 'AAA'] } });
    expect(cfg.optimizer.basisUniverse).toEqual(['SPY', 'BRK.B', 'AAA']);
    expect(parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { ...basis, basisUniverse: ['SPY', 'IEF'] } }).optimizer.basisUniverse).toEqual(['SPY', 'IEF']);
  });
});

describe('resolveMode — Echtgeld-Doppel-Guard', () => {
  it('Default ist Paper', () => {
    expect(resolveMode(parseConfig(minimal), env()).mode).toBe('paper');
  });

  it('live braucht mode=live UND ALPACA_ALLOW_LIVE=1 UND AK-Key', () => {
    const live = parseConfig({ ...minimal, broker: { mode: 'live' } });
    expect(resolveMode(live, env()).mode).toBe('paper');
    const r = resolveMode(live, env({ ALPACA_ALLOW_LIVE: '1' }));
    expect(r.mode).toBe('paper');
    expect(r.reasons.join(' ')).toMatch(/Live-Key/);
    expect(resolveMode(live, env({ ALPACA_ALLOW_LIVE: '1', ALPACA_API_KEY: 'AKREAL0000000000000000' })).mode).toBe('live');
  });

  it('Live-Key gegen Paper wird abgelehnt', () => {
    expect(() => resolveMode(parseConfig(minimal), env({ ALPACA_API_KEY: 'AKREAL0000000000000000' }))).toThrow(ConfigError);
  });
});

describe('parseDotenv', () => {
  it('liest KEY=VALUE, ignoriert Kommentare, entfernt Anführungszeichen', () => {
    const out = parseDotenv('# Kommentar\nA=1\nB="zwei"\nC=\'drei\'\n\nKAPUTT\n=leer\n');
    expect(out).toEqual({ A: '1', B: 'zwei', C: 'drei' });
  });
});
