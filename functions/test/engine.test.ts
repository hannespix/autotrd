/**
 * Unit-Tests der Konfluenz-Engine (Port von trading_engine._analyze_ticker).
 * Die Indikator-Mathematik selbst ist per Golden-Tests abgesichert — hier
 * geht es um Votes und die Konfluenz-Entscheidung.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, type IndicatorsConfig, type SignalsConfig } from '../../shared/src/index.js';
import { computeSignal } from '../src/core/engine.js';

const IND: IndicatorsConfig = structuredClone(DEFAULT_STRATEGY.indicators);
const SIG: SignalsConfig = structuredClone(DEFAULT_STRATEGY.signals);

/** Geometrische Serie: 60 Bars mit konstanter Tagesänderung. */
function series(start: number, dailyPct: number, n = 60): number[] {
  const out: number[] = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! * (1 + dailyPct));
  return out;
}

describe('computeSignal (Konfluenz)', () => {
  it('stark fallende Serie + Preis unter dem Band → BUY', () => {
    const closes = series(100, -0.02);
    const price = closes[closes.length - 1]! * 0.95;
    const r = computeSignal(closes, price, IND, SIG);
    expect(r.votes.rsi).toBe('buy'); // RSI tief unter 30
    expect(r.votes.bollinger).toBe('buy'); // %B unter (100 − 95)
    // Exponentieller Abfall: MACD-Linie konvergiert gegen 0 und liegt im
    // Auslauf ÜBER dem (nachlaufenden) Signal → zusätzlicher Buy-Vote.
    expect(r.votes.macd).toBe('buy');
    expect(r.buyVotes).toBe(3);
    expect(r.sellVotes).toBe(0);
    expect(r.direction).toBe('buy');
    expect(r.confluence).toBe(3);
  });

  it('stark steigende Serie + Preis über dem Band → SELL (RSI + Bollinger)', () => {
    const closes = series(100, 0.02);
    const price = closes[closes.length - 1]! * 1.05;
    const r = computeSignal(closes, price, IND, SIG);
    expect(r.votes.rsi).toBe('sell');
    expect(r.votes.bollinger).toBe('sell');
    expect(r.votes.macd).toBe('buy');
    expect(r.direction).toBe('sell');
  });

  it('seitwärts oszillierende Serie → HOLD (RSI/Bollinger neutral)', () => {
    // ±0.2 % im Wechsel: RSI ≈ 50, Preis in Bandmitte. Der MACD kann bei
    // Mikro-Differenzen eine Einzelstimme abgeben — für die Konfluenz (≥ 2)
    // reicht das nicht.
    const closes: number[] = [100];
    for (let i = 1; i < 60; i++) closes.push(closes[i - 1]! * (i % 2 ? 1.002 : 0.998));
    const r = computeSignal(closes, 100, IND, SIG);
    expect(r.votes.rsi).toBe('hold');
    expect(r.votes.bollinger).toBe('hold');
    expect(r.buyVotes + r.sellVotes).toBeLessThanOrEqual(1);
    expect(r.direction).toBe('hold');
  });

  it('unerreichbare minConfluence (4) → HOLD trotz 3 Buy-Votes', () => {
    const closes = series(100, -0.02);
    const price = closes[closes.length - 1]! * 0.95;
    const strict: SignalsConfig = { ...SIG, minConfluence: 4 };
    const r = computeSignal(closes, price, IND, strict);
    expect(r.buyVotes).toBe(3);
    expect(r.direction).toBe('hold');
  });

  it('deaktivierte Indikatoren geben keine Votes ab', () => {
    const closes = series(100, -0.02);
    const off: IndicatorsConfig = {
      rsi: { ...IND.rsi, enabled: false },
      macd: { ...IND.macd, enabled: false },
      bollinger: { ...IND.bollinger, enabled: false },
    };
    const r = computeSignal(closes, closes[closes.length - 1]!, off, SIG);
    expect(r.buyVotes).toBe(0);
    expect(r.sellVotes).toBe(0);
    expect(r.votes).toEqual({});
    expect(r.direction).toBe('hold');
  });

  it('Snapshot enthält RSI/MACD/Bollinger-Werte', () => {
    const closes = series(100, 0.01);
    const r = computeSignal(closes, closes[closes.length - 1]!, IND, SIG);
    expect(r.snapshot.rsi).not.toBeNull();
    expect(r.snapshot.macd).not.toBeNull();
    expect(r.snapshot.bollinger).not.toBeNull();
  });

  it('Prognose-Gewicht 0 heißt STUMM — nicht „mindestens 1"', () => {
    // Der Fund vom 31.07. (Owner-Screenshot): ADA-USD zeigte 2▲, obwohl kein
    // Indikator im Kaufbereich stand. accuracyWeightedVote hatte das Gewicht
    // mangels Evidenz auf 0 gestellt, aber der Einstiegs-Deckel
    // Math.max(1, …) hob die Stimme wieder auf 1 — die Beweislast-Umkehr war
    // auf der Kaufseite ausgehebelt. compileClassic hatte den Guard immer.
    // Indikatoren komplett aus: Es geht hier NUR um die Prognose-Stimme.
    const off: IndicatorsConfig = {
      rsi: { ...IND.rsi, enabled: false },
      macd: { ...IND.macd, enabled: false },
      bollinger: { ...IND.bollinger, enabled: false },
    };
    const closes = series(100, 0.001);
    const price = closes[closes.length - 1]!;
    const stumm = { ...SIG, forecastWeight: 0 };
    const r = computeSignal(closes, price, off, stumm, { predictedPct: 5 });
    expect(r.votes.forecast).toBeUndefined(); // stimmt gar nicht mit ab
    expect(r.buyVotes).toBe(0);
    expect(r.direction).toBe('hold');
    // Gegenprobe: mit Gewicht ≥ 1 stimmt sie weiter gedeckelt mit
    const laut = { ...SIG, forecastWeight: 2 };
    const r2 = computeSignal(closes, price, off, laut, { predictedPct: 5 });
    expect(r2.votes.forecast).toBe('buy');
    expect(r2.buyVotes).toBe(Math.max(1, Math.min(2, SIG.minConfluence - 1)));
  });
});
