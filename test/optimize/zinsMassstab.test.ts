/**
 * Die Verkabelung des risikolosen Zinses im Optimierer.
 *
 * Der Messfehler (Befund B2, 12.09.2026): `beats_market` und
 * `probabilistic_sharpe_oos` maßen Ertrag über NULL je Schwankung. Mit einem
 * Geldmarktpapier im Korb — seit dem 12.09. steht BIL im Korb von
 * `vigilant_allocation` — wird damit **Bargeld als Kante verbucht**. Die
 * Rechnung selbst lebt in `src/backtest/metrics.ts` und
 * `src/optimize/robustness.ts`; hier wird geprüft, dass der Optimierer sie
 * richtig ANSCHLIESST. Genau dort kann sie still falsch werden:
 *
 *  1. **Tagesachse.** Eine Zinsreihe wird taggenau auf die OOS-Kette gelegt.
 *     Ohne Achse ist jede Ausrichtung geraten; ein Versatz um EINEN Tag wäre
 *     ein subtilerer Fehler als der behobene und sähe in jeder Kennzahl
 *     plausibel aus.
 *  2. **Beide Seiten oder keine.** Die Latte von `beats_market` muss aus
 *     derselben Rechnung kommen wie der Wert. Die Marktkette liefert dafür
 *     ihre Renditen, nicht nur ihren Sharpe.
 *  3. **Vorgabe inert.** Ohne konfiguriertes Symbol — und ebenso mit einem
 *     Geldmarkt, dessen Satz null ist — muss jede Zahl bleiben, wie sie war.
 *     (Abbruchbedingung 1 der Vorregistrierung 2026-09-13-sharpe-gegen-zins.)
 *  4. **Laut, nie still.** Fehlt die Reihe oder passt sie nicht, steht das im
 *     Bericht und in jeder betroffenen Gate-Notiz.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchSymbols } from '../../src/app.ts';
import { marktKette } from '../../src/backtest/marktbezug.ts';
import { alignRiskFree, excessReturns, riskFreeFromBars, sharpeRatio } from '../../src/backtest/metrics.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { ConfigError, parseConfig } from '../../src/core/config.ts';
import { DAY } from '../../src/core/time.ts';
import type { Bar, BarSeriesLike, Strategy } from '../../src/core/types.ts';
import { marktReihe, runOptimization, type OptimizeRunInput, type StrategyRun } from '../../src/optimize/run.ts';
import { NOISE_PROFILE, REWARD_PROFILE, T0, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

const tag = (i: number, c: number): Bar => ({ t: T0 + i * DAY, o: c, h: c, l: c, c, v: 1_000 });

/** Geldmarkt-Reihe: gleichmäßig steigend um `proTag` — genau der kurze Zins, wie BIL ihn trägt. */
function geldmarkt(n: number, proTag: number): BarSeries {
  let c = 100;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push(tag(i, c));
    c *= 1 + proTag;
  }
  return BarSeries.from(bars);
}

/**
 * Geldmarkt mit TAG FÜR TAG verschiedenem Satz (nie fallend — ein
 * Geldmarktpapier fällt nicht).
 *
 * Warum nicht der gleichmäßige: Ein gleichmäßiger Satz ist gegen einen
 * Versatz um einen Tag blind — verschiebt man ihn, ändert sich keine einzige
 * Zahl. Genau daran wäre der Ausrichtungsfehler (Abbruchbedingung 2 der
 * Vorregistrierung) unentdeckt geblieben; beim absichtlichen Bruch des
 * Wächters ist das aufgefallen.
 */
function geldmarktSchwankend(n: number): BarSeries {
  let c = 100;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push(tag(i, c));
    c *= 1 + (i % 2 === 0 ? 0.0006 : 0.00002);
  }
  return BarSeries.from(bars);
}

const bars = dailyBars(400);
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), noise: fakeStrategy('noise') };
const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, noise: NOISE_PROFILE };
const getStrategy = (id: string): Strategy => {
  const s = strategies[id];
  if (!s) throw new Error(`unbekannte Strategie ${id}`);
  return s;
};
/** Benchmark mit Auf und Ab, damit die Latte rechenbar ist. */
const zickzack = BarSeries.from(Array.from({ length: 400 }, (_, i) => tag(i, 100 + 10 * Math.sin(i / 5))));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'autotrd-zins-'));
  dirs.push(d);
  return d;
};

function lauf(over: { riskFreeSymbol?: string | null; rfBars?: BarSeriesLike; benchmark?: boolean } = {}) {
  const home = tmp();
  const rfSymbol = over.riskFreeSymbol ?? null;
  const input: OptimizeRunInput = {
    config: testConfig({
      symbols: ['AAA'],
      home,
      ...(over.benchmark === false ? {} : { benchmark: 'BENCH' }),
      optimizer: { seed: 7, ...(rfSymbol === null ? {} : { riskFreeSymbol: rfSymbol }) },
    }),
    symbols: ['AAA'],
    strategies: ['edge', 'noise'],
    barsFor: (s) => (s === rfSymbol ? (over.rfBars ?? geldmarkt(400, 0.0002)) : bars),
    ...(over.benchmark === false ? {} : { benchmark: zickzack }),
    home,
    initialEquity: 10_000,
    simulate: makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE),
    metricsFns: fakeMetricsFns,
    getStrategy,
    now: () => NOW,
  };
  return runOptimization(input);
}

const gate = (s: StrategyRun, name: string) => s.gates.find((g) => g.name === name)!;
const werte = (r: { results: StrategyRun[] }) => r.results.map((s) => ({ psr: gate(s, 'probabilistic_sharpe_oos').value, bm: gate(s, 'beats_market').value, latte: gate(s, 'beats_market').threshold }));

/* ───────────────────────── 1. Tagesachse der OOS-Kette ───────────────────────── */

describe('Tagesachse der OOS-Kette', () => {
  it('trägt je Tagesrendite genau einen Tagesschlüssel — sonst ist keine Zinsreihe ausrichtbar', () => {
    const out = lauf();
    for (const s of out.runs[0]!.results) {
      expect(s.wfa.oos.dayKeys!.length).toBe(s.wfa.oos.dailyReturns.length);
      expect(s.wfa.oos.dayKeys!.length).toBeGreaterThan(0);
      // Aufsteigend über die Kette: die Folds sind disjunkt und lückenlos.
      for (let i = 1; i < s.wfa.oos.dayKeys!.length; i++) expect(s.wfa.oos.dayKeys![i]! >= s.wfa.oos.dayKeys![i - 1]!).toBe(true);
    }
  });

  it('eine Zinsreihe lässt sich darauf legen — gleiche Länge, volle Deckung', () => {
    const out = lauf();
    const rf = riskFreeFromBars({ symbol: 'RF', bars: geldmarkt(400, 0.0002), assetClass: 'crypto' })!;
    for (const s of out.runs[0]!.results) {
      const a = alignRiskFree(s.wfa.oos.dayKeys!, rf)!;
      expect(a).not.toBeNull();
      expect(a.rates.length).toBe(s.wfa.oos.dailyReturns.length);
      expect(a.missing).toBe(0);
    }
  });
});

/* ───────────────────────── 2. Die Marktseite ───────────────────────── */

describe('marktReihe', () => {
  const bench = new Map<string, BarSeriesLike>([['BENCH', zickzack]]);
  const ranges = [
    { start: T0 + 10 * DAY, end: T0 + 50 * DAY },
    { start: T0 + 50 * DAY, end: T0 + 90 * DAY },
  ];

  /**
   * DER Wächter der Marktseite: Die unverdichtete Kette muss dieselbe Zahl
   * ergeben wie `marktKette`. Wäre sie es nicht, stünde in `beats_market`
   * eine Latte aus einer anderen Rechnung als der Wert daneben — und genau
   * das ist der Fehler, den die Zinsrechnung vermeiden soll.
   */
  it('ergibt zeichengleich denselben Sharpe wie marktKette', () => {
    const r = marktReihe({ bars: bench, ranges, assetClass: 'crypto' })!;
    const k = marktKette({ bars: bench, ranges, assetClass: 'crypto', periodsPerYear: 365 })!;
    expect(r.dailyReturns.length).toBe(r.dayKeys.length);
    expect(sharpeRatio(r.dailyReturns, 365)).toBeCloseTo(k.sharpe!, 12);
  });

  /**
   * DER Ausrichtungs-Wächter: Der Wert von `beats_market` muss Zeichen für
   * Zeichen der Sharpe DERSELBEN Überschussreihe sein, die man aus
   * `wfa.oos.dayKeys` und der Zinsreihe von Hand baut. Ein Versatz um EINEN
   * Tag — der klassische Fehler beim Ausrichten — fällt hier auf, weil der
   * Satz von Tag zu Tag verschieden ist.
   */
  it('der Wert von beats_market ist der Sharpe der ÜBERSCHUSSreihe, Tag für Tag ausgerichtet', () => {
    const rfBars = geldmarktSchwankend(400);
    const out = lauf({ riskFreeSymbol: 'RF', rfBars });
    const rf = riskFreeFromBars({ symbol: 'RF', bars: rfBars, assetClass: 'crypto' })!;
    for (const s of out.runs[0]!.results) {
      const rates = s.wfa.oos.dayKeys!.map((k) => rf.perDay.get(k) ?? 0);
      const erwartet = fakeMetricsFns.sharpeRatio(excessReturns(s.wfa.oos.dailyReturns, rates), 365);
      expect(erwartet).not.toBeNull();
      expect(gate(s, 'beats_market').value).toBeCloseTo(erwartet!, 12);
      // Gegenprobe: dieselbe Reihe um einen Tag verschoben ergibt eine ANDERE
      // Zahl — der Test prüft also wirklich die Ausrichtung.
      const verschoben = fakeMetricsFns.sharpeRatio(excessReturns(s.wfa.oos.dailyReturns, [0, ...rates.slice(0, -1)]), 365)!;
      expect(Math.abs(verschoben - erwartet!)).toBeGreaterThan(1e-6);
    }
  });

  it('die Latte von beats_market ist der Sharpe der Markt-ÜBERSCHUSSreihe über dieselben Fenster', () => {
    const rfBars = geldmarktSchwankend(400);
    const out = lauf({ riskFreeSymbol: 'RF', rfBars });
    const rf = riskFreeFromBars({ symbol: 'RF', bars: rfBars, assetClass: 'crypto' })!;
    for (const s of out.runs[0]!.results) {
      const m = marktReihe({
        bars: new Map<string, BarSeriesLike>([['BENCH', zickzack]]),
        ranges: s.wfa.folds.map((f) => ({ start: f.fold.oosStart, end: f.fold.oosEnd })),
        assetClass: 'crypto',
      })!;
      const rates = m.dayKeys.map((k) => rf.perDay.get(k) ?? 0);
      const erwartet = fakeMetricsFns.sharpeRatio(excessReturns(m.dailyReturns, rates), 365);
      expect(gate(s, 'beats_market').threshold).toBeCloseTo(erwartet!, 12);
    }
  });

  it('ohne Kurse in den Fenstern: null — die Latte bleibt dann ohne Zins', () => {
    expect(marktReihe({ bars: bench, ranges: [{ start: T0 + 900 * DAY, end: T0 + 950 * DAY }], assetClass: 'crypto' })).toBeNull();
  });

  it('der Lauf reicht sie an die Latte durch', () => {
    const out = lauf({ riskFreeSymbol: 'RF' });
    for (const s of out.runs[0]!.results) {
      // Beide Seiten mit Zins: Die Notiz nennt den Satz und markiert die Latte als Überschuss.
      expect(gate(s, 'beats_market').note).toMatch(/Zins: RF über dieselben Tage \(\d+ von \d+ belegt\)/);
      expect(gate(s, 'beats_market').note).toMatch(/\(Überschuss\)/);
    }
  });
});

/* ───────────────────────── 3. Vorgabe inert ───────────────────────── */

describe('Vorgabe inert (Abbruchbedingung 1)', () => {
  it('ohne riskFreeSymbol rechnen beide Gates wie bisher — und sagen es', () => {
    const out = lauf();
    for (const s of out.runs[0]!.results) {
      expect(gate(s, 'probabilistic_sharpe_oos').note).toMatch(/kein Geldmarkt-Symbol konfiguriert — gegen null gerechnet/);
      expect(gate(s, 'beats_market').note).toMatch(/kein Geldmarkt-Symbol konfiguriert — gegen null gerechnet/);
    }
  });

  /**
   * Der schärfste Inertheits-Beweis, den es gibt: ein Geldmarkt, dessen Satz
   * exakt null ist. r − 0 = r, also MUSS jede Zahl bitgleich der Rechnung
   * ohne Zinsreihe sein. Weicht sie ab, ist die Ausrichtung falsch — und zwar
   * unabhängig davon, wie plausibel die Zahlen aussehen.
   */
  it('ein Geldmarkt mit Satz 0 liefert bitgleich dieselben Gate-Werte wie gar keiner', () => {
    const ohne = werte(lauf().runs[0]!);
    const mitNull = werte(lauf({ riskFreeSymbol: 'RF', rfBars: geldmarkt(400, 0) }).runs[0]!);
    expect(mitNull).toEqual(ohne);
  });

  /**
   * Und die Gegenprobe: Ein POSITIVER Zins muss beide Seiten senken. Sonst
   * wäre die Reihe zwar ausgerichtet, aber wirkungslos — und das Gate
   * verspräche einen Maßstab, den es nicht anlegt.
   */
  it('ein positiver Zins senkt Strategie UND Latte — nie nur eine Seite', () => {
    const ohne = werte(lauf().runs[0]!);
    const mit = werte(lauf({ riskFreeSymbol: 'RF' }).runs[0]!);
    expect(mit.length).toBe(ohne.length);
    for (let i = 0; i < mit.length; i++) {
      expect(mit[i]!.bm!).toBeLessThan(ohne[i]!.bm!);
      expect(mit[i]!.latte!).toBeLessThan(ohne[i]!.latte!);
      expect(mit[i]!.psr!).toBeLessThanOrEqual(ohne[i]!.psr!);
    }
  });
});

/* ───────────────────────── 4. Laut, nie still ───────────────────────── */

describe('Rückfall auf null ist laut', () => {
  it('ein Geldmarkt-Symbol ohne Bars: Fehler im Bericht UND in jeder Notiz', () => {
    const out = lauf({
      riskFreeSymbol: 'RF',
      rfBars: BarSeries.from([]),
    });
    const r = out.runs[0]!;
    expect(r.errors.join(' ')).toMatch(/Zinsreihe RF: weniger als zwei Handelstage/);
    for (const s of r.results) expect(gate(s, 'beats_market').note).toMatch(/gegen null gerechnet/);
    expect(readFileSync(out.reportPath, 'utf8')).toMatch(/Zinsreihe RF: weniger als zwei Handelstage/);
  });

  /**
   * Abbruchbedingung 5 der Vorregistrierung: „Ein Lauf rechnet mit Zins,
   * obwohl die Deckung der Tage unter 98 % liegt." Er darf es nicht — und er
   * darf es auch nicht still lassen.
   */
  it('zu viele Lücken (> 2 % der Tage): kein Zins, und der Grund steht im Bericht', () => {
    // Nur jeder dritte Handelstag hat einen Kurs ⇒ rund zwei Drittel Lücken.
    const luecken = BarSeries.from(Array.from({ length: 400 }, (_, i) => i).filter((i) => i % 3 === 0).map((i) => tag(i, 100 * (1 + 0.0002 * i))));
    const out = lauf({ riskFreeSymbol: 'RF', rfBars: luecken });
    const r = out.runs[0]!;
    expect(r.errors.join(' ')).toMatch(/Zinsreihe RF nicht auf .* ausrichtbar \(Deckung unter 98 % der Tage\)/);
    for (const s of r.results) {
      expect(gate(s, 'probabilistic_sharpe_oos').note).toMatch(/gegen null gerechnet/);
      expect(gate(s, 'beats_market').note).toMatch(/gegen null gerechnet/);
    }
    // Und die Zahlen sind exakt die der Rechnung ohne Zins — kein halber Abzug.
    expect(werte(r)).toEqual(werte(lauf().runs[0]!));
    expect(readFileSync(out.reportPath, 'utf8')).toMatch(/Deckung unter 98 % der Tage/);
  });

  it('der Berichtskopf nennt das Symbol — oder sagt, dass keines konfiguriert ist', () => {
    expect(readFileSync(lauf().reportPath, 'utf8')).toMatch(/Risikoloser Zins: \*\*keiner konfiguriert\*\*/);
    expect(readFileSync(lauf({ riskFreeSymbol: 'RF' }).reportPath, 'utf8')).toMatch(/Risikoloser Zins: Tagesrendite von \*\*RF\*\*/);
  });

  /*
   * Bis zum 13.09.2026 MUSSTE das Zinssymbol im Kandidatenpool stehen, weil
   * `fetch` sonst seine Bars nicht lud. Das machte die Vorgabe der
   * Vorregistrierung „Kasse in den Geldmarkt" unmöglich: Das Parksymbol darf
   * NICHT im Pool stehen (Doppelführung), das Zinssymbol MUSSTE — also konnten
   * beide nie dasselbe Papier sein, und die Differenz ihrer Laufzeit und
   * Kostenquote wäre in die Überschussrendite gelaufen. Seit beide als
   * INFRASTRUKTUR geladen werden (`fetchSymbols`), fällt die Pflicht weg.
   */
  it('das Zinssymbol braucht den Pool nicht mehr — es wird als Infrastruktur geladen', () => {
    const draussen = parseConfig({
      universe: { assetClass: 'us_equity', symbols: ['SPY'], candidates: ['SPY', 'QQQ'] },
      optimizer: { strategies: ['momentum_pullback'], riskFreeSymbol: 'bil' },
    });
    expect(draussen.optimizer.riskFreeSymbol).toBe('BIL');
    expect(fetchSymbols(draussen)).toContain('BIL');
    // Im Pool bleibt es erlaubt: Ein Geldmarktpapier IM Korb, gegen dessen Zins
    // gemessen wird, ist genau der Fall, für den `riskFreeSymbol` gebaut wurde
    // (Befund B2; config/ensemble-1440.yaml hält BIL im defensiven Sleeve).
    const drin = parseConfig({
      universe: { assetClass: 'us_equity', symbols: ['SPY'], candidates: ['SPY', 'BIL'] },
      optimizer: { strategies: ['momentum_pullback'], riskFreeSymbol: 'bil' },
    });
    expect(drin.optimizer.riskFreeSymbol).toBe('BIL');
  });

  it('Park- und Zinssymbol dürfen DASSELBE Papier sein — dann gibt es zwischen ihnen keinen Spread', () => {
    const cfg = parseConfig({
      universe: { assetClass: 'us_equity', symbols: ['SPY'], candidates: ['SPY', 'QQQ'] },
      optimizer: { strategies: ['momentum_pullback'], riskFreeSymbol: 'BIL' },
      risk: { cashParking: { enabled: true, symbol: 'BIL' } },
    });
    expect(cfg.optimizer.riskFreeSymbol).toBe(cfg.risk.cashParking.symbol);
    // EIN Symbol, EINE Bars-Ladung: Der Zins, gegen den gemessen wird, ist
    // exakt die Rendite des Papiers, in dem die Kasse liegt.
    expect(fetchSymbols(cfg).filter((s) => s === 'BIL')).toEqual(['BIL']);
    // Und es ist für keine Strategie erreichbar: weder Universum noch Pool.
    expect(cfg.universe.symbols).not.toContain('BIL');
    expect(cfg.universe.candidates).not.toContain('BIL');
    // Dasselbe Papier IM Pool wäre die Doppelführung — und wird abgewiesen.
    expect(() =>
      parseConfig({
        universe: { assetClass: 'us_equity', symbols: ['SPY'], candidates: ['SPY', 'BIL'] },
        optimizer: { strategies: ['momentum_pullback'], riskFreeSymbol: 'BIL' },
        risk: { cashParking: { enabled: true, symbol: 'BIL' } },
      }),
    ).toThrow(ConfigError);
  });
});
