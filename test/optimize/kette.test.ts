import { describe, expect, it } from 'vitest';
import { DAY } from '../../src/core/time.ts';
import type { Metrics, SimResult, Trade } from '../../src/core/types.ts';
import { OHNE_BREMSEN } from '../../src/core/types.ts';
import { ueberschussKette } from '../../src/optimize/robustness.ts';
import { durchgehendeKette, foldPlanForBars, kettenScheiben, simulateWindow, walkForward, type Fold, type OosChain } from '../../src/optimize/walkForward.ts';
import { REWARD_PROFILE, T0, dailyBars, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig } from './fakes.ts';

/**
 * Die OOS-Kette als EINE Simulation (Vorregistrierung
 * `docs/wissen/vorregistrierung/2026-09-18-durchgehende-oos-kette.md`, §6).
 *
 * Bis #21 war jeder Fold ein eigener Lauf mit leerem Buch; offene Positionen
 * am Fold-Ende zählten zum Schluss bewertet als Ergebnis, ohne je ein Trade
 * zu werden (Prüfbefund K4: ≈ 2 600 $ von 3 388 $ Überschuss der csm-Kette).
 * Seit dem 18.09.2026 ist die Kette ein Lauf, an den Fold-Grenzen wechseln
 * Parameter und Korb; das Ergebnis wird in Fold-Scheiben geschnitten und je
 * Scheibe auf E₀ normiert. Der Fake hier hat je Trade ein Ergebnis
 * proportional zur Equity und ist an jedem Fold-Ende flat — für ihn müssen
 * die normierten Scheiben die Fold-Läufe reproduzieren. Die Wächter mit dem
 * ECHTEN Simulator stehen in test/backtest/kette.test.ts.
 */

const bars = dailyBars(400);
const cfg = testConfig();
const strategy = fakeStrategy('edge');
const E0 = 10_000;
const plan = foldPlanForBars(bars, cfg.optimizer);

function lauf(oosChain: OosChain) {
  const simulate = makeFakeSimulate(REWARD_PROFILE);
  const wfa = walkForward({ symbol: 'AAA', strategy, bars, config: simConfigOf(cfg), optimizer: { ...cfg.optimizer, seed: 1, oosChain }, initialEquity: E0, simulate });
  return { wfa, simulate };
}

const leereMetrik: Metrics = { netProfit: 0, netReturnPct: 0, cagrPct: null, sharpe: null, sortino: null, maxDrawdownPct: 0, profitFactor: null, winRatePct: null, expectancy: null, avgR: null, trades: 0, exposurePct: 0, feeShare: null, days: 0 };

function trade(exitTime: number, netPnl = 1): Trade {
  return { symbol: 'AAA', side: 'long', qty: 1, entryTime: exitTime - DAY, entryPrice: 100, exitTime, exitPrice: 100 + netPnl, grossPnl: netPnl, fees: 0, netPnl, rMultiple: null, exitReason: 'signal', strategy: 'edge', barsHeld: 1, mae: null, mfe: null };
}

describe('Die OOS-Kette als EINE Simulation (Vorregistrierung 2026-09-18, §6)', () => {
  const kette = lauf('continuous').wfa;
  const jeFold = lauf('per_fold').wfa;

  it('die IS-Suche ist unberührt: dieselben Fold-Besten, dieselben Trials, dieselben Lieferparameter', () => {
    expect(kette.folds.map((f) => f.best.params)).toEqual(jeFold.folds.map((f) => f.best.params));
    expect(kette.folds.map((f) => f.best.isMetrics)).toEqual(jeFold.folds.map((f) => f.best.isMetrics));
    expect(kette.finalParams).toEqual(jeFold.finalParams);
    expect(kette.trials).toBe(jeFold.trials);
    expect(kette.finalTrialSharpes).toEqual(jeFold.finalTrialSharpes);
  });

  it('WÄCHTER: die auf E₀ normierten Scheiben SIND die Fold-Läufe — Fake mit Ergebnis proportional zur Equity, an jedem Fold-Ende flat', () => {
    expect(kette.kette.modus).toBe('continuous');
    expect(kette.kette.scheiben).toHaveLength(plan.folds.length);
    expect(kette.kette.gesamt).toBeDefined();
    expect(jeFold.kette).toEqual({ modus: 'per_fold' });
    for (let i = 0; i < plan.folds.length; i++) {
      const a = kette.folds[i]!.best;
      const b = jeFold.folds[i]!.best;
      expect(a.oosTrades.length, `Fold ${i + 1}`).toBe(b.oosTrades.length);
      expect(a.oosDailyReturns.length, `Fold ${i + 1}`).toBe(b.oosDailyReturns.length);
      a.oosDailyReturns.forEach((r, k) => expect(r, `Fold ${i + 1} Tag ${k}`).toBeCloseTo(b.oosDailyReturns[k]!, 12));
      expect(a.oosMetrics.netReturnPct, `Fold ${i + 1}`).toBeCloseTo(b.oosMetrics.netReturnPct, 9);
      expect(a.oosMetrics.netProfit, `Fold ${i + 1}`).toBeCloseTo(b.oosMetrics.netProfit, 6);
      expect(a.oosMetrics.maxDrawdownPct, `Fold ${i + 1}`).toBeCloseTo(b.oosMetrics.maxDrawdownPct, 9);
      expect(a.oosMetrics.trades, `Fold ${i + 1}`).toBe(b.oosMetrics.trades);
      expect(a.oosObjective, `Fold ${i + 1}`).toBeCloseTo(b.oosObjective, 9);
    }
    // Beträge je Scheibe auf E₀ (Nachtrag G5): Ab dem zweiten Fold ist die
    // Equity des einen Buchs eine andere als E₀ — skaliert sind die Trades der
    // Scheibe wieder die des Fold-Laufs (der Fake ist proportional zur Equity).
    expect(kette.folds[1]!.best.oosTrades[0]!.netPnl).toBeCloseTo(jeFold.folds[1]!.best.oosTrades[0]!.netPnl, 6);
    expect(kette.kette.gesamt!.trades.find((t) => t.exitTime === kette.folds[1]!.best.oosTrades[0]!.exitTime)!.netPnl).not.toBeCloseTo(jeFold.folds[1]!.best.oosTrades[0]!.netPnl, 3);
    expect(kette.oos.netReturnPct).toBeCloseTo(jeFold.oos.netReturnPct, 9);
    expect(kette.oos.trades).toBe(jeFold.oos.trades);
    expect(kette.oos.objectiveMedian).toBeCloseTo(jeFold.oos.objectiveMedian, 9);
    expect(kette.oos.maxDrawdownPct).toBeCloseTo(jeFold.oos.maxDrawdownPct, 9);
  });

  it('WÄCHTER: Produkt der Scheibenfaktoren = Faktor der ganzen Kette; Trades, Tagesrenditen und Punkte der Scheiben = die der Kette', () => {
    const g = kette.kette.gesamt!;
    const scheiben = kette.kette.scheiben!;
    const produkt = scheiben.reduce((s, x) => s * (x.finalEquity / E0), 1);
    expect(produkt).toBeCloseTo(g.finalEquity / E0, 9);
    expect(kette.oos.netReturnPct).toBeCloseTo((g.finalEquity / E0 - 1) * 100, 9);
    // Trades der Scheiben = Trades der Kette — dieselben Round-Trips in derselben
    // Reihenfolge, die Beträge je Scheibe mit E₀/E_Start skaliert (Nachtrag G5).
    const flach = scheiben.flatMap((s) => s.trades);
    expect(flach.length).toBe(g.trades.length);
    let faktor = 1; // Π der Scheibenfaktoren vor der Scheibe = E_Start/E₀
    let j = 0;
    for (const s of scheiben) {
      const scale = 1 / faktor;
      for (const t of s.trades) {
        const orig = g.trades[j++]!;
        expect([t.symbol, t.entryTime, t.exitTime, t.qty]).toEqual([orig.symbol, orig.entryTime, orig.exitTime, orig.qty]);
        expect(t.netPnl).toBeCloseTo(orig.netPnl * scale, 9);
        expect(t.grossPnl).toBeCloseTo(orig.grossPnl * scale, 9);
        expect(t.fees).toBeCloseTo(orig.fees * scale, 9);
      }
      faktor *= s.finalEquity / E0;
    }
    expect(j).toBe(g.trades.length);
    expect(scheiben.flatMap((s) => s.dailyReturns)).toEqual(g.dailyReturns);
    expect(kette.oos.dailyReturns).toEqual(g.dailyReturns);
    expect(scheiben.reduce((n, s) => n + s.equity.length, 0)).toBe(g.equity.length);
    // Jede Scheibe beginnt bei E₀: der erste Punkt ist E₀ × (1 + erste Rendite der Scheibe).
    for (const s of scheiben) expect(s.equity[0]!.equity).toBeCloseTo(E0 * (1 + s.dailyReturns[0]!), 6);
  });

  it('WÄCHTER (Nachtrag G5): Σ netPnl der skalierten Trades einer Scheibe = Netto der Scheibe — Fold-Netto und Trades sind EINE Rechnung ab E₀', () => {
    // Der Fake verändert die Equity nur durch Trades: ohne Skalierung stünde
    // ab der zweiten Scheibe eine Summe in Dollar des gewachsenen Buchs neben
    // einem Netto ab E₀ — das ist die Equity-Gewichtung, die `fee_share`
    // pfadabhängig machte (Prüfbefund G5).
    for (const s of kette.kette.scheiben!) {
      const summe = s.trades.reduce((x, t) => x + t.netPnl, 0);
      expect(summe).toBeCloseTo(s.metrics.netProfit, 6);
    }
    // Und die zweite Scheibe ist wirklich skaliert (die Kette hat vorher gewonnen).
    const zweite = kette.kette.scheiben![1]!;
    const roh = kette.kette.gesamt!.trades.filter((t) => t.exitTime >= plan.folds[1]!.oosStart && t.exitTime < plan.folds[1]!.oosEnd);
    expect(roh.reduce((x, t) => x + t.netPnl, 0)).not.toBeCloseTo(zweite.metrics.netProfit, 3);
  });

  it('Schalter per_fold: jeder Fold ein eigener Lauf mit leerem Buch — bitgleich zu simulateWindow (der Weg bis 18.09.2026)', () => {
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    for (const f of jeFold.folds) {
      const r = simulateWindow({ symbol: 'AAA', strategy, params: f.best.params, bars, config: simConfigOf(cfg), initialEquity: E0, simulate, range: { start: f.fold.oosStart, end: f.fold.oosEnd } });
      expect(f.best.oosMetrics).toEqual(r.metrics);
      expect(f.best.oosTrades).toEqual(r.trades);
      expect(f.best.oosDailyReturns).toEqual(r.dailyReturns);
    }
    // Snapshot des per_fold-Pfads (Stand 18.09.2026, Fake mit Seed 1): 240
    // Trades, Netto, MaxDD, Objective-Median — wer den Pfad anfasst, sieht es.
    expect(jeFold.oos.trades).toBe(240);
    expect(jeFold.oos.netProfit).toBeCloseTo(64560.3528, 3);
    expect(jeFold.oos.maxDrawdownPct).toBeCloseTo(2.42595870, 6);
    expect(jeFold.oos.objectiveMedian).toBeCloseTo(214.68391, 4);
  });

  it('Gates: ueberschussKette nimmt die normierten Scheiben ohne Fehler — aufgezinst = Netto je Fold', () => {
    const mitZins = ueberschussKette({ wfa: kette, riskFree: kette.oos.dailyReturns.map(() => 0.0001), initialEquity: E0 });
    expect(mitZins).not.toHaveProperty('fehler');
    if ('fehler' in mitZins) return;
    expect(mitZins.folds).toHaveLength(plan.folds.length);
    mitZins.folds.forEach((x, i) => expect(x).toBeLessThan(kette.folds[i]!.best.oosMetrics.netProfit));
    const ohneZins = ueberschussKette({ wfa: kette, riskFree: kette.oos.dailyReturns.map(() => 0), initialEquity: E0 });
    if ('fehler' in ohneZins) throw new Error(ohneZins.fehler);
    ohneZins.folds.forEach((x, i) => expect(x).toBeCloseTo(kette.folds[i]!.best.oosMetrics.netProfit, 6));
  });

  it('Korb je Fold IN der Kette: ein Symbol vor seinem Eintritt bekommt `params: null` und handelt nicht; eines, das den Korb verlässt, hört auf', () => {
    const korb = new Map([
      ['AAA', bars],
      ['BBB', bars],
      ['CCC', bars],
    ]);
    const ab5 = plan.folds[4]!.oosStart;
    const membership = (at: number) => new Set(at >= ab5 ? ['AAA', 'BBB'] : ['AAA', 'CCC']);
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const params = { a: 10, b: 0 };
    const k = durchgehendeKette({ symbol: 'korb', strategy, bars: korb, config: simConfigOf(cfg), initialEquity: E0, simulate, membership, folds: plan.folds.map((fold) => ({ fold, params })) });
    // EIN Aufruf des Simulators, je Symbol der Vereinigung eine Wahl mit Fahrplan.
    expect(simulate.calls.map((c) => c.symbol).sort()).toEqual(['AAA', 'BBB', 'CCC']);
    const call = (s: string) => simulate.calls.find((c) => c.symbol === s)!;
    for (const c of simulate.calls) {
      expect(c.range).toEqual({ start: plan.folds[0]!.oosStart, end: plan.folds.at(-1)!.oosEnd });
      expect(c.wechsel!.map((w) => w.ab)).toEqual(plan.folds.map((f) => f.oosStart));
    }
    expect(call('AAA').wechsel!.every((w) => w.params !== null)).toBe(true);
    expect(call('BBB').wechsel!.map((w) => w.params !== null)).toEqual(plan.folds.map((f) => f.oosStart >= ab5));
    expect(call('CCC').wechsel!.map((w) => w.params !== null)).toEqual(plan.folds.map((f) => f.oosStart < ab5));
    k.scheiben.forEach((s, i) => {
      const syms = new Set(s.trades.map((t) => t.symbol));
      expect(syms.has('AAA'), `Fold ${i + 1} AAA`).toBe(true);
      expect(syms.has('BBB'), `Fold ${i + 1} BBB`).toBe(i >= 4);
      expect(syms.has('CCC'), `Fold ${i + 1} CCC`).toBe(i < 4);
    });
  });
});

describe('kettenScheiben: der eine Lauf in Fold-Scheiben', () => {
  const folds: Fold[] = [0, 1, 2].map((i) => ({ index: i, isStart: 0, isEnd: 0, oosStart: T0 + (10 + 30 * i) * DAY, oosEnd: T0 + (40 + 30 * i) * DAY }));
  /** 100 Tagespunkte, Equity linear steigend; Tagesrenditen dazu passend. */
  function laufVon(over: Partial<SimResult> = {}): SimResult {
    const equity = Array.from({ length: 100 }, (_, d) => ({ t: T0 + d * DAY, equity: E0 * (1 + 0.001 * d) }));
    const dailyReturns = equity.map((p, d) => (d === 0 ? p.equity / E0 - 1 : p.equity / equity[d - 1]!.equity - 1));
    return { trades: [], equity, dailyReturns, metrics: leereMetrik, finalEquity: equity[99]!.equity, notes: [], bremsen: OHNE_BREMSEN, ...over };
  }

  it('WÄCHTER: erschöpfende Zuordnung — vor dem ersten Fold ⇒ erste Scheibe, ab dem OOS-Beginn ⇒ dieser Fold, nach dem letzten Ende ⇒ letzte Scheibe; Trades nach der Ausstiegszeit', () => {
    const trades = [trade(T0 + 5 * DAY), trade(folds[1]!.oosStart), trade(folds[1]!.oosStart - 1), trade(T0 + 95 * DAY)];
    const s = kettenScheiben(laufVon({ trades }), folds, E0, 'crypto');
    expect(s).toHaveLength(3);
    expect(s[0]!.trades).toEqual([trades[0], trades[2]]);
    // Ab der zweiten Scheibe sind die Beträge mit E₀/E_Start skaliert (Tag 39: 1,039; Tag 69: 1,069).
    expect(s[1]!.trades.map((t) => t.exitTime)).toEqual([trades[1]!.exitTime]);
    expect(s[1]!.trades[0]!.netPnl).toBeCloseTo(1 / 1.039, 9);
    expect(s[2]!.trades.map((t) => t.exitTime)).toEqual([trades[3]!.exitTime]);
    expect(s[2]!.trades[0]!.netPnl).toBeCloseTo(1 / 1.069, 9);
    expect(s.reduce((n, x) => n + x.equity.length, 0)).toBe(100);
    expect(s.flatMap((x) => x.dailyReturns)).toEqual(laufVon().dailyReturns);
    expect(s[0]!.equity.length).toBe(40); // Tage 0–39: 10 vor dem Fold gehören zur ersten Scheibe
    expect(s[2]!.equity.length).toBe(30); // Tage 70–99: 5 nach dem Fold-Ende zur letzten
    // Produkt der Faktoren = Faktor des Laufs
    const produkt = s.reduce((p, x) => p * (x.finalEquity / E0), 1);
    expect(produkt).toBeCloseTo(laufVon().finalEquity / E0, 12);
    // Normierung: die zweite Scheibe beginnt bei E₀ (× ihrer ersten Tagesrendite)
    expect(s[1]!.equity[0]!.equity).toBeCloseTo(E0 * (1 + s[1]!.dailyReturns[0]!), 9);
    expect(s[1]!.metrics.netProfit).toBeCloseTo(E0 * (1.069 / 1.039 - 1), 6);
  });

  it('WÄCHTER: offenAmEnde nur, wenn der Lauf sie kennt — bekannt: letzte Scheibe trägt sie, die anderen []; unbekannt bleibt in jeder Scheibe unbekannt (K4: nie eine stille Null)', () => {
    const offen = [{ symbol: 'AAA', side: 'long' as const, qty: 1, entryPrice: 100, lastClose: 110, unrealisiert: 10 }];
    const bekannt = kettenScheiben(laufVon({ offenAmEnde: offen }), folds, E0, 'crypto');
    expect(bekannt.slice(0, 2).map((x) => x.offenAmEnde)).toEqual([[], []]);
    expect(bekannt[2]!.offenAmEnde).toHaveLength(1);
    expect(bekannt[2]!.offenAmEnde![0]!.symbol).toBe('AAA');
    // unrealisiert trägt den Faktor der letzten Scheibe (E₀/E_Start = 1/1,069)
    expect(bekannt[2]!.offenAmEnde![0]!.unrealisiert).toBeCloseTo(10 / 1.069, 9);
    const unbekannt = kettenScheiben(laufVon(), folds, E0, 'crypto');
    for (const x of unbekannt) expect(x).not.toHaveProperty('offenAmEnde');
  });

  it('wirft, wenn Tagesrenditen und Handelstage der Kurve nicht zusammenpassen — statt Renditen still zu verschieben', () => {
    const l = laufVon();
    expect(() => kettenScheiben({ ...l, dailyReturns: l.dailyReturns.slice(1) }, folds, E0, 'crypto')).toThrow(/Tagesrenditen/);
  });
});
