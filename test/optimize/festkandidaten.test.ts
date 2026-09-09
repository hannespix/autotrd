/**
 * Festkandidaten (`optimizer.fixedCandidates`): vorregistrierte Parametersätze
 * ohne Suche, die durch DIESELBEN Folds, denselben Korb je Fold, denselben
 * Holdout und dieselben Gates laufen wie die gesuchten Strategien — und in
 * derselben Liste um die Beförderung konkurrieren.
 *
 * Was diese Tests festhalten:
 *  1. Schema: Vorgabe leer, `params` leer erlaubt, `label` optional.
 *  2. Ein Festkandidat wird bewertet (alle Folds, Holdout), taucht mit
 *     `fixed: true` und einem Trial auf und kann befördert werden — der
 *     Champion-Eintrag trägt `fixed: true`.
 *  3. Ungültige Parameter sind ein Fehler-Eintrag der Einheit, kein Absturz;
 *     die anderen Kandidaten laufen weiter.
 *  4. WÄCHTER: kein Sonderweg. Mit denselben Fake-Ergebnissen fällt der
 *     Festkandidat durch dieselben Gates wie der gesuchte Kandidat, mit der
 *     VOLLEN Trade-Schwelle (nicht der anteiligen des Amtsinhabers). Nur der
 *     DSR ist „nicht anwendbar" — laut, wie beim Amtsinhaber.
 *  5. Der Korb je Fold gilt für ihn wie für jeden anderen (Lookahead-Wächter).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig, type Config, type FixedCandidateConfig } from '../../src/core/config.ts';
import { homePaths } from '../../src/core/journal.ts';
import { DAY } from '../../src/core/time.ts';
import type { Bar, Strategy } from '../../src/core/types.ts';
import { loadChampion } from '../../src/optimize/promote.ts';
import { festLabel, festParams, nichtsGemessen, runOptimization, type OptimizeRunInput, type StrategyRun } from '../../src/optimize/run.ts';
import { foldPlanForBars } from '../../src/optimize/walkForward.ts';
import { NOISE_PROFILE, REWARD_PROFILE, T0, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

const bars = dailyBars(400);
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

/**
 * Verliert unabhängig von den Parametern, mit GEMEINSAMEM Rauschen: Gesucht
 * und fest sehen Fold für Fold exakt dieselben Zahlen — die Voraussetzung,
 * um „dieselben Gates" wörtlich zu prüfen.
 */
const DEAD_TIME_PROFILE: FakeSimOptions = { edge: () => -0.004, noise: 0.03, noiseKey: 'time', costPerTrade: 0.001 };

const strategies: Record<string, Strategy> = {
  edge: fakeStrategy('edge'),
  noise: fakeStrategy('noise'),
  dead: fakeStrategy('dead'),
  intraday: fakeStrategy('intraday', { timeframes: [5] }),
};
const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, noise: NOISE_PROFILE, dead: DEAD_TIME_PROFILE, intraday: REWARD_PROFILE };
const getStrategy = (id: string): Strategy => {
  const s = strategies[id];
  if (!s) throw new Error(`unbekannte Strategie ${id}`);
  return s;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'autotrd-fest-'));
  dirs.push(d);
  return d;
};

function input(
  home: string,
  over: Partial<OptimizeRunInput> & { fixed?: FixedCandidateConfig[]; symbols?: string[]; strategies?: string[]; optimizer?: Partial<Config['optimizer']> } = {},
): OptimizeRunInput {
  const symbols = over.symbols ?? ['AAA'];
  const { fixed, optimizer, ...rest } = over;
  const cfg = testConfig({ symbols, home, optimizer: { seed: 7, fixedCandidates: fixed ?? [], ...optimizer } });
  return {
    config: cfg,
    symbols,
    strategies: over.strategies ?? ['edge'],
    barsFor: () => bars,
    home,
    initialEquity: 10_000,
    simulate: makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE),
    metricsFns: fakeMetricsFns,
    getStrategy,
    now: () => NOW,
    ...rest,
  };
}

const failed = (s: StrategyRun) => s.gates.filter((g) => !g.pass).map((g) => g.name);
const gate = (s: StrategyRun, name: string) => {
  const g = s.gates.find((x) => x.name === name);
  if (!g) throw new Error(`Gate ${name} fehlt`);
  return g;
};

describe('Config: optimizer.fixedCandidates', () => {
  it('Vorgabe ist leer; params dürfen fehlen (= Defaults); label ist optional', () => {
    expect(testConfig().optimizer.fixedCandidates).toEqual([]);
    const cfg = parseConfig({
      universe: { symbols: ['AAA'] },
      optimizer: { fixedCandidates: [{ strategy: 'edge' }, { strategy: 'edge', params: { a: 3 }, label: 'Drei' }] },
    });
    expect(cfg.optimizer.fixedCandidates).toEqual([
      { strategy: 'edge', params: {} },
      { strategy: 'edge', params: { a: 3 }, label: 'Drei' },
    ]);
  });

  it('strategy ist Pflicht, params sind Zahlen, label nicht leer', () => {
    const mit = (fixedCandidates: unknown) => () => parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { fixedCandidates } });
    expect(mit([{ strategy: '' }])).toThrow(/fixedCandidates/);
    expect(mit([{ params: { a: 1 } }])).toThrow(/strategy/);
    expect(mit([{ strategy: 'edge', params: { a: 'x' } }])).toThrow(/params/);
    expect(mit([{ strategy: 'edge', label: '' }])).toThrow(/label/);
  });

  it('festLabel: label der Config, sonst die registrierten Parameter, ohne Parameter „Defaults"', () => {
    expect(festLabel({ strategy: 'edge', params: { a: 1 }, label: 'Eins' })).toBe('Eins');
    expect(festLabel({ strategy: 'edge', params: { a: 1, b: 2 } })).toBe('{"a":1,"b":2}');
    expect(festLabel({ strategy: 'edge', params: {} })).toBe('Defaults');
  });
});

describe('festParams: Defaults ← registrierte Werte, geprüft wie strategy.params der Config', () => {
  const edge = strategies.edge!;

  it('füllt fehlende Parameter aus den Defaults und lässt gültige Werte durch', () => {
    expect(festParams({ strategy: edge, params: { a: 10 }, allowShort: false })).toEqual({ a: 10, b: 2 });
    expect(festParams({ strategy: edge, params: {}, allowShort: false })).toEqual(edge.defaults);
  });

  it('wirft bei Werten außerhalb des Raums, neben dem Gitter und bei fremden Schlüsseln', () => {
    expect(() => festParams({ strategy: edge, params: { a: 99 }, allowShort: false })).toThrow(/außerhalb/);
    expect(() => festParams({ strategy: edge, params: { a: 2.5 }, allowShort: false })).toThrow(/ganzzahlig/);
    expect(() => festParams({ strategy: edge, params: { zz: 1 }, allowShort: false })).toThrow(/kein Parameter dieser Strategie/);
  });

  it('bei gesperrtem Short ist allowShort keine Achse: auf 0 genagelt, mit Hinweis (§5a.15)', () => {
    const mitShort = fakeStrategy('short', {
      space: [...edge.paramSpace, { name: 'allowShort', min: 0, max: 1, step: 1, kind: 'int' }],
      defaults: { ...edge.defaults, allowShort: 0 },
    });
    const logs: string[] = [];
    expect(festParams({ strategy: mitShort, params: { allowShort: 1 }, allowShort: false, log: (m) => logs.push(m) }).allowShort).toBe(0);
    expect(logs.some((m) => /allowShort=1 registriert.*genagelt/.test(m))).toBe(true);
    // Mit erlaubtem Short ist die Achse echt und der registrierte Wert bleibt.
    expect(festParams({ strategy: mitShort, params: { allowShort: 1 }, allowShort: true }).allowShort).toBe(1);
  });
});

describe('Festkandidat im Lauf', () => {
  it('wird über alle Folds und den Holdout bewertet, trägt fixed: true und einen Trial, läuft durch alle Gates und wird befördert', () => {
    const home = tmp();
    const logs: string[] = [];
    const out = runOptimization(input(home, { strategies: ['noise'], fixed: [{ strategy: 'edge', params: { a: 10, b: 2 }, label: 'Zehn' }], log: (m) => logs.push(m) }));
    const r = out.runs[0]!;
    expect(r.errors).toEqual([]);
    expect(r.results.map((s) => [s.strategyId, s.fixed, s.label])).toEqual([
      ['edge', true, 'Zehn'],
      ['noise', false, null],
    ]);
    const fest = r.results[0]!;
    const gesucht = r.results[1]!;
    const plan = foldPlanForBars(bars, testConfig().optimizer);
    // ALLE Folds des Plans — es gibt kein Fit-Ende, die Parameter sind vorregistriert.
    expect(fest.wfa.folds.map((f) => f.fold.oosStart)).toEqual(plan.folds.map((f) => f.oosStart));
    expect(fest.wfa.folds.every((f) => f.best.params.a === 10 && f.best.params.b === 2)).toBe(true);
    expect(fest.wfa.finalParams).toEqual({ a: 10, b: 2 });
    expect(fest.wfa.trials).toBe(1);
    expect(fest.wfa.finalEvaluated).toBe(1);
    expect(fest.dsr.nTrials).toBe(1);
    // Holdout wie bei jedem gesuchten Kandidaten: nur Bericht, aber da.
    expect(fest.wfa.holdout).not.toBeNull();
    expect(fest.wfa.holdout!.start).toBe(plan.holdout!.start);
    // Dieselben zehn Gates, in derselben Reihenfolge.
    expect(fest.gates.map((g) => g.name)).toEqual(gesucht.gates.map((g) => g.name));
    expect(fest.gates.length).toBe(10);
    expect(fest.pass).toBe(true);
    expect(fest.score).toBe(fest.wfa.oos.objectiveMedian);
    expect(gate(fest, 'deflated_sharpe_is').note).toMatch(/nicht anwendbar \(Festkandidat/);
    expect(gate(gesucht, 'deflated_sharpe_is').note).not.toMatch(/nicht anwendbar/);
    expect(logs.some((m) => /AAA edge · fest: Zehn: Gates bestanden/.test(m))).toBe(true);

    // Beförderung: regulär über decidePromotion, Eintrag mit fixed: true.
    expect(r.decision.action).toBe('promote');
    expect(r.chosen).toMatchObject({ strategy: 'edge', params: { a: 10, b: 2 }, trials: 1, fixed: true });
    expect(loadChampion(homePaths(home).champion)!.symbols.AAA).toMatchObject({ strategy: 'edge', fixed: true, trials: 1 });
    expect(nichtsGemessen(out.runs)).toBe(false);

    // Bericht: Kennzeichnung in Kopf, Tabelle und Abschnitt.
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('- Festkandidaten (vorregistriert, ohne Suche, dieselben Folds und Gates): edge {"a":10,"b":2} „Zehn"');
    expect(text).toMatch(/\| edge · fest: Zehn \|[^\n]*✔ 10\/10/);
    expect(text).toContain('### AAA · edge · fest: Zehn');
    expect(text).toContain('(Festkandidat — vorregistriert, keine Suche;');
    expect(text).toContain('DSR (IS): nicht anwendbar (feste Parameter, keine Suche) — ');
    expect(text).toContain('| edge (fest) {"a":10,"b":2} |');
    expect(text).toContain('nicht anwendbar (Festkandidat: feste Parameter, keine Suche, keine Trials)');
  });

  it('konkurriert regulär: ein gesuchter Kandidat mit besserem Score gewinnt gegen einen bestandenen Festkandidaten', () => {
    const home = tmp();
    const out = runOptimization(input(home, { strategies: ['edge'], fixed: [{ strategy: 'edge', params: { a: 5, b: 2 }, label: 'Fünf' }] }));
    const r = out.runs[0]!;
    const fest = r.results.find((s) => s.fixed)!;
    const gesucht = r.results.find((s) => !s.fixed)!;
    expect(fest.pass).toBe(true); // sonst prüft der Test nichts: er verliert nur am Score
    expect(gesucht.score).toBeGreaterThan(fest.score);
    expect(r.results[0]).toBe(gesucht); // absteigend nach Score
    expect(r.decision.action).toBe('promote');
    expect(r.chosen!.fixed).toBeUndefined();
    expect(r.chosen!.params.a).toBe(10);
  });

  it('ein beförderter Festkandidat ist beim Folgelauf der Amtsinhaber — bewertet wie jeder andere', () => {
    const home = tmp();
    const fixed: FixedCandidateConfig[] = [{ strategy: 'edge', params: { a: 10, b: 2 }, label: 'Zehn' }];
    runOptimization(input(home, { strategies: ['noise'], fixed }));
    const second = runOptimization(input(home, { strategies: ['noise'], fixed, now: () => NOW + 1 }));
    const r = second.runs[0]!;
    expect(r.incumbent!.fixed).toBe(true);
    expect(r.incumbentEval!.pass).toBeNull(); // kein sauberes OOS nach fitEnd — wie bei jedem frischen Champion
    expect(r.decision.action).toBe('keep');
    expect(r.chosen!.fixed).toBe(true);
    expect(readFileSync(second.reportPath, 'utf8')).toContain('Amtierender Champion: edge (fest) {"a":10,"b":2}');
  });

  it('ungültige Parameter ⇒ Fehler-Eintrag mit klarer Meldung; die anderen Kandidaten laufen weiter', () => {
    const home = tmp();
    const out = runOptimization(
      input(home, {
        strategies: ['edge'],
        fixed: [
          { strategy: 'edge', params: { a: 99 }, label: 'weit weg' },
          { strategy: 'edge', params: { zz: 1 } },
          { strategy: 'edge', params: { a: 10 }, label: 'gut' },
        ],
      }),
    );
    const r = out.runs[0]!;
    expect(r.errors).toEqual([
      'edge · fest: weit weg: Parameter ungültig: "a" = 99 außerhalb [0, 10]',
      'edge · fest: {"zz":1}: Parameter ungültig: "zz" ist kein Parameter dieser Strategie (bekannt: a, b)',
    ]);
    expect(r.results.map((s) => [s.strategyId, s.label])).toEqual([
      ['edge', null],
      ['edge', 'gut'],
    ]);
    expect(r.decision.action).toBe('promote');
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('- edge · fest: weit weg: Parameter ungültig: "a" = 99 außerhalb [0, 10]');
  });

  it('nur ungültige Festkandidaten und nichts Gesuchtes ⇒ nicht bewertbar, nichts gemessen', () => {
    const home = tmp();
    const out = runOptimization(input(home, { strategies: [], fixed: [{ strategy: 'edge', params: { a: 99 } }] }));
    expect(out.runs[0]!.results).toEqual([]);
    expect(out.runs[0]!.decision.reason).toMatch(/nicht bewertbar/);
    expect(nichtsGemessen(out.runs)).toBe(true);
  });

  it('unbekannte Strategie eines Festkandidaten ist ein Config-Fehler — wie bei den gesuchten', () => {
    expect(() => runOptimization(input(tmp(), { fixed: [{ strategy: 'gibt_es_nicht', params: {} }] }))).toThrow(/unbekannte Strategie/);
  });

  it('kennt die Strategie den Zeitrahmen nicht, wird der Festkandidat übersprungen — Log, kein Fehler', () => {
    const home = tmp();
    const logs: string[] = [];
    const out = runOptimization(input(home, { fixed: [{ strategy: 'intraday', params: {} }], log: (m) => logs.push(m) }));
    const r = out.runs[0]!;
    expect(r.results.map((s) => s.strategyId)).toEqual(['edge']);
    expect(r.errors).toEqual([]);
    expect(logs.some((m) => /^intraday · fest: Defaults: Zeitrahmen 1440/.test(m))).toBe(true);
  });
});

describe('WÄCHTER: kein Sonderweg für Festkandidaten', () => {
  it('mit denselben Fake-Ergebnissen fällt der Festkandidat durch dieselben Gates wie der gesuchte Kandidat', () => {
    const home = tmp();
    const out = runOptimization(input(home, { strategies: ['dead'], fixed: [{ strategy: 'dead', params: { a: 1, b: 1 }, label: 'tot' }] }));
    const r = out.runs[0]!;
    const fest = r.results.find((s) => s.fixed)!;
    const gesucht = r.results.find((s) => !s.fixed)!;
    // Dieselbe Kette: Fold für Fold dieselben OOS-Zahlen, derselbe Score …
    expect(fest.wfa.folds.map((f) => f.best.oosMetrics.netProfit)).toEqual(gesucht.wfa.folds.map((f) => f.best.oosMetrics.netProfit));
    expect(fest.score).toBe(gesucht.score);
    // … und dieselben gerissenen Gates.
    expect(failed(gesucht).length).toBeGreaterThan(0);
    expect(failed(fest)).toEqual(failed(gesucht));
    expect(fest.pass).toBe(false);
    expect(r.decision.action).toBe('stay_notrade');
    expect(out.champion.symbols.AAA).toBeUndefined();
  });

  it('die volle Trade-Schwelle gilt — nicht die anteilige des Amtsinhabers', () => {
    const home = tmp();
    // 240 OOS-Trades über 8 Folds; die Schwelle liegt einen darüber.
    const out = runOptimization(input(home, { strategies: ['edge'], fixed: [{ strategy: 'edge', params: { a: 10, b: 2 }, label: 'Zehn' }], optimizer: { minOosTrades: 241 } }));
    const r = out.runs[0]!;
    for (const s of r.results) {
      const g = gate(s, 'oos_trades');
      expect(g.pass).toBe(false);
      expect(g.value).toBe(240);
      expect(g.threshold).toBe(241);
      expect(g.note).not.toMatch(/anteilig/);
    }
    expect(r.decision.action).toBe('stay_notrade');
  });

  it('DSR: ohne Trials nicht anwendbar — laut, wie beim Amtsinhaber, auch mit dsrIsGate', () => {
    const home = tmp();
    const out = runOptimization(input(home, { strategies: ['noise'], fixed: [{ strategy: 'noise', params: { a: 5, b: 2 }, label: 'Rauschen' }], optimizer: { dsrIsGate: true } }));
    const r = out.runs[0]!;
    const fest = r.results.find((s) => s.fixed)!;
    const gesucht = r.results.find((s) => !s.fixed)!;
    const dsrFest = gate(fest, 'deflated_sharpe_is');
    expect(dsrFest.pass).toBe(true);
    expect(dsrFest.note).toBe('nicht anwendbar (Festkandidat: feste Parameter, keine Suche, keine Trials)');
    // Der gesuchte Kandidat trägt das echte Gate — bei Rauschen fällt er daran.
    expect(gate(gesucht, 'deflated_sharpe_is').note).not.toMatch(/nicht anwendbar/);
    expect(failed(gesucht)).toContain('deflated_sharpe_is');
    // „Nicht anwendbar" hilft nicht nach oben: Rauschen bleibt an den OOS-Gates hängen.
    expect(fest.pass).toBe(false);
    expect(failed(fest)).toContain('probabilistic_sharpe_oos');
    expect(r.decision.action).toBe('stay_notrade');
  });
});

describe('Korb je Fold gilt auch für Festkandidaten', () => {
  /** Tagesbars ab T0: je Abschnitt `[Tage, Kurs, Stückzahl]`. */
  function serie(abschnitte: readonly (readonly [tage: number, kurs: number, stueck: number])[]): BarSeries {
    const out: Bar[] = [];
    let i = 0;
    for (const [tage, kurs, stueck] of abschnitte) {
      for (let k = 0; k < tage; k++, i++) out.push({ t: T0 + i * DAY, o: kurs, h: kurs, l: kurs, c: kurs, v: stueck });
    }
    return BarSeries.from(out);
  }

  // Korbwechsel 45 Tage vor dem OOS-Beginn von Fold 5 (Aufbau wie korbJeFold.test.ts):
  // DROP verliert den Umsatz, LATE2 gewinnt ihn.
  const cfgPit = testConfig({ symbols: ['AAA', 'BBB'], candidates: ['DROP', 'LATE2', 'FILL'], maxSymbols: 3, optimizer: { pooled: true } });
  const plan = foldPlanForBars(dailyBars(400), cfgPit.optimizer);
  const fold5 = plan.folds[4]!;
  const bis = Math.round((fold5.oosStart - 45 * DAY - T0) / DAY);
  const serien = new Map([
    ['AAA', serie([[400, 100, 100_000]])],
    ['BBB', serie([[400, 100, 50_000]])],
    ['DROP', serie([[bis, 100, 100_000], [400 - bis, 100, 1]])],
    ['LATE2', serie([[bis, 100, 1], [400 - bis, 100, 200_000]])],
    ['FILL', serie([[400, 100, 30_000]])],
  ]);
  const setOf = (xs: readonly string[]) => [...new Set(xs)].sort();
  const istIs = (c: { range: { start: number; end: number } | null }) => c.range !== null && c.range.end - c.range.start > 60 * DAY;

  it('jedes Fenster des Festkandidaten läuft auf dem Stand zu seinem OOS-Beginn — IS-Lauf, OOS, Stress und Holdout', () => {
    const home = tmp();
    // Die feste Strategie wird NICHT gesucht: Jeder Aufruf mit ihrer ID stammt vom Festkandidaten.
    const cfg = testConfig({
      symbols: ['AAA', 'BBB'],
      candidates: ['DROP', 'LATE2', 'FILL'],
      maxSymbols: 3,
      optimizer: { pooled: true, fixedCandidates: [{ strategy: 'noise', params: { a: 7, b: 3 }, label: 'Korbprobe' }] },
    });
    const simulate = makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE);
    const out = runOptimization({
      config: cfg,
      symbols: ['AAA', 'BBB'],
      strategies: ['edge'],
      barsFor: (s) => serien.get(s)!,
      candidateBarsFor: (s) => serien.get(s) ?? null,
      home,
      initialEquity: 10_000,
      simulate,
      metricsFns: fakeMetricsFns,
      getStrategy,
      now: () => NOW,
    });
    const r = out.runs[0]!;
    expect(r.korb).not.toBeNull();
    const stand = (t: number) => setOf(r.korb!.staende.filter((s) => s.at <= t).at(-1)!.symbols);
    expect(stand(plan.folds[0]!.oosStart)).toEqual(['AAA', 'BBB', 'DROP']);
    expect(stand(fold5.oosStart)).toEqual(['AAA', 'BBB', 'LATE2']);

    const fest = simulate.calls.filter((c) => c.strategyId === 'noise');
    expect(fest.length).toBeGreaterThan(0);
    for (const f of plan.folds) {
      const oos = fest.filter((c) => c.range?.start === f.oosStart && c.range.end === f.oosEnd);
      const is = fest.filter((c) => istIs(c) && c.range!.start === f.isStart && c.range!.end <= f.isEnd);
      expect(oos.length, `OOS Fold ${f.index + 1}`).toBeGreaterThan(0);
      expect(is.length, `IS Fold ${f.index + 1}`).toBeGreaterThan(0);
      for (const c of oos) expect(setOf(c.symbols), `OOS Fold ${f.index + 1}`).toEqual(stand(f.oosStart));
      for (const c of is) expect(setOf(c.symbols), `IS Fold ${f.index + 1}`).toEqual(stand(f.oosStart));
    }
    // Der Wächter: Zum IS-Beginn von Fold 5 war LATE2 noch ein Nichts und DROP
    // noch liquide — der Festkandidat rechnet trotzdem auf dem Korb zum OOS-Beginn.
    const is5 = fest.filter((c) => istIs(c) && c.range!.start === fold5.isStart && c.range!.end <= fold5.isEnd);
    expect(is5.length).toBeGreaterThan(0);
    for (const c of is5) {
      expect(c.symbols).toContain('LATE2');
      expect(c.symbols).not.toContain('DROP');
    }
    const holdout = fest.filter((c) => c.range?.start === plan.holdout!.start && c.range.end === plan.holdout!.end);
    expect(holdout.length).toBeGreaterThan(0);
    for (const c of holdout) expect(setOf(c.symbols)).toEqual(stand(plan.holdout!.start));

    const fk = r.results.find((s) => s.fixed)!;
    expect(fk.label).toBe('Korbprobe');
    expect(fk.wfa.folds.length).toBe(plan.folds.length);
    expect(fk.wfa.holdout).not.toBeNull();
    expect(r.errors).toEqual([]);
  });
});
