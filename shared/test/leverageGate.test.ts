/**
 * Hebel-Ampel (04.08.) — die Konjunktion, die „krasse Hebel bei sicheren
 * Gelegenheiten" von „Beschleuniger ins Ungewisse" trennt.
 *
 * Diese Tests sind die wichtigsten der ganzen Offensive. Ein Fehler in der
 * Regime-Sperre kostet entgangene Trades; ein Fehler HIER vervielfacht
 * Verluste. Deshalb prüft jeder Test eine Bedingung EINZELN gegen einen
 * ansonsten perfekten Fall: Nur so fällt auf, wenn eine Bedingung stillschweigend
 * wirkungslos geworden ist — bei einer Konjunktion sieht das im Ergebnis
 * genauso aus wie eine erfüllte Bedingung.
 */

import { describe, expect, it } from 'vitest';
import {
  LEV_MIN_EDGE_MULTIPLE,
  LEV_MIN_SAMPLES,
  leverageChance,
  type LeverageChanceInput,
} from '../src/leverageGate.js';
import { MAX_LEVERAGE } from '../src/margin.js';
import type { BucketStat } from '../src/tradeFilter.js';

/**
 * Ein Steckbrief mit belegter Kante: n Trades, deren Mittelwert so weit über
 * null liegt, dass t den geforderten Wert erreicht. Konstruiert statt
 * gemockt, damit die echte bucketTStat-Formel geprüft wird.
 */
function starkerBucket(n = 40, mean = 20, sd = 40): BucketStat {
  const pnlSum = mean * n;
  // Var = (pnlSqSum − n·mean²)/(n−1)  ⇒  pnlSqSum = sd²·(n−1) + n·mean²
  const pnlSqSum = sd * sd * (n - 1) + n * mean * mean;
  return { n, wins: Math.round(n * 0.6), pnlSum, pnlSqSum };
}

/** Der perfekte Fall — jede Bedingung erfüllt. */
const IDEAL: LeverageChanceInput = {
  konfluenz: 5,
  requiredConfluence: 2,
  leverage: 3,
  regime: 'trend',
  bucket: starkerBucket(),
  side: 'long',
  positioning: 'neues_geld',
  edgeMultiple: 8,
};

describe('leverageChance: der Idealfall', () => {
  it('gibt den Hebel frei, wenn ALLE Bedingungen zutreffen', () => {
    const r = leverageChance(IDEAL);
    expect(r.gruende).toEqual([]);
    expect(r.hebel).toBeGreaterThan(1);
    expect(r.hebel).toBeLessThanOrEqual(MAX_LEVERAGE);
  });

  it('überschreitet nie den konfigurierten Hebel', () => {
    const r = leverageChance({ ...IDEAL, leverage: 2 });
    expect(r.hebel).toBeLessThanOrEqual(2);
  });

  it('bei ausgeschaltetem Hebel (1) bleibt es bar gedeckt', () => {
    expect(leverageChance({ ...IDEAL, leverage: 1 }).hebel).toBe(1);
  });
});

describe('leverageChance: jede Bedingung sperrt EINZELN', () => {
  it('knappe Konfluenz reicht nicht', () => {
    // Schwelle ist requiredConfluence + 2, mindestens aber 3.
    const r = leverageChance({ ...IDEAL, konfluenz: 3, requiredConfluence: 2 });
    expect(r.hebel).toBe(1);
    expect(r.gruende).toContain('konfluenz_zu_niedrig');
  });

  it('kein Hebel außerhalb des Trend-Regimes', () => {
    for (const regime of ['seitwaerts', 'stress'] as const) {
      const r = leverageChance({ ...IDEAL, regime });
      expect(r.hebel, regime).toBe(1);
      expect(r.gruende).toContain('regime_nicht_trend');
    }
  });

  it('OHNE belegte Kante kein Hebel — die wichtigste Bedingung', () => {
    // Genau der Fall vom 02.08.: Konfluenz war da, die Sorte verlor trotzdem.
    // Hebel hätte den Verlust vervielfacht, nicht die Rendite.
    const r = leverageChance({ ...IDEAL, bucket: null });
    expect(r.hebel).toBe(1);
    expect(r.gruende).toContain('keine_belegte_kante');
  });

  it('eine zu kleine Stichprobe zählt nicht als Beleg', () => {
    // Zehn gute Trades sind Zufall, kein Nachweis.
    const r = leverageChance({ ...IDEAL, bucket: starkerBucket(LEV_MIN_SAMPLES - 1) });
    expect(r.hebel).toBe(1);
    expect(r.gruende).toContain('keine_belegte_kante');
  });

  it('eine NEGATIVE Kante gibt niemals Hebel', () => {
    const schwach = starkerBucket(40, -20, 40); // Mittelwert unter null
    const r = leverageChance({ ...IDEAL, bucket: schwach });
    expect(r.hebel).toBe(1);
    expect(r.gruende).toContain('keine_belegte_kante');
  });

  it('Positionierung gegen uns sperrt', () => {
    // Long in einen überfüllten Long-Markt: der nächste Rücksetzer wird
    // dort zur Liquidierungskette.
    expect(leverageChance({ ...IDEAL, positioning: 'longs_ueberfuellt' }).gruende)
      .toContain('positionierung_dagegen');
    expect(leverageChance({ ...IDEAL, positioning: 'rally_ohne_nachschub' }).gruende)
      .toContain('positionierung_dagegen');
    // Gespiegelt für Shorts: in ein Squeeze-Setup hinein shortet man nicht.
    expect(leverageChance({ ...IDEAL, side: 'short', positioning: 'short_squeeze_setup' }).gruende)
      .toContain('positionierung_dagegen');
  });

  it('UNBEKANNTE Positionierung ist kein Gegenargument', () => {
    // Sonst hinge der Hebel an der Erreichbarkeit einer fremden Börse —
    // ein Ausfall bei Kraken würde die Mechanik still abschalten.
    const r = leverageChance({ ...IDEAL, positioning: null });
    expect(r.gruende).not.toContain('positionierung_dagegen');
    expect(r.hebel).toBeGreaterThan(1);
  });

  it('zu kleine erwartete Bewegung sperrt — der Hebel hebelt auch Kosten', () => {
    const r = leverageChance({ ...IDEAL, edgeMultiple: LEV_MIN_EDGE_MULTIPLE - 0.1 });
    expect(r.hebel).toBe(1);
    expect(r.gruende).toContain('bewegung_zu_klein');
  });

  it('unbekannte Bewegung sperrt ebenfalls', () => {
    // Anders als bei der Positionierung: Ohne Kostenrechnung ist der
    // Kern der Wette unbekannt, nicht bloß ein Nebenaspekt.
    const r = leverageChance({ ...IDEAL, edgeMultiple: null });
    expect(r.hebel).toBe(1);
    expect(r.gruende).toContain('bewegung_zu_klein');
  });
});

describe('leverageChance: Höhe folgt der Stärke des Belegs', () => {
  it('gerade signifikant ⇒ höchstens zweifach', () => {
    // t knapp über 2: Kante belegt, aber nicht überwältigend.
    const knapp = starkerBucket(40, 13, 40); // t ≈ 2,06
    const r = leverageChance({ ...IDEAL, bucket: knapp, leverage: 3 });
    expect(r.hebel).toBe(2);
  });

  it('deutlich belegt ⇒ voller konfigurierter Hebel', () => {
    const deutlich = starkerBucket(40, 25, 40); // t ≈ 3,95
    const r = leverageChance({ ...IDEAL, bucket: deutlich, leverage: 3 });
    expect(r.hebel).toBe(3);
  });
});

describe('leverageChance: mehrere Gründe werden ALLE genannt', () => {
  it('nennt jeden Verstoß, nicht nur den ersten', () => {
    // Wichtig fürs Nachvollziehen: Wer nur den ersten Grund sieht, dreht an
    // einer Schraube und wundert sich, dass sich nichts ändert. Derselbe
    // Gedanke wie bei entryGate im Scan.
    const r = leverageChance({
      konfluenz: 1,
      requiredConfluence: 2,
      leverage: 3,
      regime: 'stress',
      bucket: null,
      side: 'long',
      positioning: 'longs_ueberfuellt',
      edgeMultiple: 1,
    });
    expect(r.hebel).toBe(1);
    expect(r.gruende).toHaveLength(5);
  });
});
