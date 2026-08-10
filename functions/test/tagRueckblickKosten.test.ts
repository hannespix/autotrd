/**
 * Wie teuer ist ein TIEFERES Rückblick-Fenster? (Owner-Frage 09.08.:
 * „wie bekommen wir mehr Datenpunkte?")
 *
 * Nur eine Messung, keine Behauptung — läuft aus demselben Grund wie
 * tagRueckblickEcht nicht in der CI:
 *
 *   TAG_RUECKBLICK_ECHT=1 npx vitest run functions/test/tagRueckblickKosten.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  feeRateForClass,
  werteSchattenAus,
  werteTagRueckblick,
  type TagesKurs,
} from '../../shared/src/index.js';
import { computeSignal } from '../src/core/engine.js';

const AN = process.env.TAG_RUECKBLICK_ECHT === '1';

async function holeReihe(symbol: string): Promise<TagesKurs[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=50y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (autotrd)' } });
  const json = (await res.json()) as {
    chart: { result?: Array<{ timestamp?: number[]; indicators: { quote: Array<{ close: (number | null)[] }> } }> };
  };
  const r = json.chart.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators.quote[0]?.close ?? [];
  const map = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue;
    map.set(new Date(ts[i]! * 1000).toISOString().slice(0, 10), c);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
}

describe.skipIf(!AN)('Kosten und Ertrag eines tieferen Fensters', () => {
  it('misst Laufzeit und Stichprobe je Fenstertiefe', async () => {
    const volle = await holeReihe('SPY');
    const heute = new Date().toISOString().slice(0, 10);
    const kosten = feeRateForClass('etf_regions') * 2;

    for (const basistage of [750, 1500, 3000, 6000]) {
      const reihe = volle.slice(-(basistage + 260));
      const t0 = process.hrtime.bigint();
      const e = werteTagRueckblick(
        reihe,
        (closes, preis) =>
          computeSignal(closes, preis, DEFAULT_STRATEGY.indicators, DEFAULT_STRATEGY.signals, null).direction,
        kosten,
        heute,
      );
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const a = werteSchattenAus(e.klasse);
      const b = werteSchattenAus(e.nachRichtung.buy);
      const s = werteSchattenAus(e.nachRichtung.sell);
      // eslint-disable-next-line no-console
      console.log(
        `Fenster ${String(basistage).padStart(4)}: ${String(Math.round(ms)).padStart(5)} ms  `
        + `n=${String(a.n).padStart(4)} netto=${a.kantePct?.toFixed(4)}%  |  `
        + `BUY n=${String(b.n).padStart(4)} netto=${b.kantePct?.toFixed(4)}%  `
        + `SELL n=${String(s.n).padStart(4)} netto=${s.kantePct?.toFixed(4)}%  ab=${reihe[0]?.date}`,
      );
    }
    expect(volle.length).toBeGreaterThan(1000);
  }, 300_000);
});
