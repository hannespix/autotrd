/**
 * Die Ensemble-Einheit — mehrere Sleeves, EINE Simulation, dieselben zehn
 * Gates.
 *
 * Ein Ensemble ist die gefährlichste Stelle im Repo (Vorregistrierung
 * `2026-09-12-ensemble.md`): Es ist die Konstruktion, mit der man sich
 * Beständigkeit erkaufen KÖNNTE, ohne eine zu haben. Diese Datei bewacht
 * deshalb genau die vier Stellen, an denen das passieren würde:
 *
 *  1. **Sleeves rangieren getrennt.** Zwei Sleeves in einem Zyklus dürfen
 *     ihre Kennzahlen nie in eine gemeinsame Rangliste werfen — die Zahlen
 *     bedeuten Verschiedenes. Die Trennung leistet `korbSchluessel` in
 *     `decide()`, und nichts sonst; hier wird bewiesen, dass sie greift.
 *  2. **Ein Sleeve frisst die Plätze der anderen nicht.** Die Plätze sind im
 *     Alpha-Pfad die Währung des Budgets (Risiko je Trade × gleichzeitige
 *     Positionen). Ein Plan, in dem ein Sleeve leer ausgeht, ist keine
 *     Einheit, sondern der alte Kandidat mit einem Feigenblatt.
 *  3. **Die Gewichte sind kausal.** Eine Gewichtsregel, die in ihr eigenes
 *     Fenster schaut, ist Lookahead in Reinform — und zwar besonders
 *     hinterhältig, weil jede Sleeve-Zeitreihe dabei kausal aussieht.
 *  4. **Kein Gate wird angefasst.** Dieselben Namen, dieselben Schwellen wie
 *     bei jedem anderen Kandidaten, und der DSR sagt „nicht anwendbar".
 *
 * Dazu die Konstruktionsfehler, die LAUT scheitern müssen: überlappende
 * Sleeve-Universen, zwei Sleeves auf demselben Korb, dieselbe Strategie
 * zweimal, und ein IS-Fenster, das das Embargo des langsamsten Sleeves nicht
 * trägt.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { ConfigError, parseConfig } from '../../src/core/config.ts';
import { korbRaenge, korbSchluessel, type SymbolInput } from '../../src/core/logic.ts';
import { DAY } from '../../src/core/time.ts';
import type { Bar, Decision, IndicatorSet, Params, Strategy, SymbolSnapshot } from '../../src/core/types.ts';
import { TIMEFRAMES } from '../../src/core/types.ts';
import {
  VOLA_FENSTER,
  ensembleEmbargoEnde,
  ensemblePlan,
  gewichteVor,
  korbZuordnung,
  maxGleichzeitig,
  messeEnsemble,
  plaetzeJeSleeve,
  sigmaVor,
  versuche,
  wahlFuerZuordnung,
  type EnsemblePlan,
} from '../../src/optimize/ensemble.ts';
import { homePaths } from '../../src/core/journal.ts';
import { loadChampion } from '../../src/optimize/promote.ts';
import { nichtsGemessen, runOptimization } from '../../src/optimize/run.ts';
import { deflatedSharpeIs, probabilisticSharpeOos, robustnessGates } from '../../src/optimize/robustness.ts';
import { foldPlanForBars, zeitachseVon } from '../../src/optimize/walkForward.ts';
import type { Renditereihe } from '../../src/backtest/aktivitaet.ts';
import { REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig, type FakeSimOptions } from './fakes.ts';

/* ───────────────────────── Hilfen ───────────────────────── */

const gleichParams = (s: Strategy, p: Params): Params => ({ ...s.defaults, ...p });

function planVon(a: {
  label?: string;
  weighting?: 'equal' | 'inverse_vol';
  sleeves: { strategy: string; params?: Params; universe?: 'korb' | 'fixed'; symbols?: string[]; label?: string }[];
  strategien: Record<string, Strategy>;
  optimizerOver?: Record<string, unknown>;
}): EnsemblePlan {
  const cfg = testConfig({ optimizer: a.optimizerOver as never });
  return ensemblePlan({
    ensemble: {
      label: a.label ?? 'E-Test',
      weighting: a.weighting ?? 'equal',
      sleeves: a.sleeves.map((s) => ({
        strategy: s.strategy,
        params: s.params ?? {},
        universe: s.universe ?? 'korb',
        symbols: s.symbols ?? [],
        ...(s.label ? { label: s.label } : {}),
      })),
    },
    getStrategy: (id) => a.strategien[id] ?? fakeStrategy(id),
    paramsFor: gleichParams,
    timeframe: 1440,
    optimizer: cfg.optimizer,
  });
}

/** Bars für einen Korb: jedes Symbol dieselbe Zeitachse (wie bei Tagesbars derselben Assetklasse). */
function korbBars(symbols: readonly string[], days: number): Map<string, BarSeries> {
  return new Map(symbols.map((s) => [s, dailyBars(days)]));
}

/** Renditereihe aus Tagen ab 2024-01-01 mit den gegebenen Werten. */
function reihe(werte: number[]): Renditereihe {
  const tage = werte.map((_, i) => new Date(Date.UTC(2024, 0, 1) + i * DAY).toISOString().slice(0, 10));
  return { tage, renditen: [...werte] };
}

/* ───────────────────────── 1. Sleeves rangieren getrennt ───────────────────────── */

const BUCKET = 86_400_000;
const okSession = { isRegularSession: true, minutesToClose: 200, minutesSinceOpen: 100, barsSinceOpen: 20, isLastBarOfDay: false, day: '2026-09-04' };

function serie(closes: number[]): BarSeries {
  const bars: Bar[] = closes.map((c, k) => ({ t: k * BUCKET, o: c, h: c + 1, l: c - 1, c, v: 1000 }));
  return BarSeries.from(bars);
}

/** Querschnitts-Strategie, deren Kennzahl der Close der Entscheidungs-Bar ist. */
function ranker(id: string): Strategy {
  return {
    id,
    timeframes: TIMEFRAMES,
    paramSpace: [],
    defaults: {},
    holdsOvernight: true,
    warmupBars: () => 1,
    precompute: () => ({}),
    decide: (): Decision => ({ kind: 'hold' }),
    crossScore: (snap: SymbolSnapshot): number | null => snap.bars.c[snap.i] ?? null,
  };
}

function rangInput(symbol: string, close: number, strategy: Strategy, params: Params = {}): SymbolInput {
  return { snap: { symbol, bars: serie([1, 1, close]), i: 2, position: null, session: okSession }, strategy, params, ind: {} as IndicatorSet };
}

describe('Sleeves rangieren getrennt', () => {
  /**
   * WÄCHTER 1. Zwei Sleeves in EINEM Zyklus: Ihre Kennzahlen bedeuten
   * Verschiedenes (13612W gegen −RSI), und eine gemeinsame Rangliste wäre
   * schlicht falsch — der Sleeve mit der größeren Zahlenskala bekäme jeden
   * knappen Platz. `korbSchluessel` trennt sie über Strategie, Parameter und
   * Sizing-Semantik; das Ensemble sortiert selbst NICHTS (CLAUDE.md §0.2:
   * die Rangliste baut ausschließlich `decide()`).
   */
  it('jeder Sleeve rangiert nur gegen sich selbst — `of` ist die Größe SEINES Korbs', () => {
    const a = ranker('sleeve_a');
    const b = ranker('sleeve_b');
    const raenge = korbRaenge([
      rangInput('A1', 10, a),
      rangInput('A2', 30, a),
      rangInput('A3', 20, a),
      // Der zweite Sleeve hat eine viel größere Skala. Rangierte man gemeinsam,
      // stünden B1/B2 auf Rang 1 und 2 und nähmen dem ersten Sleeve die Plätze.
      rangInput('B1', 900, b),
      rangInput('B2', 800, b),
    ]);
    expect(raenge.get('A2')).toEqual({ pct: 0, rank: 1, of: 3 });
    expect(raenge.get('A3')).toEqual({ pct: 0.5, rank: 2, of: 3 });
    expect(raenge.get('A1')).toEqual({ pct: 1, rank: 3, of: 3 });
    expect(raenge.get('B1')).toEqual({ pct: 0, rank: 1, of: 2 });
    expect(raenge.get('B2')).toEqual({ pct: 1, rank: 2, of: 2 });
  });

  it('trennt auch zwei Sleeves DERSELBEN Familie mit verschiedenen Parametern', () => {
    const s = ranker('gleiche_familie');
    const raenge = korbRaenge([
      rangInput('X1', 10, s, { topN: 2 }),
      rangInput('X2', 30, s, { topN: 2 }),
      rangInput('Y1', 900, s, { topN: 5 }),
    ]);
    expect(raenge.get('X2')?.of).toBe(2);
    expect(raenge.get('Y1')).toEqual({ pct: 0, rank: 1, of: 1 });
  });

  it('die Wahl des Ensembles liefert je Sleeve einen eigenen Korbschlüssel', () => {
    const plan = planVon({
      sleeves: [
        { strategy: 'aktien', universe: 'korb' },
        { strategy: 'defensiv', universe: 'fixed', symbols: ['BIL', 'GLD'] },
      ],
      strategien: { aktien: fakeStrategy('aktien'), defensiv: fakeStrategy('defensiv') },
    });
    const alle = korbBars(['AAA', 'BBB', 'BIL', 'GLD'], 10);
    const z = korbZuordnung({ plan, alle });
    const wahl = wahlFuerZuordnung(plan, z.sleeveVon);
    const keys = new Set(
      ['AAA', 'BBB', 'BIL', 'GLD'].map((s) => {
        const w = wahl(s)!;
        return korbSchluessel({ strategy: w.strategy, params: w.params, sizing: w.sizing });
      }),
    );
    expect(keys.size).toBe(2);
  });
});

/* ───────────────────────── 2. Plätze: keiner verdrängt den anderen ───────────────────────── */

describe('plaetzeJeSleeve', () => {
  /**
   * WÄCHTER 2. Der Fall, in dem ein Sleeve die anderen verdrängt: Seine
   * Gewichtsregel gibt ihm fast alles. Er bekommt trotzdem nicht alle Plätze,
   * weil jeder Sleeve einen behält — sonst wäre die Einheit in genau den
   * Quartalen leer, für die sie gebaut wurde (Befund M5 der Basis-Prüfung:
   * „Alpha vor Basis gilt je Symbol, nicht je Platz").
   */
  it('gibt jedem Sleeve mindestens einen Platz, auch bei erdrückendem Gewicht', () => {
    expect(plaetzeJeSleeve([0.97, 0.02, 0.01], 4)).toEqual([2, 1, 1]);
    expect(plaetzeJeSleeve([0.999, 0.001], 4)).toEqual([3, 1]);
    expect(plaetzeJeSleeve([0.5, 0.5], 2)).toEqual([1, 1]);
  });

  it('verteilt die restlichen Plätze nach Anspruch und summiert immer auf maxPositions', () => {
    expect(plaetzeJeSleeve([0.5, 0.5], 4)).toEqual([2, 2]);
    expect(plaetzeJeSleeve([0.75, 0.25], 4)).toEqual([3, 1]);
    // 0,6/0,25/0,15 × 6 = 3,6 / 1,5 / 0,9 ⇒ 4 / 1 / 1: Der Rest geht an den
    // größten offenen Anspruch, und der Kleinste behält seinen Pflichtplatz.
    expect(plaetzeJeSleeve([0.6, 0.25, 0.15], 6)).toEqual([4, 1, 1]);
    for (const g of [[0.4, 0.35, 0.25], [0.9, 0.05, 0.05], [0.34, 0.33, 0.33]]) {
      for (const max of [3, 4, 5, 8, 12]) {
        const p = plaetzeJeSleeve(g, max);
        expect(p.reduce((x, y) => x + y, 0)).toBe(max);
        expect(Math.min(...p)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('ist deterministisch bei Gleichstand (kleinerer Index zuerst)', () => {
    expect(plaetzeJeSleeve([1 / 3, 1 / 3, 1 / 3], 4)).toEqual([2, 1, 1]);
  });

  it('scheitert LAUT, wenn es weniger Plätze als Sleeves gibt', () => {
    expect(() => plaetzeJeSleeve([0.34, 0.33, 0.33], 2)).toThrow(/mindestens 3 Plätze/);
  });
});

describe('maxGleichzeitig', () => {
  const t = (entry: number, exit: number) =>
    ({ symbol: 'X', side: 'long', qty: 1, entryTime: entry, entryPrice: 1, exitTime: exit, exitPrice: 1, grossPnl: 0, fees: 0, netPnl: 0, rMultiple: null, exitReason: 'signal', strategy: 's', barsHeld: 1, mae: null, mfe: null }) as const;

  it('zählt überlappende Positionen und nicht bloß Trades', () => {
    expect(maxGleichzeitig([t(0, 10), t(1, 10), t(2, 3)])).toBe(3);
    expect(maxGleichzeitig([t(0, 1), t(1, 2), t(2, 3)])).toBe(1);
    expect(maxGleichzeitig([])).toBe(0);
  });
});

/* ───────────────────────── 3. Gewichte: kausal und ungefittet ───────────────────────── */

describe('Gewichtsregel', () => {
  it('das Vola-Fenster ist vorregistriert und steht als Konstante im Code', () => {
    expect(VOLA_FENSTER).toBe(60);
  });

  it('gleichgewichtet heißt gleichgewichtet — ohne Blick in irgendwelche Daten', () => {
    const g = gewichteVor({ reihen: [reihe([0.1, -0.2]), reihe([0.001])], bis: '2099-01-01', regel: 'equal' });
    expect(g.werte).toEqual([0.5, 0.5]);
    expect(g.aufwaermphase).toBe(false);
  });

  it('inverse Vola: der ruhigere Sleeve bekommt den größeren Anteil', () => {
    // σ ≈ 0,02 gegen σ ≈ 0,002 ⇒ rund 1 : 10.
    const laut = reihe(Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.02)));
    const leise = reihe(Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0.002 : -0.002)));
    const g = gewichteVor({ reihen: [laut, leise], bis: '2099-01-01', regel: 'inverse_vol' });
    expect(g.aufwaermphase).toBe(false);
    expect(g.werte[1]!).toBeGreaterThan(g.werte[0]!);
    expect(g.werte[0]! + g.werte[1]!).toBeCloseTo(1, 12);
    expect(g.werte[1]! / g.werte[0]!).toBeCloseTo(10, 1);
  });

  /**
   * WÄCHTER 3. DER Lookahead-Test der Gewichte. Dieselbe Regel, derselbe
   * Stichtag — einmal mit und einmal ohne die Zukunft in den Reihen. Kommt
   * etwas anderes heraus, gewichtet die Einheit ein Fenster mit Zahlen aus
   * diesem Fenster, und jede Gate-Zahl darüber ist wertlos.
   */
  it('sieht nur Handelstage VOR dem Stichtag — angehängte Zukunft ändert nichts', () => {
    const basis = Array.from({ length: 70 }, (_, i) => (i % 3 === 0 ? 0.01 : -0.005));
    const zweite = Array.from({ length: 70 }, (_, i) => (i % 2 === 0 ? 0.004 : -0.006));
    const bis = reihe(basis).tage[65]!;
    const ohne = gewichteVor({ reihen: [reihe(basis.slice(0, 65)), reihe(zweite.slice(0, 65))], bis, regel: 'inverse_vol' });
    // Dieselben Reihen, aber mit fünf weiteren Tagen — und zwar EXTREMEN, die
    // jedes σ sichtbar verschieben würden, käme auch nur einer davon an.
    const mitZukunft = gewichteVor({
      reihen: [reihe([...basis.slice(0, 65), 0.9, -0.9, 0.9, -0.9, 0.9]), reihe([...zweite.slice(0, 65), 0.9, -0.9, 0.9, -0.9, 0.9])],
      bis,
      regel: 'inverse_vol',
    });
    expect(mitZukunft.werte).toEqual(ohne.werte);
    expect(mitZukunft.sigmas).toEqual(ohne.sigmas);
  });

  it('der Stichtag selbst zählt NICHT mit — sein Wert darf σ nicht verändern', () => {
    // Bewusst KEINE symmetrische Reihe: Eine alternierende ±0,01-Folge hätte
    // dieselbe Streuung, ob man sie um einen Tag verschiebt oder nicht — der
    // Test prüfte dann nichts (beim absichtlichen Bruch aufgefallen).
    const werte = Array.from({ length: 60 }, (_, i) => 0.001 * ((i % 7) - 3));
    const bis = reihe([...werte, 0]).tage[60]!;
    const ohne = sigmaVor(reihe(werte), bis);
    expect(ohne).not.toBeNull();
    // Derselbe Stichtag, aber der Tag DES Stichtags trägt einen Ausreißer.
    // Zählte er mit, änderte sich σ sichtbar.
    expect(sigmaVor(reihe([...werte, 0.5]), bis)).toEqual(ohne);
    // Und eine Reihe mit 59 Tagen VOR dem Stichtag bleibt unbestimmbar, auch
    // wenn danach beliebig viele Tage folgen: 59 < 60.
    const frueher = reihe(werte).tage[59]!;
    expect(sigmaVor(reihe([...werte, 0.5, 0.5, 0.5]), frueher)).toBeNull();
  });

  it('Aufwärmphase: zu wenige Tage ⇒ gleichgewichtet für ALLE, nicht geraten', () => {
    const kurz = reihe(Array.from({ length: 10 }, () => 0.01));
    const lang = reihe(Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)));
    const g = gewichteVor({ reihen: [kurz, lang], bis: '2099-01-01', regel: 'inverse_vol' });
    expect(g.aufwaermphase).toBe(true);
    expect(g.werte).toEqual([0.5, 0.5]);
    expect(g.grund).toMatch(/Aufwärmphase/);
  });

  it('eine Reihe ohne Streuung ist keine Gewichtung, sondern eine Division durch null — Aufwärmphase', () => {
    const flach = reihe(Array.from({ length: 80 }, () => 0));
    const lang = reihe(Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)));
    expect(sigmaVor(flach, '2099-01-01')).toBeNull();
    expect(gewichteVor({ reihen: [flach, lang], bis: '2099-01-01', regel: 'inverse_vol' }).aufwaermphase).toBe(true);
  });
});

/* ───────────────────────── 4. Universum je Sleeve ───────────────────────── */

describe('korbZuordnung', () => {
  const plan = () =>
    planVon({
      sleeves: [
        { strategy: 'aktien', universe: 'korb', label: 'Aktien' },
        { strategy: 'defensiv', universe: 'fixed', symbols: ['BIL', 'GLD'], label: 'Defensive' },
      ],
      strategien: { aktien: fakeStrategy('aktien'), defensiv: fakeStrategy('defensiv') },
    });

  it('ein Symbol gehört genau EINEM Sleeve — der feste Sleeve hat Vorrang vor dem Korb', () => {
    const z = korbZuordnung({ plan: plan(), alle: korbBars(['AAA', 'BBB', 'GLD', 'BIL'], 10) });
    expect(z.sleeveVon.get('GLD')).toBe(1);
    expect(z.sleeveVon.get('BIL')).toBe(1);
    expect(z.sleeveVon.get('AAA')).toBe(0);
    expect(z.entzogen).toEqual(['BIL', 'GLD']);
  });

  /**
   * Der feste Sleeve IST die Vorregistrierung; die Zugehörigkeit je Fold ist
   * eine Auswahl nach Dollarumsatz, die bauartbedingt kein defensives Papier
   * enthält (Lauf #43). Filterte man ihn mit, wäre der defensive Sleeve in
   * jedem Fenster leer — und zwar stumm.
   */
  it('feste Sleeve-Symbole laufen am Korb je Fold VORBEI', () => {
    const alle = korbBars(['AAA', 'BBB', 'BIL', 'GLD'], 10);
    const membership = () => new Set(['AAA']);
    const z = korbZuordnung({ plan: plan(), alle, membership, at: 0 });
    expect([...z.korb.keys()].sort()).toEqual(['AAA', 'BIL', 'GLD']);
    expect(z.sleeveVon.get('BBB')).toBeUndefined();
    expect(z.entzogen).toEqual([]);
  });

  it('ein vorregistriertes Symbol ohne Bars fehlt sichtbar, nicht stumm', () => {
    const z = korbZuordnung({ plan: plan(), alle: korbBars(['AAA', 'GLD'], 10) });
    expect(z.fehlend).toEqual(['BIL']);
    expect(z.korb.has('BIL')).toBe(false);
  });
});

/* ───────────────────────── 5. Embargo: der langsamste bestimmt ───────────────────────── */

describe('Embargo der Einheit', () => {
  const schnell = fakeStrategy('schnell', { warmup: 5 });
  const langsam = fakeStrategy('langsam', { warmup: 255 });

  it('ist das MAXIMUM über die Sleeves, nicht das Mittel und nicht das Minimum', () => {
    const p = planVon({ sleeves: [{ strategy: 'schnell' }, { strategy: 'langsam', universe: 'fixed', symbols: ['BIL'] }], strategien: { schnell, langsam } });
    expect(p.sleeves.map((s) => s.embargoBars)).toEqual([25, 275]);
    expect(p.embargoBars).toBe(275);
    expect(p.warmupBars).toBe(255);
  });

  /**
   * Genau der Fall, an dem die erste `regime_allocation`-Fassung scheiterte
   * und wegen dem `config/vigilant-1440.yaml` auf `isDays: 550` steht: Ein
   * IS-Fenster, das kleiner ist als die Sperrzone des langsamsten Sleeves.
   * Es MUSS scheitern — ein leeres Fenster mit „0 Trades" wäre eine Messung,
   * die es nicht gibt.
   */
  it('ein zu kleines isDays scheitert LAUT und misst nicht still ein leeres Fenster', () => {
    const p = planVon({ sleeves: [{ strategy: 'schnell' }, { strategy: 'langsam', universe: 'fixed', symbols: ['BIL'] }], strategien: { schnell, langsam } });
    const achse = zeitachseVon(korbBars(['AAA'], 400));
    expect(() =>
      ensembleEmbargoEnde({ plan: p, achse, fenster: { start: achse.t[0]!, end: achse.t[200]! } }),
    ).toThrow(/Embargo \(275 Bars, gesetzt vom Sleeve langsam .*verschluckt das gesamte IS-Fenster/s);
  });

  it('ein ausreichend großes Fenster wird nur beschnitten, nicht verworfen', () => {
    const p = planVon({ sleeves: [{ strategy: 'schnell' }, { strategy: 'langsam', universe: 'fixed', symbols: ['BIL'] }], strategien: { schnell, langsam } });
    const achse = zeitachseVon(korbBars(['AAA'], 400));
    const ende = ensembleEmbargoEnde({ plan: p, achse, fenster: { start: achse.t[0]!, end: achse.t[390]! } });
    expect(ende).toBe(achse.t[390 - 275]!);
  });
});

/* ───────────────────────── 6. Config: Konstruktionsfehler scheitern laut ───────────────────────── */

function cfgMit(ensembles: unknown[], over: Record<string, unknown> = {}) {
  return parseConfig({
    universe: { assetClass: 'us_equity', symbols: ['SPY', 'QQQ'], ...over },
    timeframe: 1440,
    optimizer: { strategies: ['momentum_pullback'], oosDays: 30, stepDays: 30, ensembles },
  });
}

describe('optimizer.ensembles — Konstruktionsfehler', () => {
  it('nimmt eine gültige Einheit an und normalisiert die Symbole', () => {
    const cfg = cfgMit([
      { label: 'E1', weighting: 'inverse_vol', sleeves: [{ strategy: 'momentum_pullback' }, { strategy: 'vigilant_allocation', universe: 'fixed', symbols: ['spy', 'SPY', 'gld'] }] },
    ]);
    expect(cfg.optimizer.ensembles[0]!.sleeves[1]!.symbols).toEqual(['SPY', 'GLD']);
    expect(cfg.optimizer.ensembles[0]!.weighting).toBe('inverse_vol');
  });

  it('weist überlappende Sleeve-Universen ab — ein Symbol trägt genau EINE Strategie', () => {
    expect(() =>
      cfgMit([
        {
          label: 'E2',
          sleeves: [
            { strategy: 'vigilant_allocation', universe: 'fixed', symbols: ['SPY', 'QQQ'] },
            { strategy: 'index_reversal', universe: 'fixed', symbols: ['SPY', 'IWM'] },
          ],
        },
      ]),
    ).toThrow(ConfigError);
  });

  it('weist zwei Sleeves auf demselben Korb ab', () => {
    expect(() => cfgMit([{ label: 'E', sleeves: [{ strategy: 'a' }, { strategy: 'b' }] }])).toThrow(/Sleeves auf dem Korb/);
  });

  it('weist dieselbe Strategie zweimal ab — sonst wäre der Beitrag je Sleeve nicht trennbar', () => {
    expect(() =>
      cfgMit([
        {
          label: 'E',
          sleeves: [
            { strategy: 'a', universe: 'fixed', symbols: ['SPY'] },
            { strategy: 'a', universe: 'fixed', symbols: ['QQQ'] },
          ],
        },
      ]),
    ).toThrow(/steht mehrfach in den Sleeves/);
  });

  it('weist ein festes Universum ohne Symbole ab, und ein Korb-Universum MIT Symbolen', () => {
    expect(() => cfgMit([{ label: 'E', sleeves: [{ strategy: 'a' }, { strategy: 'b', universe: 'fixed' }] }])).toThrow(/ohne symbols/);
    expect(() =>
      cfgMit([{ label: 'E', sleeves: [{ strategy: 'a', universe: 'fixed', symbols: ['QQQ'] }, { strategy: 'b', universe: 'korb', symbols: ['SPY'] }] }]),
    ).toThrow(/universe: korb UND symbols/);
  });

  it('verlangt Sleeve-Symbole aus dem Kandidatenpool — sonst lädt `fetch` ihre Bars nie', () => {
    expect(() =>
      cfgMit(
        [{ label: 'E', sleeves: [{ strategy: 'a' }, { strategy: 'b', universe: 'fixed', symbols: ['BIL'] }] }],
        { candidates: ['SPY', 'QQQ', 'GLD'] },
      ),
    ).toThrow(/nicht im Kandidatenpool/);
  });

  it('weist ein doppeltes Label ab', () => {
    expect(() =>
      cfgMit([
        { label: 'E', sleeves: [{ strategy: 'a' }, { strategy: 'b', universe: 'fixed', symbols: ['SPY'] }] },
        { label: 'E', sleeves: [{ strategy: 'c' }, { strategy: 'd', universe: 'fixed', symbols: ['QQQ'] }] },
      ]),
    ).toThrow(/kommt zweimal vor/);
  });

  it('verlangt mindestens zwei Sleeves — ein Sleeve ist kein Ensemble', () => {
    expect(() => cfgMit([{ label: 'E', sleeves: [{ strategy: 'a' }] }])).toThrow();
  });

  it('ein Sleeve mit fremdem Zeitrahmen ist ein Fehler, kein stilles Überspringen', () => {
    expect(() =>
      planVon({
        sleeves: [{ strategy: 'tag' }, { strategy: 'nurIntraday', universe: 'fixed', symbols: ['BIL'] }],
        strategien: { tag: fakeStrategy('tag'), nurIntraday: fakeStrategy('nurIntraday', { timeframes: [5] }) },
      }),
    ).toThrow(/andere Zusammensetzung/);
  });
});

/* ───────────────────────── 7. EINE Simulation, dieselben Gates ───────────────────────── */

/** Eine gemessene Einheit aus zwei Sleeves auf dem Fake-Simulator. */
function messung(o: { weighting?: 'equal' | 'inverse_vol'; profile?: (id: string) => FakeSimOptions } = {}) {
  const cfg = testConfig({ symbols: ['AAA', 'BBB', 'CCC'], optimizer: { lookbackDays: 400, isDays: 120, oosDays: 30, stepDays: 30, holdoutDays: 30 } });
  const strategien = { aktien: fakeStrategy('aktien'), defensiv: fakeStrategy('defensiv') };
  const plan = planVon({
    weighting: o.weighting ?? 'equal',
    sleeves: [
      { strategy: 'aktien', universe: 'korb', label: 'Aktien' },
      { strategy: 'defensiv', universe: 'fixed', symbols: ['DEF1', 'DEF2'], label: 'Defensive' },
    ],
    strategien,
  });
  const bars = korbBars(['AAA', 'BBB', 'CCC', 'DEF1', 'DEF2'], 380);
  const achse = zeitachseVon(bars);
  const fp = foldPlanForBars(achse, cfg.optimizer);
  const simulate = makeFakeSimulate(o.profile ?? (() => REWARD_PROFILE));
  const m = messeEnsemble({
    plan,
    bars,
    achse,
    folds: fp.folds,
    holdout: fp.holdout,
    config: simConfigOf(cfg),
    optimizer: cfg.optimizer,
    initialEquity: 25_000,
    simulate,
    assetClass: cfg.universe.assetClass,
  });
  return { m, cfg, plan, simulate, fp };
}

describe('messeEnsemble', () => {
  it('fährt beide Sleeves in EINEM Lauf je Fenster — jedes Symbol mit SEINER Strategie', () => {
    const { m, simulate } = messung();
    // Jeder Aufruf des Simulators bekommt beide Sleeves im selben Korb.
    const gemeinsameLaeufe = simulate.calls.filter((c) => c.symbols.includes('AAA') && c.symbols.includes('DEF1'));
    expect(gemeinsameLaeufe.length).toBeGreaterThan(0);
    // Und die Wahl je Symbol ist die des jeweiligen Sleeves.
    const nachStrategie = new Map(simulate.calls.map((c) => [c.strategyId, c]));
    expect([...nachStrategie.keys()].sort()).toEqual(['aktien', 'defensiv']);
    expect(m.beitraege.map((b) => b.strategy).sort()).toEqual(['aktien', 'defensiv']);
  });

  it('misst genau die Folds des Plans und hängt sie zu EINER OOS-Kette', () => {
    const { m, fp } = messung();
    expect(m.wfa.folds.length).toBe(fp.folds.length);
    expect(m.wfa.folds.map((f) => f.fold.oosStart)).toEqual(fp.folds.map((f) => f.oosStart));
    expect(m.wfa.oos.trades).toBe(m.beitraege.reduce((s, b) => s + b.trades, 0));
  });

  /**
   * WÄCHTER 2 (zweite Hälfte). Der Sleeve mit dem ganzen Korb hat vielfach
   * mehr Signale als der defensive mit zwei Papieren. Der Plan gibt ihm
   * trotzdem nicht alle Plätze.
   */
  it('ein Sleeve mit vielen Signalen bekommt nie alle Plätze — jeder behält seinen', () => {
    const { m, cfg } = messung();
    for (const b of m.beitraege) expect(b.mittlerePlaetze).toBeGreaterThanOrEqual(1);
    const summe = m.staende[0]!.plaetze.reduce((x, y) => x + y, 0);
    expect(summe).toBe(cfg.risk.maxPositions);
    for (const st of m.staende) {
      expect(st.plaetze.reduce((x, y) => x + y, 0)).toBe(cfg.risk.maxPositions);
      expect(Math.min(...st.plaetze)).toBeGreaterThanOrEqual(1);
    }
  });

  it('inverse Vola verschiebt die Plätze, gleichgewichtet nicht — und beide summieren gleich', () => {
    const laut: FakeSimOptions = { ...REWARD_PROFILE, noise: 0.08, salt: 'laut' };
    const leise: FakeSimOptions = { ...REWARD_PROFILE, noise: 0.002, salt: 'leise' };
    const profil = (id: string) => (id === 'aktien' ? laut : leise);
    const gleich = messung({ weighting: 'equal', profile: profil }).m;
    const invers = messung({ weighting: 'inverse_vol', profile: profil }).m;
    for (const st of gleich.staende) expect(st.gewichte).toEqual([0.5, 0.5]);
    // Nach der Aufwärmphase muss der ruhige Sleeve mehr Gewicht bekommen.
    const spaet = invers.staende.filter((st) => !st.aufwaermphase);
    expect(spaet.length).toBeGreaterThan(0);
    for (const st of spaet) expect(st.gewichte[1]!).toBeGreaterThan(st.gewichte[0]!);
    for (const st of invers.staende) expect(st.plaetze.reduce((x, y) => x + y, 0)).toBe(4);
  });

  it('die Korrelationsmatrix trägt genau die Sleeves und ist symmetrisch mit Diagonale 1', () => {
    const { m } = messung();
    expect(m.korrelation.namen).toEqual(['Aktien', 'Defensive']);
    expect(m.korrelation.werte[0]![0]).toBe(1);
    expect(m.korrelation.werte[1]![1]).toBe(1);
    expect(m.korrelation.werte[0]![1]).toEqual(m.korrelation.werte[1]![0]);
  });

  it('sagt je Fold, welcher Sleeve ihn getragen hat', () => {
    const { m } = messung();
    expect(m.foldTraeger.length).toBe(m.wfa.folds.length);
    for (const ft of m.foldTraeger) {
      expect(ft.netto.length).toBe(2);
      if (ft.traeger !== null) expect(ft.netto[ft.traeger]!).toBe(Math.max(...ft.netto.filter((_, i) => ft.trades[i]! > 0)));
    }
  });

  it('nennt die Symbole, die der feste Sleeve dem Korb-Sleeve entzieht', () => {
    const cfg = testConfig({ symbols: ['AAA', 'DEF1'], optimizer: { lookbackDays: 400, isDays: 120, oosDays: 30, stepDays: 30, holdoutDays: 30 } });
    const plan = planVon({
      sleeves: [
        { strategy: 'aktien', universe: 'korb' },
        { strategy: 'defensiv', universe: 'fixed', symbols: ['DEF1'] },
      ],
      strategien: { aktien: fakeStrategy('aktien'), defensiv: fakeStrategy('defensiv') },
    });
    const bars = korbBars(['AAA', 'DEF1'], 380);
    const achse = zeitachseVon(bars);
    const fp = foldPlanForBars(achse, cfg.optimizer);
    const m = messeEnsemble({
      plan,
      bars,
      achse,
      folds: fp.folds,
      holdout: fp.holdout,
      config: simConfigOf(cfg),
      optimizer: cfg.optimizer,
      initialEquity: 25_000,
      simulate: makeFakeSimulate(REWARD_PROFILE),
      assetClass: cfg.universe.assetClass,
    });
    expect(m.entzogen).toEqual(['DEF1']);
  });

  /**
   * WÄCHTER 4. Dieselben Gates wie jeder andere Kandidat — dieselben Namen,
   * dieselbe Reihenfolge, dieselben Schwellen. Ein Ensemble ist ein KANDIDAT
   * für die bestehende Alpha-Latte, keine dritte Latte (§0.9).
   */
  it('geht durch dieselben zehn Gates, mit denselben Schwellen', () => {
    const { m, cfg } = messung();
    const dsr = deflatedSharpeIs({ wfa: m.wfa, metricsFns: fakeMetricsFns });
    const psr = probabilisticSharpeOos({ wfa: m.wfa, metricsFns: fakeMetricsFns });
    const g = robustnessGates({
      wfa: m.wfa,
      optimizer: cfg.optimizer,
      stressOos: m.stress,
      neighborhood: m.nachbarschaft,
      dsr,
      psr,
      metricsFns: fakeMetricsFns,
      periodsPerYear: 365,
      fixed: true,
    });
    expect(g.gates.map((x) => x.name)).toEqual([
      'oos_trades',
      'fold_positive_share',
      'oos_net_profit',
      'fold_concentration',
      'stress_costs',
      'neighborhood_plateau',
      'probabilistic_sharpe_oos',
      'deflated_sharpe_is',
      'fee_share',
      'beats_market',
    ]);
    expect(g.gates.find((x) => x.name === 'oos_trades')!.threshold).toBe(cfg.optimizer.minOosTrades);
    expect(g.gates.find((x) => x.name === 'fold_positive_share')!.threshold).toBe(cfg.optimizer.minFoldPositiveShare);
    expect(g.gates.find((x) => x.name === 'fold_concentration')!.threshold).toBe(cfg.optimizer.maxFoldNetShare);
    // Keine Suche ⇒ nichts zu deflationieren, und das sagt das Gate laut.
    expect(g.gates.find((x) => x.name === 'deflated_sharpe_is')!.note).toMatch(/nicht anwendbar/);
    expect(m.wfa.trials).toBe(1);
  });

  it('der Stress-Lauf rechnet mit dem konfigurierten Faktor und verdient weniger', () => {
    const { m, cfg } = messung();
    expect(m.stress.costMultiplier).toBe(cfg.optimizer.stressCostMultiplier);
    expect(m.stress.netProfit).toBeLessThan(m.wfa.oos.netProfit);
  });

  it('die Nachbarschaft prüft die Achsen ALLER Sleeves, nicht nur eines', () => {
    const { m } = messung();
    // Zwei Sleeves × zwei Achsen × je zwei Nachbarn (Rand: einer) — jedenfalls
    // mehr als die Nachbarn eines einzelnen Sleeves.
    expect(m.nachbarschaft.evaluated).toBeGreaterThanOrEqual(4);
  });

  it('reicht dem Bericht Teilläufe für die Aktivität und die Versuchszählung', () => {
    const { m } = messung();
    expect(m.oosTeile.length).toBe(m.wfa.folds.length);
    // Der Nenner ist die Vorregistrierung, nicht der Lauf: Ein Lauf mit EINER
    // Einheit zählt trotzdem sechs angemeldete Versuche und neun Einheiten.
    expect(versuche({ ensembles: 1 })).toMatch(/6 Ensemble-Versuche/);
    expect(versuche({ ensembles: 1 })).toMatch(/9 Einheiten auf denselben Daten/);
    expect(versuche({ ensembles: 1 })).toMatch(/1 Ensemble-Einheit in DIESEM Lauf/);
  });
});

/* ───────────────────────── 8. Im Lauf: gemessen, aber nie befördert ───────────────────────── */

describe('runOptimization mit Ensembles', () => {
  const strategien: Record<string, Strategy> = { edge: fakeStrategy('edge'), defensiv: fakeStrategy('defensiv') };
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'autotrd-ensemble-'));
    dirs.push(d);
    return d;
  };
  const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

  function lauf(over: { pooled?: boolean; symbols?: string[]; ensembles?: unknown[] } = {}) {
    const home = tmp();
    const symbols = over.symbols ?? ['AAA', 'BBB'];
    const cfg = testConfig({
      symbols,
      home,
      optimizer: {
        lookbackDays: 400,
        isDays: 120,
        oosDays: 30,
        stepDays: 30,
        holdoutDays: 30,
        pooled: over.pooled ?? true,
        ensembles: (over.ensembles ?? [
          {
            label: 'E1 Aktien plus Defensive',
            weighting: 'equal',
            sleeves: [
              { strategy: 'edge', universe: 'korb', label: 'Aktien' },
              { strategy: 'defensiv', universe: 'fixed', symbols: ['DEF1', 'DEF2'], label: 'Defensive' },
            ],
          },
        ]) as never,
      },
    });
    const out = runOptimization({
      config: cfg,
      symbols,
      strategies: ['edge'],
      barsFor: () => dailyBars(400),
      home,
      initialEquity: 25_000,
      simulate: makeFakeSimulate(() => REWARD_PROFILE),
      metricsFns: fakeMetricsFns,
      getStrategy: (id) => strategien[id] ?? fakeStrategy(id),
      now: () => NOW,
    });
    return { out, home, cfg };
  }

  it('misst die Einheit, stellt sie aber NIE als Champion auf', () => {
    const { out, home } = lauf();
    const run = out.runs[0]!;
    expect(run.ensembles?.length).toBe(1);
    const e = run.ensembles![0]!;
    expect(e.label).toBe('E1 Aktien plus Defensive');
    expect(e.messung.plan.sleeves.map((s) => s.strategy.id)).toEqual(['edge', 'defensiv']);
    // Nicht in der Kandidatenliste, nicht in der Champion-Datei.
    expect(run.results.map((r) => r.strategyId)).not.toContain('ensemble');
    const champion = loadChampion(homePaths(home).champion)!;
    for (const eintrag of Object.values(champion.symbols)) expect(eintrag.strategy).not.toBe('ensemble');
  });

  it('ein Lauf, der NUR ein Ensemble messen konnte, hat trotzdem gemessen', () => {
    const { out } = lauf();
    expect(nichtsGemessen(out.runs)).toBe(false);
    expect(nichtsGemessen([{ ...out.runs[0]!, results: [], ensembles: out.runs[0]!.ensembles ?? [] }])).toBe(false);
    expect(nichtsGemessen([{ ...out.runs[0]!, results: [], ensembles: [] }])).toBe(true);
  });

  it('der Bericht nennt die Versuchszählung, die Zusammensetzung und die Korrelationsmatrix', () => {
    const { out } = lauf();
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toMatch(/Versuchszählung/);
    expect(text).toMatch(/6 Ensemble-Versuche/);
    expect(text).toMatch(/9 Einheiten auf denselben Daten/);
    expect(text).toMatch(/Korrelationsmatrix der Sleeve-Renditen/);
    expect(text).toMatch(/Zusammensetzung/);
    expect(text).toMatch(/Plätze Soll/);
    expect(text).toMatch(/wer hat ihn getragen/);
    // Die Grenze steht drin, nicht nur das Ergebnis.
    expect(text).toMatch(/globales `maxPositions`/);
    expect(text).toMatch(/NICHT befördert/);
  });

  it('schreibt einen Messbefund ins Journal', () => {
    const { out, home } = lauf();
    const zeilen = readFileSync(homePaths(home).journal, 'utf8')
      .trim()
      .split('\n')
      .map((z) => JSON.parse(z) as Record<string, unknown>);
    const eintrag = zeilen.find((z) => z.action === 'ensemble_measured');
    expect(eintrag).toBeDefined();
    expect(eintrag!.kind).toBe('champion');
    expect(eintrag!.label).toBe('E1 Aktien plus Defensive');
    expect(eintrag!.weighting).toBe('equal');
    expect(eintrag!.ensemblePass).toBe(out.runs[0]!.ensembles![0]!.pass);
  });

  /**
   * Ungepoolt mit mehreren Symbolen liefe dieselbe Einheit je Symbol noch
   * einmal — eine Mehrfachmessung, die niemand zählt. Das scheitert laut und
   * steht als Fehler im Bericht der Einheit.
   */
  it('scheitert laut, wenn es mehr als eine Alpha-Einheit gibt', () => {
    const { out } = lauf({ pooled: false });
    expect(out.runs.every((r) => (r.ensembles?.length ?? 0) === 0)).toBe(true);
    expect(out.runs[0]!.errors.join(' ')).toMatch(/nur auf EINER Alpha-Einheit/);
  });
});
