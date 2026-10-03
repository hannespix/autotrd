/**
 * Selbstlernender Trade-Filter — die wichtigsten Tests sind die, die das
 * NICHT-Blocken festhalten: Ein Filter, der auf dünner Evidenz blockt, ist
 * Rauschen mit Meinung, und ein leerer Steckbrief muss handeln lassen wie
 * bisher (der Filter beginnt stumm — Schule von News-Veto und Forecast-Vote).
 */

import { describe, expect, it } from 'vitest';
import {
  FILTER_MIN_SAMPLES,
  FILTER_T_BLOCK,
  bucketKey,
  bucketTStat,
  bucketVerdict,
  signalSignature,
  updateBucket,
  type BucketStat,
} from '../src/tradeFilter.js';

const fuellen = (pnls: number[]): BucketStat =>
  pnls.reduce<BucketStat>((s, p) => updateBucket(s, p), { n: 0, wins: 0, pnlSum: 0, pnlSqSum: 0 });

describe('signalSignature', () => {
  it('sortiert die Träger — bb+rsi und rsi+bb sind DERSELBE Steckbrief', () => {
    expect(signalSignature({ rsi: 'buy', bollinger: 'buy', macd: 'hold' })).toBe('bollinger+rsi');
    expect(signalSignature({ bollinger: 'buy', rsi: 'buy' })).toBe('bollinger+rsi');
  });

  it('ohne Kauf-Stimmen (Regelbaum-Pfad) heißt die Signatur „keine"', () => {
    expect(signalSignature({})).toBe('keine');
    expect(signalSignature(null)).toBe('keine');
    expect(signalSignature({ rsi: 'sell' })).toBe('keine');
  });

  it('für Shorts zählen die VERKAUFS-Stimmen als Träger', () => {
    expect(signalSignature({ rsi: 'sell', macd: 'sell', bollinger: 'buy' }, 'sell')).toBe('macd+rsi');
  });
});

describe('bucketKey', () => {
  it('trägt den Regime-Slot ab Tag 1 — Default „alle"', () => {
    const key = bucketKey({ assetClass: 'crypto', timeframe: 'daily', signature: 'rsi', side: 'long' });
    expect(key).toBe('crypto|daily|rsi|long|alle');
  });

  it('mit Regime-Ampel entsteht ein NEUER Steckbrief statt Umdeutung', () => {
    const ohne = bucketKey({ assetClass: 'stocks', timeframe: 'intraday', signature: 'macd', side: 'long' });
    const mit = bucketKey({ assetClass: 'stocks', timeframe: 'intraday', signature: 'macd', side: 'long', regime: 'stress' });
    expect(mit).not.toBe(ohne);
  });
});

describe('updateBucket', () => {
  it('zählt n/wins/Summen korrekt und lässt das Original unangetastet', () => {
    const a = updateBucket(null, 10);
    const b = updateBucket(a, -4);
    expect(b).toEqual({ n: 2, wins: 1, pnlSum: 6, pnlSqSum: 116 });
    expect(a.n).toBe(1); // pur
  });

  it('0-P&L ist KEIN Gewinner — Gebühren-Nullsummen schönen die Quote nicht', () => {
    expect(updateBucket(null, 0).wins).toBe(0);
  });
});

describe('bucketTStat', () => {
  it('konstant negative Trades ohne Streuung ⇒ null statt −∞', () => {
    // sd = 0 wäre Division durch 0 — und „jeder Trade exakt gleich" ist
    // verdächtig (identische Rundung?), nicht beweiskräftig.
    expect(bucketTStat(fuellen([-5, -5, -5]))).toBeNull();
  });

  it('klar negativer Erwartungswert ergibt deutlich negatives t', () => {
    const pnls = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? 2 : -6));
    const t = bucketTStat(fuellen(pnls));
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(-4);
  });
});

describe('bucketVerdict — die Beweislast liegt beim Block', () => {
  const verlierer = (n: number): BucketStat =>
    fuellen(Array.from({ length: n }, (_, i) => (i % 5 === 0 ? 2 : -6)));

  it('leerer/fehlender Steckbrief blockt NIE', () => {
    expect(bucketVerdict(null).blocked).toBe(false);
    expect(bucketVerdict(undefined).blocked).toBe(false);
  });

  it('unter MIN_SAMPLES blockt auch eine katastrophale Serie nicht', () => {
    const v = bucketVerdict(verlierer(FILTER_MIN_SAMPLES - 1));
    expect(v.t).not.toBeNull();
    expect(v.t!).toBeLessThan(FILTER_T_BLOCK); // Signifikanz wäre da …
    expect(v.blocked).toBe(false); // … aber die Stichprobe ist zu klein
  });

  it('ab MIN_SAMPLES + signifikant negativ ⇒ Block', () => {
    const v = bucketVerdict(verlierer(FILTER_MIN_SAMPLES));
    expect(v.blocked).toBe(true);
    expect(v.n).toBe(FILTER_MIN_SAMPLES);
  });

  it('viele Trades mit NEUTRALEM Erwartungswert blocken nicht', () => {
    // ±6 im Wechsel: Erwartungswert ≈ 0 — kein Beweis für „schlecht",
    // egal wie groß n wird.
    const neutral = fuellen(Array.from({ length: 200 }, (_, i) => (i % 2 ? 6 : -6)));
    expect(bucketVerdict(neutral).blocked).toBe(false);
  });

  it('positiver Erwartungswert blockt nie — auch bei riesigem n', () => {
    const gewinner = fuellen(Array.from({ length: 500 }, (_, i) => (i % 3 === 0 ? -2 : 3)));
    expect(bucketVerdict(gewinner).blocked).toBe(false);
  });
});
