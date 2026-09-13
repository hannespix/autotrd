/**
 * Notbremsen je STUFE (`risk.tiers`, risk/limits.ts + core/logic.ts).
 *
 * ── Warum es das gibt ─────────────────────────────────────────────────────
 *
 * Die Tagesbremse 2 % der Plattform stellt ein voll investiertes ETF-Depot
 * an einem gewöhnlichen Minus-Tag glatt (docs/ARCHITEKTUR.md §5a.16, V3) und
 * verschlechtert damit genau die Zahl, die sie schützen soll. Eine Stufe
 * darf deshalb ihre eigene Latte haben — mit drei Bedingungen, die diese
 * Tests festnageln:
 *
 *  (a) OHNE `tiers` ändert sich NICHTS. Kein stilles Verschieben bestehender
 *      Messergebnisse.
 *  (b) Fehlt ein Wert, gilt der globale — eine Stufe erbt nie versehentlich
 *      eine gelockerte Latte, und eine unbekannte Stufe („other") bekommt
 *      immer die globalen Werte.
 *  (c) Die Latte einer Stufe wirkt nur auf DEREN Positionen und Einstiege.
 *      Die Konto-Bremse bleibt als letzter Halt über allem (die LOCKERSTE
 *      aller Latten) — eine Stufen-Latte kann sie nicht abschalten.
 *
 * Und über allem Regel §0.4: Bremsen sperren EINSTIEGE, niemals Exits.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig, type RiskConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import type { Decision, HaltState, PositionState, SessionInfo, Strategy } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';
import { grenzenFuer, kontoGrenzen, stufeOf, stufenBremsenAktiv } from '../../src/risk/limits.ts';

const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };
const session: SessionInfo = { isRegularSession: true, minutesToClose: 200, minutesSinceOpen: 100, barsSinceOpen: 1, isLastBarOfDay: false, day: '2026-09-11' };

function stub(decision: Decision): Strategy {
  return { id: 'stub', timeframes: TIMEFRAMES, paramSpace: [], defaults: {}, holdsOvernight: true, warmupBars: () => 1, precompute: () => ({}), decide: () => decision };
}
function bars(): BarSeries {
  return BarSeries.from([98, 99, 100].map((c, i) => ({ t: 1_000 + i * 86_400_000, o: c, h: c + 1, l: c - 1, c, v: 1000 })));
}
function input(symbol: string, stufe: string | undefined, decision: Decision, position: PositionState | null = null): SymbolInput {
  const b = bars();
  return { snap: { symbol, bars: b, i: b.length - 1, position, session }, strategy: stub(decision), params: {}, ind: {}, stufe };
}
function pos(symbol: string, stufe?: string): PositionState {
  return {
    symbol,
    side: 'long',
    qty: 10,
    entryPrice: 100,
    entryTime: 1,
    stop: 80,
    target: null,
    initialStop: 80,
    highWater: 100,
    strategy: 'stub',
    barsHeld: 3,
    entryDay: '2026-09-10',
    ...(stufe !== undefined ? { stufe } : {}),
  };
}
const enterLong: Decision = { kind: 'enter', side: 'long', stop: 90, reason: 'test' };

function ctx(risk: RiskConfig, over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: 1_700_000_000_000,
    today: '2026-09-11',
    nextTradingDay: '2026-09-14',
    account: { equity: 10_000, cash: 10_000, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk,
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: 1440,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    ...over,
  };
}
/** Konto 3 % im Minus — gegen die globale Latte 2 % reißt sie, gegen 8 % nicht. */
const minusDrei = { equity: 9_700, cash: 9_700, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
const exits = (r: ReturnType<typeof decide>) => r.intents.filter((i) => i.kind === 'exit').map((i) => i.symbol).sort();
const einstiege = (r: ReturnType<typeof decide>) => r.intents.filter((i) => i.kind === 'enter').map((i) => i.symbol).sort();

/** Latten einer Stufe; was nicht genannt ist, steht auf `null` = „globaler Wert" (Schema-Vorgabe). */
type Latten = Partial<{ maxDailyLossPct: number | null; maxDrawdownPct: number | null }>;
const latten = (over: Latten = {}) => ({ maxDailyLossPct: null, maxDrawdownPct: null, ...over });
const tiers = (alpha: Latten = {}, basis: Latten = {}): RiskConfig['tiers'] => ({ alpha: latten(alpha), basis: latten(basis) });

const basisLocker: RiskConfig = { ...cfg.risk, maxPositions: 10, tiers: tiers({}, { maxDailyLossPct: 8 }) };

describe('Latten je Stufe (risk/limits.ts)', () => {
  it('WÄCHTER (b): fehlt ein Wert, gilt der globale; „other" ist immer global', () => {
    expect(grenzenFuer(basisLocker, 'basis')).toEqual({ maxDailyLossPct: 8, maxDrawdownPct: 10 });
    expect(grenzenFuer(basisLocker, 'alpha')).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
    expect(grenzenFuer(basisLocker, 'other')).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
    expect(grenzenFuer(cfg.risk, 'basis')).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
  });

  it('WÄCHTER (c): die Konto-Latte ist die lockerste — und eine 0 der Stufe hebt sie nicht auf', () => {
    expect(kontoGrenzen(cfg.risk)).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
    expect(kontoGrenzen(basisLocker)).toEqual({ maxDailyLossPct: 8, maxDrawdownPct: 10 });
    const aus: RiskConfig = { ...cfg.risk, tiers: tiers({}, { maxDailyLossPct: 0, maxDrawdownPct: 0 }) };
    expect(kontoGrenzen(aus)).toEqual({ maxDailyLossPct: 2, maxDrawdownPct: 10 });
    // Eine STRENGERE Stufe verschärft die Konto-Latte nicht (sie bremst sich selbst früher).
    const streng: RiskConfig = { ...cfg.risk, tiers: tiers({ maxDailyLossPct: 1 }) };
    expect(kontoGrenzen(streng).maxDailyLossPct).toBe(2);
  });

  it('Quelle der Wahl ⇒ Stufe; Unbekanntes ist „other"', () => {
    expect(stufeOf('champion')).toBe('alpha');
    expect(stufeOf('basis')).toBe('basis');
    expect(stufeOf('config')).toBe('other');
    expect(stufeOf(undefined)).toBe('other');
    expect(stufeOf('erfunden')).toBe('other');
  });

  it('ohne Werte sind die Stufen-Bremsen aus', () => {
    expect(stufenBremsenAktiv(cfg.risk)).toBe(false);
    expect(stufenBremsenAktiv({ ...cfg.risk, tiers: tiers() })).toBe(false); // alles null = keine Stufen-Latte
    // Das Schema füllt `tiers` immer; eine von Hand gebaute Config (Adapter, Test) darf es auslassen.
    expect(stufenBremsenAktiv({ ...cfg.risk, tiers: undefined as unknown as RiskConfig['tiers'] })).toBe(false);
    expect(stufenBremsenAktiv(basisLocker)).toBe(true);
  });
});

describe('Stufen-Bremse in decide()', () => {
  it('WÄCHTER (a): ohne `tiers` bremst das Konto wie bisher — alles glatt, nichts je Stufe', () => {
    const risk = { ...cfg.risk, maxPositions: 10 };
    const positionen = new Map([
      ['ALP', pos('ALP', 'champion')],
      ['BAS', pos('BAS', 'basis')],
    ]);
    const r = decide(ctx(risk, { account: minusDrei, positions: positionen }), [
      input('ALP', 'champion', { kind: 'hold' }, positionen.get('ALP')!),
      input('BAS', 'basis', { kind: 'hold' }, positionen.get('BAS')!),
    ]);
    expect(r.haltTriggered).toBe(true);
    expect(r.halt.reason).toBe('daily_loss');
    expect(exits(r)).toEqual(['ALP', 'BAS']);
    expect(r.stufenHalt).toEqual({});
    expect(r.stufenHaltTriggered).toEqual([]);
  });

  it('die Stufe mit der lockeren Latte läuft weiter, die andere wird glattgestellt und gesperrt', () => {
    const positionen = new Map([
      ['ALP', pos('ALP', 'champion')],
      ['BAS', pos('BAS', 'basis')],
    ]);
    const r = decide(ctx(basisLocker, { account: minusDrei, positions: positionen }), [
      input('ALP', 'champion', { kind: 'hold' }, positionen.get('ALP')!),
      input('BAS', 'basis', { kind: 'hold' }, positionen.get('BAS')!),
      input('NEU_A', 'champion', enterLong),
      input('NEU_B', 'basis', enterLong),
    ]);
    // Das Konto selbst bremst nicht (Latte 8 %).
    expect(r.haltTriggered).toBe(false);
    expect(r.halt.halted).toBe(false);
    // Alpha ist gesperrt: Position glatt, kein neuer Einstieg.
    expect(r.stufenHaltTriggered).toEqual(['alpha']); // „other" kommt im Zyklus nicht vor ⇒ keine Sperre ohne Gegenstand
    expect(r.stufenHalt?.other).toBeUndefined();
    expect(r.stufenHalt?.alpha?.halted).toBe(true);
    expect(r.stufenHalt?.alpha?.reason).toBe('daily_loss');
    expect(r.stufenHalt?.alpha?.until).toBe('2026-09-14');
    expect(exits(r)).toEqual(['ALP']);
    // Basis darf: Position bleibt, Einstieg kommt.
    expect(einstiege(r)).toEqual(['NEU_B']);
    expect(r.notes.some((n) => n.kind === 'blocked' && /Stufe alpha gesperrt/.test(n.text))).toBe(true);
    expect(r.stufenHalt?.basis?.halted ?? false).toBe(false);
  });

  it('WÄCHTER (b): eine Position OHNE Stufe hängt an der globalen Latte, nicht an der lockeren', () => {
    const positionen = new Map([['FREMD', pos('FREMD')]]);
    const r = decide(ctx(basisLocker, { account: minusDrei, positions: positionen }), [input('FREMD', undefined, { kind: 'hold' }, positionen.get('FREMD')!)]);
    expect(exits(r)).toEqual(['FREMD']);
    expect(r.stufenHalt?.other?.halted).toBe(true);
  });

  it('die beim Fill festgehaltene Stufe gewinnt gegen die Wahl von heute (Prüfbefund G14)', () => {
    // Position wurde als BASIS eröffnet; heute führt sie der Alpha-Champion.
    const positionen = new Map([['X', pos('X', 'basis')]]);
    const r = decide(ctx(basisLocker, { account: minusDrei, positions: positionen }), [input('X', 'champion', { kind: 'hold' }, positionen.get('X')!)]);
    // Sie hängt an der Basis-Latte (8 %) ⇒ kein Exit bei −3 %.
    expect(exits(r)).toEqual([]);
    expect(r.stufenHalt?.alpha?.halted).toBe(true);
  });

  it('WÄCHTER (c): die Konto-Bremse bleibt der letzte Halt — bei −9 % ist alles glatt', () => {
    const positionen = new Map([
      ['ALP', pos('ALP', 'champion')],
      ['BAS', pos('BAS', 'basis')],
    ]);
    const account = { equity: 9_100, cash: 9_100, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
    const r = decide(ctx(basisLocker, { account, positions: positionen }), [
      input('ALP', 'champion', { kind: 'hold' }, positionen.get('ALP')!),
      input('BAS', 'basis', enterLong, positionen.get('BAS')!),
    ]);
    expect(r.haltTriggered).toBe(true);
    expect(exits(r)).toEqual(['ALP', 'BAS']);
    expect(einstiege(r)).toEqual([]);
  });

  it('§0.4: eine gesperrte Stufe verliert nur das KAUFEN — der Exit der anderen Stufe läuft unberührt', () => {
    const positionen = new Map([
      ['ALP', pos('ALP', 'champion')],
      ['BAS', pos('BAS', 'basis')],
    ]);
    const r = decide(ctx(basisLocker, { account: minusDrei, positions: positionen }), [
      input('ALP', 'champion', { kind: 'hold' }, positionen.get('ALP')!),
      input('BAS', 'basis', { kind: 'exit', reason: 'Regime verloren' }, positionen.get('BAS')!),
    ]);
    expect(exits(r)).toEqual(['ALP', 'BAS']);
    const basisExit = r.intents.find((i) => i.kind === 'exit' && i.symbol === 'BAS');
    if (basisExit?.kind !== 'exit') throw new Error('kein Exit');
    expect(basisExit.reason).toBe('signal'); // der eigene Exit, nicht die Bremse
  });

  it('eine stehende Stufen-Sperre fordert den Exit in JEDEM Zyklus erneut (idempotent) und sperrt weiter', () => {
    const stand: HaltState = { halted: true, reason: 'drawdown', since: 1, until: null, note: 'Drawdown 12 %' };
    const positionen = new Map([['ALP', pos('ALP', 'champion')]]);
    const r = decide(
      ctx(basisLocker, { positions: positionen, stufenHalt: { alpha: stand } }),
      [input('ALP', 'champion', { kind: 'hold' }, positionen.get('ALP')!), input('NEU', 'champion', enterLong)],
    );
    expect(exits(r)).toEqual(['ALP']);
    expect(einstiege(r)).toEqual([]);
    expect(r.stufenHaltTriggered).toEqual([]); // nicht NEU ausgelöst — nur weiterhin gesperrt
    expect(r.stufenHalt?.alpha?.halted).toBe(true);
  });

  it('der Tages-Halt einer Stufe endet am nächsten Handelstag von selbst (wie der des Kontos)', () => {
    const stand: HaltState = { halted: true, reason: 'daily_loss', since: 1, until: '2026-09-11', note: 'Tagesverlust' };
    const r = decide(ctx(basisLocker, { stufenHalt: { alpha: stand } }), [input('NEU', 'champion', enterLong)]);
    expect(r.stufenHalt?.alpha?.halted).toBe(false);
    expect(einstiege(r)).toEqual(['NEU']);
    expect(r.notes.some((n) => n.kind === 'halt' && /Stufe alpha/.test(n.text))).toBe(true);
  });

  it('die Drawdown-Latte je Stufe wirkt genauso (Peak, kein Enddatum)', () => {
    const risk: RiskConfig = { ...cfg.risk, maxPositions: 10, tiers: tiers({}, { maxDrawdownPct: 30 }) };
    const positionen = new Map([
      ['ALP', pos('ALP', 'champion')],
      ['BAS', pos('BAS', 'basis')],
    ]);
    // 12 % unter dem Hoch: über der globalen 10 %, unter den 30 % der Basis.
    const account = { equity: 8_800, cash: 8_800, dayStartEquity: 8_800, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
    const r = decide(ctx(risk, { account, positions: positionen }), [
      input('ALP', 'champion', { kind: 'hold' }, positionen.get('ALP')!),
      input('BAS', 'basis', enterLong, positionen.get('BAS')!),
    ]);
    expect(r.haltTriggered).toBe(false); // Konto-Latte ist 30 %
    expect(r.stufenHalt?.alpha?.reason).toBe('drawdown');
    expect(r.stufenHalt?.alpha?.until).toBe(null);
    expect(exits(r)).toEqual(['ALP']);
  });
});
