/**
 * Wiederaufbau einer Zielallokation nach einer Zwangs-Glattstellung
 * (`risk.wiederaufbau`, core/logic.ts).
 *
 * ── Der Befund, den dieser Test festnagelt ────────────────────────────────
 *
 * `regime_allocation` entscheidet nur an den ersten drei Handelstagen eines
 * Monats; dazwischen sagt sie nichts (regimeAllocation.ts). Stellt die
 * Tages-Notbremse an einem gewöhnlichen Minus-Tag das Buch glatt, kommt der
 * Wiedereinstieg deshalb erst im NÄCHSTEN Monatsfenster — ein Tag Bremse
 * kostet einen Monat Marktabwesenheit. Gemessen ist das in
 * docs/ARCHITEKTUR.md §5a.16 (V3: Aug. 2024, Apr. 2025; der Drawdown je
 * Einheit Exposure wurde dadurch SCHLECHTER, 15,95 % gegen 12,06 %).
 *
 * Der erste Test hier zeigt beides an derselben Bar: ohne den Schalter kein
 * Wiedereinstieg (der Befund), mit ihm einer (die Behebung). Die restlichen
 * Tests sind die Wächter gegen die Fehler, die ein Wiederaufbau machen kann:
 *
 *  (a) Er darf NUR nach einer Notbremse entstehen und nur für eine
 *      Zielallokation (Allokations-Sizing) — für Signal-Strategien mit
 *      Risiko-Budget wäre er ein erfundenes Signal.
 *  (b) Er hebt keine Sperre auf: Halt, Stufen-Bremse, `entryLock`,
 *      Einstiegsrecht, Positionslimit, Sizing gelten unverändert (§0.5).
 *  (c) Er verfällt (`maxAlterTage`) — das Schweigen der Familie außerhalb
 *      ihres Fensters ist kein Ja.
 *  (d) Sagt die Strategie „exit", ist das Ziel weg.
 *  (e) Ist die Position wieder da, ist das Ziel weg (kein Nachkauf).
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig, type RiskConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput, type WiederaufbauZiel } from '../../src/core/logic.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, Decision, HaltState, PositionState, SessionInfo, SizingSpec, Strategy } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';
import { REBAL_TAGE } from '../../src/strategy/regimeAllocation.ts';

const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const ALLOC: SizingSpec = { mode: 'allocation', positionPct: 20 };
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

/** Risiko-Config mit Wiederaufbau an (Vorgabe ist aus — genau das prüft der erste Test). */
function mitWiederaufbau(over: Partial<RiskConfig> = {}): RiskConfig {
  return { ...cfg.risk, maxPositions: 50, wiederaufbau: { enabled: true, maxAlterTage: 5 }, ...over };
}

/* ───────────── Teil 1: die echte Familie, die echte Monatslücke ───────────── */

const s = getStrategy('regime_allocation');
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
function ersterImMonat(ab: number): number {
  for (let i = ab; i < TAGE.length; i++) {
    if (new Date(TAGE[i]!).getUTCMonth() !== new Date(TAGE[i - 1]!).getUTCMonth()) return i;
  }
  throw new Error('kein Monatswechsel');
}
const REBAL = ersterImMonat(s.warmupBars(params) + 40);
/** Erster Tag NACH dem Fenster — hier schweigt die Familie. */
const NACH_FENSTER = REBAL + REBAL_TAGE;

const rampe = (gesamtPct: number) => (k: number) => 100 * (1 + (gesamtPct * k) / 300) * (1 + (k % 2 === 0 ? 0.005 : -0.005));
function serie(n: number, kurs: (k: number) => number): BarSeries {
  const bars: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const c = kurs(k);
    bars.push({ t: TAGE[k]!, o: c, h: c * 1.002, l: c * 0.998, c, v: 100_000 });
  }
  return BarSeries.from(bars);
}
const session = (day: string): SessionInfo => ({ isRegularSession: true, minutesToClose: 200, minutesSinceOpen: 100, barsSinceOpen: 1, isLastBarOfDay: false, day });

/** Korb aus zehn Basis-Symbolen mit absteigender Stärke, Bars bis inkl. `bis`. */
function korb(bis: number, positionen: ReadonlyMap<string, PositionState> = new Map()): SymbolInput[] {
  return Array.from({ length: 10 }, (_, k) => {
    const symbol = `S${String(k).padStart(2, '0')}`;
    const bars = serie(bis + 1, rampe(0.6 - k * 0.05));
    return {
      snap: { symbol, bars, i: bars.length - 1, position: positionen.get(symbol) ?? null, session: session('2024-08-05') },
      strategy: s,
      params,
      ind: s.precompute(bars, params),
      sizing: ALLOC,
      stufe: 'basis',
    };
  });
}
function basisPosition(symbol: string, entryPrice: number): PositionState {
  return {
    symbol,
    side: 'long',
    qty: 100,
    entryPrice,
    entryTime: TAGE[REBAL]!,
    stop: entryPrice * 0.8,
    target: null,
    initialStop: entryPrice * 0.8,
    highWater: entryPrice,
    strategy: s.id,
    barsHeld: 1,
    entryDay: '2024-08-01',
    stufe: 'basis',
  };
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
const einstiege = (r: ReturnType<typeof decide>) => r.intents.filter((i) => i.kind === 'enter').map((i) => i.symbol).sort();
const exits = (r: ReturnType<typeof decide>) => r.intents.filter((i) => i.kind === 'exit').map((i) => i.symbol).sort();

describe('„ein Tag Bremse kostete einen Monat" (§5a.16)', () => {
  /** Schritt 1: Im Fenster kauft die Familie die Stärksten. */
  function einstiegImFenster(risk: RiskConfig) {
    return decide(ctx({ risk }), korb(REBAL));
  }
  /** Schritt 2: Am nächsten Tag reißt der Tagesverlust die Bremse — alles glatt. */
  function bremseAmFolgetag(risk: RiskConfig, gehalten: string[]) {
    const positionen = new Map(gehalten.map((sym) => [sym, basisPosition(sym, 100)]));
    return decide(
      ctx({
        risk,
        now: TAGE[REBAL + 1]! + 86_400_000,
        today: '2024-08-02',
        nextTradingDay: '2024-08-05',
        // −3 % am Tag gegen die Vorgabe 2 %: der gemessene Normalfall, kein Crash.
        account: { equity: 970_000, cash: 970_000, dayStartEquity: 1_000_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
        positions: positionen,
      }),
      korb(REBAL + 1, positionen),
    );
  }
  /** Schritt 3: Nächster Handelstag, Bremse von selbst weg, AUSSERHALB des Fensters. */
  function tagNachDerBremse(risk: RiskConfig, halt: HaltState, wiederaufbau: Record<string, WiederaufbauZiel>) {
    return decide(
      ctx({
        risk,
        now: TAGE[NACH_FENSTER]! + 86_400_000,
        today: '2024-08-05',
        nextTradingDay: '2024-08-06',
        halt,
        account: { equity: 970_000, cash: 970_000, dayStartEquity: 970_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
        wiederaufbau,
      }),
      korb(NACH_FENSTER),
    );
  }

  it('BEFUND: ohne Wiederaufbau bleibt das Depot nach der Bremse in Kasse — die Familie schweigt bis zum nächsten Fenster', () => {
    const risk = { ...cfg.risk, maxPositions: 50 };
    const gehalten = einstiege(einstiegImFenster(risk));
    expect(gehalten.length).toBeGreaterThan(0);

    const gebremst = bremseAmFolgetag(risk, gehalten);
    expect(gebremst.haltTriggered).toBe(true);
    expect(exits(gebremst)).toEqual([...gehalten].sort());
    // Ohne Schalter merkt sich niemand die Zielallokation.
    expect(gebremst.wiederaufbau).toEqual({});

    const danach = tagNachDerBremse(risk, gebremst.halt, {});
    // Die Bremse endet von selbst …
    expect(danach.halt.halted).toBe(false);
    // … und trotzdem passiert nichts: kein Einstieg, kein Exit, keine Entscheidung.
    expect(einstiege(danach)).toEqual([]);
  });

  it('BEHOBEN: mit Wiederaufbau steht das Depot am nächsten erlaubten Tag wieder — mit dem Stop der Messung', () => {
    const risk = mitWiederaufbau();
    const gehalten = einstiege(einstiegImFenster(risk));
    expect(gehalten.length).toBeGreaterThan(0);

    const gebremst = bremseAmFolgetag(risk, gehalten);
    expect(exits(gebremst)).toEqual([...gehalten].sort());
    expect(Object.keys(gebremst.wiederaufbau ?? {}).sort()).toEqual([...gehalten].sort());
    for (const ziel of Object.values(gebremst.wiederaufbau ?? {})) {
      expect(ziel.side).toBe('long');
      expect(ziel.stopDistPct).toBeCloseTo(20, 9); // stopPct der Messung, aus dem Einstand abgeleitet
      expect(ziel.strategy).toBe('regime_allocation');
      expect(ziel.grund).toMatch(/Notbremse/);
    }

    const danach = tagNachDerBremse(risk, gebremst.halt, gebremst.wiederaufbau ?? {});
    expect(einstiege(danach)).toEqual([...gehalten].sort());
    const intent = danach.intents.find((i) => i.kind === 'enter');
    if (intent?.kind !== 'enter') throw new Error('kein Einstieg');
    // Der Stop hängt am NEUEN Kurs, nicht an der alten Marke — sonst wäre es eine andere Regel.
    expect(intent.stop).toBeCloseTo(intent.refPrice * 0.8, 6);
    expect(intent.reason).toMatch(/Wiederaufbau/);
    // Und die Größe ist die der Zielallokation (20 % der Equity), nicht das Risiko-Budget.
    expect(intent.qty * intent.refPrice).toBeGreaterThan(0.19 * 970_000);
    expect(intent.qty * intent.refPrice).toBeLessThanOrEqual(0.2 * 970_000);
  });

  it('WÄCHTER (b): der Wiederaufbau geht durch dieselben Tore — Halt, entryLock, Positionslimit', () => {
    const risk = mitWiederaufbau();
    const gehalten = einstiege(einstiegImFenster(risk));
    const ziele = bremseAmFolgetag(risk, gehalten).wiederaufbau ?? {};

    // Halt steht noch (nächster Tag noch nicht erreicht) ⇒ kein Wiederaufbau.
    const imHalt = tagNachDerBremse(risk, { halted: true, reason: 'manual', since: 1, until: null, note: 'HALT-Datei' }, ziele);
    expect(einstiege(imHalt)).toEqual([]);
    expect(imHalt.notes.some((n) => n.kind === 'blocked' && /Halt aktiv/.test(n.text))).toBe(true);

    // Einstiegssperre von außen (Echtgeld-Kette) ⇒ kein Wiederaufbau.
    const gesperrt = decide(
      ctx({ risk, now: TAGE[NACH_FENSTER]! + 86_400_000, today: '2024-08-05', entryLock: 'Kill-Switch', wiederaufbau: ziele }),
      korb(NACH_FENSTER),
    );
    expect(einstiege(gesperrt)).toEqual([]);

    // Positionslimit 1 ⇒ genau ein Wiederaufbau, nicht mehr.
    const limitiert = decide(
      ctx({ risk: mitWiederaufbau({ maxPositions: 1 }), now: TAGE[NACH_FENSTER]! + 86_400_000, today: '2024-08-05', wiederaufbau: ziele }),
      korb(NACH_FENSTER),
    );
    expect(einstiege(limitiert)).toHaveLength(1);
  });

  it('WÄCHTER (c): das Ziel verfällt nach maxAlterTage — Schweigen ist kein Ja', () => {
    const risk = mitWiederaufbau({ wiederaufbau: { enabled: true, maxAlterTage: 5 } });
    const gehalten = einstiege(einstiegImFenster(risk));
    const ziele = bremseAmFolgetag(risk, gehalten).wiederaufbau ?? {};
    const spaeter = decide(
      ctx({
        risk,
        now: TAGE[REBAL + 1]! + 86_400_000 + 6 * 86_400_000,
        today: '2024-08-12',
        wiederaufbau: ziele,
      }),
      korb(NACH_FENSTER),
    );
    expect(einstiege(spaeter)).toEqual([]);
    expect(spaeter.wiederaufbau).toEqual({});
    expect(spaeter.notes.some((n) => /verfallen/.test(n.text))).toBe(true);
  });
});

/* ───────────── Teil 2: Mechanik am Stub (schnell und scharf) ───────────── */

function stub(decision: Decision, id = 'stub'): Strategy {
  return {
    id,
    timeframes: TIMEFRAMES,
    paramSpace: [],
    defaults: {},
    holdsOvernight: true,
    warmupBars: () => 1,
    precompute: () => ({}),
    decide: () => decision,
  };
}
function stubBars(): BarSeries {
  return BarSeries.from([98, 99, 100].map((c, i) => ({ t: 1_000 + i * 86_400_000, o: c, h: c + 1, l: c - 1, c, v: 1000 })));
}
function stubInput(decision: Decision, over: Partial<SymbolInput> = {}): SymbolInput {
  const bars = stubBars();
  return {
    snap: { symbol: 'AAA', bars, i: bars.length - 1, position: null, session: session('2024-08-05') },
    strategy: stub(decision),
    params: {},
    ind: {},
    sizing: ALLOC,
    stufe: 'basis',
    ...over,
  };
}
function stubPos(over: Partial<PositionState> = {}): PositionState {
  return {
    symbol: 'AAA',
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
    entryDay: '2024-08-01',
    stufe: 'basis',
    ...over,
  };
}
/** Frisches Ziel (Alter 0 gegen die `now` des Stub-Kontexts — sonst greift der Verfall zuerst). */
const ziel = (over: Partial<WiederaufbauZiel> = {}): Record<string, WiederaufbauZiel> => ({
  AAA: { side: 'long', stopDistPct: 20, strategy: 'stub', since: TAGE[REBAL]! + 86_400_000, grund: 'Konto-Notbremse (daily_loss)', ...over },
});

describe('Wiederaufbau: Mechanik', () => {
  const risk = mitWiederaufbau();

  it('WÄCHTER (a): nur Allokations-Sizing bekommt ein Ziel — Risiko-Budget nie', () => {
    const pos = stubPos();
    const acc = { equity: 10_000, cash: 10_000, dayStartEquity: 10_000, peakEquity: 10_000, dayTradeCount: 0, patternDayTrader: false };
    const gemeinsam = {
      risk: { ...risk, maxDailyLossPct: 2 },
      account: { ...acc, equity: 9_700 },
      positions: new Map([['AAA', pos]]),
    };
    const mitAlloc = decide(ctx(gemeinsam), [stubInput({ kind: 'hold' }, { snap: { ...stubInput({ kind: 'hold' }).snap, position: pos } })]);
    expect(Object.keys(mitAlloc.wiederaufbau ?? {})).toEqual(['AAA']);

    const ohneAlloc = decide(ctx(gemeinsam), [
      stubInput({ kind: 'hold' }, { sizing: undefined, snap: { ...stubInput({ kind: 'hold' }).snap, position: pos } }),
    ]);
    expect(ohneAlloc.wiederaufbau).toEqual({});
  });

  it('WÄCHTER (a): ohne Notbremse entsteht nie ein Ziel — ein Stop-Exit ist kein Wiederaufbau-Grund', () => {
    const pos = stubPos();
    const r = decide(
      ctx({ risk, positions: new Map([['AAA', pos]]) }),
      [stubInput({ kind: 'exit', reason: 'Signal' }, { snap: { ...stubInput({ kind: 'hold' }).snap, position: pos } })],
    );
    expect(r.intents.some((i) => i.kind === 'exit')).toBe(true);
    expect(r.wiederaufbau).toEqual({});
  });

  it('WÄCHTER (d): sagt die Strategie „exit", ist das Ziel weg — kein Kauf gegen das Signal', () => {
    const r = decide(ctx({ risk, wiederaufbau: ziel() }), [stubInput({ kind: 'exit', reason: 'Regime verloren' })]);
    expect(r.intents).toEqual([]);
    expect(r.wiederaufbau).toEqual({});
    expect(r.notes.some((n) => /Wiederaufbau verworfen/.test(n.text))).toBe(true);
  });

  it('WÄCHTER (e): ist die Position wieder da, verschwindet das Ziel', () => {
    const pos = stubPos();
    const r = decide(ctx({ risk, positions: new Map([['AAA', pos]]), wiederaufbau: ziel() }), [
      stubInput({ kind: 'hold' }, { snap: { ...stubInput({ kind: 'hold' }).snap, position: pos } }),
    ]);
    expect(r.wiederaufbau).toEqual({});
  });

  it('das Ziel überlebt einen blockierten Versuch (Datenalter) und wird nicht verbraucht', () => {
    const r = decide(ctx({ risk, dataFresh: false, wiederaufbau: ziel() }), [stubInput({ kind: 'hold' })]);
    expect(r.intents).toEqual([]);
    expect(Object.keys(r.wiederaufbau ?? {})).toEqual(['AAA']);
  });

  it('wechselt die führende Strategie, verfällt das Ziel (fremde Regel, keine Zielallokation)', () => {
    const r = decide(ctx({ risk, wiederaufbau: ziel({ strategy: 'andere' }) }), [stubInput({ kind: 'hold' })]);
    expect(r.intents).toEqual([]);
    expect(r.wiederaufbau).toEqual({});
  });

  it('ein Ziel mit unplausiblem Stop wird abgelehnt statt blind gekauft', () => {
    // Stop-Distanz 0 ⇒ Stop = Kurs ⇒ Stop-Plausibilität schlägt zu.
    const r = decide(ctx({ risk, wiederaufbau: ziel({ stopDistPct: 0 }) }), [stubInput({ kind: 'hold' })]);
    expect(r.intents).toEqual([]);
    expect(r.notes.some((n) => n.kind === 'blocked' && /Stop unplausibel/.test(n.text))).toBe(true);
  });

  it('Schalter aus (Vorgabe) ⇒ ein vorhandenes Ziel wird weder benutzt noch angetastet', () => {
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositions: 50 }, wiederaufbau: ziel() }), [stubInput({ kind: 'hold' })]);
    expect(r.intents).toEqual([]);
    expect(Object.keys(r.wiederaufbau ?? {})).toEqual(['AAA']);
  });
});
