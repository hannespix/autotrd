/**
 * Regime-Ampel (Performance-Plan 31.07., Idee Nr. 2) — Stufe 1: NUR MESSEN.
 *
 * Die meiste Performance stirbt nicht an schlechten Signalen, sondern daran,
 * dass die richtige Strategie im falschen Marktzustand läuft. Die Ampel
 * klassifiziert den Zustand aus drei Gratis-Größen: Lage des S&P 500 zu
 * seinem 200-Tage-Durchschnitt (Trend), realisierte 20-Tage-Schwankung
 * (annualisiert) und VIX-Stand (erwartete Schwankung).
 *
 * In Stufe 1 steuert sie NICHTS: Sie wird je Scan gemessen, ins Heartbeat
 * geschrieben und in die Steckbriefe des Trade-Filters gestempelt — der
 * lernt damit je Regime getrennt (der Slot war im Schlüssel von Tag 1
 * reserviert). Ob und was die Ampel später schalten darf, entscheidet die
 * Evidenz dieser Statistik, nicht die Theorie.
 *
 * Fehlende Daten ⇒ 'seitwaerts': die konservative Mitte. 'trend' würde
 * fälschlich Vertrauen signalisieren, 'stress' fälschlich Alarm — beides
 * wären Aussagen ohne Grundlage.
 */

export type MarketRegime = 'trend' | 'seitwaerts' | 'stress';

/** Fenster der realisierten Schwankung (Handelstage). */
export const REGIME_VOL_WINDOW = 20;
/** VIX ab hier: Stress — historisch die Schwelle ausgewachsener Korrekturen. */
export const REGIME_STRESS_VIX = 30;
/** VIX ab hier: erhöht — unter dem SMA200 reicht das bereits für Stress. */
export const REGIME_ELEVATED_VIX = 25;
/** Realisierte annualisierte Vol (%) ab hier: Stress, egal was der VIX sagt. */
export const REGIME_STRESS_VOL = 30;
/** Realisierte Vol (%) bis hier gilt ein Markt über dem SMA200 als ruhiger Trend. */
export const REGIME_TREND_VOL = 20;
/** SMA-Fenster der Trendlage. */
export const REGIME_SMA_WINDOW = 200;

/**
 * Realisierte Volatilität in % p. a. aus Tages-Closes (Stichprobe der
 * letzten `window` Renditen, annualisiert mit √252). null bei zu wenig Daten.
 */
export function realizedVolPct(closes: number[], window = REGIME_VOL_WINDOW): number | null {
  if (closes.length < window + 1) return null;
  const seg = closes.slice(-(window + 1));
  const rets: number[] = [];
  for (let i = 1; i < seg.length; i++) {
    const prev = seg[i - 1]!;
    if (!(prev > 0)) return null;
    rets.push(seg[i]! / prev - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1);
  return Math.round(Math.sqrt(variance) * Math.sqrt(252) * 1000) / 10;
}

export interface RegimeReading {
  state: MarketRegime;
  /** Eingangsgrößen — Transparenz für Heartbeat und spätere Auswertung. */
  aboveSma200: boolean | null;
  realizedVolPct: number | null;
  vix: number | null;
}

/**
 * Der Marktzustand aus S&P-500-Tages-Closes und VIX-Stand.
 *
 * Reihenfolge der Regeln (die erste, die zieht, gewinnt):
 * 1. STRESS: VIX ≥ 30, ODER realisierte Vol ≥ 30 %, ODER (unter SMA200 UND
 *    VIX ≥ 25) — ein fallender Markt mit erhöhter erwarteter Schwankung ist
 *    kein „Seitwärts".
 * 2. TREND: über SMA200 UND realisierte Vol < 20 % UND VIX < 25 (fehlender
 *    VIX blockiert den Trend nicht — realisierte Vol ist dann die Wache).
 * 3. Sonst SEITWÄRTS.
 */
export function marketRegime(spyCloses: number[], vix: number | null): RegimeReading {
  const vol = realizedVolPct(spyCloses);
  let above: boolean | null = null;
  if (spyCloses.length >= REGIME_SMA_WINDOW) {
    const seg = spyCloses.slice(-REGIME_SMA_WINDOW);
    const sma = seg.reduce((s, c) => s + c, 0) / seg.length;
    above = spyCloses[spyCloses.length - 1]! > sma;
  }

  const fertig = (state: MarketRegime): RegimeReading => ({
    state,
    aboveSma200: above,
    realizedVolPct: vol,
    vix,
  });

  // Ohne Trendlage UND ohne Vol keine Aussage — konservative Mitte.
  if (above === null && vol === null) return fertig('seitwaerts');

  const vixStress = vix !== null && vix >= REGIME_STRESS_VIX;
  const volStress = vol !== null && vol >= REGIME_STRESS_VOL;
  const fallendNervoes = above === false && vix !== null && vix >= REGIME_ELEVATED_VIX;
  if (vixStress || volStress || fallendNervoes) return fertig('stress');

  const ruhig = vol !== null && vol < REGIME_TREND_VOL;
  const vixOk = vix === null || vix < REGIME_ELEVATED_VIX;
  if (above === true && ruhig && vixOk) return fertig('trend');

  return fertig('seitwaerts');
}
