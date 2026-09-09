/**
 * regime_allocation — was die Familie tut und vor allem, was sie NICHT tut.
 *
 * Geprüft wird durch `decide()` in core/logic.ts, wie live: Der Rang kommt
 * aus dem Kern, das Gewicht wird dort ins Sizing übersetzt. Ein Test, der die
 * Strategie direkt aufriefe, sähe nie, ob der Kern das Gewicht auch anwendet.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, HaltState, PositionState, SessionInfo } from '../../src/core/types.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';
import { VOL_LEN } from '../../src/strategy/regimeAllocation.ts';

const s = getStrategy('regime_allocation');
const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const params = resolveParams(s, { lookback: 126, skip: 0, regimeLen: 100, topPct: 0.2, exitPct: 0.6, targetVolPct: 10, stopPct: 20 });

/** Handelstage (Mo–Fr) ab dem 2. Januar 2024, Bar-Beginn 09:30 ET. */
function handelstage(n: number): number[] {
  const out: number[] = [];
  const d = new Date(Date.UTC(2024, 0, 2));
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(msFromET(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const TAGE = handelstage(400);
/** Index der ersten Bar eines Monats, die nach `ab` liegt. */
function erster(ab: number): number {
  for (let i = ab; i < TAGE.length; i++) {
    const a = new Date(TAGE[i]!).getUTCMonth();
    const b = new Date(TAGE[i - 1]!).getUTCMonth();
    if (a !== b) return i;
  }
  throw new Error('kein Monatswechsel');
}
const WARMUP = 126 + 2;
const REBAL = erster(WARMUP + 40); // ein Rebalance-Tag deutlich nach der Aufwärmphase
const KEIN_REBAL = REBAL + 5; // fünf Handelstage später — kein Monatswechsel

/** Serie über `n` Bars aus einer Kursfunktion je Index. */
function serie(n: number, kurs: (k: number) => number): BarSeries {
  const bars: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const c = kurs(k);
    bars.push({ t: TAGE[k]!, o: c, h: c * 1.002, l: c * 0.998, c, v: 100_000 });
  }
  return BarSeries.from(bars);
}
/** Gleichmäßiger Anstieg um `gesamtPct` über die Serie, mit leichtem Zickzack (sonst ist die Volatilität null). */
const rampe = (gesamtPct: number, zickzack = 0.005) => (k: number) => 100 * (1 + (gesamtPct * k) / 300) * (1 + (k % 2 === 0 ? zickzack : -zickzack));

const okSession: SessionInfo = { isRegularSession: true, minutesToClose: 200, minutesSinceOpen: 100, barsSinceOpen: 1, isLastBarOfDay: false, day: '2024-08-01' };
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

function input(symbol: string, bars: BarSeries, position: PositionState | null = null): SymbolInput {
  return { snap: { symbol, bars, i: bars.length - 1, position, session: okSession }, strategy: s, params, ind: s.precompute(bars, params) };
}
function ctx(over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: TAGE[REBAL]! + 86_400_000,
    today: '2024-08-01',
    nextTradingDay: '2024-08-02',
    account: { equity: 1_000_000, cash: 1_000_000, dayStartEquity: 1_000_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: { ...cfg.risk, maxPositions: 50 },
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: 1440,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    ...over,
  };
}
/** Zehn Symbole mit absteigender Stärke, alle über ihrem Mittel, Serie bis Index `bis` (inkl.). */
function korb(bis: number, n = 10): SymbolInput[] {
  return Array.from({ length: n }, (_, k) => input(`S${String(k).padStart(2, '0')}`, serie(bis + 1, rampe(0.6 - k * 0.05))));
}
const einstiege = (r: ReturnType<typeof decide>) => r.intents.filter((i) => i.kind === 'enter').map((i) => i.symbol).sort();
function position(symbol: string, entryPrice: number): PositionState {
  return { symbol, side: 'long', qty: 10, entryPrice, entryTime: 0, stop: entryPrice * 0.8, target: null, initialStop: entryPrice * 0.8, highWater: entryPrice, strategy: s.id, barsHeld: 20 } as PositionState;
}

describe('regime_allocation', () => {
  it('kauft am Rebalance-Tag die relativ Stärksten — und nur die', () => {
    expect(einstiege(decide(ctx(), korb(REBAL)))).toEqual(['S00', 'S01']);
  });

  it('entscheidet zwischen zwei Rebalance-Tagen NICHTS — weder Einstieg …', () => {
    expect(decide(ctx({ now: TAGE[KEIN_REBAL]! + 86_400_000 }), korb(KEIN_REBAL)).intents).toHaveLength(0);
  });

  it('… noch Ausstieg, selbst wenn das Regime verloren ist (der Broker-Stop wacht)', () => {
    // S00 bricht in den letzten 30 Bars um 25 % ein: unter das Mittel, Momentum über 126 Bars noch positiv.
    const bruch = (k: number) => (k <= KEIN_REBAL - 30 ? rampe(0.6)(k) : rampe(0.6)(KEIN_REBAL - 30) * (1 - (0.25 * (k - (KEIN_REBAL - 30))) / 30));
    const bars = serie(KEIN_REBAL + 1, bruch);
    const pos = position('S00', bars.c[KEIN_REBAL - 30]!);
    const r = decide(ctx({ now: TAGE[KEIN_REBAL]! + 86_400_000, positions: new Map([['S00', pos]]) }), [input('S00', bars, pos), ...korb(KEIN_REBAL).slice(1)]);
    expect(r.intents.filter((i) => i.kind === 'exit')).toHaveLength(0);
  });

  it('am Rebalance-Tag steigt sie aus, wenn das Regime verloren ist', () => {
    const bruch = (k: number) => (k <= REBAL - 30 ? rampe(0.6)(k) : rampe(0.6)(REBAL - 30) * (1 - (0.25 * (k - (REBAL - 30))) / 30));
    const bars = serie(REBAL + 1, bruch);
    const pos = position('S00', bars.c[REBAL - 30]!);
    const r = decide(ctx({ positions: new Map([['S00', pos]]) }), [input('S00', bars, pos), ...korb(REBAL).slice(1)]);
    expect(r.intents.find((i) => i.kind === 'exit' && i.symbol === 'S00')).toBeDefined();
    // Der Intent trägt die Kategorie; der Text der Strategie steht in der Notiz.
    expect(r.notes.some((n) => n.symbol === 'S00' && /Regime verloren/.test(n.text))).toBe(true);
  });

  it('kauft NICHT unter dem Mittel, auch wenn das Symbol relativ das stärkste ist', () => {
    // S00: stärkster Anstieg, aber die letzten 30 Bars 25 % Einbruch ⇒ Close < SMA(100); alle anderen schwächer.
    const bruch = (k: number) => (k <= REBAL - 30 ? rampe(0.9)(k) : rampe(0.9)(REBAL - 30) * (1 - (0.25 * (k - (REBAL - 30))) / 30));
    const r = decide(ctx(), [input('S00', serie(REBAL + 1, bruch)), ...korb(REBAL).slice(1)]);
    expect(einstiege(r)).not.toContain('S00');
  });

  it('kauft NICHT bei negativem eigenem Momentum — auch nicht den relativ Stärksten (Dual Momentum)', () => {
    // Alle fallen; S00 fällt am wenigsten und liegt (per Konstruktion) über seinem Mittel? Nein: fallend ⇒ unter dem Mittel.
    // Deshalb: alle fallen, aber S00 hat einen späten Hüpfer über das Mittel bei weiter negativem 126-Bar-Momentum.
    const spaet = (k: number) => (k <= REBAL - 10 ? rampe(-0.3)(k) : rampe(-0.3)(REBAL - 10) * (1 + (0.12 * (k - (REBAL - 10))) / 10));
    const andere = Array.from({ length: 9 }, (_, k) => input(`S${String(k + 1).padStart(2, '0')}`, serie(REBAL + 1, rampe(-0.4 - k * 0.05))));
    const r = decide(ctx(), [input('S00', serie(REBAL + 1, spaet)), ...andere]);
    expect(einstiege(r)).toEqual([]);
  });

  it('das Gewicht ist Zielvolatilität / realisierte Volatilität — und der Kern setzt es um', () => {
    // Zickzack ±1 % um die Rampe ⇒ Tagesrenditen ≈ ±2 % ⇒ p. a. ≈ 32 % ⇒ Gewicht ≈ 10 / 32 ≈ 0,31.
    // Die Rampe ist steiler als die der anderen, damit S00 trotz der Schwankung
    // (die den crossScore teilt) an der Spitze des Korbs bleibt.
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositions: 50, maxPositionPct: 100 } }), korb(REBAL).map((x, k) => (k === 0 ? input('S00', serie(REBAL + 1, rampe(2.0, 0.01))) : x)));
    const e = r.intents.find((i) => i.kind === 'enter' && i.symbol === 'S00');
    expect(e).toBeDefined();
    if (e?.kind !== 'enter') throw new Error('kein Einstieg');
    const anteil = (e.qty * e.refPrice) / 1_000_000;
    expect(anteil).toBeGreaterThan(0.25);
    expect(anteil).toBeLessThan(0.4);
    // Katastrophen-Stop 20 % unter dem Einstand, kein Ziel.
    expect(e.stop).toBeCloseTo(e.refPrice * 0.8, 6);
    expect(e.target).toBeNull();
  });

  it('der Positionsdeckel gilt auch für das Gewicht', () => {
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositions: 50, maxPositionPct: 5 } }), korb(REBAL));
    for (const e of r.intents) {
      if (e.kind !== 'enter') continue;
      expect((e.qty * e.refPrice) / 1_000_000).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('nur Tagesbars; Warmup deckt Momentum, Mittel und Volatilität', () => {
    expect(s.timeframes).toEqual([1440]);
    expect(s.warmupBars(params)).toBeGreaterThanOrEqual(Math.max(126, 100, VOL_LEN + 1));
  });
});
