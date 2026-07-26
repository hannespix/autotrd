/**
 * MA2/MA6 (Engine-Audit): Die neue Ein-/Ausstiegs-Logik.
 *
 * Hintergrund — Owner-Beobachtung „2 Tage Laufzeit, kein einziger Verkauf":
 * Stop und Take funktionierten, aber die Konfluenz kam praktisch nie zu
 * einem Verkauf. Zwei Ursachen, beide hier festgenagelt:
 *
 *  1. Die Prognose (Gewicht 2) riss die Schwelle (2) im Alleingang — aus der
 *     „Konfluenz aus drei Indikatoren" wurde eine Ein-Stimmen-Entscheidung.
 *  2. Die Gleichstandsregel blockierte Ausstiege genau dann, wenn sie nötig
 *     waren: In fallenden Märkten sagen RSI („überverkauft") und Bollinger
 *     („unteres Band") KAUFEN, MACD und Prognose VERKAUFEN — 2:2, also nichts.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, atr, atrPct, resolveRisk, type Position, type SignalsConfig } from '../../shared/src/index.js';
import { computeSignal } from '../src/core/engine.js';
import { riskExitReason } from '../src/core/broker.js';

/** Serie, die RSI klar überverkauft und MACD bärisch stellt (Abwärtstrend). */
const fallingCloses = (): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 80; i++) out.push(120 - i * 0.8);
  return out;
};

const signals = (over: Partial<SignalsConfig> = {}): SignalsConfig => ({
  ...DEFAULT_STRATEGY.signals,
  ...over,
});

describe('MA2 — Prognose darf die Konfluenz nicht allein reißen', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 7) * 1.5);

  it('Einstieg: Prognose mit Gewicht 2 allein genügt NICHT (Default)', () => {
    const r = computeSignal(
      closes,
      closes[closes.length - 1]!,
      DEFAULT_STRATEGY.indicators,
      signals({ minConfluence: 2, forecastWeight: 2 }),
      { predictedPct: 3 },
    );
    // Die Prognose zählt gedeckelt (minConfluence − 1 = 1) — für einen Kauf
    // muss also ein echter Indikator dazukommen.
    expect(r.votes.forecast).toBe('buy');
    if (r.direction === 'buy') {
      const others = (['rsi', 'macd', 'bollinger'] as const).filter((k) => r.votes[k] === 'buy').length;
      expect(others).toBeGreaterThanOrEqual(1);
    }
  });

  it('forecastSolo = true gibt der Prognose das volle Gewicht zurück', () => {
    const solo = computeSignal(closes, closes[closes.length - 1]!, DEFAULT_STRATEGY.indicators,
      signals({ minConfluence: 2, forecastWeight: 2, forecastSolo: true }), { predictedPct: 3 });
    const capped = computeSignal(closes, closes[closes.length - 1]!, DEFAULT_STRATEGY.indicators,
      signals({ minConfluence: 2, forecastWeight: 2, forecastSolo: false }), { predictedPct: 3 });
    expect(solo.buyVotes).toBeGreaterThan(capped.buyVotes);
  });

  it('Ausstieg: die Prognose zählt ungedeckelt (Risiko-Asymmetrie)', () => {
    const r = computeSignal(closes, closes[closes.length - 1]!, DEFAULT_STRATEGY.indicators,
      signals({ minConfluence: 2, forecastWeight: 2 }), { predictedPct: -3 },
      { hasPosition: true });
    expect(r.votes.forecast).toBe('sell');
    expect(r.sellVotes).toBeGreaterThanOrEqual(2);
    expect(r.direction).toBe('sell');
  });
});

describe('MA2 — Ausstieg ist leichter als Einstieg', () => {
  const closes = fallingCloses();
  const price = closes[closes.length - 1]!;

  it('Gleichstand der Stimmen führt MIT Position zum Verkauf, OHNE Position zu nichts', () => {
    const cfg = signals({ minConfluence: 2, exitConfluence: 1, useForecast: false });
    const flat = computeSignal(closes, price, DEFAULT_STRATEGY.indicators, cfg, null);
    const held = computeSignal(closes, price, DEFAULT_STRATEGY.indicators, cfg, null, { hasPosition: true });
    // Im Abwärtstrend steht mindestens eine Verkaufsstimme im Raum …
    expect(held.sellVotes).toBeGreaterThanOrEqual(1);
    // … die mit offener Position auch zum Ausstieg führt
    expect(held.direction).toBe('sell');
    // … ohne Position aber (mangels Gegenwert) nicht zum selben Ergebnis führen muss
    expect(flat.requiredConfluence).toBe(2);
    expect(held.requiredConfluence).toBe(1);
  });

  it('exitConfluence ist frei einstellbar und wird respektiert', () => {
    const strict = computeSignal(closes, price, DEFAULT_STRATEGY.indicators,
      signals({ minConfluence: 2, exitConfluence: 3, useForecast: false }), null, { hasPosition: true });
    expect(strict.requiredConfluence).toBe(3);
    // Mit drei geforderten Stimmen reicht ein einzelner bärischer Indikator nicht
    if (strict.sellVotes < 3) expect(strict.direction).not.toBe('sell');
  });

  it('ohne exitConfluence gilt „eine Stimme weniger als der Einstieg", mindestens 1', () => {
    const a = computeSignal(closes, price, DEFAULT_STRATEGY.indicators,
      { ...DEFAULT_STRATEGY.signals, minConfluence: 3, exitConfluence: undefined }, null, { hasPosition: true });
    expect(a.requiredConfluence).toBe(2);
    const b = computeSignal(closes, price, DEFAULT_STRATEGY.indicators,
      { ...DEFAULT_STRATEGY.signals, minConfluence: 1, exitConfluence: undefined }, null, { hasPosition: true });
    expect(b.requiredConfluence).toBe(1);
  });
});

/* ── Risiko-Exits: Trailing, ATR, Zeitgrenze ─────────────────────────────── */

const pos = (over: Partial<Position> = {}): Position => ({
  symbol: 'X', qty: 10, avgEntry: 100, stopLoss: null, takeProfit: null,
  openedAt: '2026-07-20T14:00:00.000Z', ...over,
});

describe('MA6 — nachziehender Stop sichert Gewinne', () => {
  const risk = { stopLossPct: 2, takeProfitPct: 0, trailingStopPct: 3 };

  it('greift, wenn der Kurs 3 % unter den Höchstkurs fällt', () => {
    const p = pos({ highWater: 120 });
    expect(riskExitReason(p, 117, { risk })).toBeNull();          // −2,5 % vom Peak
    expect(riskExitReason(p, 116.4, { risk })).toBe('trailing_stop'); // −3 %
  });

  it('greift NICHT, solange die Position nie im Plus war (dafür ist der feste Stop da)', () => {
    const p = pos({ highWater: 100 }); // Peak = Einstand
    expect(riskExitReason(p, 98.5, { risk })).toBeNull();
    expect(riskExitReason(p, 98, { risk })).toBe('stop_loss'); // fester Stop, nicht Trailing
  });

  it('überstimmt kein bewusst weit gesetztes Stop-Level', () => {
    const p = pos({ highWater: 100, stopLoss: 90 });
    expect(riskExitReason(p, 95, { risk })).toBeNull(); // Level 90 gilt, nicht 2 %
  });

  it('trailingStopPct = 0 schaltet ihn ab', () => {
    const p = pos({ highWater: 200 });
    expect(riskExitReason(p, 150, { risk: { stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 0 } })).toBeNull();
  });
});

describe('MA6 — ATR-Stops passen sich der Volatilität an', () => {
  it('weiter Stop bei hoher ATR, enger bei niedriger', () => {
    const risk = { stopLossPct: 2, takeProfitPct: 0, atrStopMult: 2 };
    // ATR 4 % → Stop bei 2 × 4 % = 8 %
    expect(riskExitReason(pos(), 93, { risk, atrPct: 4 })).toBeNull();
    expect(riskExitReason(pos(), 92, { risk, atrPct: 4 })).toBe('stop_loss');
    // ATR 0,5 % → Stop bei 1 %
    expect(riskExitReason(pos(), 99.5, { risk, atrPct: 0.5 })).toBeNull();
    expect(riskExitReason(pos(), 99, { risk, atrPct: 0.5 })).toBe('stop_loss');
  });

  it('fällt ohne ATR-Wert sauber auf die Prozente zurück', () => {
    const risk = { stopLossPct: 2, takeProfitPct: 0, atrStopMult: 2 };
    expect(riskExitReason(pos(), 98, { risk, atrPct: null })).toBe('stop_loss');
    expect(riskExitReason(pos(), 99, { risk, atrPct: null })).toBeNull();
  });
});

describe('MA6 — Zeitgrenze', () => {
  it('schließt eine Position nach maxHoldDays', () => {
    const risk = { stopLossPct: 2, takeProfitPct: 0, maxHoldDays: 5 };
    const p = pos({ openedAt: '2026-07-01T10:00:00.000Z' });
    expect(riskExitReason(p, 100, { risk, now: new Date('2026-07-05T10:00:00Z') })).toBeNull();
    expect(riskExitReason(p, 100, { risk, now: new Date('2026-07-06T10:00:00Z') })).toBe('max_hold');
  });

  it('maxHoldDays = 0 ist aus', () => {
    const risk = { stopLossPct: 2, takeProfitPct: 0, maxHoldDays: 0 };
    const p = pos({ openedAt: '2020-01-01T00:00:00.000Z' });
    expect(riskExitReason(p, 100, { risk, now: new Date('2026-07-06T10:00:00Z') })).toBeNull();
  });
});

describe('MA6 — Risiko-Profile je Asset-Klasse', () => {
  it('Krypto erbt weitere Stops als der globale Default', () => {
    const crypto = resolveRisk(DEFAULT_STRATEGY.engine, 'crypto');
    const global = resolveRisk(DEFAULT_STRATEGY.engine, null);
    expect(crypto.stopLossPct).toBeGreaterThan(global.stopLossPct);
    expect(crypto.takeProfitPct).toBeGreaterThan(global.takeProfitPct);
  });

  it('unbekannte Klassen fallen auf die globalen Werte zurück', () => {
    const unknown = resolveRisk(DEFAULT_STRATEGY.engine, 'gibt_es_nicht');
    expect(unknown.stopLossPct).toBe(DEFAULT_STRATEGY.engine.stopLossPct);
  });

  it('derselbe Kursverlauf löst bei Aktien aus, bei Krypto nicht', () => {
    const p = pos();
    const stock = riskExitReason(p, 97, { risk: resolveRisk(DEFAULT_STRATEGY.engine, 'stocks_us') });
    const crypto = riskExitReason(p, 97, { risk: resolveRisk(DEFAULT_STRATEGY.engine, 'crypto') });
    expect(stock).toBe('stop_loss'); // −3 % reißt den 2-%-Stop
    expect(crypto).toBeNull();       // Krypto-Profil erlaubt 6 %
  });
});

describe('ATR-Indikator', () => {
  const bars = (n: number, range: number): Array<{ high: number; low: number; close: number }> =>
    Array.from({ length: n }, (_, i) => {
      const c = 100 + Math.sin(i / 3) * 2;
      return { high: c + range / 2, low: c - range / 2, close: c };
    });

  it('liefert erst ab genügend Bars einen Wert', () => {
    expect(atr(bars(10, 2), 14).every((v) => v === null)).toBe(true);
    const a = atr(bars(30, 2), 14);
    expect(a[13]).not.toBeNull();
    expect(a[29]).toBeGreaterThan(0);
  });

  it('wächst mit der Schwankungsbreite', () => {
    const calm = atrPct(bars(40, 1), 14)!;
    const wild = atrPct(bars(40, 8), 14)!;
    expect(wild).toBeGreaterThan(calm * 3);
  });

  it('bleibt bei leeren oder kaputten Eingaben still', () => {
    expect(atr([], 14)).toEqual([]);
    expect(atrPct(bars(5, 1), 14)).toBeNull();
  });
});
