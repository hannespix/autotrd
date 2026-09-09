/**
 * Korb-Zugehörigkeit je Fold — die zweitverführerischste Lookahead-Stelle
 * nach der Rangliste (CLAUDE.md §0.2).
 *
 * Bis zum 09.09.2026 galt in jedem Walk-Forward der Korb vom ENDE des
 * Fensters rückwärts. Drei Stichtags-Läufe zeigten, was das anrichtet:
 * dieselbe Strategie über dieselben Jahre bei 0,71 / −0,18 / 0,04 — je
 * nachdem, welcher Endkorb rückwärts galt.
 *
 * Was diese Tests festhalten:
 *  1. Ein Stand kennt nur Bars bis zu seinem Zeitpunkt (Survivorship-Wächter).
 *  2. Die Stände sind verkettet wie Nacht für Nacht (Hysterese).
 *  3. Es gibt nie einen SPÄTEREN Stand für ein Fenster — und keinen ⇒ laut.
 *  4. Im Lauf bekommt jedes Fenster genau seinen Stand — die IS-Suche eines
 *     Folds den Korb zu dessen OOS-Beginn (so sucht nachts der Optimierer die
 *     Parameter des heutigen Korbs auf dem letzten Jahr), nicht den zu ihrem
 *     eigenen Beginn.
 *  5. Der Maßstab folgt mit; der Bericht zeigt die Stände; `fixed` und
 *     „kein Pool" bleiben der alte feste Korb — mit Begründung.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchSymbols } from '../../src/app.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { DAY } from '../../src/core/time.ts';
import type { Bar, Strategy } from '../../src/core/types.ts';
import { homePaths } from '../../src/core/journal.ts';
import { korbJeFold } from '../../src/optimize/korbJeFold.ts';
import { emptyChampionFile, saveChampion, type ChampionEntry } from '../../src/optimize/promote.ts';
import { runOptimization, type OptimizeRunInput } from '../../src/optimize/run.ts';
import { foldPlanForBars, korbZum } from '../../src/optimize/walkForward.ts';
import { universeRegelnFuer } from '../../src/universe/select.ts';
import { NOISE_PROFILE, REWARD_PROFILE, T0, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

/** Tagesbars ab T0: je Abschnitt `[Tage, Kurs, Stückzahl]`. */
function serie(abschnitte: readonly (readonly [tage: number, kurs: number, stueck: number])[]): BarSeries {
  const out: Bar[] = [];
  let i = 0;
  for (const [tage, kurs, stueck] of abschnitte) {
    for (let k = 0; k < tage; k++, i++) out.push({ t: T0 + i * DAY, o: kurs, h: kurs, l: kurs, c: kurs, v: stueck });
  }
  return BarSeries.from(out);
}

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), noise: fakeStrategy('noise') };
const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, noise: NOISE_PROFILE };
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
  const d = mkdtempSync(join(tmpdir(), 'autotrd-korb-'));
  dirs.push(d);
  return d;
};

describe('korbJeFold: die Stände', () => {
  // LATE: 200 Tage ein Pennystock ohne Umsatz, danach der liquideste Wert des Pools.
  const kandidaten = new Map([
    ['A', serie([[400, 100, 100_000]])],
    ['B', serie([[400, 100, 50_000]])],
    ['LATE', serie([[200, 10, 100], [200, 100, 1_000_000]])],
  ]);
  const t1 = T0 + 100 * DAY;
  const t2 = T0 + 300 * DAY;
  const rein = { ...universeRegelnFuer(2), haltePuffer: 0, minAnteil: 0 };

  it('ein Stand sieht nur Bars bis zu seinem Zeitpunkt: LATE ist per t1 nicht da, obwohl es am Ende Rang 1 hat', () => {
    const k = korbJeFold({ kandidaten, zeiten: [t1, t2], regeln: rein, pflicht: [] });
    expect([...k.at(t1)].sort()).toEqual(['A', 'B']);
    expect([...k.at(t2)].sort()).toEqual(['A', 'LATE']);
    expect(k.staende.map((s) => s.symbols.length)).toEqual([2, 2]);
  });

  it('zwischen zwei Ständen gilt der frühere — nie der spätere; davor gibt es keinen', () => {
    const k = korbJeFold({ kandidaten, zeiten: [t2, t1], regeln: rein, pflicht: [] }); // unsortiert übergeben
    expect([...k.at(t1 + 50 * DAY)].sort()).toEqual(['A', 'B']);
    expect([...k.at(t2 - 1)].sort()).toEqual(['A', 'B']);
    expect([...k.at(t2)].sort()).toEqual(['A', 'LATE']);
    expect(() => k.at(t1 - 1)).toThrow(/kein Stand/);
  });

  it('die Stände sind verkettet: mit Hysterese hält der Bestand seinen Platz, ohne Kette käme LATE sofort herein', () => {
    const regeln = universeRegelnFuer(2); // haltePuffer 5
    const kette = korbJeFold({ kandidaten, zeiten: [t1, t2], regeln, pflicht: [] });
    expect([...kette.at(t2)].sort()).toEqual(['A', 'B']); // B ist Rang 3, bleibt im Puffer — LATE kommt nicht hinein
    const allein = korbJeFold({ kandidaten, zeiten: [t2], regeln, pflicht: [] });
    expect([...allein.at(t2)].sort()).toEqual(['A', 'LATE']);
    expect(kette.staende[1]!.zugang).toEqual([]);
    expect(kette.staende[1]!.abgang).toEqual([]);
  });

  it('der Pflicht-Benchmark ist immer dabei', () => {
    const k = korbJeFold({ kandidaten, zeiten: [t1], regeln: rein, pflicht: ['B'] });
    expect(k.at(t1).has('B')).toBe(true);
  });
});

describe('Korb je Fold im Lauf', () => {
  // Korbwechsel 45 Tage vor dem OOS-Beginn von Fold 5: DROP verliert den
  // Umsatz, LATE2 gewinnt ihn. Per Median über 60 Bars kippt beides genau
  // zwischen Fold 4 (15 neue Bars) und Fold 5 (46 neue Bars).
  const cfgPit = testConfig({ symbols: ['AAA', 'BBB'], candidates: ['DROP', 'LATE2', 'FILL'], maxSymbols: 3, optimizer: { pooled: true } });
  const plan = foldPlanForBars(dailyBars(400), cfgPit.optimizer);
  const fold5 = plan.folds[4]!;
  const tSwitch = fold5.oosStart - 45 * DAY;
  const bis = Math.round((tSwitch - T0) / DAY);
  const serien = new Map([
    ['AAA', serie([[400, 100, 100_000]])],
    ['BBB', serie([[400, 100, 50_000]])],
    ['DROP', serie([[bis, 100, 100_000], [400 - bis, 100, 1]])],
    ['LATE2', serie([[bis, 100, 1], [400 - bis, 100, 200_000]])],
    // Immer liquide, aber Rang 4: rückt nur nach, wenn ein Platz frei bleibt —
    // so kann EIN fehlender Kandidat die Mindestgröße nicht reißen.
    ['FILL', serie([[400, 100, 30_000]])],
  ]);
  const barsFor = (s: string) => {
    const b = serien.get(s);
    if (!b) throw new Error(`keine Serie für ${s}`);
    return b;
  };

  function lauf(over: { fixed?: boolean; ohnePool?: boolean; vorher?: (home: string) => void; ohneKandidatenBars?: boolean; fehlend?: string[]; timeframe?: 5 | 1440 } = {}) {
    const home = tmp();
    over.vorher?.(home);
    const cfg = over.ohnePool
      ? testConfig({ symbols: ['AAA', 'BBB'], optimizer: { pooled: true } })
      : testConfig({
          symbols: ['AAA', 'BBB'],
          candidates: ['DROP', 'LATE2', 'FILL'],
          maxSymbols: 3,
          ...(over.timeframe ? { timeframe: over.timeframe } : {}),
          optimizer: { pooled: true, ...(over.fixed ? { foldMembership: 'fixed' as const } : {}) },
        });
    const simulate = makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE);
    const input: OptimizeRunInput = {
      config: cfg,
      symbols: ['AAA', 'BBB'],
      strategies: ['edge'],
      barsFor,
      candidateBarsFor: (s) => (over.ohneKandidatenBars || over.fehlend?.includes(s) ? null : (serien.get(s) ?? null)),
      home,
      initialEquity: 10_000,
      simulate,
      metricsFns: fakeMetricsFns,
      getStrategy,
      now: () => NOW,
    };
    return { out: runOptimization(input), calls: simulate.calls };
  }

  const setOf = (xs: readonly string[]) => [...new Set(xs)].sort();
  // IS-Fenster sind die langen (isDays minus Embargo); der IS-Beginn von Fold k+4
  // fällt mit dem OOS-Beginn von Fold k zusammen, der Start allein trennt sie nicht.
  const istIs = (c: { range: { start: number; end: number } | null }) => c.range !== null && c.range.end - c.range.start > 60 * DAY;

  it('jedes Fenster bekommt genau den Stand zu seinem OOS-Beginn — auch die IS-Suche des Folds', () => {
    const { out, calls } = lauf();
    const r = out.runs[0]!;
    expect(r.korb).not.toBeNull();
    const stand = (t: number) => setOf(r.korb!.staende.filter((s) => s.at <= t).at(-1)!.symbols);
    expect(stand(plan.folds[0]!.oosStart)).toEqual(['AAA', 'BBB', 'DROP']);
    expect(stand(fold5.oosStart)).toEqual(['AAA', 'BBB', 'LATE2']);

    for (const f of plan.folds) {
      const oos = calls.filter((c) => c.range?.start === f.oosStart && c.range.end === f.oosEnd);
      const is = calls.filter((c) => istIs(c) && c.range!.start === f.isStart && c.range!.end <= f.isEnd);
      expect(oos.length, `OOS Fold ${f.index + 1}`).toBeGreaterThan(0);
      expect(is.length, `IS Fold ${f.index + 1}`).toBeGreaterThan(0);
      for (const c of oos) expect(setOf(c.symbols), `OOS Fold ${f.index + 1}`).toEqual(stand(f.oosStart));
      for (const c of is) expect(setOf(c.symbols), `IS Fold ${f.index + 1}`).toEqual(stand(f.oosStart));
    }
    // Der eigentliche Wächter: Zum IS-Beginn von Fold 5 war LATE2 noch ein
    // Nichts und DROP noch liquide. Die Suche läuft trotzdem auf dem Korb zum
    // OOS-Beginn — wie nachts auf dem Korb von heute.
    const is5 = calls.filter((c) => istIs(c) && c.range!.start === fold5.isStart && c.range!.end <= fold5.isEnd);
    expect(is5.length).toBeGreaterThan(0);
    for (const c of is5) {
      expect(c.symbols).toContain('LATE2');
      expect(c.symbols).not.toContain('DROP');
    }
    // Die finale Suche des Kandidaten — der Lieferwert — läuft auf dem letzten
    // Stand (Ende des letzten Folds), nicht auf der Vereinigung (Prüfbefund 7.1).
    const letzter = plan.folds.at(-1)!;
    const final = calls.filter((c) => c.range!.start === letzter.isStart && c.range!.end > letzter.oosStart);
    expect(final.length).toBeGreaterThan(0);
    for (const c of final) expect(setOf(c.symbols)).toEqual(stand(letzter.oosEnd));
  });

  it('korbZum ohne Zeitpunkt wirft — stumm die Vereinigung zu nehmen wäre der Lookahead ohne Spur', () => {
    const korb = new Map([['AAA', serien.get('AAA')!]]);
    expect(() => korbZum(korb, () => new Set(['AAA']), undefined)).toThrow(/Zeitpunkt/);
    expect(korbZum(korb, undefined, undefined).size).toBe(1);
  });

  it('Pool konfiguriert, aber kein Kandidat mit Bars ⇒ NICHT bewertbar — kein stiller Rückfall auf den Korb der Config', () => {
    const { out, calls } = lauf({ ohneKandidatenBars: true });
    const r = out.runs[0]!;
    expect(r.errors.some((e) => /keiner von 5 Kandidaten/.test(e))).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.decision.reason).toMatch(/nicht bewertbar/);
    expect(calls).toHaveLength(0);
  });

  it('fehlt EIN Kandidat, steht er im Protokoll und im Bericht — und in keinem Stand', () => {
    const { out } = lauf({ fehlend: ['LATE2'] });
    const r = out.runs[0]!;
    expect(r.korb?.fehlend).toEqual(['LATE2']);
    for (const st of r.korb!.staende) expect(st.symbols).not.toContain('LATE2');
    expect(readFileSync(out.reportPath, 'utf8')).toMatch(/nicht wählbar: LATE2/);
  });

  it('Korb je Fold nur auf Tagesbars: auf Minutenbars bleibt der Korb fest, mit Begründung', () => {
    const { out, calls } = lauf({ timeframe: 5 });
    expect(out.runs[0]!.korb).toBeNull();
    expect(out.runs[0]!.korbHinweis).toMatch(/Tagesbars/);
    for (const c of calls) expect(setOf(c.symbols)).toEqual(['AAA', 'BBB']);
  });

  it('der Bericht nennt, wie sich der heutige Korb vom letzten Stand unterscheidet', () => {
    const { out } = lauf();
    const r = out.runs[0]!;
    expect(r.korb?.heuteZugang).toEqual([]);
    expect(r.korb?.heuteAbgang).toEqual(['LATE2']);
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toMatch(/Heute gehandelt wird ein anderer Korb/);
    expect(text).toMatch(/Abgang LATE2/);
  });

  it('Stress je Fold, Nachbarschaft und Holdout laufen auf ihrem Stand', () => {
    const { out, calls } = lauf();
    const r = out.runs[0]!;
    // Der Fake protokolliert je Symbol einen Aufruf — je Fold also so viele wie der Korb groß ist.
    const stress = calls.filter((c) => c.costMultiplier !== 1);
    expect(new Set(stress.map((c) => c.range!.start)).size).toBe(plan.folds.length);
    for (const c of stress) {
      const f = plan.folds.find((x) => x.oosStart === c.range!.start)!;
      expect(setOf(c.symbols)).toEqual(f.index >= 4 ? ['AAA', 'BBB', 'LATE2'] : ['AAA', 'BBB', 'DROP']);
    }
    const holdout = calls.filter((c) => c.range?.start === plan.holdout!.start && c.range.end === plan.holdout!.end);
    expect(holdout.length).toBeGreaterThan(0);
    for (const c of holdout) expect(setOf(c.symbols)).toEqual(['AAA', 'BBB', 'LATE2']);
    expect(r.holdoutMarkt?.korb?.symbole).toBe(3);
  });

  it('auch der Amtsinhaber wird auf den Fold-Körben nachgerechnet — nicht auf dem Korb, auf dem er gefittet wurde', () => {
    // Ein Champion für den ganzen (gepoolten) Korb, gefittet bis Fold 2 ⇒ Folds 3–8 sind sauber
    // und werden mit festen Parametern nachgerechnet (fixedParamsWfa). Auffällige Params
    // (a = 999) machen seine Aufrufe im Protokoll kenntlich.
    const fitEnd = plan.folds[1]!.oosEnd;
    const eintrag: ChampionEntry = {
      strategy: 'edge',
      params: { a: 999, b: 1 },
      timeframe: 1440,
      score: 2,
      oos: { objectiveMedian: 2, objectiveMean: 2, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
      gates: [],
      decidedAt: 1,
      trials: 1,
      dataRange: { start: 0, end: 1 },
      fitEnd,
      foldMembership: 'point_in_time',
    };
    const { out, calls } = lauf({
      vorher: (home) => saveChampion(homePaths(home).champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag, BBB: eintrag } }),
    });
    expect(out.runs[0]!.incumbentEval).not.toBeNull();
    const r = out.runs[0]!;
    const stand = (t: number) => setOf(r.korb!.staende.filter((s) => s.at <= t).at(-1)!.symbols);
    const amt = calls.filter((c) => c.params.a === 999);
    expect(amt.length).toBeGreaterThan(0);
    for (const c of amt) {
      const oosFold = plan.folds.find((f) => f.oosStart === c.range!.start && f.oosEnd === c.range!.end);
      const isFold = istIs(c) ? plan.folds.find((f) => f.isStart === c.range!.start && c.range!.end <= f.isEnd) : undefined;
      const fold = oosFold ?? isFold;
      if (!fold) continue; // finales Fenster: Korb zu dessen Ende — unten geprüft
      expect(setOf(c.symbols), `Amtsinhaber ${oosFold ? 'OOS' : 'IS'} Fold ${fold.index + 1}`).toEqual(stand(fold.oosStart));
    }
    const letzter = plan.folds.at(-1)!;
    const final = amt.filter((c) => c.range!.start === letzter.isStart && c.range!.end > letzter.oosStart);
    expect(final.length).toBeGreaterThan(0);
    for (const c of final) expect(setOf(c.symbols)).toEqual(stand(letzter.oosEnd));
  });

  it('ein Champion aus dem festen Korb ist kein Maßstab für einen Punkt-in-Zeit-Kandidaten: er tritt ab', () => {
    // Alter Eintrag ohne foldMembership (= fixed) mit unerreichbarem Score:
    // Mit Marge könnte kein Kandidat je gewinnen. Er ist nicht vergleichbar ⇒
    // der bestehende Kandidat wird befördert, der neue Eintrag trägt das Regime.
    const alt: ChampionEntry = {
      strategy: 'edge',
      params: { a: 999, b: 1 },
      timeframe: 1440,
      score: 1_000_000,
      oos: { objectiveMedian: 1_000_000, objectiveMean: 1, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
      gates: [],
      decidedAt: 1,
      trials: 1,
      dataRange: { start: 0, end: 1 },
      fitEnd: plan.folds[1]!.oosEnd,
    };
    const { out } = lauf({
      vorher: (home) => saveChampion(homePaths(home).champion, { ...emptyChampionFile(1), symbols: { AAA: alt, BBB: alt } }),
    });
    const r = out.runs[0]!;
    expect(r.errors.some((e) => /gemessen mit Korb fixed, jetzt point_in_time/.test(e))).toBe(true);
    expect(r.incumbentEval).toBeNull();
    expect(r.decision.action).toBe('promote');
    expect(out.champion.symbols.AAA?.foldMembership).toBe('point_in_time');
  });

  it('der Bericht zeigt die Stände mit Zugang und Abgang', () => {
    const { out } = lauf();
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('Korb je Fold');
    const tag = new Date(fold5.oosStart).toISOString().slice(0, 10);
    const zeile = text.split('\n').find((l) => l.startsWith(`| ${tag} `));
    expect(zeile).toBeDefined();
    expect(zeile).toContain('LATE2');
    expect(zeile).toContain('DROP');
  });

  it('`fixed`: der Korb der Config über das ganze Fenster — und der Bericht sagt es', () => {
    const { out, calls } = lauf({ fixed: true });
    for (const c of calls) expect(setOf(c.symbols)).toEqual(['AAA', 'BBB']);
    expect(out.runs[0]!.korb).toBeNull();
    expect(out.runs[0]!.korbHinweis).toMatch(/fixed/);
    expect(out.runs[0]!.holdoutMarkt?.korb?.symbole).toBe(2);
    expect(readFileSync(out.reportPath, 'utf8')).toMatch(/Korb über das ganze Fenster fest/);
  });

  it('ohne Kandidatenpool bleibt der Korb fest — mit Begründung, ohne Fehler', () => {
    const { out, calls } = lauf({ ohnePool: true });
    for (const c of calls) expect(setOf(c.symbols)).toEqual(['AAA', 'BBB']);
    expect(out.runs[0]!.korbHinweis).toMatch(/kein Kandidatenpool/);
    expect(out.runs[0]!.errors).toEqual([]);
  });
});

describe('Config und fetch', () => {
  it('foldMembership: Vorgabe point_in_time, fixed erlaubt, sonst nichts', () => {
    expect(testConfig().optimizer.foldMembership).toBe('point_in_time');
    expect(testConfig({ optimizer: { foldMembership: 'fixed' } }).optimizer.foldMembership).toBe('fixed');
    expect(() => testConfig({ optimizer: { foldMembership: 'later' as never } })).toThrow();
  });

  it('fetch lädt den Kandidatenpool nur, wenn der Korb je Fold gewählt wird (gepoolt, point_in_time)', () => {
    const mit = testConfig({ symbols: ['AAA'], candidates: ['CCC'], optimizer: { pooled: true } });
    expect(fetchSymbols(mit)).toContain('CCC');
    const ungepoolt = testConfig({ symbols: ['AAA'], candidates: ['CCC'], optimizer: { pooled: false } });
    expect(fetchSymbols(ungepoolt)).not.toContain('CCC');
    const fest = testConfig({ symbols: ['AAA'], candidates: ['CCC'], optimizer: { pooled: true, foldMembership: 'fixed' } });
    expect(fetchSymbols(fest)).not.toContain('CCC');
    const intraday = testConfig({ symbols: ['AAA'], candidates: ['CCC'], timeframe: 5, optimizer: { pooled: true } });
    expect(fetchSymbols(intraday)).not.toContain('CCC');
  });
});
