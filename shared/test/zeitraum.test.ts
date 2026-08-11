/**
 * Owner-Wunsch 11.08.: „Die Handelsanalyse zeigt nur einen definierten, sehr
 * kurzen Bereich. Kann man diesen auch einstellbar machen?"
 *
 * ── Was der Bereich vorher war ────────────────────────────────────────────
 *
 * Nicht eingestellt, sondern ein Nebenprodukt. Die Analyse rechnet auf den
 * GELADENEN Trades, und geladen wird eine Seite zu 50. Wer zehn Trades in
 * vier Tagen hatte, sah eine Vier-Tage-Auswertung — ohne dass irgendwo stand,
 * dass die Seitengröße der Grund ist. „Trefferquote 30 %" aus vier Tagen
 * sieht genauso aus wie aus vier Monaten.
 */
import { describe, expect, it } from 'vitest';
import {
  historieReicht,
  imZeitraum,
  zeitraumBeginn,
  zeitraumLabel,
  ZEITRAEUME,
  type Zeitraum,
} from '../src/tradeAnalytics.js';

const JETZT = new Date('2026-08-11T12:00:00Z');
const t = (iso: string): { executedAt: string } => ({ executedAt: iso });

describe('zeitraumBeginn', () => {
  it('rechnet Tage zurück', () => {
    expect(zeitraumBeginn(7, JETZT)?.toISOString()).toBe('2026-08-04T12:00:00.000Z');
    expect(zeitraumBeginn(30, JETZT)?.toISOString()).toBe('2026-07-12T12:00:00.000Z');
  });

  it('„Alles" hat keinen Beginn', () => {
    expect(zeitraumBeginn(0, JETZT)).toBe(null);
  });
});

describe('imZeitraum', () => {
  const trades = [
    t('2026-08-11T09:00:00Z'), // heute
    t('2026-08-08T09:00:00Z'), // vor 3 Tagen
    t('2026-07-20T09:00:00Z'), // vor 22 Tagen
    t('2026-05-01T09:00:00Z'), // vor gut 3 Monaten
  ];

  it('schneidet auf die letzten 7 Tage', () => {
    expect(imZeitraum(trades, 7, JETZT)).toHaveLength(2);
  });

  it('30 Tage nehmen mehr mit', () => {
    expect(imZeitraum(trades, 30, JETZT)).toHaveLength(3);
  });

  it('„Alles" nimmt alles', () => {
    expect(imZeitraum(trades, 0, JETZT)).toHaveLength(4);
  });

  it('genau auf der Grenze zählt noch dazu', () => {
    // Ein Trade exakt am Zeitraum-Anfang gehört hinein: Der Nutzer hat „30
    // Tage" gewählt, nicht „29 Tage und ein bisschen".
    const grenze = zeitraumBeginn(30, JETZT)!;
    expect(imZeitraum([t(grenze.toISOString())], 30, JETZT)).toHaveLength(1);
  });

  it('unlesbare Zeitstempel fliegen raus', () => {
    // Eine Kennzahl aus Zeilen, deren Datum niemand kennt, ist schlechter als
    // eine ohne sie — sie behauptet eine Zugehörigkeit, die nicht geprüft ist.
    expect(imZeitraum([t(''), t('kaputt'), t('2026-08-10T09:00:00Z')], 7, JETZT)).toHaveLength(1);
  });

  it('gibt eine KOPIE zurück, auch bei „Alles"', () => {
    // Die Aufrufer sortieren und schneiden weiter; ein durchgereichtes
    // Original würde `st.trades` still umbauen.
    const original = [t('2026-08-10T09:00:00Z')];
    expect(imZeitraum(original, 0, JETZT)).not.toBe(original);
  });

  it('leere Historie bleibt leer', () => {
    for (const z of ZEITRAEUME) expect(imZeitraum([], z, JETZT)).toEqual([]);
  });
});

describe('historieReicht — muss vor dem Rechnen nachgeladen werden?', () => {
  it('der älteste Trade liegt vor dem Zeitraum ⇒ reicht', () => {
    expect(historieReicht([t('2026-07-01T09:00:00Z')], 7, JETZT, false)).toBe(true);
  });

  it('der älteste Trade liegt IM Zeitraum ⇒ reicht NICHT', () => {
    // Der eigentliche Befund: Die Analyse hätte „letzte 90 Tage" behauptet
    // und die letzten vier gezeigt.
    expect(historieReicht([t('2026-08-08T09:00:00Z')], 90, JETZT, false)).toBe(false);
  });

  it('ist alles geladen, reicht es per Definition', () => {
    // Mehr gibt es nicht — auch wenn der älteste Trade jünger ist als der
    // gewählte Zeitraum. Sonst liefe das Nachladen gegen eine Wand.
    expect(historieReicht([t('2026-08-08T09:00:00Z')], 365, JETZT, true)).toBe(true);
  });

  it('„Alles" hat keine Untergrenze zu erreichen', () => {
    expect(historieReicht([t('2026-08-08T09:00:00Z')], 0, JETZT, false)).toBe(true);
  });

  it('ohne lesbare Zeitstempel gilt es als NICHT ausreichend', () => {
    // Im Zweifel nachladen: Das kostet eine Abfrage, die Alternative wäre
    // eine Auswertung über einen Zeitraum, den niemand kennt.
    expect(historieReicht([], 30, JETZT, false)).toBe(false);
    expect(historieReicht([t('kaputt')], 30, JETZT, false)).toBe(false);
  });

  it('genau auf der Grenze reicht es', () => {
    const grenze = zeitraumBeginn(30, JETZT)!;
    expect(historieReicht([t(grenze.toISOString())], 30, JETZT, false)).toBe(true);
  });
});

describe('zeitraumLabel', () => {
  it('beschriftet jeden Zeitraum eindeutig', () => {
    const labels = ZEITRAEUME.map((z) => zeitraumLabel(z));
    expect(labels).toEqual(['7T', '30T', '90T', '1J', 'Alles']);
    expect(new Set(labels).size).toBe(ZEITRAEUME.length);
  });

  it('jeder Wert in ZEITRAEUME ist ein gültiger Zeitraum', () => {
    for (const z of ZEITRAEUME) {
      const geprueft: Zeitraum = z;
      expect(typeof geprueft).toBe('number');
      expect(geprueft).toBeGreaterThanOrEqual(0);
    }
  });
});
