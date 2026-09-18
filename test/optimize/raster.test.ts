import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { homePaths } from '../../src/core/journal.ts';
import { DAY } from '../../src/core/time.ts';
import type { Strategy } from '../../src/core/types.ts';
import { REGEL_AKTUELL, decidePromotion, emptyChampionFile, saveChampion, type ChampionEntry, type PromotionInput } from '../../src/optimize/promote.ts';
import { rasterEnde, rasterKennung, schneideKorb, schneideSerie } from '../../src/optimize/raster.ts';
import { runOptimization, type OptimizeRunInput } from '../../src/optimize/run.ts';
import { foldPlanForBars, type SimulateFn } from '../../src/optimize/walkForward.ts';
import { DEAD_PROFILE, NOISE_PROFILE, REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig } from './fakes.ts';

/**
 * Regel 2 — Beförderung auf drei Rastern (Owner-Entscheidung 18.09.2026,
 * `docs/wissen/vorregistrierung/2026-09-18-befoerderung-auf-drei-rastern.md`).
 *
 * Prüfbefund K1: Dieselbe csm-Kette bestand in drei Nächten 6/10, 5/10 und
 * 10/10 Gates — und die eine Nacht wurde Champion. Verlangt: Ein Kandidat
 * besteht nur, wenn er auf ALLEN Rastern (Anker −0/−1/−2 Handelstage, im
 * selben Lauf) alle zehn Gates nimmt; der Amtsinhaber wird jede Nacht mit
 * festen Parametern auf denselben Rastern geprüft und nach drei gerissenen
 * Nächten in Folge abgesetzt; Altbestand aus Regel 1 wird einmal nachgeprüft.
 */

const bars = dailyBars(400);
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const tLetzte = bars.t[bars.length - 1]!;

const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), dead: fakeStrategy('dead'), noise: fakeStrategy('noise') };
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
  const d = mkdtempSync(join(tmpdir(), 'autotrd-raster-'));
  dirs.push(d);
  return d;
};

function eintrag(strategy: string, params: Record<string, number>, extra: Partial<ChampionEntry> = {}): ChampionEntry {
  return {
    strategy,
    params,
    timeframe: 1440,
    score: 2,
    oos: { objectiveMedian: 2, objectiveMean: 2, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
    gates: [],
    decidedAt: 1,
    trials: 1,
    dataRange: { start: 0, end: 1 },
    ...extra,
  };
}

function input(home: string, over: Partial<OptimizeRunInput> & { strategies?: string[]; optimizer?: Record<string, unknown> } = {}): OptimizeRunInput {
  const { strategies: strat, optimizer, ...rest } = over;
  return {
    config: testConfig({ symbols: ['AAA'], home, optimizer: { seed: 7, ...(optimizer ?? {}) } }),
    symbols: ['AAA'],
    strategies: strat ?? ['edge'],
    barsFor: () => bars,
    home,
    initialEquity: 10_000,
    simulate: makeFakeSimulate((id) => (id === 'edge' ? REWARD_PROFILE : id === 'dead' ? DEAD_PROFILE : NOISE_PROFILE)),
    metricsFns: fakeMetricsFns,
    getStrategy,
    now: () => NOW,
    ...rest,
  };
}

/**
 * Ein Simulator, der NUR mit dem jüngsten Datenstand eine Kante hat: Sieht er
 * die letzte Bar der vollen Serie, rechnet er wie REWARD; fehlt sie (Raster
 * −1/−2), wie DEAD. Genau der Kandidat, den Regel 2 aussortieren soll — auf
 * Raster 0 alle Gates, auf den beiden anderen keine. Dazu ein Protokoll, was
 * jeder Lauf gesehen hat: die jüngste Bar des Korbs und die der Parkbars.
 */
function nurHeuteMitKante(): { simulate: SimulateFn; sicht: { maxT: number; park: number | null }[] } {
  const reward = makeFakeSimulate(REWARD_PROFILE);
  const dead = makeFakeSimulate(DEAD_PROFILE);
  const sicht: { maxT: number; park: number | null }[] = [];
  const simulate: SimulateFn = (inp) => {
    let maxT = Number.NEGATIVE_INFINITY;
    for (const b of inp.bars.values()) maxT = Math.max(maxT, b.t[b.length - 1]!);
    sicht.push({ maxT, park: inp.parkBars ? inp.parkBars.t[inp.parkBars.length - 1]! : null });
    return maxT >= tLetzte ? reward(inp) : dead(inp);
  };
  return { simulate, sicht };
}

describe('Raster-Schnitt (optimize/raster.ts)', () => {
  it('Raster −j lässt genau die letzten j Handelstage der Achse weg — auf jeder Serie', () => {
    const achse = bars;
    expect(rasterEnde(achse, 0)).toBeNull();
    for (const j of [1, 2, 3]) {
      const ende = rasterEnde(achse, j)!;
      expect(ende).toBe(bars.t[bars.length - j]);
      const s = schneideSerie(bars, ende);
      expect(s.length).toBe(bars.length - j);
      expect(s.t[s.length - 1]).toBe(bars.t[bars.length - 1 - j]);
      expect(s.t[0]).toBe(bars.t[0]);
    }
    // ohne Schnitt dieselbe Serie (kein Kopieren um des Kopierens willen)
    expect(schneideSerie(bars, null)).toBe(bars);
  });

  it('eine Serie, die früher endet, bleibt unberührt; eine ohne verbleibende Bars fällt aus dem Korb', () => {
    const kurz = dailyBars(10);
    const ende = rasterEnde(bars, 2)!;
    expect(schneideSerie(kurz, ende)).toBe(kurz);
    const spaet = dailyBars(5, tLetzte - 2 * DAY); // fünf Bars ab dem drittletzten Tag — vor dem Schnitt (t < tLetzte − 1 Tag) liegt genau eine
    const korb = schneideKorb(new Map([['A', bars], ['K', kurz], ['S', spaet], ['N', dailyBars(3, tLetzte)]]), ende);
    expect([...korb.keys()].sort()).toEqual(['A', 'K', 'S']);
    expect(korb.get('A')!.length).toBe(bars.length - 2);
    expect(korb.get('S')!.length).toBe(1);
  });

  it('ein Anker jenseits der Achse ist ein Fehler, kein leeres Raster; negative Anker auch', () => {
    expect(() => rasterEnde(dailyBars(2), 2)).toThrow(/nur 2 Handelstage/);
    expect(() => rasterEnde(bars, -1)).toThrow(/ganze Zahl/);
    expect(() => rasterEnde(bars, 1.5)).toThrow(/ganze Zahl/);
    expect(rasterKennung(0)).toBe('−0');
    expect(rasterKennung(2)).toBe('−2');
  });
});

describe('Regel 2 im Lauf: Beförderung nur auf allen Rastern', () => {
  it('WÄCHTER: ein Kandidat, der nur auf Raster −0 besteht, wird NICHT befördert — er läuft auf Papier weiter', () => {
    const home = tmp();
    const { simulate } = nurHeuteMitKante();
    const out = runOptimization(input(home, { simulate }));
    const r = out.runs[0]!;
    const edge = r.results[0]!;
    expect(edge.pass).toBe(true); // Raster −0: alle Gates
    expect(edge.raster.map((u) => u.anker)).toEqual([0, 1, 2]);
    expect(edge.raster.map((u) => u.pass)).toEqual([true, false, false]);
    expect(edge.raster[1]!.failed.length).toBeGreaterThan(0);
    expect(edge.rasterPass).toBe(false);
    expect(r.rasterAnzahl).toBe(3);
    // kein Champion — und die Erprobung nimmt ihn auf Papier
    expect(r.decision.action).toBe('stay_notrade');
    expect(r.decision.reason).toMatch(/fällt durch die Gates/);
    expect(out.champion.symbols.AAA).toBeUndefined();
    expect(out.champion.noTrade.AAA).toBeDefined();
    expect(out.champion.erprobung?.AAA?.strategy).toBe('edge');
    // Bericht und Journal sagen es
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('**Beförderung (Regel 2): alle zehn Gates auf 3 Rastern**');
    expect(text).toContain('Raster (Regel 2): **1 von 3 bestanden — kein Champion**');
    expect(text).toMatch(/\| −1 \| ✘ \|/);
    expect(text).toContain('| Gates (Raster −0) | Raster |');
    const journal = readFileSync(homePaths(home).journal, 'utf8');
    const zeile = journal.split('\n').map((l) => l.trim()).filter((l) => l.includes('"champion"')).map((l) => JSON.parse(l) as { rasterAnzahl?: number; candidateRaster?: number | null });
    expect(zeile.at(-1)?.rasterAnzahl).toBe(3);
    expect(zeile.at(-1)?.candidateRaster).toBe(1);
  });

  it('mit Kante auf jedem Stand besteht der Kandidat 3/3 und wird befördert — der Eintrag trägt Regel und Raster', () => {
    const home = tmp();
    const out = runOptimization(input(home));
    const r = out.runs[0]!;
    expect(r.results[0]!.raster.map((u) => u.pass)).toEqual([true, true, true]);
    expect(r.results[0]!.rasterPass).toBe(true);
    expect(r.decision.action).toBe('promote');
    const e = out.champion.symbols.AAA!;
    expect(e.regel).toBe(REGEL_AKTUELL);
    expect(e.raster?.map((u) => u.anker)).toEqual([0, 1, 2]);
    expect(e.pruefung).toBeUndefined(); // frisch befördert, noch keine Nacht geprüft
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('Raster (Regel 2): **alle bestanden**');
  });

  it('die Raster −1/−2 sehen keinen Tag über ihrem Ende — Korb UND Parkbars sind am selben Tag geschnitten', () => {
    const home = tmp();
    const { simulate, sicht } = nurHeuteMitKante();
    runOptimization(input(home, { simulate, parkBars: dailyBars(400) }));
    const staende = [...new Set(sicht.map((s) => s.maxT))].sort((a, b) => b - a);
    expect(staende).toEqual([tLetzte, tLetzte - DAY, tLetzte - 2 * DAY]);
    for (const s of sicht) {
      expect(s.park).not.toBeNull();
      // die Parkbars enden am selben Tag wie der Korb des Rasters — nie später
      expect(s.park).toBe(s.maxT);
    }
  });

  it('promotionGrids 1 ist die alte Regel: ein Raster, ein Urteil (nur Rauchtests)', () => {
    const home = tmp();
    const { simulate } = nurHeuteMitKante();
    const out = runOptimization(input(home, { simulate, optimizer: { promotionGrids: 1 } }));
    const r = out.runs[0]!;
    expect(r.results[0]!.raster.length).toBe(1);
    expect(r.results[0]!.rasterPass).toBe(true);
    expect(r.decision.action).toBe('promote');
    expect(readFileSync(out.reportPath, 'utf8')).toContain('promotionGrids: 1 — die alte Regel');
  });
});

describe('Regel 2, R4: Altbestand wird einmal nachgeprüft', () => {
  it('ein Amtsinhaber aus Regel 1, dessen Familie heute nicht 3/3 nimmt, wird abgesetzt — ohne Bestandsschutz', () => {
    const home = tmp();
    const paths = homePaths(home);
    const plan = foldPlanForBars(bars, testConfig().optimizer);
    // Fit-Ende spät ⇒ kein sauberes OOS; nach der alten Regel bliebe er neun Monate stehen.
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag('dead', { a: 3, b: 1 }, { fitEnd: plan.folds[6]!.oosEnd, score: 0.7 }) } });
    const out = runOptimization(input(home, { strategies: ['dead'] }));
    const r = out.runs[0]!;
    expect(r.incumbentEval!.pass).toBeNull(); // sauberes OOS reicht nicht — das war bisher das Ende der Prüfung
    expect(r.altbestand).toEqual({ nachpruefungBestanden: false, raster: 3 });
    expect(r.decision.action).toBe('demote_to_notrade');
    expect(r.decision.reason).toMatch(/Altbestand aus Regel 1/);
    expect(r.decision.reason).toMatch(/Nachprüfung unter Regel 2/);
    expect(out.champion.symbols.AAA).toBeUndefined();
    expect(out.champion.noTrade.AAA!.reason).toMatch(/kein Handel/);
    // und die Erprobung übernimmt auf Papier
    expect(out.champion.erprobung?.AAA?.strategy).toBe('dead');
    expect(readFileSync(out.reportPath, 'utf8')).toContain('Altbestand aus Regel 1 — Nachprüfung unter Regel 2 **nicht bestanden**');
  });

  it('besteht seine Familie 3/3, bleibt er (oder wird von ihr abgelöst) — und der Eintrag trägt danach Regel 2', () => {
    const home = tmp();
    const paths = homePaths(home);
    const plan = foldPlanForBars(bars, testConfig().optimizer);
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag('edge', { a: 10, b: 2 }, { fitEnd: plan.folds[6]!.oosEnd, score: 1e9 }) } });
    const out = runOptimization(input(home));
    const r = out.runs[0]!;
    expect(r.altbestand).toEqual({ nachpruefungBestanden: true, raster: 3 });
    expect(r.decision.action).toBe('keep'); // Score 1e9 schlägt kein Kandidat
    expect(out.champion.symbols.AAA!.regel).toBe(REGEL_AKTUELL);
    expect(out.champion.symbols.AAA!.params).toEqual({ a: 10, b: 2 });
    expect(out.champion.symbols.AAA!.pruefung!.gerisseneNaechte).toBe(0);
  });

  it('ein Eintrag unter Regel 2 wird NICHT nachgeprüft — für ihn gilt allein die nächtliche Prüfung', () => {
    const home = tmp();
    const paths = homePaths(home);
    const plan = foldPlanForBars(bars, testConfig().optimizer);
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag('dead', { a: 3, b: 1 }, { fitEnd: plan.folds[6]!.oosEnd, score: 0.7, regel: REGEL_AKTUELL }) } });
    const out = runOptimization(input(home, { strategies: ['dead'] }));
    const r = out.runs[0]!;
    expect(r.altbestand).toBeNull();
    expect(r.decision.action).toBe('keep');
    expect(r.incumbentNacht!.gerisseneNaechte).toBe(1);
  });
});

describe('Regel 2, R3: der Amtsinhaber wird jede Nacht geprüft und nach drei gerissenen Nächten abgesetzt', () => {
  const spaet = () => foldPlanForBars(bars, testConfig().optimizer).folds[6]!.oosEnd;
  const pruefung = (gerisseneNaechte: number) => ({ gerisseneNaechte, zuletzt: 1, bestanden: false, raster: [] });

  it('zwei gerissene Nächte ⇒ keep, der Zähler steht auf 2 im Champion-Eintrag', () => {
    const home = tmp();
    saveChampion(homePaths(home).champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag('dead', { a: 3, b: 1 }, { fitEnd: spaet(), score: 0.7, regel: REGEL_AKTUELL, pruefung: pruefung(1) }) } });
    const out = runOptimization(input(home, { strategies: ['dead'] }));
    const r = out.runs[0]!;
    expect(r.incumbentNacht!.bestanden).toBe(false);
    expect(r.incumbentNacht!.raster.map((u) => u.anker)).toEqual([0, 1, 2]);
    expect(r.incumbentNacht!.gerisseneNaechte).toBe(2);
    expect(r.decision.action).toBe('keep');
    expect(out.champion.symbols.AAA!.pruefung!.gerisseneNaechte).toBe(2);
    expect(out.champion.symbols.AAA!.pruefung!.zuletzt).toBe(NOW);
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('Nächtliche Prüfung (Regel 2, feste Parameter über alle Folds, 3 Raster');
    expect(text).toContain('**gerissen** — Zähler gerissener Nächte in Folge: **2**');
  });

  it('WÄCHTER: die dritte gerissene Nacht in Folge setzt ihn ab — auch ohne sauberes OOS', () => {
    const home = tmp();
    saveChampion(homePaths(home).champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag('dead', { a: 3, b: 1 }, { fitEnd: spaet(), score: 0.7, regel: REGEL_AKTUELL, pruefung: pruefung(2) }) } });
    const out = runOptimization(input(home, { strategies: ['dead'] }));
    const r = out.runs[0]!;
    expect(r.incumbentEval!.pass).toBeNull();
    expect(r.incumbentNacht!.gerisseneNaechte).toBe(3);
    expect(r.decision.action).toBe('demote_to_notrade');
    expect(r.decision.reason).toMatch(/3 aufeinanderfolgenden Nächten/);
    expect(out.champion.symbols.AAA).toBeUndefined();
    expect(out.champion.erprobung?.AAA?.strategy).toBe('dead');
  });

  it('eine bestandene Nacht setzt den Zähler zurück', () => {
    const home = tmp();
    saveChampion(homePaths(home).champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag('edge', { a: 10, b: 2 }, { fitEnd: spaet(), score: 1e9, regel: REGEL_AKTUELL, pruefung: pruefung(2) }) } });
    const out = runOptimization(input(home));
    const r = out.runs[0]!;
    expect(r.incumbentNacht!.bestanden).toBe(true);
    expect(r.incumbentNacht!.gerisseneNaechte).toBe(0);
    expect(r.decision.action).toBe('keep');
    expect(out.champion.symbols.AAA!.pruefung!.gerisseneNaechte).toBe(0);
  });

  it('incumbentFailNights ist die Schwelle: mit 5 hält er die dritte Nacht noch', () => {
    const home = tmp();
    saveChampion(homePaths(home).champion, { ...emptyChampionFile(1), symbols: { AAA: eintrag('dead', { a: 3, b: 1 }, { fitEnd: spaet(), score: 0.7, regel: REGEL_AKTUELL, pruefung: pruefung(2) }) } });
    const out = runOptimization(input(home, { strategies: ['dead'], optimizer: { incumbentFailNights: 5 } }));
    expect(out.runs[0]!.incumbentNacht!.gerisseneNaechte).toBe(3);
    expect(out.runs[0]!.decision.action).toBe('keep');
  });
});

describe('decidePromotion mit Regel 2', () => {
  const inc = { ...eintrag('old', { a: 1 }), score: 1 };
  const cand = (score: number, pass = true) => ({ entry: { ...eintrag('new', { a: 2 }), score }, pass });
  const decide = (over: Partial<PromotionInput>) => decidePromotion({ incumbent: inc, incumbentRescore: 1, incumbentPass: null, candidate: null, margin: 0.1, ...over });

  it('Zähler unter der Schwelle: nichts ändert sich; erreicht: demote — oder promote ohne Marge, wenn ein Kandidat besteht', () => {
    expect(decide({ incumbentNaechte: { gerissen: 2, schwelle: 3 } }).action).toBe('keep');
    const d = decide({ incumbentNaechte: { gerissen: 3, schwelle: 3 } });
    expect(d.action).toBe('demote_to_notrade');
    expect(d.reason).toMatch(/3 aufeinanderfolgenden Nächten/);
    // Kandidat mit Score 0.5 < 1 × 1.1 — ohne Absetzung wäre es keep, mit Absetzung promote
    expect(decide({ candidate: cand(0.5) }).action).toBe('keep');
    const p = decide({ candidate: cand(0.5), incumbentNaechte: { gerissen: 3, schwelle: 3 } });
    expect(p.action).toBe('promote');
    expect(p.reason).toMatch(/aufeinanderfolgenden Nächten/);
  });

  it('Altbestand: Nachprüfung nicht bestanden ⇒ abgesetzt; bestanden ⇒ wie bisher', () => {
    const d = decide({ altbestand: { nachpruefungBestanden: false, raster: 3 } });
    expect(d.action).toBe('demote_to_notrade');
    expect(d.reason).toMatch(/Altbestand aus Regel 1/);
    expect(decide({ altbestand: { nachpruefungBestanden: true, raster: 3 } }).action).toBe('keep');
    expect(decide({ candidate: cand(0.5), altbestand: { nachpruefungBestanden: false, raster: 3 } }).action).toBe('promote');
  });

  it('ein Kandidat, der nicht besteht, befördert nie — auch wenn der Amtsinhaber abgesetzt ist', () => {
    const d = decide({ candidate: cand(9, false), incumbentNaechte: { gerissen: 3, schwelle: 3 } });
    expect(d.action).toBe('demote_to_notrade');
    expect(d.reason).toMatch(/fällt durch die Gates/);
  });
});

describe('Nahtwächter', () => {
  it('die Beförderungsfrage liest rasterPass, nie pass allein', () => {
    const src = readFileSync('src/optimize/run.ts', 'utf8');
    expect(src).toMatch(/const bestPassed = results\.find\(\(r\) => r\.rasterPass\)/);
    expect(src).not.toMatch(/const bestPassed = results\.find\(\(r\) => r\.pass\)/);
  });

  it('BarSeries-Schnitt und dailyBars passen zusammen (Testvoraussetzung)', () => {
    expect(bars).toBeInstanceOf(BarSeries);
  });
});
