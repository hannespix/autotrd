/**
 * turn_of_month — der Kalender ist hier die Kante, an der Geld verloren geht.
 *
 * Diese Familie fragt keinen Kurs. Ihr einziger Eingang ist die Frage „wie
 * viele HANDELSTAGE liegen in diesem Monat noch vor mir?", und die kann auf
 * genau zwei Weisen falsch beantwortet werden:
 *
 *  1. über Kalendertage — dann kauft man an Karfreitag, am 4. Juli und am
 *     Wochenende, und das Fenster verschiebt sich um bis zu vier Tage;
 *  2. über die Bar-Serie — dann ist es LOOKAHEAD, weil „nach mir kommt noch
 *     eine Bar in diesem Monat" erst in der Zukunft feststeht.
 *
 * Deshalb prüft diese Datei drei Dinge mit HANDVERIFIZIERTEN Daten des
 * NYSE-Kalenders 2026 (Neujahr, Karfreitag, vorgezogener 4. Juli,
 * Monatsende am Wochenende, Thanksgiving) und einer Zeitumstellung:
 * die Kalenderrechnung selbst, die Präfix-Konsistenz der Flaggen und das
 * Verhalten durch `decide()` und den echten Simulator — wie live.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { addDays, dayKey, etOffsetMin, isTradingDay, msFromET, parseDay } from '../../src/core/time.ts';
import type { Bar, HaltState, PositionState, SessionInfo } from '../../src/core/types.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';
import { fensterLage, monatsHandelstage } from '../../src/strategy/turnOfMonth.ts';
import { baseConfig } from '../backtest/helpers.ts';

const s = getStrategy('turn_of_month');
const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const params = resolveParams(s, {});

/* ───────────────────────── Serien auf echten Handelstagen ───────────────────────── */

/** ET-Handelstage von `von` bis `bis` (beide inklusive) laut NYSE-Kalender. */
function handelstage(von: string, bis: string): string[] {
  const out: string[] = [];
  for (let d = von; d <= bis; d = addDays(d, 1)) {
    if (isTradingDay(d, 'us_equity')) out.push(d);
  }
  return out;
}

/** Bar-Beginn = Sitzungseröffnung 09:30 ET des Tages. */
function barZeit(day: string): number {
  const { y, m, d } = parseDay(day);
  return msFromET(y, m, d, 9, 30);
}

/** Tagesbars über die gegebenen Handelstage; Close = kurs(k), Spanne ±0,4 %. */
function serie(tage: readonly string[], kurs: (k: number) => number = () => 100): BarSeries {
  const bars: Bar[] = tage.map((day, k) => {
    const c = kurs(k);
    return { t: barZeit(day), o: c, h: c * 1.004, l: c * 0.996, c, v: 500_000 };
  });
  return BarSeries.from(bars);
}

const TAGE = handelstage('2025-06-02', '2026-12-31');
const SERIE = serie(TAGE, (k) => 100 * (1 + 0.0004 * k) * (1 + (k % 2 === 0 ? 0.002 : -0.002)));
const IND = s.precompute(SERIE, params);
const idxVon = (day: string): number => TAGE.indexOf(day);

const okSession: SessionInfo = { isRegularSession: true, minutesToClose: 0, minutesSinceOpen: 390, barsSinceOpen: 1, isLastBarOfDay: true, day: '2026-05-28' };
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

function input(day: string, position: PositionState | null = null): SymbolInput {
  const i = idxVon(day);
  const bars = SERIE.prefix(i + 1);
  return { snap: { symbol: 'AAA', bars, i, position, session: { ...okSession, day }, ...{} }, strategy: s, params, ind: s.precompute(bars, params) };
}

function ctx(day: string, over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: barZeit(day) + 86_400_000,
    today: day,
    nextTradingDay: addDays(day, 1),
    account: { equity: 1_000_000, cash: 1_000_000, dayStartEquity: 1_000_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: cfg.risk,
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: 1440,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    ...over,
  };
}

function position(entryPrice: number, barsHeld = 1): PositionState {
  return {
    symbol: 'AAA',
    side: 'long',
    qty: 10,
    entryPrice,
    entryTime: 0,
    stop: entryPrice * 0.9,
    target: null,
    initialStop: entryPrice * 0.9,
    highWater: entryPrice,
    strategy: s.id,
    barsHeld,
    entryDay: '2026-05-29',
  };
}

/** Entscheidet die Strategie an diesem Tag `enter` / `exit` / `hold`? */
function urteil(day: string, pos: PositionState | null = null): string {
  const inp = input(day, pos);
  const c = ctx(day, pos ? { positions: new Map([['AAA', pos]]) } : {});
  const r = decide(c, [inp]);
  const e = r.intents[0];
  return e ? e.kind : 'hold';
}

/* ───────────────────────── 1. Der Kalender selbst ───────────────────────── */

describe('turn_of_month: Handelstage, nicht Kalendertage', () => {
  it('Januar 2026 beginnt am 2. (Neujahr ist Donnerstag und geschlossen)', () => {
    expect(monatsHandelstage('2026-01').slice(0, 3)).toEqual(['2026-01-02', '2026-01-05', '2026-01-06']);
  });

  it('April 2026 überspringt Karfreitag (3. April)', () => {
    const tage = monatsHandelstage('2026-04');
    expect(tage.slice(0, 3)).toEqual(['2026-04-01', '2026-04-02', '2026-04-06']);
    expect(tage).not.toContain('2026-04-03');
  });

  it('Juli 2026 überspringt den vorgezogenen Unabhängigkeitstag (4. Juli ist Samstag ⇒ Freitag, 3. Juli, zu)', () => {
    const tage = monatsHandelstage('2026-07');
    expect(tage.slice(0, 3)).toEqual(['2026-07-01', '2026-07-02', '2026-07-06']);
    expect(tage).not.toContain('2026-07-03');
  });

  it('Mai 2026 endet am Freitag, 29. — der 30. und 31. sind Wochenende', () => {
    expect(monatsHandelstage('2026-05').slice(-2)).toEqual(['2026-05-28', '2026-05-29']);
  });

  it('November 2026 überspringt Thanksgiving (26.), behält den Frühschluss-Freitag (27.) und endet am Montag, 30.', () => {
    const tage = monatsHandelstage('2026-11');
    expect(tage).not.toContain('2026-11-26');
    expect(tage.slice(-2)).toEqual(['2026-11-27', '2026-11-30']);
  });

  it('fensterLage zählt vor und nach — auch über Feiertage hinweg', () => {
    expect(fensterLage('2026-05-28')).toEqual({ davor: 18, danach: 1 }); // vorletzter Handelstag
    expect(fensterLage('2026-05-29')).toEqual({ davor: 19, danach: 0 }); // letzter
    expect(fensterLage('2026-07-06')).toEqual({ davor: 2, danach: 19 }); // dritter Handelstag trotz zweier Feiertage davor
    expect(fensterLage('2026-04-06')).toEqual({ davor: 2, danach: 18 }); // dritter Handelstag nach Karfreitag
  });

  it('ein Tag, den der Fallback nicht als Handelstag kennt, bleibt wohldefiniert (kein −1)', () => {
    // Karfreitag selbst ist keiner der 21 Handelstage im April: zwei liegen
    // davor (1., 2.), die restlichen 19 danach — Summe 21, kein Index −1.
    expect(fensterLage('2026-04-03')).toEqual({ davor: 2, danach: 19 });
    expect(monatsHandelstage('2026-04')).toHaveLength(21);
  });
});

/* ───────────────────────── 2. Kausalität ───────────────────────── */

describe('turn_of_month: kein Lookahead in der Monatsrechnung', () => {
  it('die Flaggen an Index i sind mit Präfix und voller Serie identisch — auch an jedem Monatsende', () => {
    // Genau hier scheitert jede Implementierung, die Bars zählt statt den
    // Kalender zu fragen: An der letzten Bar eines Präfixes ist unbekannt,
    // ob noch eine Bar des Monats folgt.
    const monatsenden = TAGE.map((d, i) => [d, i] as const).filter(([d]) => fensterLage(d).danach <= 2);
    expect(monatsenden.length).toBeGreaterThan(30);
    for (const [, i] of monatsenden) {
      const pre = s.precompute(SERIE.prefix(i + 1), params);
      for (const key of ['enter', 'imFenster'] as const) {
        expect(Object.is(pre[key]![i], IND[key]![i]), `${key}[${i}] Präfix ${pre[key]![i]} vs voll ${IND[key]![i]}`).toBe(true);
      }
    }
  });

  it('die Flaggen hängen nur am Datum der Bar, nicht an ihrer Position in der Serie', () => {
    // Dieselben Tage, aber die Serie beginnt ein halbes Jahr später: gleiche Flaggen.
    const spaet = handelstage('2026-01-02', '2026-12-31');
    const indSpaet = s.precompute(serie(spaet), params);
    for (const day of ['2026-05-28', '2026-05-29', '2026-11-27', '2026-11-30', '2026-07-06']) {
      expect(indSpaet.enter![spaet.indexOf(day)]).toBe(IND.enter![idxVon(day)]);
      expect(indSpaet.imFenster![spaet.indexOf(day)]).toBe(IND.imFenster![idxVon(day)]);
    }
  });
});

/* ───────────────────────── 3. Das Fenster, Tag für Tag ───────────────────────── */

describe('turn_of_month: Einstieg am vorletzten Handelstag, Ausstieg am dritten des neuen Monats', () => {
  it('kauft am vorletzten Handelstag des Monats — und nur dort', () => {
    expect(urteil('2026-05-28')).toBe('enter'); // vorletzter (der 30./31. sind Wochenende)
    expect(urteil('2026-05-29')).toBe('hold'); // letzter: zu spät, der Fill läge im neuen Monat
    expect(urteil('2026-05-27')).toBe('hold'); // drittletzter: zu früh
    expect(urteil('2026-06-01')).toBe('hold'); // erster des neuen Monats
  });

  it('über 18 Monate fällt genau ein Einstieg je Monat, immer am vorletzten Handelstag', () => {
    const einstiege = TAGE.filter((d, i) => i + 1 >= s.warmupBars(params) && IND.enter![i] === 1);
    const jeMonat = new Map<string, string[]>();
    for (const d of einstiege) jeMonat.set(d.slice(0, 7), [...(jeMonat.get(d.slice(0, 7)) ?? []), d]);
    expect(jeMonat.size).toBeGreaterThanOrEqual(17);
    for (const [ym, tage] of jeMonat) {
      expect(tage, ym).toHaveLength(1);
      expect(tage[0], ym).toBe(monatsHandelstage(ym).at(-2));
    }
  });

  it('hält über den Monatswechsel und steigt am dritten Handelstag des neuen Monats aus — Karfreitag verschiebt mit', () => {
    const pos = position(SERIE.c[idxVon('2026-03-31')]!);
    expect(urteil('2026-03-31', pos)).toBe('hold'); // letzter Handelstag März
    expect(urteil('2026-04-01', pos)).toBe('hold'); // 1. Handelstag April
    expect(urteil('2026-04-02', pos)).toBe('hold'); // 2. Handelstag (danach Karfreitag)
    expect(urteil('2026-04-06', pos)).toBe('exit'); // 3. Handelstag — Fill am Open des 7.
  });

  it('der vorgezogene Feiertag im Juli verschiebt das Fensterende ebenso', () => {
    const pos = position(SERIE.c[idxVon('2026-06-30')]!);
    expect(urteil('2026-07-01', pos)).toBe('hold');
    expect(urteil('2026-07-02', pos)).toBe('hold');
    expect(urteil('2026-07-06', pos)).toBe('exit');
  });

  it('DST-Kante: der Wechsel Oktober → November 2026 fällt mit der Zeitumstellung zusammen und trifft trotzdem die richtigen Tage', () => {
    // Sommerzeit endet am Sonntag, 1. November 2026: Der Einstiegstag liegt in
    // EDT (−240), das Fensterende in EST (−300).
    expect(etOffsetMin(barZeit('2026-10-29'))).toBe(-240);
    expect(etOffsetMin(barZeit('2026-11-04'))).toBe(-300);
    expect(urteil('2026-10-29')).toBe('enter'); // vorletzter Handelstag Oktober
    const pos = position(SERIE.c[idxVon('2026-10-30')]!);
    expect(urteil('2026-10-30', pos)).toBe('hold'); // letzter Oktober
    expect(urteil('2026-11-02', pos)).toBe('hold'); // 1. Handelstag November
    expect(urteil('2026-11-03', pos)).toBe('hold'); // 2.
    expect(urteil('2026-11-04', pos)).toBe('exit'); // 3.
  });

  it('Thanksgiving-Monat: Einstieg am Frühschluss-Freitag, Monatsende am Montag', () => {
    expect(urteil('2026-11-27')).toBe('enter');
    expect(urteil('2026-11-25')).toBe('hold');
  });

  it('zwischen den Fenstern hält sie still — kein Einstieg, kein Ausstieg (nur der Broker-Stop wacht)', () => {
    const mitte = ['2026-06-10', '2026-06-11', '2026-06-15', '2026-09-16'];
    const pos = position(SERIE.c[idxVon('2026-06-10')]!);
    for (const d of mitte) {
      expect(urteil(d), `Einstieg an ${d}`).toBe('hold');
      expect(urteil(d, pos), `Ausstieg an ${d}`).toBe('exit'); // außerhalb des Fensters: die Position gehört geschlossen
    }
  });
});

/* ───────────────────────── 4. Sicherheitsnetz, Stop, Vertrag ───────────────────────── */

describe('turn_of_month: Stop, Zeitstopp, Vertrag', () => {
  it('der Stop liegt 4 ATR unter dem Einstand, es gibt kein Ziel und keinen Short', () => {
    const r = decide(ctx('2026-05-28'), [input('2026-05-28')]);
    const e = r.intents[0];
    if (e?.kind !== 'enter') throw new Error('kein Einstieg');
    expect(e.side).toBe('long');
    expect(e.target).toBeNull();
    const i = idxVon('2026-05-28');
    expect(e.stop).toBeCloseTo(SERIE.c[i]! - 4 * IND.atr![i]!, 9);
    expect(e.stop).toBeLessThan(e.refPrice);
  });

  it('der Zeitstopp greift auch INNERHALB des Fensters, wenn eine Position zu lange lebt', () => {
    // 8 Bars ist das Sicherheitsnetz: Ohne es bliebe eine Position nach einer
    // Datenlücke über den Monatswechsel bis in alle Ewigkeit offen.
    expect(urteil('2026-06-01', position(100, 7))).toBe('hold');
    expect(urteil('2026-06-01', position(100, 8))).toBe('exit');
  });

  it('nur Tagesbars, hält über Nacht, kein Querschnitt', () => {
    expect(s.timeframes).toEqual([1440]);
    expect(s.holdsOvernight).toBe(true);
    expect(s.crossScore).toBeUndefined();
    expect(s.warmupBars(params)).toBe(16);
  });

  it('exitTradingDay 1 verkürzt das Fenster auf den ersten Handelstag des neuen Monats', () => {
    const p1 = resolveParams(s, { exitTradingDay: 1 });
    const ind1 = s.precompute(SERIE, p1);
    expect(ind1.imFenster![idxVon('2026-05-29')]).toBe(1); // letzter Handelstag Mai: noch drin
    expect(ind1.imFenster![idxVon('2026-06-01')]).toBe(0); // erster Juni: Ausstiegs-Entscheidung
  });
});

/* ───────────────────────── 5. Durch den echten Simulator ───────────────────────── */

describe('turn_of_month: durch den Simulator', () => {
  it('handelt jeden Monat einmal, hält rund vier Bars und entscheidet nur im Fenster', () => {
    const tage = handelstage('2025-01-02', '2026-09-11');
    const bars = new Map([['SPY', serie(tage, (k) => 100 * (1 + 0.0006 * k) * (1 + (k % 3 === 0 ? 0.003 : -0.002)))]]);
    const res = simulate({
      bars,
      strategyFor: () => ({ strategy: s, params }),
      config: baseConfig({ timeframe: 1440, risk: { maxPositions: 4 } }),
      initialEquity: 100_000,
    });
    // Rund 20 Monate, ein Round-Trip je Monat (der erste fällt in die Aufwärmphase).
    expect(res.trades.length).toBeGreaterThanOrEqual(17);
    expect(res.trades.length).toBeLessThanOrEqual(21);
    for (const t of res.trades) {
      // Einstieg gefüllt am Open des LETZTEN Handelstags des Monats, Ausstieg
      // am Open des vierten Handelstags des Folgemonats.
      expect(fensterLage(dayKey(t.entryTime)).danach, `Einstieg ${dayKey(t.entryTime)}`).toBe(0);
      expect(fensterLage(dayKey(t.exitTime)).davor, `Ausstieg ${dayKey(t.exitTime)}`).toBe(3);
      expect(t.barsHeld).toBeLessThanOrEqual(5);
      expect(t.side).toBe('long');
    }
    // Zwischen den Fenstern steht das Buch leer: Exposure deutlich unter der Hälfte.
    const exponiert = res.equity.filter((p) => (p.exposure ?? 0) > 0).length;
    expect(exponiert / res.equity.length).toBeLessThan(0.35);
  });
});
