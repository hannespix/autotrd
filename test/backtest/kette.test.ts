import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, Decision } from '../../src/core/types.ts';
import { durchgehendeKette, foldPlanForBars, simulateWindow, type Fold } from '../../src/optimize/walkForward.ts';
import { testConfig } from '../optimize/fakes.ts';
import { baseConfig, seriesOf, strategyOf } from './helpers.ts';

/**
 * Die durchgehende OOS-Kette mit dem ECHTEN Simulator (Vorregistrierung
 * `docs/wissen/vorregistrierung/2026-09-18-durchgehende-oos-kette.md`, §6):
 *
 * - Eine Strategie, die an jedem Fold-Ende flat ist und deren Buch an jeder
 *   Fold-Grenze wieder bei E₀ steht, liefert Scheiben, die BITGLEICH zu den
 *   Fold-Läufen mit leerem Buch sind — Equity, Trades, Tagesrenditen, Kennzahlen.
 * - Ein Trade, der eine Fold-Grenze überspannt, gehört zur Scheibe seiner
 *   Ausstiegszeit; der Fold-Lauf mit leerem Buch kennt ihn nur als „Offen am
 *   Ende" — genau der Buchgewinn, den Prüfbefund K4 in der alten Kette fand.
 * - Produkt der Scheibenfaktoren = Faktor des ganzen Laufs; Σ Trades der
 *   Scheiben = Trades des Laufs.
 */

const E0 = 100_000;
const cfg = baseConfig({
  timeframe: 1440,
  risk: { riskPerTradePct: 5, maxPositionPct: 100 },
  costs: { slippageBps: 0, spreadBps: 0, secFeeRate: 0, finraTafPerShare: 0, finraTafMax: 0 },
});
const optimizer = testConfig().optimizer;

/** Werktags-Tagesbars ab dem 1.1.2024, Schluss = close(k). */
function tage(n: number, close: (k: number) => number): Bar[] {
  const out: Bar[] = [];
  const d0 = Date.UTC(2024, 0, 1);
  for (let d = 0; out.length < n; d++) {
    const dt = new Date(d0 + d * 86_400_000);
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const c = close(out.length);
    out.push({ t: msFromET(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 9, 30), o: c, h: c, l: c, c, v: 1_000 });
  }
  return out;
}

/**
 * Bar-Indizes, an denen ein Einstieg eine Grenze berühren würde: Entschieden
 * an Bar k, gefüllt am Open von k+1, Exit-Fill am Open von k+2 — liegt eine
 * Grenze in (t_k, t_{k+2}], wäre am Fold-Ende eine Order offen oder eine
 * Position im Buch, und der Fold-Lauf mit leerem Buch sähe etwas anderes.
 */
function tabuVon(bars: readonly Bar[], grenzen: readonly number[]): ReadonlySet<number> {
  const tabu = new Set<number>();
  for (let k = 0; k + 2 < bars.length; k++) {
    for (const g of grenzen) if (bars[k]!.t < g && g <= bars[k + 2]!.t) tabu.add(k);
  }
  return tabu;
}

describe('Durchgehende OOS-Kette mit dem echten Simulator', () => {
  const bars = tage(400, () => 100);
  const series = seriesOf(bars);
  const plan = foldPlanForBars(series, optimizer);
  const folds: Fold[] = plan.folds;
  const grenzen = [...folds.slice(1).map((f) => f.oosStart), folds.at(-1)!.oosEnd];
  const params = { modus: 1 };

  it('hat mehr als zwei Folds, sonst prüft dieser Test nichts', () => {
    expect(folds.length).toBeGreaterThan(2);
  });

  it('WÄCHTER: flat an jedem Fold-Ende und Buch bei E₀ ⇒ die Scheiben sind BITGLEICH zu den Fold-Läufen mit leerem Buch', () => {
    // Alle 5 Bars long für genau eine Bar — Ein- und Ausstieg zum selben Kurs,
    // ohne Kosten: das Buch steht nach jedem Trade wieder exakt bei E₀, also
    // ist die Stückzahl in jedem Fold dieselbe.
    const tabu = tabuVon(bars, grenzen);
    const takt = strategyOf({
      timeframes: [1440],
      decide: (snap): Decision => {
        if (snap.position) return { kind: 'exit', reason: 'eine-bar' };
        if (snap.i % 5 !== 0 || tabu.has(snap.i)) return { kind: 'hold' };
        return { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.5, reason: 'takt' };
      },
    });
    const k = durchgehendeKette({ symbol: 'AAA', strategy: takt, bars: series, config: cfg, initialEquity: E0, simulate, folds: folds.map((fold) => ({ fold, params })) });
    expect(k.scheiben).toHaveLength(folds.length);
    expect(k.gesamt.trades.length).toBeGreaterThan(folds.length * 3);
    let trades = 0;
    for (let i = 0; i < folds.length; i++) {
      const f = folds[i]!;
      const einzeln = simulateWindow({ symbol: 'AAA', strategy: takt, params, bars: series, config: cfg, initialEquity: E0, simulate, range: { start: f.oosStart, end: f.oosEnd } });
      const s = k.scheiben[i]!;
      expect(s.trades.length, `Fold ${i + 1}`).toBeGreaterThan(0);
      expect(s.trades, `Fold ${i + 1} Trades`).toEqual(einzeln.trades);
      expect(s.equity, `Fold ${i + 1} Equity`).toEqual(einzeln.equity);
      expect(s.dailyReturns, `Fold ${i + 1} Renditen`).toEqual(einzeln.dailyReturns);
      expect(s.metrics, `Fold ${i + 1} Kennzahlen`).toEqual(einzeln.metrics);
      expect(s.finalEquity).toBe(E0);
      expect(einzeln.offenAmEnde).toEqual([]);
      trades += s.trades.length;
    }
    expect(trades).toBe(k.gesamt.trades.length);
    expect(k.scheiben.flatMap((s) => s.trades)).toEqual(k.gesamt.trades);
    expect(k.gesamt.offenAmEnde).toEqual([]);
  });

  it('WÄCHTER: ein Trade über die Fold-Grenze gehört zur Scheibe seiner Ausstiegszeit — der Fold-Lauf kennt ihn nur als „Offen am Ende" (K4)', () => {
    const steigend = tage(400, (k) => 100 + 0.1 * k);
    const serieS = seriesOf(steigend);
    const planS = foldPlanForBars(serieS, optimizer);
    const f0 = planS.folds[0]!;
    const f1 = planS.folds[1]!;
    const i0 = steigend.findIndex((b) => b.t >= f0.oosStart);
    const j = steigend.findIndex((b) => b.t >= f1.oosStart) - 1; // letzte Bar von Fold 1
    expect(i0).toBeGreaterThan(0);
    expect(j - i0).toBeGreaterThan(8);
    // Trade 1 ganz in Fold 1 (Einstieg i0 ⇒ Fill i0+1, Exit i0+3 ⇒ Fill i0+4);
    // Trade 2 überspannt die Grenze (Einstieg j−1 ⇒ Fill j, Exit j+1 ⇒ Fill j+2).
    const einmal = strategyOf({
      timeframes: [1440],
      decide: (snap): Decision => {
        if (snap.position) return snap.i === i0 + 3 || snap.i === j + 1 ? { kind: 'exit', reason: 'plan' } : { kind: 'hold' };
        if (snap.i === i0 || snap.i === j - 1) return { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.5, reason: 'plan' };
        return { kind: 'hold' };
      },
    });
    const k = durchgehendeKette({ symbol: 'AAA', strategy: einmal, bars: serieS, config: cfg, initialEquity: E0, simulate, folds: planS.folds.map((fold) => ({ fold, params })) });
    expect(k.gesamt.trades.map((t) => [t.entryTime, t.exitTime])).toEqual([
      [steigend[i0 + 1]!.t, steigend[i0 + 4]!.t],
      [steigend[j]!.t, steigend[j + 2]!.t],
    ]);
    expect(k.gesamt.offenAmEnde).toEqual([]);
    const [s0, s1] = [k.scheiben[0]!, k.scheiben[1]!];
    // Scheibe 1 = Fold-Lauf 1: gleiche Equity (die offene Position ist in beiden zum Schluss bewertet), gleicher Trade 1 —
    // aber der Fold-Lauf hat die Position am Ende offen, die Scheibe nicht: sie läuft weiter.
    const einzeln0 = simulateWindow({ symbol: 'AAA', strategy: einmal, params, bars: serieS, config: cfg, initialEquity: E0, simulate, range: { start: f0.oosStart, end: f0.oosEnd } });
    expect(s0.equity).toEqual(einzeln0.equity);
    expect(s0.dailyReturns).toEqual(einzeln0.dailyReturns);
    expect(s0.trades).toEqual(einzeln0.trades);
    expect(s0.trades).toEqual([k.gesamt.trades[0]]);
    expect(einzeln0.offenAmEnde).toHaveLength(1);
    expect(s0.offenAmEnde).toEqual([]);
    // Der überspannende Trade steht in Scheibe 2 — im Fold-Lauf 2 mit leerem Buch gibt es ihn nicht.
    expect(s1.trades).toHaveLength(1);
    expect([s1.trades[0]!.entryTime, s1.trades[0]!.exitTime]).toEqual([k.gesamt.trades[1]!.entryTime, k.gesamt.trades[1]!.exitTime]);
    // Betrag mit E₀/E_Start der zweiten Scheibe skaliert (Nachtrag G5): E_Start = Endstand der ersten (Faktor 1 dort).
    expect(s1.trades[0]!.netPnl).toBeCloseTo((k.gesamt.trades[1]!.netPnl * E0) / s0.finalEquity, 9);
    expect(s0.finalEquity).not.toBeCloseTo(E0, 3);
    const einzeln1 = simulateWindow({ symbol: 'AAA', strategy: einmal, params, bars: serieS, config: cfg, initialEquity: E0, simulate, range: { start: f1.oosStart, end: f1.oosEnd } });
    expect(einzeln1.trades).toEqual([]);
    // Danach flat: keine Trades, Rendite 0, jede Scheibe bei E₀.
    for (const s of k.scheiben.slice(2)) {
      expect(s.trades).toEqual([]);
      for (const r of s.dailyReturns) expect(r).toBe(0);
      expect(s.metrics.netProfit).toBeCloseTo(0, 6);
      for (const p of s.equity) expect(p.equity).toBeCloseTo(E0, 6);
    }
    // Produkt der Scheibenfaktoren = Faktor des Laufs; das Ergebnis des Laufs ist die Summe der beiden Trades (ohne Kosten, am Ende flat).
    const produkt = k.scheiben.reduce((p, s) => p * (s.finalEquity / E0), 1);
    expect(produkt).toBeCloseTo(k.gesamt.finalEquity / E0, 12);
    expect(k.gesamt.finalEquity - E0).toBeCloseTo(k.gesamt.trades[0]!.netPnl + k.gesamt.trades[1]!.netPnl, 9);
    expect(k.gesamt.trades[0]!.netPnl).toBeGreaterThan(0);
  });

  it('am Kettenende offene Positionen hängen an der letzten Scheibe — die anderen Scheiben tragen []', () => {
    const halten = strategyOf({
      timeframes: [1440],
      decide: (snap): Decision => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.5, reason: 'halten' }),
    });
    const k = durchgehendeKette({ symbol: 'AAA', strategy: halten, bars: series, config: cfg, initialEquity: E0, simulate, folds: folds.map((fold) => ({ fold, params })) });
    expect(k.gesamt.trades).toEqual([]);
    expect(k.gesamt.offenAmEnde).toHaveLength(1);
    expect(k.scheiben.map((s) => s.offenAmEnde)).toEqual([...folds.slice(1).map(() => []), k.gesamt.offenAmEnde]);
  });
});
