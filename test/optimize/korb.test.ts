/**
 * Gepoolte Bewertung: ein Parametersatz, EIN Lauf über den ganzen Korb.
 *
 * Warum das der Kern ist: Heute fragt der Optimierer „hat trend_donchian eine
 * Kante auf LTC?" — 33 OOS-Trades, unbeantwortbar, das Gate verlangt 60. Die
 * beantwortbare Frage lautet „hat trend_donchian eine Kante in dieser
 * Assetklasse?" und hat bei zehn Symbolen zehnmal so viele Trades.
 *
 * Die naive Variante — jedes Symbol einzeln rechnen und die Zahlen hinterher
 * addieren — wäre FALSCH: Jeder Einzellauf startet mit dem vollen Kapital,
 * die Summe wäre zehnfacher Hebel, und Positionslimit, Brutto-Exposure und
 * Notbremsen kämen nie zum Tragen. Deshalb geht der Korb in EINEN
 * Simulationslauf mit EINEM Konto — genau wie live.
 *
 * Diese Tests halten die Verdrahtung fest, nicht das Ergebnis.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/optimize/search.ts';
import { foldPlanForBars, korbVon, simulateWindow, walkForward, zeitachseVon } from '../../src/optimize/walkForward.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { DAY } from '../../src/core/time.ts';
import type { SimInput } from '../../src/optimize/walkForward.ts';
import type { SimResult } from '../../src/core/types.ts';
import { REWARD_PROFILE, dailyBars, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig } from './fakes.ts';

const cfg = testConfig();
const strategy = fakeStrategy('edge');

describe('korbVon', () => {
  it('macht aus einem Einzelsymbol einen Korb mit einem Eintrag', () => {
    const b = dailyBars(10);
    const k = korbVon('AAA', b);
    expect([...k.keys()]).toEqual(['AAA']);
    expect(k.get('AAA')).toBe(b);
  });

  it('reicht einen bereits übergebenen Korb unverändert durch', () => {
    const k0 = new Map([['AAA', dailyBars(10)], ['BBB', dailyBars(10)]]);
    expect(korbVon('egal', k0)).toBe(k0);
  });
});

describe('zeitachseVon', () => {
  it('gibt bei einem Symbol dessen eigene Achse zurück (identisch, nicht kopiert)', () => {
    const b = dailyBars(50);
    expect(zeitachseVon(korbVon('AAA', b))).toBe(b);
  });

  it('vereinigt mehrere Achsen aufsteigend und ohne Dubletten', () => {
    // Gleiche Assetklasse, gleicher Zeitrahmen ⇒ deckungsgleiche Achsen:
    // Die Vereinigung muss dann exakt so lang sein wie eine einzelne.
    const a = dailyBars(40);
    const b = dailyBars(40);
    const achse = zeitachseVon(new Map([['AAA', a], ['BBB', b]]));
    expect(achse.length).toBe(a.length);
    for (let i = 1; i < achse.length; i++) expect(achse.t[i]!).toBeGreaterThan(achse.t[i - 1]!);
  });

  it('deckt bei unterschiedlich langen Historien beide Enden ab', () => {
    const lang = dailyBars(60);
    const kurz = lang.prefix(20);
    const achse = zeitachseVon(new Map([['LANG', lang], ['KURZ', kurz]]));
    expect(achse.length).toBe(lang.length);
    expect(achse.t[0]!).toBe(lang.t[0]!);
    expect(achse.t[achse.length - 1]!).toBe(lang.t[lang.length - 1]!);
  });

  it('ohne Bars gibt es keinen Walk-Forward', () => {
    expect(() => zeitachseVon(new Map())).toThrow(/Keine Bars/);
  });

  /** Eine Reihe mit einer verirrten Einzelbar `tage` Tage vor ihrem dichten Anfang (IEX: SO 2019-11-11). */
  function mitStreuner(dicht: BarSeries, tage: number): BarSeries {
    return BarSeries.from([{ t: dicht.t[0]! - tage * DAY, o: 100, h: 101, l: 99, c: 100, v: 1 }, ...dicht.toBars()]);
  }

  it('WÄCHTER: eine verirrte Einzelbar eines Kandidaten zieht die Achse nicht nach hinten (Stichtag 2025-03-07)', () => {
    // Am 09.09.2026 zog SOs Bar vom 2019-11-11 die Achse acht Monate vor den
    // Datenbeginn; der Fold-Planer legte einen Fold hinein, dessen IS-Fenster
    // das Embargo verschluckte — die ganze Messung fiel aus.
    const dicht = dailyBars(400);
    const achse = zeitachseVon(new Map([['SPY', dicht], ['SO', mitStreuner(dicht, 259)]]));
    expect(achse.t[0]).toBe(dicht.t[0]);
    expect(achse.length).toBe(dicht.length);
    // Derselbe Fold-Plan wie ohne den Streuner — sonst gäbe es einen Fold ohne Bars im IS-Fenster.
    const ohne = foldPlanForBars(zeitachseVon(korbVon('SPY', dicht)), cfg.optimizer);
    const mit = foldPlanForBars(achse, cfg.optimizer);
    expect(mit.folds.length).toBe(ohne.folds.length);
    expect(mit.folds[0]!.isStart).toBe(ohne.folds[0]!.isStart);
  });

  it('auch die Achse eines Einzelsymbols beginnt dicht', () => {
    const dicht = dailyBars(60);
    const achse = zeitachseVon(korbVon('SO', mitStreuner(dicht, 259)));
    expect(achse.t[0]).toBe(dicht.t[0]);
    expect(achse.length).toBe(dicht.length);
  });
});

describe('simulateWindow mit einem Korb', () => {
  /** Spion: hält fest, womit der Simulator wirklich aufgerufen wurde. */
  function spion() {
    const echt = makeFakeSimulate(REWARD_PROFILE);
    const gesehen: SimInput[] = [];
    const fn = (input: SimInput): SimResult => {
      gesehen.push(input);
      return echt(input);
    };
    return { fn, gesehen };
  }

  const korb = new Map([['AAA', dailyBars(120)], ['BBB', dailyBars(120)], ['CCC', dailyBars(120)]]);

  it('schickt ALLE Symbole in EINEN Lauf — nicht drei Läufe hintereinander', () => {
    const s = spion();
    simulateWindow({
      symbol: 'korb',
      strategy,
      params: strategy.defaults,
      bars: korb,
      config: simConfigOf(cfg),
      initialEquity: 10_000,
      simulate: s.fn,
      range: { start: korb.get('AAA')!.t[0]!, end: korb.get('AAA')!.t[119]! + 1 },
    });
    expect(s.gesehen).toHaveLength(1);
    expect([...s.gesehen[0]!.bars.keys()].sort()).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('beantwortet strategyFor für jedes Symbol des Korbs — und für kein anderes', () => {
    const s = spion();
    simulateWindow({
      symbol: 'korb',
      strategy,
      params: strategy.defaults,
      bars: korb,
      config: simConfigOf(cfg),
      initialEquity: 10_000,
      simulate: s.fn,
      range: { start: korb.get('AAA')!.t[0]!, end: korb.get('AAA')!.t[119]! + 1 },
    });
    const f = s.gesehen[0]!.strategyFor;
    for (const sym of ['AAA', 'BBB', 'CCC']) {
      expect(f(sym), `${sym} muss handeln dürfen`).not.toBeNull();
      expect(f(sym)!.strategy.id).toBe('edge');
    }
    expect(f('FREMD'), 'ein Symbol außerhalb des Korbs darf nicht handeln').toBeNull();
  });

  it('EIN Konto für den ganzen Korb — nicht dreimal das Startkapital', () => {
    const s = spion();
    simulateWindow({
      symbol: 'korb',
      strategy,
      params: strategy.defaults,
      bars: korb,
      config: simConfigOf(cfg),
      initialEquity: 10_000,
      simulate: s.fn,
      range: { start: korb.get('AAA')!.t[0]!, end: korb.get('AAA')!.t[119]! + 1 },
    });
    expect(s.gesehen[0]!.initialEquity).toBe(10_000);
  });
});

describe('walkForward über einen Korb', () => {
  it('plant dieselben Folds wie ein Einzelsymbol und läuft einmal je Fenster', () => {
    const bars = dailyBars(400);
    const einzeln = walkForward({
      symbol: 'AAA', strategy, bars,
      config: simConfigOf(cfg), optimizer: cfg.optimizer,
      initialEquity: 10_000, simulate: makeFakeSimulate(REWARD_PROFILE), rng: mulberry32(1),
    });
    const gepoolt = walkForward({
      symbol: 'korb', strategy,
      bars: new Map([['AAA', bars], ['BBB', dailyBars(400)]]),
      config: simConfigOf(cfg), optimizer: cfg.optimizer,
      initialEquity: 10_000, simulate: makeFakeSimulate(REWARD_PROFILE), rng: mulberry32(1),
    });
    // Deckungsgleiche Achsen ⇒ identischer Fold-Plan. Wäre das nicht so,
    // wären gepoolte und einzelne Ergebnisse nicht vergleichbar.
    expect(gepoolt.folds.length).toBe(einzeln.folds.length);
    expect(gepoolt.folds.map((f) => f.fold.oosStart)).toEqual(einzeln.folds.map((f) => f.fold.oosStart));
    expect(gepoolt.dataRange).toEqual(einzeln.dataRange);
    expect(gepoolt.symbol).toBe('korb');
  });
});
