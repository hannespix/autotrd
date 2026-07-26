/**
 * Short-Selling (Owner 26.07.: „bitte auch schorten können"):
 * riskExitReason gespiegelt (Verlust bei STEIGENDEM Kurs) und die
 * Exit-Asymmetrie von computeSignal für offene Shorts (Ausstieg = buy).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, type Position } from '../../shared/src/index.js';
import { riskExitReason } from '../src/core/broker.js';
import { computeSignal } from '../src/core/engine.js';

const risk = (over: Partial<{ stopLossPct: number; takeProfitPct: number; trailingStopPct: number }> = {}) => ({
  risk: {
    stopLossPct: over.stopLossPct ?? 2,
    takeProfitPct: over.takeProfitPct ?? 4,
    trailingStopPct: over.trailingStopPct ?? 0,
  },
});

const shortPos = (over: Partial<Position> = {}): Position => ({
  symbol: 'QQQ',
  qty: 10,
  avgEntry: 100,
  side: 'short',
  stopLoss: null,
  takeProfit: null,
  openedAt: '2026-07-26T10:00:00.000Z',
  lowWater: 100,
  ...over,
});

describe('riskExitReason — Short-Spiegelung', () => {
  it('Stop feuert, wenn der Kurs ÜBER den Einstand steigt (+3 % bei 2 % Stop)', () => {
    expect(riskExitReason(shortPos(), 103, risk())).toBe('stop_loss');
  });

  it('Take feuert, wenn der Kurs unter den Einstand fällt (−5 % bei 4 % Ziel)', () => {
    expect(riskExitReason(shortPos(), 95, risk())).toBe('take_profit');
  });

  it('zwischen den Schwellen bleibt der Short offen (+1 %)', () => {
    expect(riskExitReason(shortPos(), 101, risk())).toBeNull();
  });

  it('gespeichertes Stop-LEVEL (über dem Einstand) schlägt den Prozentwert', () => {
    const p = shortPos({ stopLoss: 110 });
    expect(riskExitReason(p, 105, risk())).toBeNull(); // +5 % — Level 110 noch nicht erreicht
    expect(riskExitReason(p, 110.5, risk())).toBe('stop_loss');
  });

  it('gespeichertes Take-LEVEL (unter dem Einstand) schlägt den Prozentwert', () => {
    const p = shortPos({ takeProfit: 94 });
    expect(riskExitReason(p, 95, risk())).toBeNull(); // −5 % — Level 94 noch nicht erreicht
    expect(riskExitReason(p, 93.9, risk())).toBe('take_profit');
  });

  it('Short-Trailing: sichert Gewinne über lowWater — Kurs läuft vom Tief hoch', () => {
    // Tief 90 (< Einstand 100) → 3 % über dem Tief = 92.7
    const p = shortPos({ lowWater: 90 });
    expect(riskExitReason(p, 92.7, risk({ stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 3 }))).toBe('trailing_stop');
    expect(riskExitReason(p, 92.0, risk({ stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 3 }))).toBeNull();
  });

  it('Short-Trailing greift NICHT, solange der Short nie im Gewinn war', () => {
    // lowWater = Einstand → nie unter Entry → nur der reguläre Stop zählt
    const p = shortPos({ lowWater: 100 });
    expect(riskExitReason(p, 101, risk({ stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 3 }))).toBeNull();
  });

  it('Long-Verhalten bleibt unverändert (side fehlt = long)', () => {
    const long: Position = { ...shortPos(), side: undefined as never, highWater: 100, lowWater: null };
    delete (long as Partial<Position>).side;
    expect(riskExitReason(long, 97, risk())).toBe('stop_loss'); // −3 % bei 2 % Stop
    expect(riskExitReason(long, 105, risk())).toBe('take_profit'); // +5 % bei 4 % Ziel
  });
});

describe('computeSignal — Exit-Asymmetrie für offene Shorts', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 2);
  const signals = { ...DEFAULT_STRATEGY.signals, useForecast: true, forecastWeight: 2, forecastThresholdPct: 0.5, minConfluence: 2, exitConfluence: 1 };
  const noInd = {
    rsi: { enabled: false, window: 14, thresholdBuy: 30, thresholdSell: 70 },
    macd: { enabled: false, crossoverBuy: true },
    bollinger: { enabled: false, bbBreakoutPct: 95 },
  };

  it('offener Short: Kauf-Stimme mit Exit-Schwelle deckt ein (buy)', () => {
    const sig = computeSignal(closes, 100, noInd, signals, { predictedPct: 2 }, { hasPosition: true, positionSide: 'short' });
    expect(sig.direction).toBe('buy'); // 1 gedeckelte buy-Stimme ≥ exitConfluence 1
  });

  it('offener Short: Gleichstand geht an den Exit (buy), wie beim Long an sell', () => {
    // Prognose neutral, keine Indikatoren → 0:0-Gleichstand reicht NICHT (exitReq 1)
    const neutral = computeSignal(closes, 100, noInd, signals, { predictedPct: 0 }, { hasPosition: true, positionSide: 'short' });
    expect(neutral.direction).toBe('hold');
  });

  it('offener LONG bleibt bei der bisherigen Semantik (sell gewinnt)', () => {
    const sig = computeSignal(closes, 100, noInd, signals, { predictedPct: -2 }, { hasPosition: true });
    expect(sig.direction).toBe('sell');
  });
});
