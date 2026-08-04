/**
 * Regime-gerechte Lesart derselben Indikatoren — als SCHATTEN-Variante (MI).
 *
 * ── Der Befund, der das nötig macht ───────────────────────────────────────
 *
 * Am 04.08. um 21:10 Uhr stand im Heartbeat:
 *
 *   signalDirs   buy 0 · sell 0 · hold 13
 *   knappVerfehlt 13 von 13
 *   voteDirs     rsi  0/0/13 hold · bollinger 0/2/11 · macd 6/7/0
 *   regime       trend (S&P über SMA200, VIX 16,5)
 *
 * Jedes einzelne Signal verfehlte die Konfluenz um genau EINE Stimme, und
 * zwar immer dieselbe: MACD stimmte ab, RSI und Bollinger schwiegen. Das ist
 * kein Zufall und kein Datenfehler, sondern Bauart.
 *
 * RSI (Schwellen 30/70) und Bollinger (Ausbruch ab dem 95. Perzentil) sind
 * als UMKEHR-Indikatoren parametriert: Sie sprechen nur im Extrem. MACD ist
 * ein TRENDFOLGER: Er spricht, sobald eine Richtung da ist. In einem
 * laufenden Trend — genau dem Regime von heute — schweigen die
 * Umkehr-Indikatoren strukturell, und `minConfluence: 2` ist damit
 * unerreichbar. Nicht selten. Unerreichbar.
 *
 * ── Warum NICHT einfach eine vierte Stimme ────────────────────────────────
 *
 * Der naheliegende Griff wäre ein zweiter Trendfolger (Preis über SMA50).
 * Der spräche im Trend zuverlässig — und sagte dasselbe wie MACD. Zwei
 * korrelierte Trendfolger als „Konfluenz aus zwei Stimmen" zu zählen ist
 * `minConfluence: 1` mit Extraschritten; die Zahl im UI stiege, die
 * Aussagekraft nicht. Diese Art von Selbstbetrug hat das Projekt schon
 * einmal gekostet (Forecast-Gewicht 2 bei Konfluenz 2 — die „Konfluenz aus
 * drei Indikatoren" war ein Etikett, Audit 26.07.).
 *
 * ── Was diese Datei stattdessen tut ───────────────────────────────────────
 *
 * Sie liest DIESELBEN Indikatoren regime-gerecht. Ein Bollinger-Ausbruch
 * nach oben ist im Seitwärtsmarkt ein Umkehrsignal („zu weit gelaufen") und
 * im Trend ein Fortsetzungssignal („Stärke"). Ein RSI über 50 ist im
 * Seitwärtsmarkt nichtssagend und im Trend eine Richtungsbestätigung. Das
 * ist keine Erfindung, sondern der Standard-Unterschied zwischen
 * Mean-Reversion- und Momentum-Lesart.
 *
 * ── Und warum es NUR im Schatten läuft ────────────────────────────────────
 *
 * Weil mehr Signale bei negativer Kante mehr Verlust bedeuten. Die
 * gemessene Lage am 04.08.: +0,143 % Kante je Trade gegen 0,300 %
 * Roundtrip-Kosten, Deckung 0,48. Solange das gilt, ist der Stillstand
 * teuer, aber billiger als der Betrieb — und jede Änderung, die mehr
 * Trades erzeugt, muss VORHER belegen, dass sie die Kante hebt.
 *
 * Genau dafür gibt es die Schatten-Messung aus MG4: Diese Variante schreibt
 * ihre Signale mit, sie werden gegen den nächsten Kurs bewertet, und nach
 * ein bis zwei Tagen steht die Kante beider Lesarten nebeneinander. Erst
 * dann wird entschieden. Messen, dann handeln — nicht umgekehrt.
 */

import type { IndicatorSnapshot, IndicatorsConfig, SignalDirection } from './strategy.js';
import type { MarketRegime } from './regime.js';

/**
 * RSI-Mitte: darüber Aufwärts-, darunter Abwärtsbestätigung.
 *
 * 50 ist beim RSI keine willkürliche Zahl, sondern der Punkt, an dem sich
 * durchschnittliche Auf- und Abwärtsbewegung die Waage halten. Eine
 * Totzone darum herum verhindert, dass jedes Zittern um die Mitte eine
 * Stimme erzeugt.
 */
export const RSI_MITTE = 50;
export const RSI_TOTZONE = 5;

export interface RegimeStimmen {
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger', SignalDirection>>;
  buyVotes: number;
  sellVotes: number;
}

/**
 * Stimmen derselben drei Indikatoren, regime-gerecht gelesen.
 *
 * `stress` gibt bewusst gar keine Stimme: Wenn die Volatilität aus dem
 * Rahmen läuft, taugt weder die Umkehr- noch die Trendlesart — und ein
 * Signal, dem man nicht trauen kann, ist schlechter als keins.
 */
export function regimeStimmen(
  snapshot: IndicatorSnapshot,
  regime: MarketRegime,
  cfg: IndicatorsConfig,
): RegimeStimmen {
  const votes: RegimeStimmen['votes'] = {};
  let buyVotes = 0;
  let sellVotes = 0;
  if (regime === 'stress') return { votes, buyVotes, sellVotes };

  const stimme = (name: keyof RegimeStimmen['votes'], dir: SignalDirection): void => {
    votes[name] = dir;
    if (dir === 'buy') buyVotes += 1;
    else if (dir === 'sell') sellVotes += 1;
  };

  if (cfg.rsi.enabled && snapshot.rsi !== null) {
    if (regime === 'trend') {
      // Momentum-Lesart: Der RSI bestätigt die Richtung, statt gegen sie zu
      // arbeiten. Ohne Totzone wäre das ein Münzwurf um die Mitte.
      if (snapshot.rsi > RSI_MITTE + RSI_TOTZONE) stimme('rsi', 'buy');
      else if (snapshot.rsi < RSI_MITTE - RSI_TOTZONE) stimme('rsi', 'sell');
      else stimme('rsi', 'hold');
    } else if (snapshot.rsi < cfg.rsi.thresholdBuy) stimme('rsi', 'buy');
    else if (snapshot.rsi > cfg.rsi.thresholdSell) stimme('rsi', 'sell');
    else stimme('rsi', 'hold');
  }

  // MACD bleibt in beiden Regimes derselbe Trendfolger — er ist die einzige
  // der drei Stimmen, die ohnehin schon regime-gerecht liest.
  if (cfg.macd.enabled && cfg.macd.crossoverBuy && snapshot.macd) {
    const { line, signal, histogram } = snapshot.macd;
    if (line > signal && histogram > 0) stimme('macd', 'buy');
    else if (line < signal && histogram < 0) stimme('macd', 'sell');
    else stimme('macd', 'hold');
  }

  if (cfg.bollinger.enabled && snapshot.bollinger) {
    const pct = snapshot.bollinger.pctB;
    const thr = cfg.bollinger.bbBreakoutPct;
    if (regime === 'trend') {
      // Ausbruch = Stärke, nicht Übertreibung. Genau hier dreht sich das
      // Vorzeichen gegenüber der Live-Logik.
      if (pct > thr) stimme('bollinger', 'buy');
      else if (pct < 100 - thr) stimme('bollinger', 'sell');
      else stimme('bollinger', 'hold');
    } else if (pct > thr) stimme('bollinger', 'sell');
    else if (pct < 100 - thr) stimme('bollinger', 'buy');
    else stimme('bollinger', 'hold');
  }

  return { votes, buyVotes, sellVotes };
}

/**
 * Richtung dieser Variante — bewusst nur die EINSTIEGS-Sicht.
 *
 * Der Schatten misst, was eine andere Signal-Logik EINGESTIEGEN wäre. Für
 * Ausstiege gilt die Live-Logik weiter; sie werden nie im Schatten
 * simuliert, weil eine offene Position immer nach den Regeln geschlossen
 * wird, unter denen sie eröffnet wurde.
 */
export function regimeRichtung(stimmen: RegimeStimmen, minConfluence: number): SignalDirection {
  const req = Math.max(1, minConfluence);
  if (stimmen.buyVotes >= req && stimmen.buyVotes > stimmen.sellVotes) return 'buy';
  if (stimmen.sellVotes >= req && stimmen.sellVotes > stimmen.buyVotes) return 'sell';
  return 'hold';
}
