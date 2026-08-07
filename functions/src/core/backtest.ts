/**
 * Backtest-Engine (M11) — purer Port von reference/scripts/backtest_engine.py.
 *
 * Long/Flat über Tages-Bars mit Kommission + Slippage; Kennzahlen wie die
 * Referenz: Equity-Kurve, Total-/Buy&Hold-Return, MaxDD, Sharpe (√252,
 * Stichproben-Std), Winrate, bester/schlechtester Trade.
 *
 * LOOKAHEAD-DISZIPLIN (gleiche Härte wie das forecast_eval-Gate): Der
 * Kontext an Bar i sieht ausschließlich Daten ≤ i — Indikator-Serien sind
 * kausal (rollierende Fenster/EMA), ctx.closes wird hart auf [0..i]
 * geschnitten, prevValues kommen von i−1. Der Regressionstest enthält eine
 * adversariale Fixture, die jedes Zukunfts-Leck auffliegen lässt.
 */

import {
  DEFAULT_LOOKBACK,
  FORECAST_HORIZON,
  beschreibeBlatt,
  bollinger,
  computeForecastV2,
  evaluate,
  macd,
  sammleBlaetter,
  wilderRsi,
  type RuleContext,
  type StrategySpec,
} from '../../../shared/src/index.js';

export interface BacktestBar {
  date: string;
  close: number;
}

export interface BacktestOptions {
  initialCapital?: number;
  /** z. B. 0.001 = 0,1 % je Seite. */
  commissionPct?: number;
  /** Basispunkte Slippage je Seite. */
  slippageBps?: number;
  /** Volle Tagesrendite-Serie im Ergebnis mitliefern (Struktursuche, MO). */
  mitRenditen?: boolean;
  /** Bedingungs-Statistik je Blatt mitzählen (M11-Rest). */
  mitBedingungen?: boolean;
}

/**
 * Feuer-Statistik EINES Blatts über den Lauf: `gefeuert` = wie oft die
 * Einzelbedingung wahr war, `amSignalTag` = wie oft davon an einem Bar, an
 * dem die GESAMTE Baum-Seite auslöste. Bewusst diese zwei Zählungen statt
 * einer Kausal-Analyse: „feuerte 41×, 12× am Signal-Tag" trennt bereits
 * Dauer-Brenner (immer wahr, nie unterscheidend) von seltenen Auslösern —
 * ein kontrafaktisches „wäre ohne dieses Blatt nichts passiert?" wäre bei
 * any/weighted mehrdeutig und suggeriert mehr Präzision, als drinsteckt.
 */
export interface BedingungsZeile {
  seite: 'buy' | 'sell';
  label: string;
  gefeuert: number;
  amSignalTag: number;
}

export interface BacktestTrade {
  entryDate: string;
  exitDate: string;
  pnl: number;
}

export interface BacktestResult {
  finalEquity: number;
  totalReturnPct: number;
  buyHoldPct: number;
  numTrades: number;
  winRatePct: number;
  avgPnl: number;
  maxDrawdownPct: number;
  sharpe: number;
  bestTrade: number;
  worstTrade: number;
  /** ≤ 200 Punkte, gleichmäßig ausgedünnt (Firestore-Doc-Budget). */
  equityCurve: Array<{ date: string; value: number }>;
  trades: BacktestTrade[];
  evaluatedBars: number;
  /** Nur mit `opts.mitBedingungen`: Feuer-Statistik je Blatt (buy + sell). */
  bedingungen?: BedingungsZeile[];
  /**
   * Nur mit `opts.mitRenditen` (Struktursuche): UNGEDÜNNTE Tagesrendite je
   * Bar-Übergang — `renditen[i]` gehört zum Übergang bars[i] → bars[i+1]
   * (Länge = bars.length − 1, Warmup-Übergänge sind exakt 0). Bewusst NICHT
   * Teil der Firestore-Ergebnisse — die Kurve dort bleibt gedünnt.
   */
  renditen?: number[];
}

const WARMUP = 26; // MACD-Slow — davor sind die Serien ohnehin null

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function backtestSpec(
  spec: StrategySpec,
  bars: BacktestBar[],
  opts: BacktestOptions = {},
): BacktestResult {
  const initial = opts.initialCapital ?? 10_000;
  const fee = (opts.commissionPct ?? 0.001) + (opts.slippageBps ?? 5) / 10_000;
  const closes = bars.map((b) => b.close);
  const rsi = wilderRsi(closes);
  const m = macd(closes);
  const bb = bollinger(closes);

  const valuesAt = (i: number): RuleContext['values'] => ({
    price: closes[i],
    rsi: rsi[i],
    macdLine: m.line[i],
    macdSignal: m.signal[i],
    macdHistogram: m.histogram[i],
    bbUpper: bb.upper[i],
    bbMiddle: bb.middle[i],
    bbLower: bb.lower[i],
    pctB: bb.pctB[i],
  });

  // Kausale Forecast-Serie (Prognose 2.0 Teil 4): Die Prognose an Bar i
  // nutzt AUSSCHLIESSLICH closes[0..i] mit
  // den System-Defaults (w, Lookback) — damit greifen Forecast-Regeln auch
  // in Backtests und Sweeps. Gleiche Lookahead-Härte wie der Rest der Engine.
  const fcPct: Array<number | null> = new Array(bars.length).fill(null);
  for (let i = Math.min(WARMUP, bars.length - 1); i < bars.length; i++) {
    const fc = computeForecastV2(
      closes.slice(0, i + 1),
      bars[i]!.date,
      FORECAST_HORIZON,
      DEFAULT_LOOKBACK,
    );
    fcPct[i] =
      fc && fc.points.length > 0 && fc.baseClose > 0
        ? Math.round((fc.points[fc.points.length - 1]!.value / fc.baseClose - 1) * 10_000) / 100
        : null;
  }

  let capital = initial;
  let shares = 0;
  let entryPrice = 0;
  let entryDate = '';
  const equity: number[] = [];
  const trades: BacktestTrade[] = [];
  let evaluated = 0;

  // Bedingungs-Statistik: Blätter einmal einsammeln, je Bar einzeln stimmen
  // lassen. Jedes Blatt ist selbst ein gültiger Baum — evaluate(blatt, ctx)
  // ist exakt die Stimme, die es im Gesamtbaum abgibt.
  const statistik = opts.mitBedingungen
    ? ([
        ...sammleBlaetter(spec.buy).map((blatt) => ({
          seite: 'buy' as const, blatt, zeile: { seite: 'buy' as const, label: beschreibeBlatt(blatt), gefeuert: 0, amSignalTag: 0 },
        })),
        ...sammleBlaetter(spec.sell).map((blatt) => ({
          seite: 'sell' as const, blatt, zeile: { seite: 'sell' as const, label: beschreibeBlatt(blatt), gefeuert: 0, amSignalTag: 0 },
        })),
      ])
    : null;

  for (let i = 0; i < bars.length; i++) {
    const price = closes[i]!;
    if (i >= Math.min(WARMUP, bars.length - 1)) {
      const ctx: RuleContext = {
        values: valuesAt(i),
        prevValues: i > 0 ? valuesAt(i - 1) : {},
        // KAUSAL: nur Vergangenheit + Gegenwart — nie bars[i+1..]
        closes: closes.slice(0, i + 1),
        minuteOfDay: 600,
        forecastPct: fcPct[i] ?? null,
        position:
          shares > 0
            ? { open: true, unrealizedPct: ((price - entryPrice) / entryPrice) * 100 }
            : { open: false },
      };
      evaluated++;
      const buy = evaluate(spec.buy, ctx);
      const sell = evaluate(spec.sell, ctx);
      if (statistik) {
        for (const s of statistik) {
          if (!evaluate(s.blatt, ctx)) continue;
          s.zeile.gefeuert += 1;
          if (s.seite === 'buy' ? buy : sell) s.zeile.amSignalTag += 1;
        }
      }
      if (buy && !sell && shares === 0) {
        const eff = price * (1 + fee);
        const maxShares = Math.floor(capital / eff);
        if (maxShares > 0) {
          shares = maxShares;
          entryPrice = eff;
          entryDate = bars[i]!.date;
          capital -= eff * shares;
        }
      } else if (sell && !buy && shares > 0) {
        const eff = price * (1 - fee);
        trades.push({ entryDate, exitDate: bars[i]!.date, pnl: round2((eff - entryPrice) * shares) });
        capital += eff * shares;
        shares = 0;
      }
    }
    equity.push(capital + shares * price);
  }

  // Restposition zum letzten Close glattstellen (wie die Referenz)
  if (shares > 0) {
    const last = bars[bars.length - 1]!;
    const eff = last.close * (1 - fee);
    trades.push({ entryDate, exitDate: last.date, pnl: round2((eff - entryPrice) * shares) });
    capital += eff * shares;
    equity[equity.length - 1] = capital;
  }

  const finalEquity = equity[equity.length - 1] ?? initial;

  let peak = -Infinity;
  let maxDd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    maxDd = Math.min(maxDd, ((v - peak) / peak) * 100);
  }

  // Bar-aligniert (Index i = Übergang i → i+1); entartete Vorwerte zählen als
  // 0, damit die Zuordnung Rendite ↔ Bar-Datum nie verrutscht.
  const alleRenditen: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    alleRenditen.push(prev > 0 ? equity[i]! / prev - 1 : 0);
  }
  const rets = alleRenditen.filter((_, i) => equity[i]! > 0);
  let sharpe = 0;
  if (rets.length > 1) {
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    if (sd > 0) sharpe = (mean / sd) * Math.sqrt(252);
  }

  const pnls = trades.map((t) => t.pnl);
  const winning = pnls.filter((p) => p > 0).length;
  const buyHold =
    bars.length > 1 ? ((closes[closes.length - 1]! - closes[0]!) / closes[0]!) * 100 : 0;

  // Equity-Kurve auf ≤ 200 Punkte ausdünnen (erster + letzter bleiben)
  const step = Math.max(1, Math.ceil(equity.length / 200));
  const equityCurve = equity
    .map((value, i) => ({ date: bars[i]!.date, value: round2(value) }))
    .filter((_, i) => i % step === 0 || i === equity.length - 1);

  return {
    finalEquity: round2(finalEquity),
    totalReturnPct: round2(((finalEquity - initial) / initial) * 100),
    buyHoldPct: round2(buyHold),
    numTrades: trades.length,
    winRatePct: round2((winning / Math.max(trades.length, 1)) * 100),
    avgPnl: round2(pnls.length > 0 ? pnls.reduce((s, p) => s + p, 0) / pnls.length : 0),
    maxDrawdownPct: round2(maxDd),
    sharpe: Math.round(sharpe * 1000) / 1000,
    bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
    worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
    equityCurve,
    trades,
    evaluatedBars: evaluated,
    ...(opts.mitRenditen ? { renditen: alleRenditen } : {}),
    ...(statistik ? { bedingungen: statistik.map((s) => s.zeile) } : {}),
  };
}
