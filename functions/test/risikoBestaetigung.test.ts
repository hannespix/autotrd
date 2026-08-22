/**
 * Wächter der Risiko-Bestätigung (Owner 22.08.: „jeder soll bei der
 * Anmeldung bestätigen, dass er auf eigenes Risiko handelt … ich will mich
 * nicht angreifbar machen. Nur neue Kunden!").
 *
 * Drei Eigenschaften tragen das hier, und jede kann still brechen:
 *
 *  1. **Serverseitig.** Ein Häkchen im Formular ist keine Zustimmung,
 *     sondern eine Anzeige. Wer den Client umgeht, hätte sonst genau das
 *     Konto ohne Bestätigung, das zum Problem wird.
 *  2. **Nur neue Konten.** Die Prüfung steht HINTER dem
 *     Bestandskonto-Check. Rutschte sie davor, wären am nächsten Morgen
 *     alle bestehenden Nutzer ausgesperrt.
 *  3. **Mit Fassung.** Ein gespeichertes `true` sagt nicht, WOZU jemand
 *     zugestimmt hat. Im Streitfall ist genau das die Frage.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RISIKO_VERSION,
  istAktuelleRisikoVersion,
  leseRisikoVermerk,
} from '../../shared/src/risiko.js';

const profil = readFileSync(
  join(import.meta.dirname, '..', 'src', 'callable', 'profile.ts'),
  'utf8',
);

describe('Ohne Bestätigung entsteht kein Konto', () => {
  it('die Profil-Anlage verlangt sie selbst', () => {
    expect(profil).toContain('if (!istAktuelleRisikoVersion(risiko)) {');
    expect(profil).toContain("throw new HttpsError('failed-precondition', 'srv.risikoBestaetigungFehlt');");
  });

  it('und zwar BEVOR irgendetwas angelegt wird', () => {
    /* Ein Wallet, eine Strategie oder eine Zugangsstufe, die vor der
     * Prüfung entstehen, wären ein halb angelegtes Konto ohne Zustimmung —
     * schlimmer als gar keins, weil es aussieht wie ein gültiges. */
    const pruefung = profil.indexOf('istAktuelleRisikoVersion(risiko)');
    const anlegen = profil.indexOf('await ref.set({');
    expect(pruefung).toBeGreaterThan(-1);
    expect(anlegen).toBeGreaterThan(pruefung);
  });
});

describe('Nur neue Kunden — Bestandskonten bleiben unangetastet', () => {
  it('der Bestandskonto-Check steht VOR der Prüfung', () => {
    /* Owner ausdrücklich: „nur neue Kunden". Stünde die Prüfung davor,
     * bekäme jeder bestehende Nutzer beim nächsten Login einen Fehler —
     * dieselbe Regel wie bei der Zugangsstufe (core/access.ts, 26.07.). */
    const bestand = profil.indexOf('if (snap.exists) return { created: false };');
    const pruefung = profil.indexOf('istAktuelleRisikoVersion(risiko)');
    expect(bestand).toBeGreaterThan(-1);
    expect(bestand).toBeLessThan(pruefung);
  });
});

describe('Der Vermerk trägt die Fassung, nicht nur ein Ja', () => {
  it('gespeichert werden Version UND Zeitpunkt', () => {
    expect(profil).toContain('risiko: { version: RISIKO_VERSION, at: now },');
  });

  it('er liegt AUSSERHALB von settings', () => {
    /* Die Firestore-Regeln erlauben dem Client Updates ausschliesslich auf
     * `settings`. Läge der Vermerk dort, könnte sich jeder mit einem
     * Einzeiler selbst eine Zustimmung schreiben — derselbe Grund, aus dem
     * `accessLevel` oben liegt. */
    const block = profil.slice(profil.indexOf('await ref.set({'));
    const risikoPos = block.indexOf('risiko: {');
    const settingsPos = block.indexOf('settings: {');
    expect(risikoPos).toBeGreaterThan(-1);
    expect(risikoPos).toBeLessThan(settingsPos);
  });

  it('eine ältere Fassung legt kein neues Konto an', () => {
    // Zustimmung zu einem anderen Text ist keine Zustimmung zu diesem.
    expect(istAktuelleRisikoVersion(RISIKO_VERSION)).toBe(true);
    expect(istAktuelleRisikoVersion('2020-01-01')).toBe(false);
    expect(istAktuelleRisikoVersion('')).toBe(false);
    expect(istAktuelleRisikoVersion(true)).toBe(false);
    expect(istAktuelleRisikoVersion(undefined)).toBe(false);
  });

  it('ein halb geschriebener Vermerk gilt NICHT als Zustimmung', () => {
    expect(leseRisikoVermerk({ version: 'x', at: '2026-08-22T10:00:00Z' })).not.toBeNull();
    expect(leseRisikoVermerk({ version: 'x' })).toBeNull();
    expect(leseRisikoVermerk({ at: '2026-08-22T10:00:00Z' })).toBeNull();
    expect(leseRisikoVermerk({ version: '', at: 'x' })).toBeNull();
    expect(leseRisikoVermerk(true)).toBeNull();
    expect(leseRisikoVermerk(null)).toBeNull();
  });
});
