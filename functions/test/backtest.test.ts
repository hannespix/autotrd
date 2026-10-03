/**
 * Tests der Backtest-Engine (M11): Metriken auf handrechenbarer Serie,
 * Determinismus — und die ADVERSARIALE Lookahead-Fixture: ein Sprung, den
 * man nur mit Blick in die Zukunft vor dem Sprung-Tag handeln könnte.
 */
import { describe, expect, it } from 'vitest';
import type { StrategySpec } from '../../shared/src/index.js';
import { backtestSpec, type BacktestBar } from '../src/core/backtest.js';

function flatThenJump(): BacktestBar[] {
  // 40 Bars exakt flach bei 100, dann EIN Sprung auf 130, danach flach.
  const bars: BacktestBar[] = [];
  for (let i = 0; i < 40; i++) bars.push({ date: `D${String(i).padStart(3, '0')}`, close: 100 });
  for (let i = 40; i < 50; i++) bars.push({ date: `D${String(i).padStart(3, '0')}`, close: 130 });
  return bars;
}

describe('backtestSpec', () => {
  it('Lookahead-Fixture: der Sprung ist erst AM Sprung-Tag sichtbar, nie davor', () => {
    // „Kaufe, wenn der letzte Bar ≥ 20 % gestiegen ist" — kausal kann das
    // frühestens der Sprung-Tag D040 selbst sein. Jedes Zukunfts-Leck würde
    // schon D039 kaufen und den Gewinn des Sprungs einstreichen.
    const spec: StrategySpec = {
      buy: { type: 'changePct', lookbackBars: 1, op: 'gte', pct: 20 },
      sell: { type: 'changePct', lookbackBars: 1, op: 'lte', pct: -99 }, // nie
    };
    const r = backtestSpec(spec, flatThenJump(), { commissionPct: 0, slippageBps: 0 });
    expect(r.numTrades).toBe(1);
    expect(r.trades[0]!.entryDate).toBe('D040'); // NICHT D039
    // Entry zum Close 130 ⇒ der 30-%-Sprung ist NICHT im PnL (kein Leck)
    expect(r.trades[0]!.pnl).toBe(0);
    expect(r.totalReturnPct).toBe(0);
  });

  it('Metriken auf handrechenbarer Serie (ohne Kosten)', () => {
    // Kauf bei 100 (RSI-frei via priceLevel), Verkauf über 120 ⇒ +20 % Trade.
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 30; i++) bars.push({ date: `A${i}`, close: 100 });
    for (let i = 0; i < 10; i++) bars.push({ date: `B${i}`, close: 100 + (i + 1) * 3 });
    const spec: StrategySpec = {
      buy: { type: 'priceLevel', level: 101, side: 'below' },
      sell: { type: 'priceLevel', level: 120, side: 'above' },
    };
    const r = backtestSpec(spec, bars, { initialCapital: 10_000, commissionPct: 0, slippageBps: 0 });
    expect(r.numTrades).toBe(1);
    expect(r.trades[0]!.pnl).toBeGreaterThan(1900); // 100 Stück × ~+21
    expect(r.winRatePct).toBe(100);
    expect(r.maxDrawdownPct).toBe(0); // nie unter Wasser
    expect(r.finalEquity).toBeCloseTo(10_000 + r.trades[0]!.pnl, 1);
    expect(r.buyHoldPct).toBeCloseTo(30, 5);
    expect(r.equityCurve.length).toBeLessThanOrEqual(200);
  });

  it('Kosten drücken den PnL (Kommission + Slippage je Seite)', () => {
    const bars = flatThenJump();
    const spec: StrategySpec = {
      buy: { type: 'changePct', lookbackBars: 1, op: 'gte', pct: 20 },
      sell: { type: 'changePct', lookbackBars: 1, op: 'lte', pct: -99 },
    };
    const free = backtestSpec(spec, bars, { commissionPct: 0, slippageBps: 0 });
    const paid = backtestSpec(spec, bars, { commissionPct: 0.001, slippageBps: 5 });
    expect(paid.finalEquity).toBeLessThan(free.finalEquity);
  });

  it('ist deterministisch', () => {
    const bars = flatThenJump();
    const spec: StrategySpec = {
      buy: { type: 'changePct', lookbackBars: 1, op: 'gte', pct: 20 },
      sell: { type: 'position', state: 'open', minUnrealizedPct: 50 },
    };
    expect(backtestSpec(spec, bars)).toEqual(backtestSpec(spec, bars));
  });

  // Echte ISO-Daten für die Forecast-Tests: die Prognose projiziert Werktage
  // ab dem Bar-Datum — synthetische Strings („D000") ergäben leere Horizonte.
  const isoDate = (i: number): string =>
    new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

  it('Forecast-Regeln greifen im Backtest (kausaler forecastPct je Bar)', () => {
    // Stetiger Anstieg ⇒ die Drift-Prognose ist positiv ⇒ die forecast-Regel
    // löst Käufe aus. Vor Teil 4 war forecastPct null und die Regel tot.
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 60; i++) bars.push({ date: isoDate(i), close: 100 + i });
    const spec: StrategySpec = {
      buy: { type: 'forecast', direction: 'up', minAbsPct: 0.1 },
      sell: { type: 'forecast', direction: 'down', minAbsPct: 99 }, // nie
    };
    const r = backtestSpec(spec, bars, { commissionPct: 0, slippageBps: 0 });
    expect(r.numTrades).toBeGreaterThan(0);
  });

  it('Bedingungs-Statistik: trennt seltenen Auslöser vom Dauerbrenner', () => {
    // flatThenJump hat 50 Bars, ausgewertet ab WARMUP=26 ⇒ 24 Bars.
    // changePct≥20 feuert GENAU am Sprung-Tag; Kurs>1 feuert IMMER — und
    // weil er im any steht, ist jeder ausgewertete Bar ein Signal-Tag.
    const spec: StrategySpec = {
      buy: {
        type: 'any',
        children: [
          { type: 'changePct', lookbackBars: 1, op: 'gte', pct: 20 },
          { type: 'priceLevel', level: 1, side: 'above' },
        ],
      },
      sell: { type: 'priceLevel', level: -1, side: 'below' }, // nie
    };
    const r = backtestSpec(spec, flatThenJump(), {
      commissionPct: 0, slippageBps: 0, mitBedingungen: true,
    });
    expect(r.evaluatedBars).toBe(24);
    const zeile = (label: string) => r.bedingungen!.find((z) => z.label === label)!;
    expect(zeile('Δ1 Bar ≥ 20 %')).toMatchObject({ seite: 'buy', gefeuert: 1, amSignalTag: 1 });
    expect(zeile('Kurs > 1')).toMatchObject({ seite: 'buy', gefeuert: 24, amSignalTag: 24 });
    expect(zeile('Kurs < -1')).toMatchObject({ seite: 'sell', gefeuert: 0, amSignalTag: 0 });
    // Ohne die Option bleibt das Ergebnis unverändert schlank.
    expect(backtestSpec(spec, flatThenJump()).bedingungen).toBeUndefined();
  });

  it('PRÄFIX-KONSISTENZ: gleiche Entscheidungen, egal wie lang die Serie ist', () => {
    /* Der stärkste Lookahead-Beweis über ALLE Indikator-Pfade: Die
     * RSI/MACD/Bollinger-Serien werden einmal über die VOLLE Serie gerechnet
     * und dann an Bar i indiziert — kausal ist das nur, wenn jede dieser
     * Implementierungen strikt rollierend/rekursiv ist (Fenster bzw. EMA,
     * die an i enden). Ein zentriertes Fenster, eine Normalisierung über die
     * Gesamtserie oder ein Off-by-one nach vorn wäre mit den bisherigen
     * Fixtures unsichtbar, solange es beide Läufe gleich trifft.
     *
     * Deshalb hier mechanisch: Backtest auf bars[0..m] und auf bars[0..n]
     * (m < n) müssen bis zum Schnitt IDENTISCH laufen — dieselben Einstiege
     * vor dem Schnitt-Tag und dieselbe Equity je Bar (bis auf den letzten
     * Bar des kurzen Laufs, den seine Schluss-Liquidation umschreibt). */
    const lcg = (seed: number) => () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const rnd = lcg(42);
    const bars: BacktestBar[] = [];
    let preis = 100;
    for (let i = 0; i < 160; i++) {
      preis = Math.max(5, preis * (1 + (rnd() - 0.5) * 0.06 + Math.sin(i / 9) * 0.01));
      bars.push({ date: isoDate(i), close: Math.round(preis * 100) / 100 });
    }
    // Alle drei Indikator-Familien im Spiel, damit jede Serie geprüft wird.
    const spec: StrategySpec = {
      buy: {
        type: 'any',
        children: [
          { type: 'compare', left: 'rsi', op: 'lt', right: 45 },
          { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'above' },
        ],
      },
      sell: { type: 'compare', left: 'pctB', op: 'gt', right: 0.9 },
    };
    const m = 110;
    const kurz = backtestSpec(spec, bars.slice(0, m), { commissionPct: 0, slippageBps: 0 });
    const lang = backtestSpec(spec, bars, { commissionPct: 0, slippageBps: 0 });
    expect(kurz.numTrades).toBeGreaterThan(0); // die Fixture muss wirklich handeln
    const schnitt = bars[m - 1]!.date;
    expect(kurz.trades.map((t) => t.entryDate).filter((d) => d < schnitt))
      .toEqual(lang.trades.map((t) => t.entryDate).filter((d) => d < schnitt));
    // Equity Bar für Bar identisch — außer dem letzten Bar des kurzen Laufs
    // (Schluss-Liquidation). renditen[i] gehört zum Übergang i → i+1.
    const rKurz = backtestSpec(spec, bars.slice(0, m), { commissionPct: 0, slippageBps: 0, mitRenditen: true }).renditen!;
    const rLang = backtestSpec(spec, bars, { commissionPct: 0, slippageBps: 0, mitRenditen: true }).renditen!;
    expect(rKurz.slice(0, m - 2)).toEqual(rLang.slice(0, m - 2));
  });

  it('KAUSALITÄT: forecastPct an Bar i ändert sich nicht, wenn die Zukunft variiert', () => {
    // Adversarial: gleiche Vergangenheit, radikal andere Zukunft — die
    // Trades bis zum Verzweigungstag MÜSSEN identisch sein. Jede Abweichung
    // wäre ein Zukunfts-Leck in der Forecast-Serie.
    const past: BacktestBar[] = [];
    for (let i = 0; i < 45; i++) past.push({ date: isoDate(i), close: 100 + i * 0.5 });
    const futureUp = [...past, { date: isoDate(45), close: 200 }, { date: isoDate(46), close: 250 }];
    const futureDown = [...past, { date: isoDate(45), close: 50 }, { date: isoDate(46), close: 25 }];
    const spec: StrategySpec = {
      buy: { type: 'forecast', direction: 'up', minAbsPct: 0.1 },
      sell: { type: 'forecast', direction: 'down', minAbsPct: 0.1 },
    };
    const up = backtestSpec(spec, futureUp, { commissionPct: 0, slippageBps: 0 });
    const down = backtestSpec(spec, futureDown, { commissionPct: 0, slippageBps: 0 });
    const cutoff = isoDate(45);
    const before = (t: { entryDate: string }): boolean => t.entryDate < cutoff;
    expect(up.trades.filter(before).map((t) => t.entryDate))
      .toEqual(down.trades.filter(before).map((t) => t.entryDate));
  });
});
