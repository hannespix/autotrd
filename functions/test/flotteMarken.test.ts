/**
 * Was die Schatten-Flotte bewertet — und was nicht (Befund 23.08.).
 *
 * `tuneFleet.riskExitReason` trug den Kommentar „bewusst mit denselben Marken
 * wie der echte Pfad". Das war falsch: Der echte `riskExitReason` in
 * `broker.ts` prüft vier Marken (Trailing, fester Stop, Ziel, Zeitgrenze),
 * die Flotte zwei (fester Stop, Ziel). Es fehlt ausgerechnet die Marke, die
 * im echten Pfad ZUERST geprüft wird.
 *
 * Das Urteil der Flotte verstellt echte Konfiguration — `autoTune` befördert
 * Sieger. Die Lücke trifft Varianten ungleichmäßig: Eine, deren Einstiege
 * erst weit laufen und dann drehen, verliert im Schatten bis zum festen Stop,
 * während sie live am nachgezogenen ausgestiegen wäre.
 *
 * Dieser Wächter schreibt den ZUSTAND fest, nicht das Wunschbild. Er wird
 * rot, sobald jemand die Marken angleicht — und dann ist der Kommentar
 * anzupassen, nicht der Test wegzuwerfen. Ein Wächter, der eine Lücke
 * dokumentiert, ist die ehrlichere Variante, solange die Lücke besteht.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const flotte = readFileSync(join(__dirname, '../src/core/tuneFleet.ts'), 'utf8');
const echt = readFileSync(join(__dirname, '../src/core/broker.ts'), 'utf8');

describe('Der echte Pfad prüft vier Marken', () => {
  const block = echt.slice(echt.indexOf('export function riskExitReason('));
  const kopf = block.slice(0, block.indexOf('\n}\n'));

  it('Trailing, fester Stop, Ziel und Zeitgrenze', () => {
    expect(kopf).toContain("return 'trailing_stop';");
    expect(kopf).toContain("return 'stop_loss';");
    expect(kopf).toContain("return 'take_profit';");
    expect(kopf).toContain("'max_hold'");
  });
});

describe('Die Flotte prüft zwei — und sagt es jetzt auch', () => {
  const block = flotte.slice(flotte.indexOf('function riskExitReason('));
  const kopf = block.slice(0, block.indexOf('\n}\n'));

  it('fester Stop und Ziel: ja', () => {
    expect(kopf).toContain("return 'stop_loss';");
    expect(kopf).toContain("return 'take_profit';");
  });

  it('Trailing und Zeitgrenze: nein — das ist die dokumentierte Lücke', () => {
    expect(kopf).not.toContain('trailing');
    expect(kopf).not.toContain('highWater');
    expect(kopf).not.toContain('max_hold');
  });

  it('der Kommentar behauptet NICHT mehr, es seien dieselben Marken', () => {
    // Genau dieser Satz stand hier und war die eigentliche Gefahr: Er lässt
    // ein Flotten-Urteil vertrauenswürdiger aussehen, als es ist.
    expect(flotte).not.toContain('Bewusst mit denselben Marken wie der echte Pfad');
    expect(flotte).toContain('NICHT dieselben MARKEN wie der echte Pfad');
  });

  it('und die Folge für den Vergleich ist benannt, nicht nur die Tatsache', () => {
    // „Es fehlt etwas" allein hilft niemandem. Wer das liest, muss wissen,
    // dass der Vergleich dadurch SCHIEF wird, nicht bloß gröber.
    expect(flotte).toContain('nicht bloß gröber als die Wirklichkeit, er ist schief');
    expect(flotte).toContain('autoTune` befördert Sieger');
  });
});
