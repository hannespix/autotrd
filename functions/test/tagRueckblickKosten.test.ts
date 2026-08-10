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

    const reihe = volle.slice(-6260);
    const t0 = process.hrtime.bigint();
    const e = werteTagRueckblick(
      reihe,
      (closes, preis) =>
        computeSignal(closes, preis, DEFAULT_STRATEGY.indicators, DEFAULT_STRATEGY.signals, null).direction,
      kosten,
      heute,
    );
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`SPY ab ${reihe[0]?.date}, ${Math.round(ms)} ms für ALLE Horizonte:`);
    for (const [tage, h] of Object.entries(e.horizonte)) {
      const a = werteSchattenAus(h.klasse);
      const b = werteSchattenAus(h.nachRichtung.buy);
      const s = werteSchattenAus(h.nachRichtung.sell);
      console.log(
        `  ${String(tage).padStart(2)} Tage halten: n=${String(a.n).padStart(4)} `
        + `roh=${a.rohPct?.toFixed(4)}% netto=${a.kantePct?.toFixed(4)}% Treffer=${((a.trefferquote ?? 0) * 100).toFixed(1)}%`
        + `  |  BUY n=${String(b.n).padStart(3)} netto=${b.kantePct?.toFixed(4)}%`
        + `  SELL n=${String(s.n).padStart(3)} netto=${s.kantePct?.toFixed(4)}%`,
      );
    }
    expect(volle.length).toBeGreaterThan(1000);
    expect(e.horizonte[10]!.bewertet).toBeGreaterThan(50);
  }, 300_000);
});
