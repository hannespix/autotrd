/**
 * Verdrahtung des Geldmarkt-Parkens in die MESSUNG — die Wächter, ohne die
 * die Funktion tot bzw. gefährlich wäre.
 *
 * Drei Dinge werden hier bewiesen:
 *
 *  1. **Die Parkbars erreichen jeden Simulationslauf.** Ohne sie parkt der
 *     Simulator nicht (er sagt es laut), und ein Lauf misst dann NICHTS —
 *     genau die Lücke, wegen der `SimInput.parkBars` gefüllt werden muss.
 *  2. **Die Parkbars landen in KEINEM Korb.** Aus `SimInput.bars` entstehen
 *     Zeitachse, Fold-Plan, Korb je Fold, Rangliste, `strategyFor` und der
 *     Maßstab. Eine verirrte Bar hat den Fold-Plan schon einmal ins Leere
 *     gezogen (core/bars.ts, `anfangsStreuner`); das Parksymbol darf diese
 *     Tür nicht öffnen. Es reist ausschließlich im eigenen Feld.
 *  3. **Ein Infrastruktursymbol ist für keine Strategie erreichbar.** Weder
 *     über `universe.symbols`/`candidates` noch über den Basis-Korb noch über
 *     ein Sleeve-Universum — und `strategyChoice` gibt für das Parksymbol
 *     auch dann null, wenn es auf einem Weg ins Universum gerät, den
 *     `parseConfig` nicht sieht (`engineConfig` erweitert es NACH der
 *     Prüfung um den Korb der Basis-Stufe aus champion.json).
 *
 * Dazu die Designfrage vom 13.09.2026: Park- und Zinssymbol dürfen DASSELBE
 * Papier sein. Vorher musste `optimizer.riskFreeSymbol` im Kandidatenpool
 * stehen (sonst lud `fetch` es nicht) und `risk.cashParking.symbol` durfte es
 * nicht — beides zugleich war unmöglich, also wäre die Differenz aus
 * Laufzeit und Kostenquote zweier Papiere in die Überschussrendite gelaufen.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap, engineConfig, fetchSymbols, infrastrukturSymbole, strategyChoice, type App } from '../../src/app.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { ConfigError, parseConfig } from '../../src/core/config.ts';
import { homePaths } from '../../src/core/journal.ts';
import { setLogSink } from '../../src/core/log.ts';
import { DAY } from '../../src/core/time.ts';
import type { Strategy } from '../../src/core/types.ts';
import { saveChampion, type ChampionFile } from '../../src/optimize/promote.ts';
import { runOptimization } from '../../src/optimize/run.ts';
import type { SimInput, SimulateFn } from '../../src/optimize/walkForward.ts';
import { REWARD_PROFILE, T0, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig } from './fakes.ts';

setLogSink(() => undefined);

const PARK = 'BIL';
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'autotrd-parkverdrahtung-'));
  dirs.push(d);
  return d;
};

/**
 * Parkbars mit ERKENNBAR anderer Zeitachse als der Korb: eine halbe Bar
 * versetzt und länger. Geriete auch nur eine davon in `bars`, verschöbe sie
 * Zeitachse und Fold-Plan — der Wächter unten würde es sehen.
 */
function parkBars(days: number): BarSeries {
  const out = [];
  for (let i = 0; i < days; i++) {
    const t = T0 - 50 * DAY + i * DAY + DAY / 2;
    out.push({ t, o: 100, h: 100.1, l: 99.9, c: 100, v: 5000 });
  }
  return BarSeries.from(out);
}

describe('Parkbars im Optimierer', () => {
  const strategien: Record<string, Strategy> = { edge: fakeStrategy('edge'), defensiv: fakeStrategy('defensiv') };

  /** Ein Lauf mit Ensemble — der Pfad mit den MEISTEN Simulationsaufrufen (Solo, IS, OOS, Stress, Nachbarschaft, Holdout). */
  function lauf(over: { park?: BarSeries | undefined; parken?: boolean } = {}) {
    const home = tmp();
    const symbols = ['AAA', 'BBB'];
    const cfg = testConfig({
      symbols,
      home,
      ...(over.parken === false ? {} : { risk: { cashParking: { enabled: true, symbol: PARK, bandPct: 5, bufferPct: 2 } } }),
      optimizer: {
        lookbackDays: 400,
        isDays: 120,
        oosDays: 30,
        stepDays: 30,
        holdoutDays: 30,
        pooled: true,
        ensembles: [
          {
            label: 'E1',
            weighting: 'equal',
            sleeves: [
              { strategy: 'edge', universe: 'korb', label: 'Aktien' },
              { strategy: 'defensiv', universe: 'fixed', symbols: ['DEF1', 'DEF2'], label: 'Defensive' },
            ],
          },
        ] as never,
      },
    });
    const roh = makeFakeSimulate(() => REWARD_PROFILE);
    const eingaben: SimInput[] = [];
    const simulate: SimulateFn = (input) => {
      eingaben.push(input);
      return roh(input);
    };
    const out = runOptimization({
      config: cfg,
      symbols,
      strategies: ['edge'],
      barsFor: () => dailyBars(400),
      home,
      initialEquity: 25_000,
      simulate,
      metricsFns: fakeMetricsFns,
      getStrategy: (id) => strategien[id] ?? fakeStrategy(id),
      now: () => NOW,
      ...('park' in over ? { parkBars: over.park } : {}),
    });
    return { out, eingaben, cfg };
  }

  it('die Parkbars erreichen JEDEN Simulationslauf über SimInput.parkBars — sonst misst der Lauf nichts', () => {
    const serie = parkBars(450);
    const { eingaben } = lauf({ park: serie });
    expect(eingaben.length).toBeGreaterThan(10);
    for (const input of eingaben) expect(input.parkBars).toBe(serie);
  });

  it('WÄCHTER: die Parkbars landen in KEINEM Korb — nicht in bars, nicht in der Zeitachse', () => {
    const serie = parkBars(450);
    const { eingaben } = lauf({ park: serie });
    for (const input of eingaben) {
      expect([...input.bars.keys()]).not.toContain(PARK);
      for (const [sym, b] of input.bars) {
        expect(b, `${sym} trägt die Parkserie`).not.toBe(serie);
        // Und keine einzige Parkzeit steckt in einer Korbserie: Die Parkbars
        // liegen um eine halbe Bar versetzt — ein Treffer wäre eine Vermischung.
        expect(b.t[0]! % DAY, `${sym}: fremde Zeitachse im Korb`).toBe(T0 % DAY);
      }
      // `strategyFor` kennt das Parksymbol nicht: keine Strategie, kein Sizing.
      expect(input.strategyFor(PARK)).toBeNull();
    }
  });

  it('ohne Parkbars bleibt das Feld leer — der Simulator sagt dann laut, dass er NICHT geparkt hat', () => {
    const { eingaben } = lauf();
    for (const input of eingaben) expect(input.parkBars).toBeUndefined();
  });
});

describe('Infrastruktursymbole: geladen, nie gehandelt', () => {
  it('`fetch` lädt Park- UND Zinssymbol, ohne dass eines im Pool steht', () => {
    const cfg = parseConfig({
      universe: { symbols: ['AAA'], benchmark: 'SPY', candidates: ['AAA', 'CCC'] },
      timeframe: 1440,
      risk: { cashParking: { enabled: true, symbol: PARK } },
      optimizer: { riskFreeSymbol: 'SHV' },
    });
    expect(infrastrukturSymbole(cfg).sort()).toEqual(['BIL', 'SHV']);
    const geladen = fetchSymbols(cfg);
    expect(geladen).toContain(PARK);
    expect(geladen).toContain('SHV');
    // … und keines der beiden ist dadurch Kandidat oder Handelssymbol geworden.
    expect(cfg.universe.symbols).not.toContain(PARK);
    expect(cfg.universe.candidates).not.toContain(PARK);
    expect(cfg.universe.candidates).not.toContain('SHV');
  });

  it('Park- und Zinssymbol dürfen DASSELBE Papier sein — ein Symbol, eine Ladung, kein Spread', () => {
    const cfg = parseConfig({
      universe: { symbols: ['AAA'], benchmark: 'SPY' },
      timeframe: 1440,
      risk: { cashParking: { enabled: true, symbol: PARK } },
      optimizer: { riskFreeSymbol: PARK },
    });
    expect(cfg.risk.cashParking.symbol).toBe(cfg.optimizer.riskFreeSymbol);
    expect(infrastrukturSymbole(cfg)).toEqual([PARK]);
    expect(fetchSymbols(cfg).filter((s) => s === PARK)).toEqual([PARK]);
  });

  it('WÄCHTER: ein Infrastruktursymbol kann nicht gehandelt werden — Universum, Pool, Basis-Korb, Sleeve', () => {
    const basis = {
      universe: { symbols: ['AAA'], candidates: ['AAA', PARK] },
      timeframe: 1440,
      optimizer: { fixedCandidates: [{ strategy: 'regime_allocation', tier: 'basis' }], basisUniverse: ['AAA', PARK] },
      risk: { cashParking: { enabled: true, symbol: PARK } },
    };
    // Kandidatenpool
    expect(() => parseConfig(basis)).toThrow(/Parksymbol|cashParking/);
    // Handelsuniversum
    expect(() => parseConfig({ ...basis, universe: { symbols: ['AAA', PARK] }, optimizer: { fixedCandidates: [], basisUniverse: [] } })).toThrow(ConfigError);
    // Eigener Korb der Basis-Allokation (steht NICHT in universe.symbols)
    expect(() =>
      parseConfig({
        universe: { symbols: ['AAA'] },
        timeframe: 1440,
        optimizer: { fixedCandidates: [{ strategy: 'regime_allocation', tier: 'basis' }], basisUniverse: ['AAA', PARK] },
        risk: { cashParking: { enabled: true, symbol: PARK } },
      }),
    ).toThrow(/optimizer\.basisUniverse/);
    // Vorregistriertes Sleeve-Universum eines Ensembles (der Geldmarkt-Pol!)
    expect(() =>
      parseConfig({
        universe: { symbols: ['AAA'] },
        timeframe: 1440,
        risk: { cashParking: { enabled: true, symbol: PARK } },
        optimizer: {
          ensembles: [
            {
              label: 'E1',
              weighting: 'equal',
              sleeves: [
                { strategy: 'momentum_pullback', universe: 'korb', label: 'Aktien' },
                { strategy: 'vigilant_allocation', universe: 'fixed', symbols: ['SPY', PARK], label: 'Defensive' },
              ],
            },
          ],
        },
      }),
    ).toThrow(/optimizer\.ensembles/);
    // Und der Maßstab ist es auch nicht.
    expect(() => parseConfig({ universe: { symbols: ['AAA'], benchmark: PARK }, risk: { cashParking: { enabled: true, symbol: PARK } } })).toThrow(/benchmark/);
  });

  it('WÄCHTER: `strategyChoice` gibt für das Parksymbol null — auch wenn der Basis-Korb es ins Universum trägt', () => {
    const home = tmp();
    const cfgPfad = join(home, 'cfg.yaml');
    // Ohne Kandidatenpool wird der Basis-Korb NICHT gegen den Pool geprüft
    // (core/basisTier.ts) — genau der Weg, auf dem ein fremdes Symbol ins
    // Universum kommt, ohne je durch `parseConfig` gegangen zu sein.
    writeFileSync(cfgPfad, `universe:\n  symbols: [AAA]\ntimeframe: 1440\nrisk:\n  cashParking:\n    enabled: true\n    symbol: ${PARK}\n`, 'utf8');
    // Champion aus einer ANDEREN Quelle (champion.json): Sein Basis-Korb nennt
    // das Parksymbol. `engineConfig` erweitert das Universum darum — NACH
    // `parseConfig`, das den Fall sonst abgewiesen hätte.
    const champion: ChampionFile = {
      version: 1,
      updatedAt: NOW,
      symbols: {},
      noTrade: {},
      basis: {
        version: 1,
        strategy: 'regime_allocation',
        params: {},
        positionPct: 20,
        timeframe: 1440,
        symbols: ['AAA', PARK],
        pass: true,
        gates: [],
        measuredAt: NOW,
        label: 'Basis',
      },
    };
    saveChampion(homePaths(home).champion, champion);
    const app: App = bootstrap({ config: cfgPfad, env: join(home, 'keine.env'), home });
    expect(engineConfig(app).universe.symbols).toContain(PARK);
    expect(strategyChoice(app, PARK)).toBeNull();
    expect(strategyChoice(app, 'AAA')).not.toBeNull();
  });
});
