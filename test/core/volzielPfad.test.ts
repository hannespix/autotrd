/**
 * Ein Faktor, zwei Welten: Das Vola-Ziel (`risk.volTarget`) muss im
 * Simulator und in der Engine DIESELBE Zahl ergeben.
 *
 * Warum das ein eigener Test ist: Der Faktor multipliziert jede
 * Positionsgröße. Rechneten Simulator und Engine ihn getrennt — zwei
 * Definitionen der Tagesrendite, zwei Fenster, zwei Aufwärmphasen —, wäre die
 * Messung eine andere Strategie als der Handel, und das wäre exakt der
 * Fehler, gegen den dieser Neubau gebaut ist (CLAUDE.md §0.1). Deshalb:
 *
 *  (a) Gerechnet wird der Faktor NUR in `decide()`. Die Aufrufer liefern die
 *      Renditen, sonst nichts — dieser Test prüft, dass `decide()`s Ergebnis
 *      genau `volSkalierung()` auf den übergebenen Renditen ist.
 *  (b) Beide Welten bilden die Renditen gleich: Der Simulator aus seiner
 *      Equity-Kurve (`dailyReturns`), die Engine aus den Tagesmarken im State
 *      (`tagesRenditen(equityHistory)`). Gleiche Kurve ⇒ gleiche Reihe ⇒
 *      gleicher Faktor.
 *  (c) Der Faktor wirkt tatsächlich auf die Stückzahl — und die Deckel des
 *      Nutzers bleiben darüber.
 *  (d) Er ist sichtbar: `LogicResult.volZiel` trägt Faktor, realisierte Vola
 *      und Grund (Journal/Bericht).
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig, type RiskConfig } from '../../src/core/config.ts';
import { equityHistorieAnhaengen, EQUITY_HISTORIE_MAX } from '../../src/core/journal.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, Decision, HaltState, SessionInfo, Strategy } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';
import { tagesRenditen, volSkalierung } from '../../src/risk/volziel.ts';
import { baseConfig, strategyOf } from '../backtest/helpers.ts';

const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };
const session: SessionInfo = { isRegularSession: true, minutesToClose: 200, minutesSinceOpen: 100, barsSinceOpen: 1, isLastBarOfDay: false, day: '2026-09-11' };

const volAn = (over: Partial<RiskConfig['volTarget']> = {}): RiskConfig => ({
  ...cfg.risk,
  maxPositionPct: 100,
  volTarget: { enabled: true, zielVolPct: 10, halbwertszeitTage: 20, minFaktor: 0.25, maxFaktor: 2, minBeobachtungen: 60, ...over },
});

function stub(decision: Decision): Strategy {
  return { id: 'stub', timeframes: TIMEFRAMES, paramSpace: [], defaults: {}, holdsOvernight: true, warmupBars: () => 1, precompute: () => ({}), decide: () => decision };
}
function input(decision: Decision): SymbolInput {
  const bars = BarSeries.from([98, 99, 100].map((c, i) => ({ t: 1_000 + i * 86_400_000, o: c, h: c + 1, l: c - 1, c, v: 1000 })));
  return { snap: { symbol: 'AAA', bars, i: bars.length - 1, position: null, session }, strategy: stub(decision), params: {}, ind: {} };
}
function ctx(risk: RiskConfig, over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: 1_700_000_000_000,
    today: '2026-09-11',
    nextTradingDay: '2026-09-14',
    account: { equity: 100_000, cash: 100_000, dayStartEquity: 100_000, peakEquity: 100_000, dayTradeCount: 0, patternDayTrader: false },
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
const enterLong: Decision = { kind: 'enter', side: 'long', stop: 90, reason: 'test' };
const qtyOf = (r: ReturnType<typeof decide>) => (r.intents[0]?.kind === 'enter' ? r.intents[0].qty : 0);

/** Eine Equity-Kurve aus Tagesmarken: ruhig, aber nicht flach (0,4 % Zickzack, leichter Aufwärtsdrift). */
function kurve(tage: number): number[] {
  const out = [100_000];
  for (let i = 1; i <= tage; i++) {
    const vorher = out[i - 1]!;
    out.push(vorher * (1 + (i % 2 === 0 ? 0.004 : -0.003)));
  }
  return out;
}

describe('Vola-Ziel: ein Faktor für Simulator und Engine', () => {
  it('WÄCHTER (b): gleiche Equity-Kurve ⇒ gleiche Renditen in beiden Welten', () => {
    const marken = kurve(80);
    // So bildet der Simulator sie (backtest/simulator.ts: dayCloseEquity / lastDayEquity − 1) …
    const simulator: number[] = [];
    for (let i = 1; i < marken.length; i++) simulator.push(marken[i]! / marken[i - 1]! - 1);
    // … und so die Engine aus den Tagesmarken ihres States.
    let historie: number[] = [];
    for (const m of marken) historie = equityHistorieAnhaengen(historie, m);
    const engine = tagesRenditen(historie);
    expect(engine).toEqual(simulator);
    expect(volSkalierung({ ...volAn().volTarget, renditen: engine }).faktor).toBe(volSkalierung({ ...volAn().volTarget, renditen: simulator }).faktor);
  });

  it('WÄCHTER (a): `decide()` ist die EINE Rechenstelle — sein Ergebnis ist genau volSkalierung(ctx.equityReturns)', () => {
    const renditen = tagesRenditen(kurve(120));
    const risk = volAn();
    const r = decide(ctx(risk, { equityReturns: renditen }), [input(enterLong)]);
    const erwartet = volSkalierung({
      renditen,
      zielVolPct: risk.volTarget.zielVolPct,
      halbwertszeitTage: risk.volTarget.halbwertszeitTage,
      minFaktor: risk.volTarget.minFaktor,
      maxFaktor: risk.volTarget.maxFaktor,
      minBeobachtungen: risk.volTarget.minBeobachtungen,
      tageJeJahr: 252,
    });
    expect(r.volZiel).toEqual(erwartet);
  });

  it('WÄCHTER (c): der Faktor wirkt auf die Stückzahl — und der Deckel bleibt darüber', () => {
    const renditen = tagesRenditen(kurve(200));
    const ohne = decide(ctx({ ...cfg.risk, maxPositionPct: 100 }), [input(enterLong)]);
    const mit = decide(ctx(volAn(), { equityReturns: renditen }), [input(enterLong)]);
    const faktor = mit.volZiel?.faktor ?? 1;
    expect(faktor).toBeGreaterThan(1);
    expect(qtyOf(mit)).toBe(Math.floor(qtyOf(ohne) * faktor));
    // Deckel 1 % der Equity = 1 000 $ / 100 $ = 10 Stück, trotz Faktor > 1.
    const gedeckelt = decide(ctx({ ...volAn(), maxPositionPct: 1 }, { equityReturns: renditen }), [input(enterLong)]);
    expect(qtyOf(gedeckelt)).toBe(10);
  });

  it('Aufwärmphase: zu kurze Historie ⇒ Faktor 1,0, Stückzahl exakt wie ohne Vola-Ziel', () => {
    const kurz = tagesRenditen(kurve(30));
    const ohne = decide(ctx({ ...cfg.risk, maxPositionPct: 100 }), [input(enterLong)]);
    const mit = decide(ctx(volAn(), { equityReturns: kurz }), [input(enterLong)]);
    expect(mit.volZiel?.faktor).toBe(1);
    expect(qtyOf(mit)).toBe(qtyOf(ohne));
  });

  it('WÄCHTER (d): aus ⇒ kein volZiel im Ergebnis, an ⇒ Faktor, Vola und Grund', () => {
    expect(decide(ctx({ ...cfg.risk }), [input(enterLong)]).volZiel ?? null).toBe(null);
    const r = decide(ctx(volAn(), { equityReturns: tagesRenditen(kurve(120)) }), [input(enterLong)]);
    expect(r.volZiel?.grund).toMatch(/Vola-Ziel/);
    expect(r.volZiel?.realisiertVolPct).toBeGreaterThan(0);
    expect(r.volZiel?.beobachtungen).toBe(120);
  });

  it('Krypto rechnet mit 365 Tagen — auch das entscheidet `decide()`, nicht der Aufrufer', () => {
    const renditen = tagesRenditen(kurve(120));
    const aktien = decide(ctx(volAn(), { equityReturns: renditen }), [input(enterLong)]);
    const krypto = decide(ctx(volAn(), { equityReturns: renditen, assetClass: 'crypto' }), [input(enterLong)]);
    expect((krypto.volZiel?.realisiertVolPct ?? 0) / (aktien.volZiel?.realisiertVolPct ?? 1)).toBeCloseTo(Math.sqrt(365 / 252), 10);
  });
});

describe('Vola-Ziel im echten Simulator (die Verdrahtung, nicht nur der Typ)', () => {
  /** Tagesbars (Mo–Fr) mit sanftem Zickzack — Kurs 100, damit die Stückzahl leicht nachrechenbar bleibt. */
  function tagesBars(n: number): BarSeries {
    const bars: Bar[] = [];
    const d = new Date(Date.UTC(2024, 0, 2));
    let k = 0;
    while (bars.length < n) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) {
        const c = 100 * (1 + (k % 2 === 0 ? 0.002 : -0.002));
        bars.push({ t: msFromET(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30), o: c, h: c * 1.001, l: c * 0.999, c, v: 100_000 });
        k++;
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return BarSeries.from(bars);
  }

  /** Einstieg erst an Bar 80 (davor Kasse), danach halten — der Lauf hat so 79 Tagesrenditen vor dem Sizing. */
  const spaeterEinstieg = strategyOf({
    id: 'spaet',
    holdsOvernight: true,
    warmup: 1,
    timeframes: [1440],
    decide: (snap) => (snap.position === null && snap.i === 80 ? { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.9, reason: 'test' } : { kind: 'hold' }),
  });

  function lauf(risk: Partial<RiskConfig>) {
    return simulate({
      bars: new Map([['AAA', tagesBars(120)]]),
      strategyFor: () => ({ strategy: spaeterEinstieg, params: {} }),
      config: baseConfig({ timeframe: 1440, risk: { maxPositionPct: 100, ...risk } }),
      initialEquity: 100_000,
    });
  }

  it('der Simulator reicht seine Renditen wirklich durch — und die bekannte Grenze zeigt sich: flache Kasse ⇒ maxFaktor', () => {
    const ohne = lauf({});
    const mit = lauf({ volTarget: volAn().volTarget });
    // In beiden Läufen entsteht genau ein Einstieg; mit Vola-Ziel ist er (bis auf die
    // Stückelung) doppelt so groß, weil die Kurve vorher flach war (Kasse) — genau der
    // im Modulkopf benannte prozyklische Fall, gedeckelt durch maxFaktor.
    expect(mit.notes.some((n) => /Vola-Ziel/.test(n))).toBe(true);
    expect(ohne.notes.some((n) => /Vola-Ziel/.test(n))).toBe(false);
    const offenOhne = ohne.notes.find((n) => n.startsWith('Offen am Ende'));
    const offenMit = mit.notes.find((n) => n.startsWith('Offen am Ende'));
    expect(offenOhne).toBeDefined();
    expect(offenMit).toBeDefined();
    const stueck = (note: string) => Number(note.split(' long ')[1]!.split(' ')[0]);
    expect(stueck(offenOhne!)).toBeGreaterThan(0);
    // Faktor 2 auf das Budget; das Verhältnis der abgerundeten Stückzahlen liegt deshalb nahe 2,
    // aber nicht exakt darauf (floor verteilt sich nicht: 99 / 49 = 2,02).
    expect(stueck(offenMit!) / stueck(offenOhne!)).toBeGreaterThan(1.95);
    expect(stueck(offenMit!) / stueck(offenOhne!)).toBeLessThan(2.1);
  });

  it('der Deckel des Nutzers bleibt auch im Simulator über dem Faktor', () => {
    const gedeckelt = lauf({ volTarget: volAn().volTarget, maxPositionPct: 5 });
    const offen = gedeckelt.notes.find((n) => n.startsWith('Offen am Ende'))!;
    const stueck = Number(offen.split(' long ')[1]!.split(' ')[0]);
    // 5 % von 100 000 $ = 5 000 $ / ~100 $ ⇒ höchstens 50 Stück, egal welcher Faktor.
    expect(stueck).toBeLessThanOrEqual(50);
  });
});

describe('Equity-Historie im State', () => {
  it('hängt an, deckelt und verwirft Unsinn (additiv, idempotent im Format)', () => {
    expect(equityHistorieAnhaengen(undefined, 100)).toEqual([100]);
    expect(equityHistorieAnhaengen([100], 110)).toEqual([100, 110]);
    expect(equityHistorieAnhaengen([100], 0)).toEqual([100]);
    expect(equityHistorieAnhaengen([100], Number.NaN)).toEqual([100]);
    const lang = Array.from({ length: EQUITY_HISTORIE_MAX }, (_, i) => 100 + i);
    const neu = equityHistorieAnhaengen(lang, 999);
    expect(neu).toHaveLength(EQUITY_HISTORIE_MAX);
    expect(neu[EQUITY_HISTORIE_MAX - 1]).toBe(999);
    expect(neu[0]).toBe(101); // die älteste Marke fällt heraus
  });
});
