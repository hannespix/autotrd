/**
 * Regime-Ampel (Performance-Plan 31.07., Idee Nr. 2) — seit 04.08. Stufe 2:
 * sie STEUERT die Einstiegsrichtung (siehe `regimeEntryBlocked` am Ende).
 *
 * Die meiste Performance stirbt nicht an schlechten Signalen, sondern daran,
 * dass die richtige Strategie im falschen Marktzustand läuft. Die Ampel
 * klassifiziert den Zustand aus drei Gratis-Größen: Lage des S&P 500 zu
 * seinem 200-Tage-Durchschnitt (Trend), realisierte 20-Tage-Schwankung
 * (annualisiert) und VIX-Stand (erwartete Schwankung).
 *
 * Stufe 1 (31.07.) hat nur gemessen und in die Steckbriefe des Trade-Filters
 * gestempelt — der lernt seither je Regime getrennt. Stufe 2 (04.08.) ist
 * genau das, was dort als Bedingung stand: „Ob und was die Ampel später
 * schalten darf, entscheidet die Evidenz dieser Statistik, nicht die
 * Theorie." Die Evidenz liegt vor, siehe `regimeEntryBlocked`.
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

/* ── Stufe 2: die Ampel steuert (04.08.) ─────────────────────────────────── */

/** Warum ein Einstieg am Regime scheitert — `null` heißt: er darf. */
export type RegimeBlock = 'gegen_trend' | 'stress';

/**
 * Darf in diesem Marktzustand überhaupt in diese Richtung eingestiegen
 * werden? Pure Funktion, damit sie im Scan, im Backtest und im Test dieselbe
 * Antwort gibt.
 *
 * ── Die Evidenz, die Stufe 2 ausgelöst hat (Messung 04.08.) ───────────────
 *
 * Der Trade-Filter hatte zu diesem Zeitpunkt vier Steckbriefe für SHORTS im
 * Trend-Regime. Alle vier waren negativ, zusammen 112 Trades mit 8 Gewinnern:
 *
 *   bollinger+rsi   n=70  6 Gewinner  t=−9,0
 *   bollinger+macd  n=26  2 Gewinner  t=−5,1
 *   macd+rsi        n=12  0 Gewinner  t=−3,2
 *   bol+macd+rsi    n= 4  0 Gewinner  t=−3,1
 *
 * Entscheidend ist, was NICHT im Muster steckt: Es liegt nicht an einem
 * bestimmten Indikator. Auch die MACD-bestätigten Shorts verlieren. Der
 * gemeinsame Nenner ist die RICHTUNG — kurz gegen einen Markt, der über
 * seinem 200-Tage-Schnitt steht und ruhig läuft. Deshalb sperrt die Regel
 * die Richtung und nicht eine Signatur; eine Signatur-Regel hätte dieselbe
 * Wette bloß über den nächsten Indikator wieder hereingelassen.
 *
 * ── Die drei Regeln ───────────────────────────────────────────────────────
 *
 *  - **trend** → keine SHORT-Einstiege. Long bleibt frei: Ein Rücksetzer-Kauf
 *    im Aufwärtstrend läuft MIT dem Markt, nicht gegen ihn.
 *  - **stress** → gar keine neuen Einstiege. Bei VIX ≥ 30 bewegen sich Kurse
 *    in Sprüngen; RSI, MACD und Bollinger sagen über Sprünge nichts, und ein
 *    Stop schützt nicht, wenn zum nächsten Kurs statt zum Stop-Kurs
 *    ausgeführt wird. Bestehende Positionen bleiben unberührt.
 *  - **seitwaerts** → alles erlaubt. Das ist die Heimat der Mean Reversion:
 *    ohne Trend gibt es keine Trendrichtung, gegen die man verstoßen könnte.
 *
 * ── Was die Regel bewusst NICHT tut ───────────────────────────────────────
 *
 * Sie schließt nichts. Wie das News-Veto kann sie Einstiege nur verhindern,
 * nie auslösen und nie festhalten — eine offene Short-Position wird also
 * nicht zwangsliquidiert, weil der Markt in den Trend dreht. Sie ersetzt
 * auch den Trade-Filter nicht: Der lernt weiter je Steckbrief und trifft
 * Sorten, die diese grobe Richtungsregel durchlässt.
 */
export function regimeEntryBlocked(
  regime: MarketRegime,
  side: 'long' | 'short',
): RegimeBlock | null {
  if (regime === 'stress') return 'stress';
  if (regime === 'trend' && side === 'short') return 'gegen_trend';
  return null;
}

/* ── Stufe 3: die Seitwärts-Bremse (Hebel 2, Owner 15.08.) ────────────────── */

/**
 * Im SEITWÄRTS-Regime handelt die Engine seltener und kleiner.
 *
 * Die Ampel oben kennt für `seitwaerts` keine Richtungssperre — „alles
 * erlaubt" ist dort fachlich richtig (keine Trendrichtung, gegen die man
 * verstoßen könnte). Aber erlaubt heißt nicht empfehlenswert: Ohne Trend
 * kippt die Konfluenz im Rauschen hin und her, und genau dieses Hin und Her
 * ist der Umschlag, der über die Gebühren das Geld verbrennt (der
 * 5-min-Befund vom 30.07. — 525 Trades in zwei Tagen, Gebühren das
 * 4,7-Fache des Bruttos — war exakt dieses Muster in schnell).
 *
 * Deshalb zwei Dämpfer, beide NUR verschärfend und beide nur für Einstiege
 * (der Cooldown blockt Exits ohnehin nie, das Sizing betrifft nur neue
 * Positionen):
 *
 *  - Cooldown: mindestens verdoppelt und nie unter 30 Minuten — auch wer
 *    den Cooldown auf 0 gestellt hat, bekommt im Seitwärtsmarkt einen
 *    Whipsaw-Schutz.
 *  - Positionsgröße: halbiert. Wenn schon gehandelt wird, dann mit kleinem
 *    Einsatz — Mean-Reversion-Treffer bleiben möglich, Fehlsignale kosten
 *    die Hälfte.
 *
 * `trend` bleibt unangetastet (dort trägt die Richtungsregel oben), und in
 * `stress` sind Einstiege ohnehin komplett gesperrt — die Bremse hier ist
 * also ausschließlich die Antwort auf die NEUTRALE Ampel.
 */
export const SEITWAERTS_COOLDOWN_FAKTOR = 2;
export const SEITWAERTS_COOLDOWN_MIN = 30;
export const SEITWAERTS_GROESSEN_FAKTOR = 0.5;

/**
 * Wirksamer Einstiegs-Cooldown unter der Ampel — NUR verlängernd: Außerhalb
 * von `seitwaerts` exakt der Basiswert, darin nie kürzer als Basis, Faktor
 * und Boden.
 */
export function regimeCooldownMin(cooldownMin: number, state: MarketRegime): number {
  const basis = Number.isFinite(cooldownMin) && cooldownMin > 0 ? cooldownMin : 0;
  if (state !== 'seitwaerts') return basis;
  return Math.max(basis, basis * SEITWAERTS_COOLDOWN_FAKTOR, SEITWAERTS_COOLDOWN_MIN);
}

/** Positionsgrößen-Dämpfer unter der Ampel — NUR dämpfend (≤ 1, nie ≤ 0). */
export function regimeGroessenFaktor(state: MarketRegime): number {
  return state === 'seitwaerts' ? SEITWAERTS_GROESSEN_FAKTOR : 1;
}
