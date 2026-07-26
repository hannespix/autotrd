/**
 * Signal-Zeitrahmen (Owner 26.07.: „Tradefrequenz deutlich erhöhen"):
 * signalCloses wählt die Kerzen-Basis der Konfluenz/Regelbaum-Signale.
 */
import { describe, expect, it } from 'vitest';
import { signalCloses } from '../src/scheduled/scanMarket.js';

const daily = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
const m5 = Array.from({ length: 390 }, (_, i) => 100 + Math.sin(i / 10));

describe('signalCloses — Zeitbasis der Signale', () => {
  it("'intraday' nutzt die 5-min-Closes, wenn genug Anlauf da ist", () => {
    expect(signalCloses({ closes: daily, closes5m: m5, price: 100, forecast: null }, 'intraday')).toBe(m5);
  });

  it("'daily' bleibt IMMER auf Tages-Closes", () => {
    expect(signalCloses({ closes: daily, closes5m: m5, price: 100, forecast: null }, 'daily')).toBe(daily);
  });

  it('zu wenig 5-min-Bars (< 35, RSI/MACD-Anlauf) → Fallback auf Tages-Closes', () => {
    expect(signalCloses({ closes: daily, closes5m: m5.slice(0, 20), price: 100, forecast: null }, 'intraday')).toBe(daily);
    expect(signalCloses({ closes: daily, price: 100, forecast: null }, 'intraday')).toBe(daily);
  });
});
