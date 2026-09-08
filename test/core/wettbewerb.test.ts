/**
 * Wer bekommt den letzten freien Platz?
 *
 * `maxPositions`, Brutto-Exposure, PDT-Reserve und Bargeld sind gemeinsame
 * Budgets. Vor `wettbewerbsOrdnung` entschied darüber die Reihenfolge, in der
 * der Aufrufer seine Liste gebaut hatte — also `universe.symbols`. Bei 30
 * Symbolen auf 4 Plätzen hätten die ersten vier Einträge der Config
 * systematisch gewonnen, und ein umsortiertes Universum hätte das Ergebnis
 * verschoben, ohne dass sich eine Strategie geändert hat.
 *
 * Diese Tests halten beides fest: Die Aufruferreihenfolge darf nichts mehr
 * ändern, und über die Zeit muss die Priorität gleich verteilt sein.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { decide, openPosition, wettbewerbsOrdnung, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import type { Decision, HaltState, SessionInfo, Strategy } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';

const cfg = parseConfig({ universe: { symbols: ['AAPL'] } });
const TF = 5;
const BUCKET = TF * 60_000;
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

const okSession: SessionInfo = {
  isRegularSession: true,
  minutesToClose: 200,
  minutesSinceOpen: 100,
  barsSinceOpen: 20,
  isLastBarOfDay: false,
  day: '2026-09-04',
};

function stub(decision: Decision): Strategy {
  return {
    id: 'stub',
    timeframes: TIMEFRAMES,
    paramSpace: [],
    defaults: {},
    holdsOvernight: true,
    warmupBars: () => 1,
    precompute: () => ({}),
    decide: () => decision,
  };
}

const enterLong: Decision = { kind: 'enter', side: 'long', stop: 98, target: 104, reason: 'test' };
const exitNow: Decision = { kind: 'exit', reason: 'signal' };

/** Ein Symbol mit Entscheidungs-Bar im Bucket `b`. */
function input(symbol: string, b: number, decision: Decision, withPosition = false): SymbolInput {
  const t = b * BUCKET;
  const bars = BarSeries.from([2, 1, 0].map((back) => ({ t: t - back * BUCKET, o: 100, h: 101, l: 99, c: 100, v: 1000 })));
  const position = withPosition
    ? openPosition({ symbol, side: 'long', qty: 10, fillPrice: 95, fillTime: 1, stop: 92, target: 110, strategy: 'stub', entryDay: '2026-09-03' })
    : null;
  return { snap: { symbol, bars, i: bars.length - 1, position, session: okSession }, strategy: stub(decision), params: {}, ind: {} };
}

function ctx(b: number, maxPositions: number): LogicContext {
  return {
    now: (b + 1) * BUCKET,
    today: '2026-09-04',
    nextTradingDay: '2026-09-08',
    // Über der PDT-Schwelle: Der Wettbewerb soll an `maxPositions` scheitern, nicht an der Daytrade-Reserve.
    account: { equity: 100_000, cash: 100_000, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: { ...cfg.risk, maxPositions },
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: TF,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
  };
}

const KORB = ['AAPL', 'DIA', 'IWM', 'QQQ', 'SPY', 'XOM'];

/** Welche Symbole bekommen im Bucket `b` einen Einstieg, wenn alle sechs kaufen wollen? */
function gewinner(b: number, maxPositions: number, reihenfolge: readonly string[] = KORB): string[] {
  const r = decide(
    ctx(b, maxPositions),
    reihenfolge.map((s) => input(s, b, enterLong)),
  );
  return r.intents.filter((i) => i.kind === 'enter').map((i) => i.symbol);
}

describe('wettbewerbsOrdnung', () => {
  it('ist unabhängig davon, wie der Aufrufer die Liste sortiert hat', () => {
    const vorwaerts = [...KORB];
    const rueckwaerts = [...KORB].reverse();
    const gemischt = ['QQQ', 'XOM', 'AAPL', 'SPY', 'IWM', 'DIA'];
    for (const b of [100, 101, 102, 103, 104, 105]) {
      const erwartet = gewinner(b, 2, vorwaerts);
      expect(gewinner(b, 2, rueckwaerts), `Bucket ${b} rückwärts`).toEqual(erwartet);
      expect(gewinner(b, 2, gemischt), `Bucket ${b} gemischt`).toEqual(erwartet);
    }
  });

  it('verteilt die Priorität über die Bars gleichmäßig — kein Symbol gewinnt immer', () => {
    const siege = new Map<string, number>();
    for (let b = 100; b < 100 + KORB.length; b++) {
      for (const s of gewinner(b, 1)) siege.set(s, (siege.get(s) ?? 0) + 1);
    }
    // Sechs Symbole, sechs Bars, ein Platz: Jeder ist genau einmal dran.
    expect([...siege.keys()].sort()).toEqual([...KORB].sort());
    expect([...siege.values()]).toEqual(KORB.map(() => 1));
  });

  it('bevorzugt nicht mehr den ersten Config-Eintrag (der Fehler, den es zu verhindern gilt)', () => {
    // Vor der Regel hätte AAPL als erster Eintrag alle sechs Bars gewonnen.
    let aapl = 0;
    for (let b = 100; b < 106; b++) if (gewinner(b, 1).includes('AAPL')) aapl++;
    expect(aapl, 'AAPL gewinnt nicht jede Bar, nur weil es alphabetisch/konfiguratorisch vorn steht').toBe(1);
  });

  it('lässt Exits unberührt — sie konkurrieren um nichts', () => {
    const positionen = new Map(
      KORB.map((s) => [
        s,
        openPosition({ symbol: s, side: 'long', qty: 10, fillPrice: 95, fillTime: 1, stop: 92, target: 110, strategy: 'stub', entryDay: '2026-09-03' }),
      ]),
    );
    for (const reihenfolge of [KORB, [...KORB].reverse()]) {
      const c = { ...ctx(100, 1), positions: positionen };
      const r = decide(c, reihenfolge.map((s) => input(s, 100, exitNow, true)));
      const exits = r.intents.filter((i) => i.kind === 'exit').map((i) => i.symbol);
      expect(exits.sort(), 'jede offene Position bekommt ihren Exit, egal in welcher Reihenfolge gefragt wird').toEqual([...KORB].sort());
    }
  });

  it('rotiert deterministisch: gleiche Bar, gleiche Reihenfolge', () => {
    const eins = wettbewerbsOrdnung(KORB.map((s) => input(s, 100, enterLong)), TF).map((i) => i.snap.symbol);
    const zwei = wettbewerbsOrdnung([...KORB].reverse().map((s) => input(s, 100, enterLong)), TF).map((i) => i.snap.symbol);
    expect(zwei).toEqual(eins);
    // Nächste Bar: um genau einen Platz weitergedreht.
    const drei = wettbewerbsOrdnung(KORB.map((s) => input(s, 101, enterLong)), TF).map((i) => i.snap.symbol);
    expect(drei).toEqual([...eins.slice(1), eins[0]!]);
  });

  it('lässt ein einzelnes Symbol unverändert', () => {
    const eins = wettbewerbsOrdnung([input('AAPL', 100, enterLong)], TF);
    expect(eins.map((i) => i.snap.symbol)).toEqual(['AAPL']);
  });
});
