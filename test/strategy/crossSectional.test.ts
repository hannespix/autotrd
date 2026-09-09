/**
 * cross_sectional_momentum — die erste Strategie, die den KORB fragt statt
 * das einzelne Symbol.
 *
 * Sie existiert wegen der Messungen vom 08.09.2026: Vier symbolweise
 * Vorlagen, drei Zeitrahmen, und in zwei von drei kehrt sich die Rangfolge
 * zwischen OOS und Holdout vollständig um. Auf 30 stark korrelierten
 * Großwerten ist „steigt NVDA?" fast dieselbe Frage wie „steigt der Index?" —
 * die Auswahl greift dann das Marktregime ab, und Regime halten nicht.
 * Shorts helfen dagegen nicht (gemessen, ARCHITEKTUR.md §5a).
 *
 * „Ist NVDA stärker als die anderen 29?" ist eine andere Frage: Steigen alle,
 * ist niemand relativ stark. Diese Tests halten fest, dass die Strategie
 * genau das tut — und dass sie ohne belastbaren Rang lieber nichts tut.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { MIN_KORB } from '../../src/strategy/crossSectionalMomentum.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';
import type { Bar, HaltState, PositionState, SessionInfo } from '../../src/core/types.ts';

const s = getStrategy('cross_sectional_momentum');
const cfg = parseConfig({ universe: { symbols: ['AAA'] } });
const BUCKET = 300_000;
const N = 60;

const okSession: SessionInfo = {
  isRegularSession: true,
  minutesToClose: 200,
  minutesSinceOpen: 100,
  barsSinceOpen: 20,
  isLastBarOfDay: false,
  day: '2026-09-04',
};
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

/** Serie, die über N Bars gleichmäßig um `gesamtPct` steigt (oder fällt). */
function rampe(gesamtPct: number): BarSeries {
  const bars: Bar[] = [];
  for (let k = 0; k < N; k++) {
    const c = 100 * (1 + (gesamtPct * k) / (N - 1));
    bars.push({ t: k * BUCKET, o: c, h: c + 0.5, l: c - 0.5, c, v: 1000 });
  }
  return BarSeries.from(bars);
}

const params = resolveParams(s, { lookback: 20, skip: 0, topPct: 0.2, exitPct: 0.5, volAdjust: 0, atrLen: 7, atrMult: 2.5, trailMult: 0 });

function input(symbol: string, bars: BarSeries, position: PositionState | null = null): SymbolInput {
  const i = bars.length - 1;
  return { snap: { symbol, bars, i, position, session: okSession }, strategy: s, params, ind: s.precompute(bars, params) };
}

function ctx(over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: N * BUCKET,
    today: '2026-09-04',
    nextTradingDay: '2026-09-08',
    account: { equity: 1_000_000, cash: 1_000_000, dayStartEquity: 1_000_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: { ...cfg.risk, maxPositions: 50 },
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: 5,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    ...over,
  };
}

/** Zehn Symbole mit absteigender Stärke: S00 am stärksten, S09 am schwächsten. */
function korb(n = 10): SymbolInput[] {
  return Array.from({ length: n }, (_, k) => input(`S${String(k).padStart(2, '0')}`, rampe(0.5 - k * 0.1)));
}

const einstiege = (r: ReturnType<typeof decide>) => r.intents.filter((i) => i.kind === 'enter').map((i) => i.symbol).sort();

describe('cross_sectional_momentum', () => {
  it('kauft die stärksten des Korbs — und nur die', () => {
    // 10 Symbole, topPct 0.2 ⇒ pct = k/9 ≤ 0.2 ⇒ k ∈ {0, 1}.
    expect(einstiege(decide(ctx(), korb()))).toEqual(['S00', 'S01']);
  });

  it('urteilt RELATIV: steigen alle gleich stark, ist niemand stark genug', () => {
    // Genau das kann eine symbolweise Trendfolge nicht — sie würde alle kaufen.
    const alleGleich = Array.from({ length: 10 }, (_, k) => input(`S${String(k).padStart(2, '0')}`, rampe(0.5)));
    const r = decide(ctx(), alleGleich);
    // Bei Gleichstand entscheidet der alphabetische Tie-Break; entscheidend ist,
    // dass NICHT alle zehn gekauft werden, obwohl alle 50 % gestiegen sind.
    expect(einstiege(r).length).toBeLessThanOrEqual(2);
  });

  it('kauft auch im fallenden Markt den relativ Stärksten', () => {
    // Alle fallen; S00 fällt am wenigsten. Eine Trendfolge bliebe hier flach.
    const allefallen = Array.from({ length: 10 }, (_, k) => input(`S${String(k).padStart(2, '0')}`, rampe(-0.05 - k * 0.05)));
    expect(einstiege(decide(ctx(), allefallen))).toEqual(['S00', 'S01']);
  });

  it('rührt sich nicht, wenn der Korb zu klein für eine Rangaussage ist', () => {
    const klein = korb(MIN_KORB - 1);
    expect(decide(ctx(), klein).intents).toHaveLength(0);
  });

  it('steigt aus, sobald die relative Stärke verloren ist', () => {
    const halten = korb();
    // S00 hält eine Position, ist aber jetzt das SCHWÄCHSTE Symbol.
    const schwach = input('S00', rampe(-0.9), {
      symbol: 'S00',
      side: 'long',
      qty: 10,
      entryPrice: 100,
      entryTime: 0,
      stop: 90,
      target: null,
      initialStop: 90,
      highWater: 100,
      strategy: s.id,
      barsHeld: 5,
      entryDay: '2026-09-03',
    });
    const inputs = [schwach, ...halten.slice(1)];
    const positions = new Map([[schwach.snap.symbol, schwach.snap.position!]]);
    const r = decide(ctx({ positions }), inputs);
    const exits = r.intents.filter((i) => i.kind === 'exit');
    expect(exits.map((e) => e.symbol)).toEqual(['S00']);
  });

  it('steigt NICHT aus, nur weil ein Rang fehlt — ein fehlender Rang ist keine Information', () => {
    // Einzelnes Symbol mit Position: zu kleiner Korb, also kein belastbarer Rang.
    const pos: PositionState = {
      symbol: 'S00',
      side: 'long',
      qty: 10,
      entryPrice: 100,
      entryTime: 0,
      stop: 90,
      target: null,
      initialStop: 90,
      highWater: 100,
      strategy: s.id,
      barsHeld: 5,
      entryDay: '2026-09-03',
    };
    const allein = input('S00', rampe(-0.9), pos);
    const r = decide(ctx({ positions: new Map([['S00', pos]]) }), [allein]);
    expect(r.intents.filter((i) => i.kind === 'exit')).toHaveLength(0);
  });

  it('volAdjust bestraft das volatilere Symbol bei gleicher Rendite', () => {
    const ruhig = rampe(0.3);
    // Gleiche Gesamtrendite, aber mit Zickzack — höhere Schwankung.
    const wild = BarSeries.from(
      Array.from({ length: N }, (_, k) => {
        const basis = 100 * (1 + (0.3 * k) / (N - 1));
        const c = basis * (1 + (k % 2 === 0 ? 0.05 : -0.05));
        return { t: k * BUCKET, o: c, h: c + 0.5, l: c - 0.5, c, v: 1000 };
      }),
    );
    const mitAdj = resolveParams(s, { ...params, volAdjust: 1 });
    const wert = (b: BarSeries) => s.crossScore!({ symbol: 'X', bars: b, i: b.length - 1, position: null, session: okSession }, s.precompute(b, mitAdj), mitAdj)!;
    expect(wert(ruhig)).toBeGreaterThan(wert(wild));
  });

  it('hält über Nacht und kann jeden Zeitrahmen', () => {
    expect(s.holdsOvernight).toBe(true);
    expect(s.timeframes).toContain(1440);
    expect(s.timeframes).toContain(5);
  });
});

describe('knappe Plätze: der Rang entscheidet, nicht der Hash', () => {
  // Prüfbefund 09.09.: Bei sechs Kandidaten auf vier Plätze kamen Rang 3–6
  // herein, 1 und 2 nicht — die rotierende Ordnung kannte den Rang nicht.
  // topPct 0,35 ⇒ pct = k/9 ≤ 0,35 ⇒ vier Kandidaten (ZEBRA, QUARK, MOLCH, ADLER) auf zwei Plätze.
  const weit = resolveParams(s, { lookback: 20, skip: 0, topPct: 0.35, exitPct: 0.8, volAdjust: 0, atrLen: 7, atrMult: 2.5, trailMult: 0 });
  const inputWeit = (symbol: string, bars: BarSeries): SymbolInput => ({
    snap: { symbol, bars, i: bars.length - 1, position: null, session: okSession },
    strategy: s,
    params: weit,
    ind: s.precompute(bars, weit),
  });
  // Namen so gewählt, dass die Hash-Ordnung NICHT der Stärke folgt.
  const namen = ['ZEBRA', 'QUARK', 'MOLCH', 'ADLER', 'FUCHS', 'IGEL', 'KRAKE', 'NATTER', 'OTTER', 'WAL'];

  it('bei zwei Plätzen und vier Kandidaten kaufen die beiden Stärksten', () => {
    const k = namen.map((name, i) => inputWeit(name, rampe(0.5 - i * 0.1)));
    expect(einstiege(decide(ctx({ risk: { ...cfg.risk, maxPositions: 2 } }), k))).toEqual(['QUARK', 'ZEBRA']);
  });
});
