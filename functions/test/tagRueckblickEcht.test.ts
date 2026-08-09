/**
 * Ende-zu-Ende-Probe der Rückschau mit ECHTEN Kursen (nur auf Anforderung).
 *
 * Die Unit-Tests prüfen die Gates an konstruierten Reihen. Diese Probe prüft
 * etwas anderes: dass die ganze Kette — Yahoo-Bars → Reihe → computeSignal →
 * Kante — überhaupt eine plausible Zahl liefert und nicht still null bleibt.
 *
 * Sie holt Daten aus dem Netz und läuft deshalb NICHT in der CI. Einschalten:
 *
 *   TAG_RUECKBLICK_ECHT=1 npx vitest run functions/test/tagRueckblickEcht.test.ts
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
  // `50y` und nicht `max` — genau wie `getDeepDailyBars`. Mit `max` antwortet
  // Yahoo in Monatskerzen; diese Probe hat den Fehler am 09.08. aufgedeckt.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=50y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (autotrd)' } });
  const json = (await res.json()) as {
    chart: { result?: Array<{ timestamp?: number[]; indicators: { quote: Array<{ close: (number | null)[] }> } }> };
  };
  const r = json.chart.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators.quote[0]?.close ?? [];
  const out: TagesKurs[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue;
    out.push({ date: new Date(ts[i]! * 1000).toISOString().slice(0, 10), close: c });
  }
  // Entdoppeln wie im Lauf — Yahoo liefert gelegentlich denselben Tag zweimal.
  const map = new Map(out.map((t) => [t.date, t.close]));
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
}

describe.skipIf(!AN)('Tages-Rückblick mit echten Kursen', () => {
  it('liefert für SPY eine plausible Kante über mehrere hundert Basistage', async () => {
    const reihe = (await holeReihe('SPY')).slice(-1010);
    const heute = new Date().toISOString().slice(0, 10);
    const e = werteTagRueckblick(
      reihe,
      (closes, preis) =>
        computeSignal(closes, preis, DEFAULT_STRATEGY.indicators, DEFAULT_STRATEGY.signals, null).direction,
      feeRateForClass('etf_regions') * 2,
      heute,
    );
    const a = werteSchattenAus(e.klasse);
    // eslint-disable-next-line no-console
    console.log('SPY:', JSON.stringify({ bewertet: e.bewertet, ...a, ausfaelle: e.ausfaelle }));

    // Kein Werturteil über die Kante — nur: Die Kette LIEFERT etwas, und die
    // Buchführung stimmt. Eine stille Null wäre der eigentliche Fehler.
    expect(e.bewertet).toBeGreaterThan(50);
    expect(a.n).toBe(e.bewertet);
    const summe = Object.values(e.ausfaelle).reduce((x, y) => x + y, 0) + e.bewertet;
    expect(summe).toBe(reihe.length);
  }, 60_000);
});
