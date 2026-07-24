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
  minuteOfDayEt,
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
    expect(clamped.engine.stopLossPct).toBe(RISK_LIMITS.fallbackStopLossPct);
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
