/**
 * RED-TEAM (gering): PDT-Reserve für Übernacht-Strategien wird je Zyklus
 * nicht verbraucht. logic.ts:302 zählt `plannedIntraday` nur für
 * holdsOvernight=false; pdt.ts:52-60 verlangt für Übernacht-Einstiege aber
 * „Rest > 0", weil ein Stop am selben Tag ein Daytrade wäre. Drei Symbole
 * im selben Zyklus bekommen alle den letzten freien Daytrade.
 */
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { msFromET } from '../../src/core/time.ts';
import type { SymbolSnapshot } from '../../src/core/types.ts';
import { barsMap, fullDay5, strategyOf } from '../backtest/helpers.ts';

describe('RED-TEAM PDT Übernacht', () => {
  it('bei einem freien Daytrade darf höchstens EIN Übernacht-Einstieg je Zyklus geplant werden', () => {
    const cfg = ConfigSchema.parse({ universe: { symbols: ['A', 'B', 'C'] } });
    const strategy = strategyOf({
      holdsOvernight: true,
      decide: (snap) => ({ kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.95, reason: 'x' }),
    });
    const series = barsMap({ A: fullDay5('2026-09-01', 100), B: fullDay5('2026-09-01', 100), C: fullDay5('2026-09-01', 100) });
    const i = 20;
    const session = { isRegularSession: true, minutesToClose: 285, minutesSinceOpen: 105, barsSinceOpen: 21, isLastBarOfDay: false, day: '2026-09-01' };
    const inputs: SymbolInput[] = ['A', 'B', 'C'].map((s) => {
      const snap: SymbolSnapshot = { symbol: s, bars: series.get(s)!.prefix(i + 1), i, position: null, session };
      return { snap, strategy, params: {}, ind: {} };
    });
    const ctx: LogicContext = {
      now: msFromET(2026, 9, 1, 11, 15),
      today: '2026-09-01',
      nextTradingDay: '2026-09-02',
      account: { equity: 10_000, cash: 10_000, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 2, patternDayTrader: false },
      positions: new Map(),
      pendingEntries: new Set(),
      halt: { halted: false, reason: null, since: null, until: null, note: null },
      risk: cfg.risk,
      session: cfg.session,
      assetClass: 'us_equity',
      timeframe: 5,
      dataFresh: true,
      localDayTrades: 2,
      assetFacts: () => ({ tradable: true, shortable: true }),
    };
    const res = decide(ctx, inputs);
    const enters = res.intents.filter((x) => x.kind === 'enter');
    // Erwartet ≤ 1 (ein Rest-Daytrade). Beobachtet: 3.
    expect(enters.length).toBeLessThanOrEqual(1);
  });
});
