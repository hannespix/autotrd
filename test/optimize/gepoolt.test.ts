/**
 * Gepoolte Bewertung im Optimierer.
 *
 * Je Symbol lautet die Frage „hat die Strategie eine Kante auf LTC?" — bei
 * 33 OOS-Trades gegen ein Gate von 60 nicht zu beantworten. Gepoolt lautet
 * sie „hat sie eine Kante in dieser Assetklasse?", mit der Trade-Zahl des
 * ganzen Korbs. Zugleich fällt ein ungezählter Freiheitsgrad weg: „bestes
 * Symbol aus dreißig" ist selbst eine Auswahl.
 *
 * Was hier festgehalten wird, ist die Mechanik — nicht das Ergebnis:
 * EIN Lauf für den Korb, EINE Entscheidung, derselbe Eintrag für jedes
 * Symbol (damit Engine und Frontend unverändert bleiben), und ein je Symbol
 * gefitteter Champion gilt NICHT als Amtsinhaber eines Korb-Kandidaten.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../src/core/journal.ts';
import type { Strategy } from '../../src/core/types.ts';
import { loadChampion, saveChampion, emptyChampionFile, type ChampionEntry } from '../../src/optimize/promote.ts';
import { runOptimization, type OptimizeRunInput } from '../../src/optimize/run.ts';
import { DEAD_PROFILE, NOISE_PROFILE, REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

const bars = dailyBars(400);
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const KORB = ['AAA', 'BBB', 'CCC'];

const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), noise: fakeStrategy('noise'), dead: fakeStrategy('dead') };
const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, noise: NOISE_PROFILE, dead: DEAD_PROFILE };
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
  const d = mkdtempSync(join(tmpdir(), 'autotrd-pool-'));
  dirs.push(d);
  return d;
};

function input(home: string, pooled: boolean, over: { symbols?: string[]; barsFor?: OptimizeRunInput['barsFor'] } = {}): OptimizeRunInput {
  const symbols = over.symbols ?? KORB;
  return {
    config: testConfig({ symbols, home, optimizer: { seed: 7, pooled } }),
    symbols,
    strategies: ['edge', 'noise'],
    barsFor: over.barsFor ?? (() => bars),
    home,
    initialEquity: 10_000,
    simulate: makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE),
    metricsFns: fakeMetricsFns,
    getStrategy,
    now: () => NOW,
  };
}

describe('gepoolt: eine Einheit statt einer je Symbol', () => {
  it('bewertet den Korb EINMAL statt dreimal', () => {
    const home = tmp();
    const out = runOptimization(input(home, true));
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]!.symbol).toContain('3 Symbole');
  });

  it('je Symbol bleibt unverändert: eine Einheit je Symbol', () => {
    const home = tmp();
    const out = runOptimization(input(home, false));
    expect(out.runs.map((r) => r.symbol)).toEqual(KORB);
  });

  it('schreibt denselben Eintrag für JEDES Symbol — Engine und Frontend bleiben unberührt', () => {
    const home = tmp();
    const out = runOptimization(input(home, true));
    const champ = loadChampion(homePaths(home).champion)!;
    const eintraege = KORB.map((s) => champ.symbols[s]);
    // Entweder alle drei handeln mit demselben Satz, oder keiner handelt.
    if (eintraege[0]) {
      for (const e of eintraege) {
        expect(e, 'jedes Symbol des Korbs braucht denselben Eintrag').toBeDefined();
        expect(e!.strategy).toBe(eintraege[0]!.strategy);
        expect(e!.params).toEqual(eintraege[0]!.params);
        expect(e!.fitEnd).toBe(eintraege[0]!.fitEnd);
      }
    } else {
      for (const s of KORB) expect(champ.noTrade[s], `${s} müsste in noTrade stehen`).toBeDefined();
    }
    expect(out.runs[0]!.decision.action).toBeTruthy();
  });

  it('Symbole ohne Bars fallen aus dem Korb, bekommen aber die Entscheidung', () => {
    const home = tmp();
    const out = runOptimization(
      input(home, true, {
        barsFor: (s: string) => {
          if (s === 'CCC') throw new Error('keine Daten');
          return bars;
        },
      }),
    );
    // Der Korb rechnet mit zweien …
    expect(out.runs[0]!.symbol).toContain('2 Symbole');
    // … der Fehler steht im Bericht, nicht stumm im Nichts …
    expect(out.runs[0]!.errors.join(' ')).toContain('CCC');
    // … und CCC behält keinen alten Champion still weiter.
    const champ = loadChampion(homePaths(home).champion)!;
    expect(champ.symbols['CCC'] ?? champ.noTrade['CCC']).toBeDefined();
  });

  it('der Bericht nennt den Korb', () => {
    const home = tmp();
    const out = runOptimization(input(home, true));
    expect(readFileSync(out.reportPath, 'utf8')).toContain('Korb');
  });
});

describe('gepoolt: Amtsinhaber', () => {
  /** Champion-Eintrag, wie ihn ein früherer Lauf hinterlassen hätte. */
  function eintrag(strategy: string, params: Record<string, number>, fitEnd: number): ChampionEntry {
    return {
      strategy, params, timeframe: 1440, score: 5,
      oos: { objectiveMedian: 5, objectiveMean: 5, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
      gates: [], decidedAt: 1, trials: 1, dataRange: { start: 0, end: 1 }, fitEnd,
    };
  }

  it('ein JE SYMBOL gefitteter Champion gilt nicht als Amtsinhaber des Korbs', () => {
    const home = tmp();
    const datei = emptyChampionFile(1);
    // Verschiedene Parameter je Symbol — typisch für einen Lauf im alten Modus.
    datei.symbols['AAA'] = eintrag('edge', { a: 10, b: 1 }, 111);
    datei.symbols['BBB'] = eintrag('edge', { a: 4, b: 1 }, 111);
    datei.symbols['CCC'] = eintrag('edge', { a: 7, b: 1 }, 111);
    saveChampion(homePaths(home).champion, datei);

    const out = runOptimization(input(home, true));
    // Kein Amtsinhaber ⇒ der Kandidat muss keine Marge gegen etwas
    // Unvergleichbares erreichen.
    expect(out.runs[0]!.incumbent).toBeNull();
  });

  it('ein GEPOOLTER Champion (überall identisch) gilt als Amtsinhaber', () => {
    const home = tmp();
    const datei = emptyChampionFile(1);
    for (const s of KORB) datei.symbols[s] = eintrag('edge', { a: 10, b: 1 }, 111);
    saveChampion(homePaths(home).champion, datei);

    const out = runOptimization(input(home, true));
    expect(out.runs[0]!.incumbent).not.toBeNull();
    expect(out.runs[0]!.incumbent!.strategy).toBe('edge');
  });
});
