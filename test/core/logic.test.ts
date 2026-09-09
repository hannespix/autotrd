import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { advancePosition, decide, openPosition, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import type { Decision, HaltState, PositionState, SessionInfo, Strategy, SymbolSnapshot } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';

const cfg = parseConfig({ universe: { symbols: ['AAPL'] } });

function stub(decision: Decision, holdsOvernight = true, warmup = 1): Strategy {
  return {
    id: 'stub',
    timeframes: TIMEFRAMES,
    paramSpace: [],
    defaults: {},
    holdsOvernight,
    warmupBars: () => warmup,
    precompute: () => ({}),
    decide: () => decision,
  };
}

function series(closes: number[]): BarSeries {
  return BarSeries.from(closes.map((c, i) => ({ t: 1_000 + i * 60_000, o: c, h: c + 1, l: c - 1, c, v: 1000 })));
}

const okSession: SessionInfo = {
  isRegularSession: true,
  minutesToClose: 200,
  minutesSinceOpen: 100,
  barsSinceOpen: 20,
  isLastBarOfDay: false,
  day: '2026-09-04',
};

function snap(over: Partial<SymbolSnapshot> = {}): SymbolSnapshot {
  const bars = series([98, 99, 100]);
  return { symbol: 'AAPL', bars, i: bars.length - 1, position: null, session: okSession, ...over };
}

const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

function ctx(over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: 5_000_000,
    today: '2026-09-04',
    nextTradingDay: '2026-09-08',
    account: { equity: 10_000, cash: 10_000, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: cfg.risk,
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: 5,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    ...over,
  };
}

const enterLong: Decision = { kind: 'enter', side: 'long', stop: 98, target: 104, reason: 'test' };

function input(decision: Decision, over: Partial<SymbolInput> = {}, snapOver: Partial<SymbolSnapshot> = {}): SymbolInput {
  return { snap: snap(snapOver), strategy: stub(decision), params: {}, ind: {}, ...over };
}

function longPos(over: Partial<PositionState> = {}): PositionState {
  return {
    ...openPosition({ symbol: 'AAPL', side: 'long', qty: 10, fillPrice: 95, fillTime: 1, stop: 92, target: 110, strategy: 'stub', entryDay: '2026-09-03' }),
    ...over,
  };
}

describe('Einstieg', () => {
  it('geht durch alle Tore und wird auf Equity gesized', () => {
    const r = decide(ctx(), [input(enterLong)]);
    expect(r.intents).toHaveLength(1);
    const it0 = r.intents[0]!;
    expect(it0.kind).toBe('enter');
    if (it0.kind === 'enter') {
      // Risiko 0,5 % von 10 000 = 50 $ / 2 $ Abstand = 25; Deckel 20 % = 2000 $ / 100 = 20 ⇒ 20
      expect(it0.qty).toBe(20);
      expect(it0.stop).toBe(98);
      expect(it0.target).toBe(104);
      expect(it0.refPrice).toBe(100);
    }
  });

  it('kein Einstieg vor dem Warmup', () => {
    const r = decide(ctx(), [input(enterLong, { strategy: stub(enterLong, true, 10) })]);
    expect(r.intents).toHaveLength(0);
  });

  it('Stop auf der falschen Seite oder ohne Abstand wird abgelehnt', () => {
    const bad: Decision = { kind: 'enter', side: 'long', stop: 100.01, reason: 'x' };
    const r = decide(ctx(), [input(bad)]);
    expect(r.intents).toHaveLength(0);
    expect(r.notes.some((n) => n.kind === 'blocked' && /Stop/.test(n.text))).toBe(true);
    const tooClose: Decision = { kind: 'enter', side: 'long', stop: 99.99, reason: 'x' };
    expect(decide(ctx(), [input(tooClose)]).intents).toHaveLength(0);
  });

  it('Ziel auf der falschen Seite wird verworfen, Einstieg bleibt', () => {
    const r = decide(ctx(), [input({ kind: 'enter', side: 'long', stop: 98, target: 90, reason: 'x' })]);
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]!.kind === 'enter' && r.intents[0]!.target).toBeNull();
  });

  it.each([
    ['Halt', { halt: { ...noHalt, halted: true, reason: 'manual' as const } }, /Halt/],
    ['Daten nicht frisch', { dataFresh: false }, /frisch/],
    ['Einstiegs-Order offen', { pendingEntries: new Set(['AAPL']) }, /bereits offen/],
    ['Asset nicht handelbar', { assetFacts: () => ({ tradable: false, shortable: false }) }, /handelbar/],
  ])('blockiert bei %s', (_name, over, re) => {
    const r = decide(ctx(over as Partial<LogicContext>), [input(enterLong)]);
    expect(r.intents).toHaveLength(0);
    expect(r.notes.some((n) => n.kind === 'blocked' && re.test(n.text))).toBe(true);
  });

  it('Short nur mit Erlaubnis und shortbarem Asset', () => {
    const short: Decision = { kind: 'enter', side: 'short', stop: 102, reason: 'x' };
    expect(decide(ctx(), [input(short)]).intents).toHaveLength(0);
    const allow = { ...cfg.risk, allowShort: true };
    expect(decide(ctx({ risk: allow }), [input(short)]).intents).toHaveLength(1);
    expect(decide(ctx({ risk: allow, assetFacts: () => ({ tradable: true, shortable: false }) }), [input(short)]).intents).toHaveLength(0);
    expect(decide(ctx({ risk: allow, assetClass: 'crypto' }), [input(short)]).intents).toHaveLength(0);
  });

  it('Session-Tore: Eröffnungs- und Schlussfenster, außerhalb der Sitzung', () => {
    const early = decide(ctx(), [input(enterLong, {}, { session: { ...okSession, minutesSinceOpen: 3 } })]);
    expect(early.intents).toHaveLength(0);
    const late = decide(ctx(), [input(enterLong, {}, { session: { ...okSession, minutesToClose: 20 } })]);
    expect(late.intents).toHaveLength(0);
    const off = decide(ctx(), [input(enterLong, {}, { session: { ...okSession, isRegularSession: false } })]);
    expect(off.intents).toHaveLength(0);
    // Tagesbars kennen keine Sitzungsfenster
    const daily = decide(ctx({ timeframe: 1440 }), [input(enterLong, {}, { session: { ...okSession, minutesSinceOpen: 0 } })]);
    expect(daily.intents).toHaveLength(1);
  });

  it('Positionslimit zählt offene Positionen, Pending und Einstiege dieses Zyklus', () => {
    const risk = { ...cfg.risk, maxPositions: 2 };
    const positions = new Map([['MSFT', longPos({ symbol: 'MSFT' })]]);
    const r = decide(ctx({ risk, positions }), [
      input(enterLong, {}, { symbol: 'AAPL' }),
      input(enterLong, {}, { symbol: 'NVDA' }),
    ]);
    expect(r.intents.filter((i) => i.kind === 'enter')).toHaveLength(1);
    expect(r.notes.some((n) => /Positionslimit/.test(n.text))).toBe(true);
  });

  it('PDT: unter 25k und drei Daytrades ⇒ kein Intraday-Einstieg', () => {
    const acc = { equity: 10_000, cash: 10_000, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 3, patternDayTrader: false };
    const intraday = stub(enterLong, false);
    expect(decide(ctx({ account: acc }), [input(enterLong, { strategy: intraday })]).intents).toHaveLength(0);
    // über 25k greift die Regel nicht
    expect(decide(ctx({ account: { ...acc, equity: 30_000, cash: 30_000 } }), [input(enterLong, { strategy: intraday })]).intents).toHaveLength(1);
    // Übernacht-Strategie mit noch einem freien Daytrade darf
    expect(decide(ctx({ account: { ...acc, dayTradeCount: 2 } }), [input(enterLong)]).intents).toHaveLength(1);
    // zwei Intraday-Einstiege im selben Zyklus verbrauchen das Fenster
    const r = decide(ctx({ account: { ...acc, dayTradeCount: 2 } }), [
      input(enterLong, { strategy: intraday }, { symbol: 'AAPL' }),
      input(enterLong, { strategy: intraday }, { symbol: 'MSFT' }),
    ]);
    expect(r.intents.filter((i) => i.kind === 'enter')).toHaveLength(1);
    // auch Übernacht-Einstiege belegen die Reserve (ein Stop am selben Tag wäre ein Daytrade)
    const r2 = decide(ctx({ account: { ...acc, dayTradeCount: 2 } }), [
      input(enterLong, {}, { symbol: 'AAPL' }),
      input(enterLong, {}, { symbol: 'MSFT' }),
      input(enterLong, {}, { symbol: 'NVDA' }),
    ]);
    expect(r2.intents.filter((i) => i.kind === 'enter')).toHaveLength(1);
  });

  it('offene Einstiegs-Orders belegen das Exposure-Budget', () => {
    // Budget 100 % von 10 000; eine offene Order über 9 500 $ lässt nur 500 $ ⇒ 5 Stück
    const r = decide(ctx({ pendingEntries: new Set(['MSFT']), pendingNotional: new Map([['MSFT', 9_500]]) }), [input(enterLong)]);
    expect(r.intents[0]).toMatchObject({ kind: 'enter', qty: 5 });
  });

  it('Sizing 0 blockiert mit Grund', () => {
    const acc = { equity: 300, cash: 300, dayStartEquity: 300, peakEquity: 300, dayTradeCount: 0, patternDayTrader: false };
    const r = decide(ctx({ account: acc }), [input(enterLong)]);
    expect(r.intents).toHaveLength(0);
    expect(r.notes.some((n) => /Sizing/.test(n.text))).toBe(true);
  });
});

describe('Basis-Stufe in decide(): Allokations-Sizing, dieselben Bremsen', () => {
  const alloc = { mode: 'allocation' as const, positionPct: 20 };
  const weit: Decision = { kind: 'enter', side: 'long', stop: 80, reason: 'Basis' };

  it('sizing: allocation ⇒ Stückzahl = floor(Equity × positionPct / Kurs); der Stop der Strategie bleibt unverändert', () => {
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositionPct: 100 } }), [input(weit, { sizing: alloc })]);
    expect(r.intents).toHaveLength(1);
    // 10 000 × 20 % / 100 = 20 Stück; das Risiko-Budget (0,5 % = 50 $ / 20 $) ergäbe 2.
    expect(r.intents[0]).toMatchObject({ kind: 'enter', qty: 20, stop: 80, target: null, strategy: 'stub' });
    const ohne = decide(ctx({ risk: { ...cfg.risk, maxPositionPct: 100 } }), [input(weit)]);
    expect(ohne.intents[0]).toMatchObject({ kind: 'enter', qty: 2 });
  });

  it('WÄCHTER: maxPositionPct des Nutzers deckelt die Allokation (10 % ⇒ 10 Stück), vergrößert sie nie', () => {
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositionPct: 10 } }), [input(weit, { sizing: alloc })]);
    expect(r.intents[0]).toMatchObject({ kind: 'enter', qty: 10 });
    const r2 = decide(ctx({ risk: { ...cfg.risk, maxPositionPct: 50 } }), [input(weit, { sizing: alloc })]);
    expect(r2.intents[0]).toMatchObject({ kind: 'enter', qty: 20 });
  });

  it('WÄCHTER: Exposure-Budget und Positionslimit gelten für die Basis wie für alle', () => {
    const budget = decide(ctx({ risk: { ...cfg.risk, maxPositionPct: 100, maxGrossExposurePct: 10 } }), [input(weit, { sizing: alloc })]);
    expect(budget.intents[0]).toMatchObject({ kind: 'enter', qty: 10 });
    const voll = decide(ctx({ risk: { ...cfg.risk, maxPositions: 1 }, positions: new Map([['MSFT', longPos({ symbol: 'MSFT' })]]) }), [input(weit, { sizing: alloc })]);
    expect(voll.intents).toHaveLength(0);
    expect(voll.notes.some((n) => /Positionslimit/.test(n.text))).toBe(true);
  });

  it.each([
    ['Tages-Halt', { halt: { ...noHalt, halted: true, reason: 'daily_loss' as const, until: '2026-09-08' } }, /Halt aktiv/],
    ['Drawdown-Halt', { halt: { ...noHalt, halted: true, reason: 'drawdown' as const } }, /Halt aktiv/],
    ['Einstiegssperre von außen (Echtgeld-Kette)', { entryLock: 'Kill-Switch aktiv' }, /Einstiege gesperrt/],
    ['Daten nicht frisch', { dataFresh: false }, /frisch/],
  ])('WÄCHTER: %s sperrt Einstiege der Basis wie die des Champions — keine Sonderrechte', (_name, over, re) => {
    const r = decide(ctx(over as Partial<LogicContext>), [input(weit, { sizing: alloc })]);
    expect(r.intents).toHaveLength(0);
    expect(r.notes.some((n) => n.kind === 'blocked' && re.test(n.text))).toBe(true);
  });

  it('Notbremse (Drawdown) stellt auch Basis-Positionen glatt — Exits nie gesperrt', () => {
    const positions = new Map([['AAPL', longPos()]]);
    const acc = { equity: 8_000, cash: 8_000, dayStartEquity: 8_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
    const r = decide(ctx({ positions, account: acc }), [input({ kind: 'hold' }, { sizing: alloc }, { position: positions.get('AAPL')! })]);
    expect(r.halt.reason).toBe('drawdown');
    expect(r.intents).toEqual([{ kind: 'exit', symbol: 'AAPL', reason: 'drawdown', decidedAt: 5_000_000 }]);
  });
});

describe('Einstiegsrecht der Wahl (Prüfbefund M6/M8): entriesAllowed false sperrt nur Einstiege', () => {
  const alloc = { mode: 'allocation' as const, positionPct: 20 };
  const weit: Decision = { kind: 'enter', side: 'long', stop: 80, reason: 'Basis' };

  it('WÄCHTER: entriesAllowed false ⇒ kein Einstieg, Notiz mit Grund; true oder fehlend ⇒ Einstieg', () => {
    const gesperrt = decide(ctx(), [input(weit, { sizing: alloc, entriesAllowed: false, entryLockReason: 'Latte nicht bestanden' })]);
    expect(gesperrt.intents).toHaveLength(0);
    expect(gesperrt.notes.some((n) => n.kind === 'blocked' && /Einstiege gesperrt: Latte nicht bestanden/.test(n.text))).toBe(true);
    expect(decide(ctx(), [input(weit, { sizing: alloc, entriesAllowed: true })]).intents).toHaveLength(1);
    expect(decide(ctx(), [input(weit, { sizing: alloc })]).intents).toHaveLength(1);
  });

  it('WÄCHTER: der gesperrte Kandidat belegt keinen Platz — der nächste Kandidat kommt an den Platz', () => {
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositions: 1 } }), [
      input(weit, { sizing: alloc, entriesAllowed: false, entryLockReason: 'aus' }),
      input(weit, { sizing: alloc }, { symbol: 'MSFT' }),
    ]);
    expect(r.intents.map((i) => i.symbol)).toEqual(['MSFT']);
  });

  it('WÄCHTER: Exits der eigenen Strategie laufen ohne Einstiegsrecht weiter — Signal-Exit, Stop-Nachzug, Notbremse', () => {
    const pos = longPos();
    const exit = decide(ctx({ positions: new Map([['AAPL', pos]]) }), [input({ kind: 'exit', reason: 'Regime verloren' }, { sizing: alloc, entriesAllowed: false }, { position: pos })]);
    expect(exit.intents).toEqual([{ kind: 'exit', symbol: 'AAPL', reason: 'signal', decidedAt: 5_000_000 }]);
    const stop = decide(ctx({ positions: new Map([['AAPL', pos]]) }), [input({ kind: 'move_stop', stop: 94, reason: 'enger' }, { entriesAllowed: false }, { position: pos })]);
    expect(stop.intents).toMatchObject([{ kind: 'move_stop', symbol: 'AAPL', stop: 94 }]);
    const acc = { equity: 8_000, cash: 8_000, dayStartEquity: 8_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
    const bremse = decide(ctx({ positions: new Map([['AAPL', pos]]), account: acc }), [input({ kind: 'hold' }, { entriesAllowed: false }, { position: pos })]);
    expect(bremse.intents).toEqual([{ kind: 'exit', symbol: 'AAPL', reason: 'drawdown', decidedAt: 5_000_000 }]);
  });
});

describe('Fremde Führung (Prüfbefund M4): eine andere Strategie führt die Position nicht', () => {
  const fremd = (decision: Decision): Strategy => ({ ...stub(decision), id: 'andere' });

  it('WÄCHTER: Position der Strategie A, Symbol führt jetzt B ⇒ kein Exit-Intent aus B-Signalen, kein Stop-Nachzug, Notiz', () => {
    const pos = longPos(); // strategy 'stub'
    const positions = new Map([['AAPL', pos]]);
    const exit = decide(ctx({ positions }), [input({ kind: 'exit', reason: 'B sagt raus' }, { strategy: fremd({ kind: 'exit', reason: 'B sagt raus' }) }, { position: pos })]);
    expect(exit.intents).toHaveLength(0);
    expect(exit.notes.some((n) => n.kind === 'info' && /Position der Strategie stub — andere führt sie nicht/.test(n.text))).toBe(true);
    const trailing = decide(ctx({ positions }), [input({ kind: 'move_stop', stop: 99, reason: 'ATR' }, { strategy: fremd({ kind: 'move_stop', stop: 99, reason: 'ATR' }) }, { position: pos })]);
    expect(trailing.intents).toHaveLength(0);
    // EOD-Flatten ist eine Regel der neuen Strategie — gilt für die fremde Position nicht.
    const intraday = { ...fremd({ kind: 'hold' }), holdsOvernight: false };
    const eod = decide(ctx({ positions }), [input({ kind: 'hold' }, { strategy: intraday }, { position: pos, session: { ...okSession, minutesToClose: 6 } })]);
    expect(eod.intents).toHaveLength(0);
  });

  it('WÄCHTER: die Notbremse stellt auch fremd geführte Positionen glatt — Exits werden nie gesperrt', () => {
    const pos = longPos();
    const acc = { equity: 8_000, cash: 8_000, dayStartEquity: 8_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
    const r = decide(ctx({ positions: new Map([['AAPL', pos]]), account: acc }), [input({ kind: 'hold' }, { strategy: fremd({ kind: 'hold' }) }, { position: pos })]);
    expect(r.intents).toEqual([{ kind: 'exit', symbol: 'AAPL', reason: 'drawdown', decidedAt: 5_000_000 }]);
  });

  it('dieselbe Strategie führt wie bisher: Exit-Signal ⇒ Exit', () => {
    const pos = longPos();
    const r = decide(ctx({ positions: new Map([['AAPL', pos]]) }), [input({ kind: 'exit', reason: 'x' }, {}, { position: pos })]);
    expect(r.intents).toHaveLength(1);
  });
});

describe('Offene Position', () => {
  it('Exit-Signal wird ausgeführt — auch im Halt', () => {
    const positions = new Map([['AAPL', longPos()]]);
    const r = decide(ctx({ positions, halt: { ...noHalt, halted: true, reason: 'manual' } }), [
      input({ kind: 'exit', reason: 'Trendbruch' }, {}, { position: positions.get('AAPL')! }),
    ]);
    expect(r.intents).toEqual([{ kind: 'exit', symbol: 'AAPL', reason: 'signal', decidedAt: 5_000_000 }]);
  });

  it('EOD-Flatten für Intraday-Strategien vor Schluss, nicht für Übernacht-Strategien', () => {
    const pos = longPos();
    const positions = new Map([['AAPL', pos]]);
    const eodSession = { ...okSession, minutesToClose: 5 };
    const r = decide(ctx({ positions }), [input({ kind: 'hold' }, { strategy: stub({ kind: 'hold' }, false) }, { position: pos, session: eodSession })]);
    expect(r.intents[0]).toMatchObject({ kind: 'exit', reason: 'eod' });
    const r2 = decide(ctx({ positions }), [input({ kind: 'hold' }, {}, { position: pos, session: eodSession })]);
    expect(r2.intents).toHaveLength(0);
  });

  it('Stop nachziehen nur enger und auf der Verlustseite', () => {
    const pos = longPos({ stop: 92 });
    const positions = new Map([['AAPL', pos]]);
    const tighter = decide(ctx({ positions }), [input({ kind: 'move_stop', stop: 96, reason: 'trail' }, {}, { position: pos })]);
    expect(tighter.intents[0]).toMatchObject({ kind: 'move_stop', stop: 96 });
    const looser = decide(ctx({ positions }), [input({ kind: 'move_stop', stop: 90, reason: 'trail' }, {}, { position: pos })]);
    expect(looser.intents).toHaveLength(0);
    const aboveMarket = decide(ctx({ positions }), [input({ kind: 'move_stop', stop: 101, reason: 'trail' }, {}, { position: pos })]);
    expect(aboveMarket.intents).toHaveLength(0);
  });

  it('Gegensignal bei offener Position wird ignoriert', () => {
    const pos = longPos();
    const positions = new Map([['AAPL', pos]]);
    const r = decide(ctx({ positions }), [input({ kind: 'enter', side: 'short', stop: 105, reason: 'x' }, {}, { position: pos })]);
    expect(r.intents).toHaveLength(0);
  });
});

describe('Konto-Sperren', () => {
  it('Tages-Notbremse stellt alles glatt und sperrt bis zum nächsten Handelstag', () => {
    const positions = new Map([['AAPL', longPos()], ['MSFT', longPos({ symbol: 'MSFT' })]]);
    const acc = { equity: 9_700, cash: 5_000, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
    const r = decide(ctx({ positions, account: acc }), [input(enterLong, {}, { symbol: 'NVDA' })]);
    expect(r.haltTriggered).toBe(true);
    expect(r.halt.reason).toBe('daily_loss');
    expect(r.halt.until).toBe('2026-09-08');
    expect(r.intents.map((i) => i.kind)).toEqual(['exit', 'exit']);
    expect(r.intents.every((i) => i.kind === 'exit' && i.reason === 'kill_switch')).toBe(true);
  });

  it('Drawdown-Sperre bleibt bis manuelles resume', () => {
    const acc = { equity: 10_500, cash: 10_500, dayStartEquity: 10_500, peakEquity: 12_000, dayTradeCount: 0, patternDayTrader: false };
    const r = decide(ctx({ account: acc }), [input(enterLong)]);
    expect(r.halt.reason).toBe('drawdown');
    expect(r.halt.until).toBeNull();
    expect(r.intents).toHaveLength(0);
  });

  it('Tages-Halt endet am Zieltag von selbst', () => {
    const halt: HaltState = { halted: true, reason: 'daily_loss', since: 1, until: '2026-09-04', note: null };
    const r = decide(ctx({ halt }), [input(enterLong)]);
    expect(r.halt.halted).toBe(false);
    expect(r.intents).toHaveLength(1);
  });
});

describe('Positions-Hilfen', () => {
  it('openPosition trägt die Stufe nur, wenn sie gegeben ist (additiv; der Simulator lässt sie weg)', () => {
    const mit = openPosition({ symbol: 'AAPL', side: 'long', qty: 1, fillPrice: 100, fillTime: 1, stop: 90, target: null, strategy: 's', entryDay: 'd', stufe: 'basis' });
    expect(mit.stufe).toBe('basis');
    const ohne = openPosition({ symbol: 'AAPL', side: 'long', qty: 1, fillPrice: 100, fillTime: 1, stop: 90, target: null, strategy: 's', entryDay: 'd' });
    expect('stufe' in ohne).toBe(false);
  });

  it('advancePosition zählt Bars und führt das Hochwasser', () => {
    const p = advancePosition(advancePosition(longPos({ highWater: 95 }), 99), 97);
    expect(p.barsHeld).toBe(2);
    expect(p.highWater).toBe(99);
    const s = advancePosition(openPosition({ symbol: 'X', side: 'short', qty: 1, fillPrice: 50, fillTime: 1, stop: 55, target: null, strategy: 's', entryDay: 'd' }), 48);
    expect(s.highWater).toBe(48);
  });
});
