/**
 * Regime-Ampel — die kritischen Tests sind die Grenz- und Fehlfälle:
 * Fehlende Daten dürfen weder Vertrauen ('trend') noch Alarm ('stress')
 * behaupten, und die Stress-Regeln müssen VOR der Trend-Regel greifen.
 */

import { describe, expect, it } from 'vitest';
import {
  REGIME_ELEVATED_VIX,
  REGIME_SMA_WINDOW,
  REGIME_STRESS_VIX,
  marketRegime,
  realizedVolPct,
} from '../src/regime.js';

/** n Tages-Closes mit konstanter Tagesrendite. */
const serie = (n: number, dailyPct: number, start = 100): number[] => {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! * (1 + dailyPct));
  return out;
};

/** Ruhiger Aufwärtstrend: 250 Tage à +0,05 % — über SMA200, Vol ≈ 0,8 % p. a. */
const trendSerie = serie(250, 0.0005);

/** Abwärtsserie: 250 Tage à −0,2 % — klar unter SMA200. */
const baisseSerie = serie(250, -0.002);

describe('realizedVolPct', () => {
  it('braucht window+1 Closes — sonst null', () => {
    expect(realizedVolPct(serie(20, 0.001))).toBeNull();
    expect(realizedVolPct(serie(21, 0.001))).not.toBeNull();
  });

  it('konstante Renditen ⇒ Vol ≈ 0; wilde Sprünge ⇒ hohe Vol', () => {
    expect(realizedVolPct(trendSerie)!).toBeLessThan(1);
    const wild = trendSerie.map((c, i) => (i % 2 ? c * 1.03 : c * 0.97));
    expect(realizedVolPct(wild)!).toBeGreaterThan(30);
  });
});

describe('marketRegime', () => {
  it('ruhiger Markt über SMA200 mit niedrigem VIX ⇒ trend', () => {
    const r = marketRegime(trendSerie, 15);
    expect(r.state).toBe('trend');
    expect(r.aboveSma200).toBe(true);
  });

  it('VIX ≥ 30 ⇒ stress, auch wenn der Kurs noch über dem SMA200 steht', () => {
    // Der Crash-Anfang sieht im Kursbild oft noch gesund aus — der VIX ist
    // dann das frühere Signal. Die Stress-Regel MUSS vor der Trend-Regel ziehen.
    expect(marketRegime(trendSerie, REGIME_STRESS_VIX).state).toBe('stress');
  });

  it('hohe REALISIERTE Vol ⇒ stress, auch ganz ohne VIX', () => {
    const wild = trendSerie.map((c, i) => (i % 2 ? c * 1.03 : c * 0.97));
    expect(marketRegime(wild, null).state).toBe('stress');
  });

  it('unter SMA200 + erhöhter VIX ⇒ stress; unter SMA200 + ruhiger VIX ⇒ seitwaerts', () => {
    expect(marketRegime(baisseSerie, REGIME_ELEVATED_VIX).state).toBe('stress');
    expect(marketRegime(baisseSerie, 15).state).toBe('seitwaerts');
  });

  it('über SMA200, aber VIX erhöht ⇒ KEIN trend (seitwaerts)', () => {
    expect(marketRegime(trendSerie, REGIME_ELEVATED_VIX).state).toBe('seitwaerts');
  });

  it('fehlender VIX blockiert den Trend nicht — realisierte Vol ist die Wache', () => {
    expect(marketRegime(trendSerie, null).state).toBe('trend');
  });

  it('fehlende Daten ⇒ konservative Mitte, nie Vertrauen oder Alarm', () => {
    expect(marketRegime([], null).state).toBe('seitwaerts');
    expect(marketRegime(serie(10, 0.001), null).state).toBe('seitwaerts');
  });

  it('unter SMA-Fenster, aber mit Vol ⇒ urteilt nur über die Vol-Achse', () => {
    // 50 Closes: keine Trendlage (null), aber Vol berechenbar — ruhig ⇒
    // seitwaerts (trend braucht die Lage), wild ⇒ stress.
    const kurz = serie(50, 0.0005);
    expect(marketRegime(kurz, null).state).toBe('seitwaerts');
    expect(kurz.length).toBeLessThan(REGIME_SMA_WINDOW);
    const kurzWild = kurz.map((c, i) => (i % 2 ? c * 1.03 : c * 0.97));
    expect(marketRegime(kurzWild, null).state).toBe('stress');
  });

  it('liefert die Eingangsgrößen transparent mit', () => {
    const r = marketRegime(trendSerie, 12);
    expect(r.vix).toBe(12);
    expect(r.realizedVolPct).not.toBeNull();
    expect(r.aboveSma200).toBe(true);
  });
});
