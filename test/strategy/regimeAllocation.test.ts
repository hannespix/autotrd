/**
 * regime_allocation — was die Familie tut und vor allem, was sie NICHT tut.
 *
 * Geprüft wird durch `decide()` in core/logic.ts, wie live: Der Rang kommt
 * aus dem Kern, die Stückzahl aus dem Risiko-Budget. Ein Test, der die
 * Strategie direkt aufriefe, sähe nie, ob der Kern mitspielt. Zum Schluss
 * läuft sie einmal durch den echten Simulator.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, HaltState, PositionState, SessionInfo } from '../../src/core/types.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';
import { REBAL_TAGE, VOL_LEN } from '../../src/strategy/regimeAllocation.ts';
import { baseConfig } from '../backtest/helpers.ts';

const s = getStrategy('regime_allocation');
const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const params = resolveParams(s, { lookback: 63, skip: 0, regimeLen: 50, topPct: 0.2, exitPct: 0.6, stopPct: 20 });

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
/** Index der ersten Bar eines Monats nach `ab`. */
function erster(ab: number): number {
  for (let i = ab; i < TAGE.length; i++) {
    if (new Date(TAGE[i]!).getUTCMonth() !== new Date(TAGE[i - 1]!).getUTCMonth()) return i;
  }
  throw new Error('kein Monatswechsel');
}
const WARMUP = s.warmupBars(params);
const REBAL = erster(WARMUP + 40); // erster Tag eines Fensters, deutlich nach der Aufwärmphase
const FENSTER_ENDE = REBAL + REBAL_TAGE - 1; // letzter Tag des Fensters
const KEIN_REBAL = REBAL + REBAL_TAGE + 2; // außerhalb

/** Serie über `n` Bars aus einer Kursfunktion je Index. */
function serie(n: number, kurs: (k: number) => number): BarSeries {
  const bars: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const c = kurs(k);
    bars.push({ t: TAGE[k]!, o: c, h: c * 1.002, l: c * 0.998, c, v: 100_000 });
  }
  return BarSeries.from(bars);
}
/** Gleichmäßiger Anstieg um `gesamtPct` über 300 Bars, mit Zickzack (sonst ist die Volatilität null). */
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
/** Rampe bis `bis − 30`, dann 25 % Einbruch über 30 Bars — unter das Mittel, Momentum über 63 Bars noch positiv. */
const bruch = (g: number, bis: number) => (k: number) => (k <= bis - 30 ? rampe(g)(k) : rampe(g)(bis - 30) * (1 - (0.25 * (k - (bis - 30))) / 30));

describe('regime_allocation', () => {
  it('kauft im Fenster die relativ Stärksten — und nur die', () => {
    expect(einstiege(decide(ctx(), korb(REBAL)))).toEqual(['S00', 'S01']);
  });

  it('das Fenster hat drei Tage: am dritten noch, am vierten nicht mehr', () => {
    expect(einstiege(decide(ctx({ now: TAGE[FENSTER_ENDE]! + 86_400_000 }), korb(FENSTER_ENDE)))).toEqual(['S00', 'S01']);
    expect(decide(ctx({ now: TAGE[FENSTER_ENDE + 1]! + 86_400_000 }), korb(FENSTER_ENDE + 1)).intents).toHaveLength(0);
  });

  it('außerhalb des Fensters entscheidet sie NICHTS — weder Einstieg …', () => {
    expect(decide(ctx({ now: TAGE[KEIN_REBAL]! + 86_400_000 }), korb(KEIN_REBAL)).intents).toHaveLength(0);
  });

  it('… noch Ausstieg, selbst wenn das Regime verloren ist (der Broker-Stop wacht)', () => {
    const bars = serie(KEIN_REBAL + 1, bruch(0.6, KEIN_REBAL));
    const pos = position('S00', bars.c[KEIN_REBAL - 30]!);
    const r = decide(ctx({ now: TAGE[KEIN_REBAL]! + 86_400_000, positions: new Map([['S00', pos]]) }), [input('S00', bars, pos), ...korb(KEIN_REBAL).slice(1)]);
    expect(r.intents.filter((i) => i.kind === 'exit')).toHaveLength(0);
  });

  it('im Fenster steigt sie aus, wenn das Regime verloren ist', () => {
    const bars = serie(REBAL + 1, bruch(0.6, REBAL));
    const pos = position('S00', bars.c[REBAL - 30]!);
    const r = decide(ctx({ positions: new Map([['S00', pos]]) }), [input('S00', bars, pos), ...korb(REBAL).slice(1)]);
    expect(r.intents.find((i) => i.kind === 'exit' && i.symbol === 'S00')).toBeDefined();
    expect(r.notes.some((n) => n.symbol === 'S00' && /Regime verloren/.test(n.text))).toBe(true);
  });

  it('im Fenster steigt sie aus, wenn das eigene Momentum negativ ist — auch über dem Mittel', () => {
    // 43 Bars 15 % abwärts, dann 20 Bars 8 % aufwärts: Close über SMA(50), aber unter dem Kurs von vor 63 Bars.
    const start = REBAL - 63;
    const kurs = (k: number) => (k <= start ? 100 : k <= REBAL - 20 ? 100 * (1 - (0.15 * (k - start)) / 43) : 85 * (1 + (0.08 * (k - (REBAL - 20))) / 20));
    const bars = serie(REBAL + 1, kurs);
    const ind = s.precompute(bars, params);
    expect(ind.mom![REBAL]!).toBeLessThan(0);
    expect(bars.c[REBAL]!).toBeGreaterThan(ind.sma![REBAL]!);
    const pos = position('S00', 90);
    const r = decide(ctx({ positions: new Map([['S00', pos]]) }), [input('S00', bars, pos), ...korb(REBAL).slice(1)]);
    expect(r.notes.some((n) => n.symbol === 'S00' && /Momentum negativ/.test(n.text))).toBe(true);
  });

  it('im Fenster steigt sie aus, wenn die relative Stärke verloren ist', () => {
    const k = korb(REBAL);
    const schwach = k[9]!; // S09: Rang 10 von 10 ⇒ pct 1 > exitPct 0,6
    const pos = position('S09', schwach.snap.bars.c[REBAL]!);
    const r = decide(ctx({ positions: new Map([['S09', pos]]) }), [...k.slice(0, 9), { ...schwach, snap: { ...schwach.snap, position: pos } }]);
    expect(r.notes.some((n) => n.symbol === 'S09' && /relative Stärke verloren/.test(n.text))).toBe(true);
  });

  it('kauft NICHT unter dem Mittel, auch wenn das Symbol relativ das stärkste ist', () => {
    const r = decide(ctx(), [input('S00', serie(REBAL + 1, bruch(0.9, REBAL))), ...korb(REBAL).slice(1)]);
    expect(einstiege(r)).not.toContain('S00');
  });

  it('kauft NICHT bei negativem eigenem Momentum — auch nicht den relativ Stärksten (Dual Momentum)', () => {
    // S00 fällt 63 Bars lang steil (−19 %) und hüpft in den letzten 10 Bars um 12 % über sein Mittel:
    // Momentum über 63 Bars bleibt negativ, Regime sagt ja — Dual Momentum sagt nein.
    const spaet = (k: number) => (k <= REBAL - 10 ? rampe(-0.9)(k) : rampe(-0.9)(REBAL - 10) * (1 + (0.12 * (k - (REBAL - 10))) / 10));
    const andere = Array.from({ length: 9 }, (_, k) => input(`S${String(k + 1).padStart(2, '0')}`, serie(REBAL + 1, rampe(-1.0 - k * 0.05))));
    const ind0 = s.precompute(serie(REBAL + 1, spaet), params);
    expect(ind0.mom![REBAL]!).toBeLessThan(0);
    expect(spaet(REBAL)).toBeGreaterThan(ind0.sma![REBAL]!);
    expect(einstiege(decide(ctx(), [input('S00', serie(REBAL + 1, spaet)), ...andere]))).toEqual([]);
  });

  it('rührt sich nicht, wenn der Korb zu klein für eine Rangaussage ist', () => {
    expect(decide(ctx(), korb(REBAL, 7)).intents).toHaveLength(0);
  });

  it('die Rangkennzahl teilt durch die Schwankung: der ruhigere Wert schlägt den unruhigeren mit etwas mehr Rendite', () => {
    // S00: 60 % Anstieg mit ±2 % Zickzack. S01: 58 % ruhig. Ohne Vol-Teilung gewänne S00.
    // Gerader Lookback (84): So hebt sich der Zickzack an beiden Enden auf, und
    // allein die Schwankung entscheidet — nicht die Parität der Endpunkte.
    const p84 = resolveParams(s, { ...params, lookback: 84 });
    const inp = (symbol: string, bars: BarSeries): SymbolInput => ({ snap: { symbol, bars, i: bars.length - 1, position: null, session: okSession }, strategy: s, params: p84, ind: s.precompute(bars, p84) });
    const k = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? inp('S00', serie(REBAL + 1, rampe(0.6, 0.02))) : i === 1 ? inp('S01', serie(REBAL + 1, rampe(0.58))) : inp(`S${String(i).padStart(2, '0')}`, serie(REBAL + 1, rampe(0.4 - i * 0.03))),
    );
    expect(einstiege(decide(ctx({ risk: { ...cfg.risk, maxPositions: 1 } }), k))).toEqual(['S01']);
  });

  it('die Stückzahl folgt dem Risiko-Budget über die Stop-Distanz — wie bei jeder Vorlage', () => {
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositions: 50, maxPositionPct: 100 } }), korb(REBAL));
    const e = r.intents.find((i) => i.kind === 'enter' && i.symbol === 'S00');
    if (e?.kind !== 'enter') throw new Error('kein Einstieg');
    const risiko = e.qty * (e.refPrice - e.stop);
    const budget = (1_000_000 * cfg.risk.riskPerTradePct) / 100; // 0,5 % ⇒ 5 000 $
    expect(risiko).toBeLessThanOrEqual(budget);
    expect(risiko).toBeGreaterThan(budget - (e.refPrice - e.stop)); // höchstens ein Stück unter dem Budget
    expect(e.stop).toBeCloseTo(e.refPrice * 0.8, 6);
    expect(e.target).toBeNull();
  });

  it('nur Tagesbars; Warmup deckt Momentum, Mittel und Volatilität; Embargo passt ins IS-Fenster', () => {
    expect(s.timeframes).toEqual([1440]);
    expect(WARMUP).toBeGreaterThanOrEqual(Math.max(63, 50, VOL_LEN + 1));
    // Größter Warmup des Gitters (126 + 21) plus 20 Embargo-Bars muss unter einem 365-Tage-IS-Fenster (~252 Bars) bleiben.
    expect(s.warmupBars(resolveParams(s, { lookback: 126, skip: 21, regimeLen: 150 })) + 20).toBeLessThan(230);
  });

  it('durch den echten Simulator: Einstiege nur aus dem Fenster, Ausstiege nur aus dem Fenster oder über den Broker-Stop', () => {
    // Zehn Rampen; S00 bricht ab Bar 220 um 35 % ein: Erst reißt der 20 %-Stop
    // (zwischen zwei Fenstern erlaubt — nur er wacht dort), dann rückt am
    // nächsten Fenster der Nächste nach. So gibt es geschlossene Trades.
    const symbole = Array.from({ length: 10 }, (_, k) => `S${String(k).padStart(2, '0')}`);
    const mitBruch = (g: number) => (k: number) => (k < 220 ? rampe(g, 0.004)(k) : rampe(g, 0.004)(219) * Math.max(0.55, 1 - (0.35 * (k - 219)) / 40));
    const bars = new Map(symbole.map((sym, k) => [sym, serie(TAGE.length, k === 0 ? mitBruch(0.8) : rampe(0.8 - k * 0.06, 0.004))]));
    const res = simulate({
      bars,
      strategyFor: () => ({ strategy: s, params }),
      config: baseConfig({ timeframe: 1440, risk: { maxPositions: 4 } }),
      initialEquity: 100_000,
    });
    expect(res.trades.length).toBeGreaterThan(0);
    const rebal = s.precompute(bars.get('S01')!, params).rebal!;
    const imFenster = (t: number) => {
      const idx = TAGE.findIndex((x) => x >= t);
      return idx > 0 && (rebal[idx - 1] === 1 || rebal[idx] === 1); // Entscheidung an einer Fenster-Bar, Fill am nächsten Open
    };
    for (const t of res.trades) {
      expect(imFenster(t.entryTime), `Einstieg ${new Date(t.entryTime).toISOString()} außerhalb des Fensters`).toBe(true);
      expect(t.exitReason === 'stop' || imFenster(t.exitTime), `Ausstieg ${t.symbol} ${t.exitReason} ${new Date(t.exitTime).toISOString()}`).toBe(true);
    }
    // S00 wird geschlossen — je nach Tempo des Einbruchs am Fenster (Regime) oder über den Stop; beides ist der Vertrag.
    expect(res.trades.some((t) => t.symbol === 'S00')).toBe(true);
  });
});
