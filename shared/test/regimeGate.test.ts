/**
 * Regime-Ampel Stufe 2: die Richtungssperre (04.08.).
 *
 * Warum eigene Tests: Diese Regel entscheidet, ob ein Einstieg überhaupt
 * stattfindet — ein Fehler hier ist unsichtbar. Sperrt sie zu viel, sieht
 * das im Log exakt aus wie ein ruhiger Markt; sperrt sie zu wenig, kehrt
 * genau die Wette zurück, die 112 Trades mit 8 Gewinnern produziert hat.
 */

import { describe, expect, it } from 'vitest';
import {
  marketRegime,
  regimeEntryBlocked,
  REGIME_ELEVATED_VIX,
  REGIME_STRESS_VIX,
} from '../src/regime.js';

describe('regimeEntryBlocked', () => {
  it('sperrt SHORTS im Aufwärtstrend — der Befund vom 04.08.', () => {
    // Alle vier Short-Steckbriefe im Trend-Regime waren negativ, zusammen
    // n=112 mit 8 Gewinnern (t von −3,1 bis −9,0).
    expect(regimeEntryBlocked('trend', 'short')).toBe('gegen_trend');
  });

  it('lässt LONGS im Aufwärtstrend frei — sie laufen MIT dem Markt', () => {
    expect(regimeEntryBlocked('trend', 'long')).toBeNull();
  });

  it('sperrt im Stress BEIDE Richtungen', () => {
    // Bei VIX ≥ 30 springen Kurse. RSI, MACD und Bollinger sagen über
    // Sprünge nichts, und ein Stop wird zum nächsten Kurs ausgeführt, nicht
    // zum Stop-Kurs — „vorsichtig long" ist da keine Rettung.
    expect(regimeEntryBlocked('stress', 'long')).toBe('stress');
    expect(regimeEntryBlocked('stress', 'short')).toBe('stress');
  });

  it('lässt seitwärts alles zu — die Heimat der Mean Reversion', () => {
    expect(regimeEntryBlocked('seitwaerts', 'long')).toBeNull();
    expect(regimeEntryBlocked('seitwaerts', 'short')).toBeNull();
  });

  it('sperrt die RICHTUNG, nicht eine Signatur', () => {
    // Regressionsschutz gegen die naheliegende Fehlreparatur: Wer nur
    // „bollinger+rsi" sperrte, ließe dieselbe Wette über macd+rsi wieder
    // herein — auch die verlor (n=12, 0 Gewinner). Die Funktion kennt
    // deshalb gar keine Signatur; dieser Test hält das fest.
    expect(regimeEntryBlocked.length).toBe(2); // (regime, side) — kein dritter Parameter
  });
});

/**
 * Das Zusammenspiel mit der Messung: Aus Kursen und VIX wird ein Zustand,
 * aus dem Zustand eine Erlaubnis. Beides zusammen ist die eigentliche Regel.
 */
describe('Messung → Sperre (End-to-End der puren Kette)', () => {
  /** Ruhig steigender Markt: 250 Closes, +0,04 % je Tag. */
  const steigend = Array.from({ length: 250 }, (_, i) => 100 * 1.0004 ** i);
  /** Fallender Markt mit kräftigen Ausschlägen. */
  const fallend = Array.from({ length: 250 }, (_, i) => 100 * 0.999 ** i * (1 + (i % 2 ? 0.02 : -0.02)));

  it('ruhiger Aufwärtsmarkt ⇒ trend ⇒ Short gesperrt, Long frei', () => {
    const r = marketRegime(steigend, REGIME_ELEVATED_VIX - 10);
    expect(r.state).toBe('trend');
    expect(regimeEntryBlocked(r.state, 'short')).toBe('gegen_trend');
    expect(regimeEntryBlocked(r.state, 'long')).toBeNull();
  });

  it('hoher VIX ⇒ stress ⇒ gar nichts geht', () => {
    const r = marketRegime(steigend, REGIME_STRESS_VIX + 5);
    expect(r.state).toBe('stress');
    expect(regimeEntryBlocked(r.state, 'long')).toBe('stress');
  });

  it('fehlende Daten ⇒ seitwaerts ⇒ die Regel sperrt NICHTS', () => {
    // Wichtig: Ohne Marktdaten darf die Ampel nicht zum Handelsverbot
    // werden. Ein Datenausfall würde sonst still den ganzen Handel
    // abschalten und sähe dabei aus wie ein ereignisloser Tag.
    const r = marketRegime([], null);
    expect(r.state).toBe('seitwaerts');
    expect(regimeEntryBlocked(r.state, 'long')).toBeNull();
    expect(regimeEntryBlocked(r.state, 'short')).toBeNull();
  });

  it('unruhiger Abwärtsmarkt ⇒ nie trend, Shorts bleiben also möglich', () => {
    const r = marketRegime(fallend, REGIME_ELEVATED_VIX - 5);
    expect(r.state).not.toBe('trend');
    // In genau diesem Zustand ist ein Short kein Kampf gegen den Markt.
    if (r.state === 'seitwaerts') expect(regimeEntryBlocked(r.state, 'short')).toBeNull();
  });
});
