/**
 * Live-Vorschau des Strategie-Studios (M10) — PUR und komplett clientseitig:
 * Indikator-Serien über die gecachten Bars, dann Bar für Bar evaluate().
 * KEIN Backtest (kein PnL, keine Kosten) — nur Marker + Haltebänder.
 *
 * Offengelegte Annahmen (im UI beschriftet):
 *  - Uhrzeit je Bar: 10:00 ET (Tages-Bars haben keine Uhrzeit)
 *  - forecastPct: unbekannt (Prognose-Historie liegt clientseitig nicht vor)
 *  - Sentiment/Events je Tag aus market/{sym}/events, sonst „keine Events"
 *  - Position wird als Long/Flat-Zustand SIMULIERT (Entry = Close des Kaufs)
 */

import {
  bollinger,
  evaluate,
  macd,
  wilderRsi,
  type RuleContext,
  type StrategySpec,
} from '@autotrd/shared';

export interface PreviewBar {
  date: string;
  close: number;
}

export interface PreviewDayInfo {
  sentiment?: number | null;
  tags?: string[];
}

export interface PreviewMarker {
  index: number;
  date: string;
  dir: 'buy' | 'sell';
}

export interface PreviewResult {
  markers: PreviewMarker[];
  /** Haltebänder als [Kauf-Index, Verkauf-Index | letzter Bar]. */
  holds: Array<[number, number]>;
  evaluatedBars: number;
}

const WARMUP = 26; // MACD-Slow — davor sind Serien ohnehin null → unbekannt

export function previewSignals(
  spec: StrategySpec,
  bars: PreviewBar[],
  dayInfo?: Map<string, PreviewDayInfo>,
): PreviewResult {
  const closes = bars.map((b) => b.close);
  const rsi = wilderRsi(closes);
  const m = macd(closes);
  const bb = bollinger(closes);

  const markers: PreviewMarker[] = [];
  const holds: Array<[number, number]> = [];
  let openIndex: number | null = null;
  let entry: number | null = null;
  let evaluated = 0;

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

  for (let i = Math.min(WARMUP, bars.length); i < bars.length; i++) {
    const day = dayInfo?.get(bars[i]!.date);
    const ctx: RuleContext = {
      values: valuesAt(i),
      prevValues: i > 0 ? valuesAt(i - 1) : {},
      closes: closes.slice(0, i + 1),
      minuteOfDay: 600, // Annahme 10:00 ET (Tages-Bars)
      sentiment: day?.sentiment ?? null,
      newsEvents: dayInfo ? (day?.tags ?? []) : null,
      forecastPct: null,
      position:
        openIndex !== null && entry !== null
          ? { open: true, unrealizedPct: ((closes[i]! - entry) / entry) * 100 }
          : { open: false },
    };
    evaluated++;
    const buy = evaluate(spec.buy, ctx);
    const sell = evaluate(spec.sell, ctx);
    if (buy && !sell && openIndex === null) {
      openIndex = i;
      entry = closes[i]!;
      markers.push({ index: i, date: bars[i]!.date, dir: 'buy' });
    } else if (sell && !buy && openIndex !== null) {
      holds.push([openIndex, i]);
      openIndex = null;
      entry = null;
      markers.push({ index: i, date: bars[i]!.date, dir: 'sell' });
    }
  }
  if (openIndex !== null) holds.push([openIndex, bars.length - 1]);

  return { markers, holds, evaluatedBars: evaluated };
}
