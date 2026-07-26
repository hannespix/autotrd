/**
 * Tests der puren Regelbaum-Trading-Bausteine (M10): Risiko-Hülle (Clamps,
 * Cooldown), RuleContext-Builder und die Richtungsentscheidung.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, compileClassic, type IndicatorSnapshot } from '../../shared/src/index.js';
import {
  RISK_LIMITS,
  buildRuleContext,
  clampStrategyRisk,
  cooldownActive,
  decideTree,
  applyPredictionVote,
  minuteOfDayEt,
  planPromotion,
  predictionVote,
  shadowEquity,
  shadowTrade,
} from '../src/core/rulesTrading.js';

const SNAPSHOT: IndicatorSnapshot = {
  rsi: 22,
  macd: { line: 1.2, signal: 1.0, histogram: 0.2 },
  bollinger: { upper: 110, middle: 100, lower: 90, pctB: 3 },
};

describe('Risiko-Hülle (von keinem Knoten überschreibbar)', () => {
  it('klemmt maxPositionPct hart auf 25 und erzwingt einen Stop-Loss', () => {
    const greedy = structuredClone(DEFAULT_STRATEGY);
    greedy.engine.maxPositionPct = 80;
    greedy.engine.stopLossPct = 0;
    const clamped = clampStrategyRisk(greedy);
    expect(clamped.engine.maxPositionPct).toBe(RISK_LIMITS.maxPositionPct);
    expect(clamped.engine.stopLossPct).toBe(RISK_LIMITS.emergencyStopPct);
    // Original bleibt unangetastet (pure)
    expect(greedy.engine.maxPositionPct).toBe(80);
  });

  it('lässt konservative Configs unverändert', () => {
    const c = clampStrategyRisk(DEFAULT_STRATEGY);
    expect(c.engine.maxPositionPct).toBe(DEFAULT_STRATEGY.engine.maxPositionPct);
    expect(c.engine.stopLossPct).toBe(DEFAULT_STRATEGY.engine.stopLossPct);
  });

  it('Cooldown: aktiv innerhalb des Fensters, danach frei, robust bei Müll', () => {
    const now = new Date('2026-07-24T15:00:00Z');
    const within = new Date(now.getTime() - (RISK_LIMITS.cooldownMin - 1) * 60_000).toISOString();
    const past = new Date(now.getTime() - (RISK_LIMITS.cooldownMin + 1) * 60_000).toISOString();
    expect(cooldownActive(within, now)).toBe(true);
    expect(cooldownActive(past, now)).toBe(false);
    expect(cooldownActive(undefined, now)).toBe(false);
    expect(cooldownActive('kein-datum', now)).toBe(false);
  });
});

describe('buildRuleContext + decideTree', () => {
  it('mappt Snapshot-Werte vollständig in den Kontext', () => {
    const ctx = buildRuleContext({
      price: 100,
      snapshot: SNAPSHOT,
      prevSnapshot: { ...SNAPSHOT, rsi: 35 },
      prevPrice: 99,
      closes: [95, 97, 99, 100],
      minuteOfDayEt: 600,
      forecastPct: 1.5,
      position: { open: false },
    });
    expect(ctx.values['rsi']).toBe(22);
    expect(ctx.values['macdSignal']).toBe(1.0);
    expect(ctx.values['pctB']).toBe(3);
    expect(ctx.prevValues?.['rsi']).toBe(35);
    expect(ctx.prevValues?.['price']).toBe(99);
    expect(ctx.forecastPct).toBe(1.5);
  });

  it('null-Indikatoren werden zu unbekannt, nicht zu 0', () => {
    const ctx = buildRuleContext({
      price: 100,
      snapshot: { rsi: null, macd: null, bollinger: null },
      closes: [100],
      minuteOfDayEt: null,
      position: null,
    });
    expect(ctx.values['rsi']).toBeNull();
    expect(ctx.values['macdLine']).toBeUndefined();
  });

  it('decideTree: kompilierte Classic-Spec kauft im klaren Buy-Setup', () => {
    const spec = compileClassic(DEFAULT_STRATEGY);
    const ctx = buildRuleContext({
      price: 100,
      snapshot: SNAPSHOT, // RSI 22 (buy), MACD-Cross (buy), pctB 3 (buy)
      closes: [95, 97, 99, 100],
      minuteOfDayEt: 600,
      forecastPct: 2, // Forecast-Vote buy (w2)
      position: { open: false },
    });
    expect(decideTree(spec, ctx)).toBe('buy');
  });

  it('decideTree: Sell-Setup verkauft, Patt hält', () => {
    const spec = compileClassic(DEFAULT_STRATEGY);
    const sellCtx = buildRuleContext({
      price: 100,
      snapshot: {
        rsi: 85,
        macd: { line: 0.8, signal: 1.0, histogram: -0.2 },
        bollinger: { upper: 110, middle: 100, lower: 90, pctB: 99 },
      },
      closes: [105, 103, 101, 100],
      minuteOfDayEt: 600,
      forecastPct: -2,
      position: { open: true, unrealizedPct: -1 },
    });
    expect(decideTree(spec, sellCtx)).toBe('sell');

    const mixedCtx = buildRuleContext({
      price: 100,
      snapshot: { rsi: 50, macd: { line: 1, signal: 1, histogram: 0 }, bollinger: { upper: 110, middle: 100, lower: 90, pctB: 50 } },
      closes: [100],
      minuteOfDayEt: 600,
      forecastPct: 0,
      position: { open: false },
    });
    expect(decideTree(spec, mixedCtx)).toBe('hold');
  });
});

describe('minuteOfDayEt', () => {
  it('rechnet UTC korrekt nach ET um (EDT im Juli, EST im Januar)', () => {
    expect(minuteOfDayEt(new Date('2026-07-22T16:00:00Z'))).toBe(12 * 60); // 12:00 EDT
    expect(minuteOfDayEt(new Date('2026-01-21T14:30:00Z'))).toBe(9 * 60 + 30); // 09:30 EST
  });
});

describe('Shadow-Konto (M11): pure Buchführung', () => {
  it('Entry dimensioniert nach maxPositionPct, Exit stellt komplett glatt — mit Paper-Gebühren', () => {
    // Realismus (User-Wunsch 25.07.): effektiver Preis = 500 × 1,0015 = 500.75
    const start = { balance: 25_000, positions: {} };
    const buy = shadowTrade(start, 'QQQ', 'buy', 500, 10); // 2500 / 500.75 → 4 Stück
    expect(buy.executed).toBe(true);
    expect(buy.book.positions['QQQ']).toEqual({ qty: 4, avgEntry: 500.75, highWater: 500.75 });
    expect(buy.book.balance).toBeCloseTo(25_000 - 4 * 500.75, 6);
    // nie nachkaufen
    expect(shadowTrade(buy.book, 'QQQ', 'buy', 480, 10).executed).toBe(false);
    // Verkauf zu 520 → effektiv 520 × 0,9985 = 519.22 je Stück zurück
    const sell = shadowTrade(buy.book, 'QQQ', 'sell', 520, 10);
    expect(sell.executed).toBe(true);
    expect(sell.book.balance).toBeCloseTo(buy.book.balance + 4 * 519.22, 6);
    expect(sell.book.positions['QQQ']).toBeUndefined();
    // Original bleibt unangetastet (pure)
    expect(start.positions).toEqual({});
  });

  it('Sell ohne Position und Buy ohne Budget sind No-ops', () => {
    expect(shadowTrade({ balance: 100, positions: {} }, 'QQQ', 'sell', 500, 10).executed).toBe(false);
    expect(shadowTrade({ balance: 100, positions: {} }, 'QQQ', 'buy', 500, 10).executed).toBe(false);
  });

  it('shadowEquity = Balance + Positionswert (fehlender Preis → Einstand)', () => {
    const book = { balance: 1_000, positions: { QQQ: { qty: 5, avgEntry: 500 }, AAPL: { qty: 2, avgEntry: 200 } } };
    expect(shadowEquity(book, new Map([['QQQ', 520]]))).toBe(1_000 + 2_600 + 400);
  });
});

describe('Shadow-Duell-Parität (MA4, 26.07.)', () => {
  it("Sizing-Basis 'initial' via capital-Override — wie der echte Broker", () => {
    // Startkapital 25 000, aber nur noch 3 000 Cash: 10 % von 25 000 = 2 500
    // → 4 Stück à 500.75 = 2 003 ≤ 3 000 Deckung → Kauf geht durch.
    const book = { balance: 3_000, positions: {} };
    const r = shadowTrade(book, 'QQQ', 'buy', 500, 10, { capital: 25_000 });
    expect(r.executed).toBe(true);
    expect(r.book.positions['QQQ']?.qty).toBe(4);
  });

  it('Deckung prüft IMMER der Shadow-Cash (zu_wenig_cash-Parität)', () => {
    // 10 % von 25 000 wollen 4 Stück (2 003) — Cash deckt nur 1 500 → No-op
    const book = { balance: 1_500, positions: {} };
    expect(shadowTrade(book, 'QQQ', 'buy', 500, 10, { capital: 25_000 }).executed).toBe(false);
  });

  it('Kauf stempelt highWater (= Einstand) und openedAt für Trailing/Zeitgrenze', () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const r = shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'buy', 500, 10, { now });
    expect(r.book.positions['QQQ']).toEqual({
      qty: 4,
      avgEntry: 500.75,
      highWater: 500.75,
      openedAt: '2026-07-26T12:00:00.000Z',
    });
  });

  it('negatives capital kauft nichts (Math.max-Guard)', () => {
    expect(shadowTrade({ balance: 25_000, positions: {} }, 'QQQ', 'buy', 500, 10, { capital: -1 }).executed).toBe(false);
  });
});

describe('Befördern (M11 A/B): purer Rollentausch-Plan', () => {
  const S = (id: string, mode: 'paper' | 'shadow', symbols: string[], status = 'published') => ({
    id,
    status,
    mode,
    symbols,
  });

  it('demotet genau die überlappenden Paper-Strategien', () => {
    const list = [
      S('a', 'paper', ['QQQ', 'AAPL']),
      S('b', 'shadow', ['QQQ']),
      S('c', 'paper', ['TSLA']), // keine Überlappung → bleibt
      S('d', 'paper', ['AAPL'], 'draft'), // nicht publiziert → handelt eh nicht
    ];
    expect(planPromotion(list, 'b')).toEqual({ demote: ['a'] });
  });

  it('ohne Überlappung wird niemand demotet', () => {
    expect(planPromotion([S('x', 'shadow', ['BTC-USD']), S('y', 'paper', ['QQQ'])], 'x')).toEqual({ demote: [] });
  });

  it('lehnt ungültige Ziele ab (fehlt / draft / paper / ohne Symbole)', () => {
    expect(() => planPromotion([], 'nix')).toThrow(/existiert nicht/);
    expect(() => planPromotion([S('a', 'shadow', ['QQQ'], 'draft')], 'a')).toThrow(/publizieren/);
    expect(() => planPromotion([S('a', 'paper', ['QQQ'])], 'a')).toThrow(/Shadow/);
    expect(() => planPromotion([S('a', 'shadow', [])], 'a')).toThrow(/Symbole/);
  });
});

describe('User-Prognose-Stimme (Chart-Pfeile)', () => {
  const pred = (over: Partial<import('../../shared/src/index.js').UserPrediction> = {}) => ({
    symbol: 'QQQ',
    targetPrice: 620,
    targetDate: '2026-08-15',
    confidence: 2 as const,
    basePrice: 600,
    baseDate: '2026-07-24',
    createdAt: '2026-07-24T20:00:00Z',
    ...over,
  });
  const NOW = '2026-07-24T20:30:00Z';

  it('Richtung + Gewicht aus Ziel vs. Kurs; Mini-Abstände zählen nicht', () => {
    expect(predictionVote(pred(), 600, NOW)).toEqual({ dir: 'buy', weight: 2 });
    expect(predictionVote(pred({ targetPrice: 580, confidence: 3 }), 600, NOW)).toEqual({ dir: 'sell', weight: 3 });
    expect(predictionVote(pred({ targetPrice: 600.5 }), 600, NOW)).toBeNull(); // < ±0,2 %
    expect(predictionVote(undefined, 600, NOW)).toBeNull();
  });

  it('abgelaufene Prognosen zählen nicht (Stichtag inklusiv)', () => {
    expect(predictionVote(pred({ targetDate: '2026-07-23' }), 600, NOW)).toBeNull();
    expect(predictionVote(pred({ targetDate: '2026-07-24' }), 600, NOW)).not.toBeNull();
  });

  it('kippt die Konfluenz-Entscheidung nach der Engine-Regel', () => {
    const base = { direction: 'hold' as const, buyVotes: 1, sellVotes: 0, requiredConfluence: 2 };
    // +2 buy → 3 ≥ 2 und > 0 → buy
    expect(applyPredictionVote(base, { dir: 'buy', weight: 2 })).toBe('buy');
    // Gegenstimme reicht nicht für sell (1 < 2) → hold
    expect(applyPredictionVote(base, { dir: 'sell', weight: 1 })).toBe('hold');
    // Patt bleibt hold: buy 2 vs sell 2
    expect(
      applyPredictionVote({ direction: 'hold', buyVotes: 2, sellVotes: 0, requiredConfluence: 2 }, { dir: 'sell', weight: 2 }),
    ).toBe('hold');
    // ohne Stimme bleibt die Engine-Entscheidung
    expect(applyPredictionVote({ ...base, direction: 'sell' }, null)).toBe('sell');
  });
});
