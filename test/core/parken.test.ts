/**
 * Wächter der sechs nicht verhandelbaren Eigenschaften des Geldmarkt-Parkens
 * (docs/wissen/vorregistrierung/2026-09-13-kasse-in-den-geldmarkt.md) auf der
 * Ebene, auf der sie entschieden werden: `decide()`.
 *
 *  1. blockiert nie einen Einstieg   4. Backtest = Live
 *  2. kein Positionsplatz, kein Exposure-Budget   5. Band, höchstens einmal je Tag
 *  3. kein Stop, kein Ziel           6. per Vorgabe AUS (bitgleich nichts)
 *
 * Dazu die beiden Fallstricke, die Geld kosten würden: Doppelführung des
 * Parksymbols und die Notbremse, die die Kasse verkauft.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig, type Config } from '../../src/core/config.ts';
import { decide, offeneStrategiePositionen, grossExposure, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, Decision, HaltState, PositionState, SessionInfo, Strategy, SymbolSnapshot } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';
import { PARK_STRATEGY_ID, PARK_STUFE } from '../../src/risk/parken.ts';
import { baseConfig, barsMap, dayBars5, flat, strategyOf, type Ohlc } from '../backtest/helpers.ts';

const PARK = 'BIL';
const DAY_A = '2026-09-01';

function cfgMit(over: Record<string, unknown> = {}): Config {
  return parseConfig({ universe: { symbols: ['AAPL'] }, risk: { cashParking: { enabled: true, symbol: PARK }, ...over } });
}

function stub(decision: Decision, id = 'stub'): Strategy {
  return { id, timeframes: TIMEFRAMES, paramSpace: [], defaults: {}, holdsOvernight: true, warmupBars: () => 1, precompute: () => ({}), decide: () => decision };
}

function series(closes: number[]): BarSeries {
  return BarSeries.from(closes.map((c, i) => ({ t: 1_000 + i * 60_000, o: c, h: c + 1, l: c - 1, c, v: 1000 })));
}

const okSession: SessionInfo = { isRegularSession: true, minutesToClose: 200, minutesSinceOpen: 100, barsSinceOpen: 20, isLastBarOfDay: false, day: DAY_A };

function snap(symbol = 'AAPL', over: Partial<SymbolSnapshot> = {}): SymbolSnapshot {
  const bars = series([98, 99, 100]);
  return { symbol, bars, i: bars.length - 1, position: null, session: okSession, ...over };
}

const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

/** Parkposition der Treasury: kein Stop, kein Ziel, eigene Kennung. */
function parkPos(qty: number, price = 100): PositionState {
  return {
    symbol: PARK,
    side: 'long',
    qty,
    entryPrice: price,
    entryTime: 1,
    stop: null,
    target: null,
    initialStop: null,
    highWater: price,
    strategy: PARK_STRATEGY_ID,
    barsHeld: 0,
    entryDay: DAY_A,
    stufe: PARK_STUFE,
  };
}

function ctx(over: Partial<LogicContext> = {}, config: Config = cfgMit()): LogicContext {
  return {
    now: 5_000_000,
    today: DAY_A,
    nextTradingDay: '2026-09-02',
    account: { equity: 100_000, cash: 100_000, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: config.risk,
    session: config.session,
    assetClass: 'us_equity',
    timeframe: 5,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    parkQuote: { symbol: PARK, price: 100, t: 4_999_000 },
    ...over,
  };
}

const enterLong: Decision = { kind: 'enter', side: 'long', stop: 98, target: 104, reason: 'test' };
const input = (decision: Decision, id = 'stub', symbol = 'AAPL'): SymbolInput => ({ snap: snap(symbol), strategy: stub(decision, id), params: {}, ind: {} });

/* ───────────────── Eigenschaft 6: per Vorgabe AUS ───────────────── */

describe('Eigenschaft 6 — per Vorgabe aus', () => {
  it('ohne Config und ohne Parkposition passiert nichts (bitgleich)', () => {
    const aus = parseConfig({ universe: { symbols: ['AAPL'] } });
    expect(aus.risk.cashParking).toEqual({ enabled: false, symbol: null, bandPct: 5, bufferPct: 2 });
    const r = decide(ctx({ parkQuote: undefined }, aus), [input(enterLong)]);
    expect(r.park).toBeNull();
    expect(r.parkStand).toEqual({ tag: null });
    // Und die Entscheidung selbst ist dieselbe wie mit eingeschaltetem Parken ohne Kurs.
    const mit = decide(ctx({ parkQuote: undefined }), [input(enterLong)]);
    expect(mit.intents).toEqual(r.intents);
  });

  it('ein Parksymbol im Handelsuniversum wird schon von der Config abgelehnt', () => {
    expect(() => parseConfig({ universe: { symbols: ['AAPL', PARK] }, risk: { cashParking: { enabled: true, symbol: PARK } } })).toThrow(/Parksymbol/);
    expect(() => parseConfig({ universe: { symbols: ['AAPL'], candidates: [PARK] }, risk: { cashParking: { enabled: true, symbol: PARK } } })).toThrow(/Parksymbol/);
    expect(() => parseConfig({ universe: { symbols: ['AAPL'] }, risk: { cashParking: { enabled: true } } })).toThrow(/ohne risk.cashParking.symbol/);
  });
});

/* ───────────────── Eigenschaft 1: blockiert nie einen Einstieg ───────────────── */

describe('Eigenschaft 1 — das Parken blockiert nie einen Einstieg', () => {
  it('Konto voll geparkt, Signal kommt: der Einstieg entsteht in voller Größe, das Parken finanziert ihn', () => {
    const positions = new Map([[PARK, parkPos(1_000)]]); // 100 000 $ geparkt
    const r = decide(ctx({ account: { equity: 100_000, cash: 0, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false }, positions }), [input(enterLong)]);
    const enter = r.intents.find((i) => i.kind === 'enter');
    expect(enter).toBeDefined();
    // Risiko 0,5 % von 100 000 = 500 $ / 2 $ Stop-Distanz = 250 Stück; Deckel 20 % = 200 Stück
    expect(enter!.kind === 'enter' && enter!.qty).toBe(200);
    expect(r.notes.some((n) => n.kind === 'blocked')).toBe(false);
    // … und der Freikauf deckt genau das ab, was in der Kasse fehlt.
    expect(r.park).toMatchObject({ symbol: PARK, side: 'sell', pflicht: true });
    expect(r.park!.qty).toBeGreaterThanOrEqual(200); // 20 000 $ Einstieg ⇒ ≥ 200 Stück à 100 $
    expect(r.park!.qty).toBeLessThanOrEqual(1_000);
  });

  it('ohne Parkposition bleibt das leere Konto blockiert — der Freikauf erfindet kein Geld', () => {
    const r = decide(ctx({ account: { equity: 100_000, cash: 0, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false } }), [input(enterLong)]);
    expect(r.intents).toHaveLength(0);
    expect(r.park).toBeNull();
  });

  it('ohne brauchbaren Kurs zählt der Parkwert NICHT als Bargeld (was wir nicht verkaufen können, planen wir nicht ein)', () => {
    const positions = new Map([[PARK, parkPos(1_000)]]);
    const r = decide(ctx({ account: { equity: 100_000, cash: 0, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false }, positions, parkQuote: undefined }), [input(enterLong)]);
    expect(r.intents).toHaveLength(0);
    expect(r.park).toBeNull();
  });
});

/* ───────────────── Eigenschaft 2: kein Platz, kein Budget ───────────────── */

describe('Eigenschaft 2 — die Parkposition belegt keinen Platz und kein Budget', () => {
  it('zählt nicht gegen risk.maxPositions', () => {
    const config = cfgMit({ maxPositions: 1 });
    const positions = new Map([[PARK, parkPos(500)]]);
    const r = decide(ctx({ positions }, config), [input(enterLong)]);
    expect(r.intents.some((i) => i.kind === 'enter')).toBe(true);
    expect(r.notes.some((n) => n.kind === 'blocked' && /Positionslimit/.test(n.text))).toBe(false);
    expect(offeneStrategiePositionen(positions)).toBe(0);
  });

  it('zählt nicht ins Brutto-Exposure — sonst sperrte sich ein geparktes Konto selbst aus', () => {
    const positions = new Map([[PARK, parkPos(1_000)]]); // 100 % der Equity
    expect(grossExposure(positions, () => 100)).toBe(0);
    const r = decide(ctx({ account: { equity: 100_000, cash: 0, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false }, positions }), [input(enterLong)]);
    expect(r.intents.some((i) => i.kind === 'enter')).toBe(true);
    expect(r.notes.some((n) => n.kind === 'blocked' && /Exposure/.test(n.text))).toBe(false);
  });

  it('eine Strategie-Position im selben Konto zählt weiterhin voll', () => {
    const strat: PositionState = { ...parkPos(100), symbol: 'MSFT', strategy: 'stub', stufe: 'champion' };
    const positions = new Map<string, PositionState>([
      [PARK, parkPos(500)],
      ['MSFT', strat],
    ]);
    expect(offeneStrategiePositionen(positions)).toBe(1);
    expect(grossExposure(positions, () => 100)).toBe(100 * 100);
  });
});

/* ───────────────── Eigenschaft 5: Band und Tagesgrenze ───────────────── */

describe('Eigenschaft 5 — Band statt Hyperaktivität', () => {
  it('parkt brachliegende Kasse, aber nur einmal je Handelstag', () => {
    const erste = decide(ctx(), [input({ kind: 'hold' })]);
    expect(erste.park).toMatchObject({ side: 'buy', pflicht: false });
    expect(erste.parkStand).toEqual({ tag: DAY_A });
    // Zweiter Zyklus am selben Tag: nichts mehr.
    const zweite = decide(ctx({ parkStand: erste.parkStand! }), [input({ kind: 'hold' })]);
    expect(zweite.park).toBeNull();
    // Nächster Handelstag: wieder erlaubt.
    const morgen = decide(ctx({ parkStand: erste.parkStand!, today: '2026-09-02' }), [input({ kind: 'hold' })]);
    expect(morgen.park?.side).toBe('buy');
  });

  it('kleine Abweichungen lassen die Position in Ruhe', () => {
    const positions = new Map([[PARK, parkPos(980)]]);
    const r = decide(ctx({ account: { equity: 100_000, cash: 2_000, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false }, positions }), [input({ kind: 'hold' })]);
    expect(r.park).toBeNull();
  });

  it('mit offener Park-Order wird keine zweite geplant', () => {
    const r = decide(ctx({ parkPending: true }), [input({ kind: 'hold' })]);
    expect(r.park).toBeNull();
  });

  it('bei alten Daten wird nicht umgeschichtet (aber der Freikauf läuft)', () => {
    expect(decide(ctx({ dataFresh: false }), [input({ kind: 'hold' })]).park).toBeNull();
  });
});

/* ───────────────── Halt, PDT, Rückzug, Doppelführung ───────────────── */

describe('Halt und Notbremse', () => {
  const haltCtx = (positions: Map<string, PositionState>) =>
    ctx({
      positions,
      // Tagesverlust 5 % > Latte 2 % ⇒ Notbremse
      account: { equity: 95_000, cash: 0, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false },
    });

  it('die Notbremse stellt das Strategie-Buch glatt, nie die Kasse im Geldmarkt', () => {
    const strat: PositionState = { ...parkPos(100), symbol: 'AAPL', strategy: 'stub', stop: 90, initialStop: 90, stufe: 'champion' };
    const positions = new Map<string, PositionState>([
      [PARK, parkPos(500)],
      ['AAPL', strat],
    ]);
    const r = decide(haltCtx(positions), [input({ kind: 'hold' })]);
    expect(r.haltTriggered).toBe(true);
    expect(r.intents.map((i) => i.symbol)).toEqual(['AAPL']);
    expect(r.intents.some((i) => i.symbol === PARK)).toBe(false);
  });

  it('im Halt wird nicht umgeschichtet — die Treasury steht still', () => {
    const r = decide(haltCtx(new Map()), [input({ kind: 'hold' })]);
    expect(r.halt.halted).toBe(true);
    expect(r.park).toBeNull();
  });

  it('ein Rückzug läuft auch im Halt (Abbau wird nie gesperrt)', () => {
    const aus = parseConfig({ universe: { symbols: ['AAPL'] } });
    const positions = new Map([[PARK, parkPos(500)]]);
    const r = decide(haltCtx(positions), [input({ kind: 'hold' })]);
    expect(r.park).toBeNull(); // mit eingeschaltetem Parken: stillstehen
    const rAus = decide(ctx({ positions, halt: { ...noHalt, halted: true, reason: 'manual' } }, aus), [input({ kind: 'hold' })]);
    expect(rAus.park).toMatchObject({ side: 'sell', qty: 500, pflicht: true });
    expect(rAus.park!.reason).toMatch(/Rückzug/);
  });
});

describe('PDT — das Parken nimmt keinem echten Trade den Platz', () => {
  it('unter der PDT-Schwelle wird nicht gekauft (ein Kauf heute + Freikauf heute wäre ein Daytrade)', () => {
    const klein = { equity: 20_000, cash: 20_000, dayStartEquity: 20_000, peakEquity: 20_000, dayTradeCount: 0, patternDayTrader: false };
    expect(decide(ctx({ account: klein }), [input({ kind: 'hold' })]).park).toBeNull();
    // Verkaufen darf sie weiter — sonst käme ein kleines Konto nie mehr an sein Geld.
    const positions = new Map([[PARK, parkPos(200)]]);
    const r = decide(ctx({ account: { ...klein, cash: 0 }, positions, risk: cfgMit({ cashParking: { enabled: true, symbol: PARK, bandPct: 1, bufferPct: 2 } }).risk }), [input({ kind: 'hold' })]);
    expect(r.park?.side).toBe('sell');
  });

  it('Einstiegssperre von außen sperrt den Kauf', () => {
    expect(decide(ctx({ entryLock: 'Echtgeld-Kette offen' }), [input({ kind: 'hold' })]).park).toBeNull();
  });
});

describe('Doppelführung — das Parksymbol gehört der Treasury allein', () => {
  it('führt eine Strategie das Parksymbol, parkt die Treasury nicht und räumt ihre Position', () => {
    const positions = new Map([[PARK, parkPos(500)]]);
    const r = decide(ctx({ positions }), [input(enterLong), input({ kind: 'hold' }, 'fremd', PARK)]);
    expect(r.park).toMatchObject({ side: 'sell', qty: 500, pflicht: true });
    expect(r.park!.reason).toMatch(/führt das Parksymbol/);
    // Die Strategie selbst bekommt keine zweite Position im Symbol.
    expect(r.intents.some((i) => i.symbol === PARK)).toBe(false);
  });

  it('eine FREMDE Position im Parksymbol wird nie angefasst (zwei Besitzer einer Menge gibt es nicht)', () => {
    const fremd: PositionState = { ...parkPos(500), strategy: 'regime_allocation', stufe: 'basis' };
    const r = decide(ctx({ positions: new Map([[PARK, fremd]]) }), [input({ kind: 'hold' })]);
    expect(r.park).toBeNull();
    expect(r.notes.some((n) => /Position der Strategie regime_allocation/.test(n.text))).toBe(true);
  });

  it('ein Symbolwechsel räumt zuerst das alte Papier', () => {
    const positions = new Map([['SHV', { ...parkPos(300), symbol: 'SHV' }]]);
    const r = decide(ctx({ positions, parkQuote: { symbol: 'SHV', price: 100, t: 4_999_000 } }), [input({ kind: 'hold' })]);
    expect(r.park).toMatchObject({ symbol: 'SHV', side: 'sell', qty: 300, pflicht: true });
    expect(r.park!.reason).toMatch(/gewechselt/);
  });
});

/* ───────────────── Eigenschaft 4: Backtest = Live ───────────────── */

describe('Eigenschaft 4 — ein Entscheidungspfad', () => {
  const OPEN = msFromET(2026, 9, 1, 9, 30);
  const parkBars = (n: number, p: number): Bar[] => dayBars5(DAY_A, flat(n, p) as Ohlc[]);

  function simCfg(over: Record<string, unknown> = {}) {
    const c = parseConfig({ universe: { symbols: ['AAA'] }, risk: { cashParking: { enabled: true, symbol: PARK, ...over } } });
    return { ...baseConfig(), risk: c.risk };
  }

  it('Simulator und direkter `decide()`-Aufruf treffen dieselbe Parkentscheidung', () => {
    const halten = strategyOf({ decide: () => ({ kind: 'hold' }) });
    const bars = barsMap({ AAA: parkBars(3, 50), [PARK]: parkBars(3, 100) });
    const res = simulate({ bars, strategyFor: (s) => (s === 'AAA' ? { strategy: halten, params: {} } : null), config: simCfg(), initialEquity: 100_000 });

    // Der Simulator hat am zweiten Zyklus gekauft (Fill am Open der Folgebar).
    const parkNote = res.notes.find((n) => n.startsWith('Geldmarkt-Parken'));
    expect(parkNote).toMatch(/1 Umschichtung/);
    expect(res.equity.length).toBe(3);

    // Dieselbe Lage direkt in decide(): dieselbe Stückzahl.
    const direkt = decide(
      ctx({
        account: { equity: 100_000, cash: 100_000, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false },
        parkQuote: { symbol: PARK, price: 100, t: OPEN },
      }),
      [input({ kind: 'hold' })],
    );
    expect(direkt.park?.qty).toBe(978);
    // 978 Stück à 100 $ = 97 800 $ — im Simulator steckt genau das im Parkwert.
    expect(parkNote).toMatch(/978 Stück/);
  });

  it('der Simulator bucht KEINEN Trade für eine Umschichtung, aber die Kosten treffen die Equity', () => {
    const halten = strategyOf({ decide: () => ({ kind: 'hold' }) });
    const bars = barsMap({ AAA: parkBars(4, 50), [PARK]: parkBars(4, 100) });
    const res = simulate({ bars, strategyFor: (s) => (s === 'AAA' ? { strategy: halten, params: {} } : null), config: simCfg(), initialEquity: 100_000 });
    expect(res.trades).toHaveLength(0);
    expect(res.metrics.trades).toBe(0);
    expect(res.metrics.feeShare).toBeNull();
    // Kosten: 978 Stück à 100 $ mit Slippage+Spread ⇒ Equity unter dem Startwert.
    expect(res.finalEquity).toBeLessThan(100_000);
    expect(res.notes.some((n) => /Kosten \d+\.\d\d \$ \(nicht in feeShare\)/.test(n))).toBe(true);
  });

  it('die Exposure-Kennzahl der Equity-Kurve bleibt 0 — geparkte Kasse ist keine Marktzeit', () => {
    const halten = strategyOf({ decide: () => ({ kind: 'hold' }) });
    const bars = barsMap({ AAA: parkBars(4, 50), [PARK]: parkBars(4, 100) });
    const res = simulate({ bars, strategyFor: (s) => (s === 'AAA' ? { strategy: halten, params: {} } : null), config: simCfg(), initialEquity: 100_000 });
    expect(res.equity.every((p) => p.exposure === 0)).toBe(true);
    expect(res.metrics.exposurePct).toBe(0);
  });

  it('im Simulator finanziert der Verkauf den Einstieg DERSELBEN Bar — die Position wird nicht kleiner', () => {
    // Bar 0: parken (97 800 $ von 100 000 $). Bar 2: Einstiegssignal — die
    // Kasse trägt dann nur noch 2 151 $, das reichte für 43 Stück. Der
    // Freikauf füllt VOR dem Einstieg, also bekommt er seine volle Größe.
    const strategie = strategyOf({
      decide: (s) => (s.position || s.i !== 2 ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: 45, reason: 'test' }),
    });
    const lauf = (parken: boolean) =>
      simulate({
        bars: barsMap({ AAA: parkBars(6, 50), [PARK]: parkBars(6, 100) }),
        strategyFor: (s) => (s === 'AAA' ? { strategy: strategie, params: {} } : null),
        config: parken ? simCfg() : baseConfig(),
        initialEquity: 100_000,
      });
    const mit = lauf(true);
    const ohne = lauf(false);
    const offen = (r: ReturnType<typeof simulate>) => r.notes.find((n) => n.startsWith('Offen am Ende: AAA'));
    // Ohne Parken: 0,5 % von 100 000 $ / 5 $ Stop-Distanz = 100 Stück.
    expect(offen(ohne)).toMatch(/AAA long 100 @ 50/);
    // Mit Parken: 99 Stück — der EINZIGE Unterschied sind die Kosten der
    // Umschichtung (Equity 99 951 $ statt 100 000 $), nicht die Kasse. Wäre
    // das Bargeld die Grenze, stünden hier 43 Stück (2 151 $ / 50 $).
    expect(offen(mit)).toMatch(/AAA long 99 @ 50/);
    expect(mit.notes.some((n) => /Bargeld reicht am Fill nicht/.test(n))).toBe(false);
    expect(mit.notes.some((n) => /Stückzahl am Fill reduziert/.test(n))).toBe(false);
    // Zwei Umschichtungen: einmal parken, einmal freikaufen.
    expect(mit.notes.some((n) => /Geldmarkt-Parken \(BIL\): 2 Umschichtung\(en\)/.test(n))).toBe(true);
    // Die Exposure-Kennzahl misst weiter nur die Strategie (≈ 5 %), nicht die
    // 95 % geparkte Kasse — sonst läse die Basis-Latte Kasse als Marktrisiko.
    expect(Math.max(...mit.equity.map((p) => p.exposure ?? 0))).toBeLessThan(0.06);
    expect(Math.max(...ohne.equity.map((p) => p.exposure ?? 0))).toBeLessThan(0.06);
  });

  it('nimmt die Parkbars auch getrennt vom Korb (`parkBars`) — dort gehören sie hin', () => {
    const halten = strategyOf({ decide: () => ({ kind: 'hold' }) });
    const res = simulate({
      bars: barsMap({ AAA: parkBars(4, 50) }),
      parkBars: BarSeries.from(parkBars(4, 100)),
      strategyFor: (s) => (s === 'AAA' ? { strategy: halten, params: {} } : null),
      config: simCfg(),
      initialEquity: 100_000,
    });
    expect(res.notes.some((n) => /Geldmarkt-Parken \(BIL\): 1 Umschichtung/.test(n))).toBe(true);
    expect(res.trades).toHaveLength(0);
    expect(res.equity.every((p) => p.exposure === 0)).toBe(true);
  });

  it('ohne Bars des Parksymbols wird nicht geparkt — und es steht laut in den Notizen', () => {
    const halten = strategyOf({ decide: () => ({ kind: 'hold' }) });
    const res = simulate({ bars: barsMap({ AAA: parkBars(3, 50) }), strategyFor: () => ({ strategy: halten, params: {} }), config: simCfg(), initialEquity: 100_000 });
    expect(res.notes.some((n) => /ohne Bars — NICHT geparkt/.test(n))).toBe(true);
    expect(res.finalEquity).toBe(100_000);
  });
});
