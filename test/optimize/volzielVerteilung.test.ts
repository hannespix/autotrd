/**
 * Die Verteilung des Vola-Ziel-Faktors über die Folds der OOS-Kette.
 *
 * Warum es diesen Wächter gibt: Lauf #50 konnte sein eigenes
 * Abbruchkriterium nicht prüfen, weil die Verteilung nur als Notiz je
 * Fold-Lauf entstand und Notizen den Optimierer-Bericht nie erreichen. Ein
 * Anteil über 16 Folds lässt sich aus 16 Sätzen nicht addieren. Seitdem
 * wandert die Verteilung strukturiert mit — und genau das prüft diese Datei.
 *
 * Entschieden wird mit diesen Zahlen NICHTS: Kein Gate liest sie. Sie
 * trennen allein den Fall „der Faktor atmet" von „der Faktor klebt am
 * Deckel", und nur der zweite macht eine Messung wertlos
 * (docs/wissen/vorregistrierung/2026-09-13-volatilitaetsziel.md).
 */
import { describe, expect, it } from 'vitest';
import { volZielUeberFolds } from '../../src/optimize/run.ts';
import type { SimResult, VolZielVerteilung } from '../../src/core/types.ts';

const leer = (): Omit<SimResult, 'volZiel'> => ({
  trades: [],
  equity: [],
  dailyReturns: [],
  metrics: {} as SimResult['metrics'],
  finalEquity: 0,
  notes: [],
});

function fold(v: Partial<VolZielVerteilung>): SimResult {
  return {
    ...leer(),
    volZiel: { zyklen: 0, summe: 0, min: 1, max: 1, aufwaermen: 0, amDeckel: 0, amBoden: 0, minFaktor: 0.25, maxFaktor: 2, ...v },
  };
}

describe('volZielUeberFolds', () => {
  it('ohne Vola-Ziel gibt es keine Verteilung — nicht etwa eine leere', () => {
    expect(volZielUeberFolds([])).toBe(null);
    expect(volZielUeberFolds([leer() as SimResult, leer() as SimResult])).toBe(null);
  });

  it('WÄCHTER: Zähler und Summe ADDIEREN sich über die Folds, die Spanne ist das Extremum', () => {
    const v = volZielUeberFolds([
      fold({ zyklen: 100, summe: 150, min: 0.8, max: 2, aufwaermen: 60, amDeckel: 30, amBoden: 5 }),
      fold({ zyklen: 100, summe: 190, min: 0.5, max: 1.9, aufwaermen: 0, amDeckel: 80, amBoden: 10 }),
    ])!;
    // Die Folds sind disjunkte Zeitabschnitte DERSELBEN Kette: Ihre Zyklen
    // addieren sich, sie überschneiden sich nicht. Ein Mittelwert der
    // Mittelwerte wäre hier falsch (er gewichtete kurze Folds zu stark) —
    // deshalb wandert die SUMME mit und der Mittelwert entsteht erst hier.
    expect(v.zyklen).toBe(200);
    expect(v.summe).toBe(340);
    expect(v.summe / v.zyklen).toBeCloseTo(1.7, 10);
    expect(v.aufwaermen).toBe(60);
    expect(v.amDeckel).toBe(110);
    expect(v.amBoden).toBe(15);
    expect(v.min).toBe(0.5);
    expect(v.max).toBe(2);
    expect(v.minFaktor).toBe(0.25);
    expect(v.maxFaktor).toBe(2);
    // Und dasselbe mit UMGEKEHRTER Reihenfolge: Sonst besteht ein Aggregat,
    // das schlicht den letzten Fold nimmt, den Wächter zufällig — beim ersten
    // absichtlichen Bruch ist mir genau das passiert, weil das Extremum oben
    // im letzten Fold liegt.
    const r = volZielUeberFolds([
      fold({ zyklen: 100, summe: 190, min: 0.5, max: 1.9, aufwaermen: 0, amDeckel: 80, amBoden: 10 }),
      fold({ zyklen: 100, summe: 150, min: 0.8, max: 2, aufwaermen: 60, amDeckel: 30, amBoden: 5 }),
    ])!;
    expect(r.min).toBe(0.5);
    expect(r.max).toBe(2);
    expect(r).toEqual(v);
  });

  it('WÄCHTER: der Anteil am Deckel zählt OHNE Aufwärmphase — sonst redet der Abbruch sich klein', () => {
    // 200 Zyklen, davon 120 Aufwärmphase und 80 am Deckel: Über ALLE Zyklen
    // wären das 40 % und der Lauf sähe auswertbar aus. Gemessen wird aber nur,
    // wo überhaupt geschätzt wurde — dort sind es 100 %, und das ist der
    // Abbruchfall. Die Zahl, die zählt, steht in volZielZeile (report.ts).
    const v = volZielUeberFolds([fold({ zyklen: 200, summe: 320, min: 1, max: 2, aufwaermen: 120, amDeckel: 80, amBoden: 0 })])!;
    const gemessen = v.zyklen - v.aufwaermen;
    expect(v.amDeckel / v.zyklen).toBeCloseTo(0.4, 10);
    expect(gemessen).toBe(80);
    expect(v.amDeckel / gemessen).toBe(1);
  });

  it('die vier Zähler sind eine ZERLEGUNG: sie überschreiten die Zyklen nie', () => {
    const v = volZielUeberFolds([
      fold({ zyklen: 50, summe: 60, aufwaermen: 20, amDeckel: 10, amBoden: 5 }),
      fold({ zyklen: 70, summe: 90, aufwaermen: 0, amDeckel: 40, amBoden: 0 }),
    ])!;
    expect(v.aufwaermen + v.amDeckel + v.amBoden).toBeLessThanOrEqual(v.zyklen);
  });
});
