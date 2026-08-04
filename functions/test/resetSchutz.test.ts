/**
 * Schutz der Handelshistorie beim Reset (04.08.).
 *
 * Anlass: `'trades'` stand in der Löschliste, und `recursiveDelete` kennt kein
 * Zurück — ein Reset vernichtete das komplette Handelsjournal. Beim letzten
 * Mal traf das 297 Einträge. Kurse, Zeitpunkte, Gebühren und Anschaffungs-
 * bezüge existieren nirgendwo sonst; sie sind das Einzige an diesem System,
 * das sich grundsätzlich nicht wiederherstellen lässt.
 *
 * Dieser Test prüft bewusst eine KONSTANTE statt eines Ablaufs. Der Ablauf
 * braucht Firestore, aber der Schaden entstand nicht im Ablauf — er entstand
 * in einer Liste, in der ein Wort zu viel stand. Genau dort setzt die Prüfung
 * an: Wer `'trades'` wieder einträgt, bricht diesen Test.
 */

import { describe, expect, it } from 'vitest';
import { GELOESCHTE_SAMMLUNGEN } from '../src/callable/reset.js';

describe('Reset-Löschliste', () => {
  it('löscht die Handelshistorie NICHT', () => {
    expect(GELOESCHTE_SAMMLUNGEN as readonly string[]).not.toContain('trades');
  });

  it('rührt das Archiv erst recht nicht an', () => {
    expect(GELOESCHTE_SAMMLUNGEN as readonly string[]).not.toContain('tradesArchive');
  });

  it('lässt Strategien und Prognosen stehen — sie sind Ideen, keine Messergebnisse', () => {
    expect(GELOESCHTE_SAMMLUNGEN as readonly string[]).not.toContain('strategies');
    expect(GELOESCHTE_SAMMLUNGEN as readonly string[]).not.toContain('predictions');
  });

  it('räumt weiterhin alles auf, was aus der Historie NEU berechnet werden kann', () => {
    // Diese Listen sind abgeleitete Größen: Positionen, Equity-Verlauf,
    // Kennzahlen, Tuning-Stand. Sie dürfen weg — die Rohdaten bleiben.
    for (const name of ['positions', 'equity', 'stats', 'tuning']) {
      expect(GELOESCHTE_SAMMLUNGEN as readonly string[]).toContain(name);
    }
  });
});
