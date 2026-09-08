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
    const BARS = 600;
    const fair = BARS / KORB.length;
    const siege = new Map<string, number>();
    for (let b = 100; b < 100 + BARS; b++) for (const s of gewinner(b, 1)) siege.set(s, (siege.get(s) ?? 0) + 1);
    expect([...siege.keys()].sort(), 'jedes Symbol kommt vor').toEqual([...KORB].sort());
    for (const [sym, n] of siege) {
      expect(n, `${sym} gewinnt ${n} von ${BARS} (fair wären ${fair})`).toBeGreaterThan(fair / 2);
      expect(n, `${sym} gewinnt ${n} von ${BARS} (fair wären ${fair})`).toBeLessThan(fair * 2);
    }
  });

  it('bevorzugt nicht mehr den ersten Config-Eintrag (der Fehler, den es zu verhindern gilt)', () => {
    // Vor der Regel gewann AAPL als erster Eintrag JEDE Bar — die Gegenprobe
    // (Regel entfernt) liefert hier 600 von 600.
    const BARS = 600;
    let aapl = 0;
    for (let b = 100; b < 100 + BARS; b++) if (gewinner(b, 1).includes('AAPL')) aapl++;
    expect(aapl, 'AAPL gewinnt nicht jede Bar, nur weil es alphabetisch/konfiguratorisch vorn steht').toBeLessThan(BARS / 3);
    expect(aapl, 'AAPL kommt aber sehr wohl regelmäßig dran').toBeGreaterThan(BARS / 12);
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

  it('ist deterministisch: gleiche Bar, gleiche Reihenfolge; andere Bar, andere Reihenfolge', () => {
    const eins = wettbewerbsOrdnung(KORB.map((s) => input(s, 100, enterLong)), TF).map((i) => i.snap.symbol);
    const zwei = wettbewerbsOrdnung([...KORB].reverse().map((s) => input(s, 100, enterLong)), TF).map((i) => i.snap.symbol);
    expect(zwei).toEqual(eins);
    const drei = wettbewerbsOrdnung(KORB.map((s) => input(s, 101, enterLong)), TF).map((i) => i.snap.symbol);
    expect(drei).not.toEqual(eins);
  });

  /**
   * Der Fund, der die erste Fassung erledigt hat: Mit `start = bucket mod n`
   * rückt der Startpunkt an einer FESTEN Tageszeit täglich um `288 mod n` vor
   * (288 Buckets je Handelstag bei 5 min). Erreichbar sind nur die Vielfachen
   * von ggT(288, n) — bei n = 30 also 5 von 30 Startpunkten, bei n ∈ {12, 16,
   * 18, 24} genau einer, für immer. Signale hängen an der Tageszeit (Eröffnung,
   * Schluss), also ist das keine Spitzfindigkeit.
   */
  it('hat zu fester Tageszeit keine Resonanz — auch bei n mit vielen Teilern von 288', () => {
    const BUCKETS_JE_TAG = 288;
    for (const n of [12, 16, 18, 24, 30]) {
      const korb = Array.from({ length: n }, (_, i) => `S${String(i).padStart(2, '0')}`);
      const ersteJeTag = new Set<string>();
      for (let tag = 0; tag < 200; tag++) {
        const b = 1_000_000 + tag * BUCKETS_JE_TAG; // immer dieselbe Uhrzeit
        ersteJeTag.add(wettbewerbsOrdnung(korb.map((s) => input(s, b, enterLong)), TF)[0]!.snap.symbol);
      }
      expect(ersteJeTag.size, `n=${n}: nur ${ersteJeTag.size} verschiedene Erste an 200 Tagen zur selben Uhrzeit`).toBeGreaterThan(n / 2);
    }
  });

  /**
   * Live enthält der Zyklus nur Symbole mit NEUER geschlossener Bar. Fehlt eine
   * IEX-Bar, ist die Menge kleiner als im Backtest. Hinge die Reihenfolge an der
   * Anzahl, permutierte ein einziges fehlendes Symbol die ganze Prioritätsliste
   * gegenüber der Messung — und zwar systematisch, weil Ausfälle die dünneren
   * Werte treffen.
   */
  it('ändert die relative Reihenfolge nicht, wenn ein Symbol fehlt', () => {
    const voll = wettbewerbsOrdnung(KORB.map((s) => input(s, 100, enterLong)), TF).map((i) => i.snap.symbol);
    for (const fehlt of KORB) {
      const rest = KORB.filter((s) => s !== fehlt);
      const ohne = wettbewerbsOrdnung(rest.map((s) => input(s, 100, enterLong)), TF).map((i) => i.snap.symbol);
      expect(ohne, `ohne ${fehlt}`).toEqual(voll.filter((s) => s !== fehlt));
    }
  });

  /**
   * Live haben die Symbole eines Takts nicht alle dieselbe letzte Bar-Zeit
   * (verspätete IEX-Bars). Maßgeblich ist die JÜNGSTE — sonst hinge der Bucket
   * daran, welches Symbol zufällig zuerst in der Liste steht.
   */
  it('nimmt die jüngste Bar-Zeit, nicht die des ersten Eintrags', () => {
    const gemischt = [input('AAPL', 99, enterLong), input('DIA', 100, enterLong), input('IWM', 99, enterLong)];
    const alleNeu = [input('AAPL', 100, enterLong), input('DIA', 100, enterLong), input('IWM', 100, enterLong)];
    const reihe = (xs: SymbolInput[]) => wettbewerbsOrdnung(xs, TF).map((i) => i.snap.symbol);
    expect(reihe(gemischt)).toEqual(reihe(alleNeu));
    // Gegenprobe: Die Reihenfolge des Aufrufers ändert daran nichts.
    expect(reihe([...gemischt].reverse())).toEqual(reihe(alleNeu));
  });

  it('lässt ein einzelnes Symbol unverändert', () => {
    const eins = wettbewerbsOrdnung([input('AAPL', 100, enterLong)], TF);
    expect(eins.map((i) => i.snap.symbol)).toEqual(['AAPL']);
  });
});
