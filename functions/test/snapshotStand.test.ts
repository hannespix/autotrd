/**
 * Audit-Befund 11.08. (A4): `snapshotEquity` mischte zwei Zeitpunkte.
 *
 * Der Saldo stammte aus dem Konten-Query vom Beginn des Laufs, die Positionen
 * aus einem frischen Lesevorgang. Fiel ein Kauf in dieses Fenster, zählte das
 * Geld doppelt — Cash aus dem alten Stand UND die neue Position. Dieselbe
 * Zahl wird zur Bezugsgröße der Notbremse, die dann am nächsten Tag zu früh
 * auslöst und ein gesundes Konto sperrt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ── Audit-Befund A4: der Snapshot mischte zwei Zeitpunkte ────────────────
 *
 * Das Verhalten von `leseKontostand` prüft `rules-test/kontostand.test.ts`
 * gegen den echten Emulator. Hier steht nur, dass der tägliche Lauf sie auch
 * benutzt — sonst wäre die Funktion richtig und wirkungslos. */
describe('Quelltext: snapshotEquity liest aus EINEM Stand', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'snapshotEquity.ts');

  it('die Schleife holt Saldo und Positionen über leseKontostand', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).toContain('const stand = await leseKontostand(db, userDoc.ref, roh);');
  });

  it('und liest die Positionen nicht mehr getrennt daneben', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toContain("await userDoc.ref.collection('positions').get()");
  });

  it('es gibt keine Zinsbuchung mehr, die den Saldo verschieben könnte', () => {
    /* Bis zum Rückbau buchte der Lauf Margin-Zinsen auf das eigene Buch und
     * musste den Saldo dann genau EINMAL um sie korrigieren. Das Buch mit
     * Hebel ist weg — ein `- zins` darf hier nicht wieder auftauchen. */
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toMatch(/- zins\b/);
    expect(text).not.toContain('accrueMarginInterest');
  });

  it('der Lesevorgang ist read-only — der Snapshot darf nichts sperren', () => {
    // Der Tageslauf geht über alle Konten. Schreibsperren auf jedem
    // Konto-Dokument würden mit dem 5-Minuten-Scan kollidieren.
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('export async function leseKontostand(');
    expect(ab).toBeGreaterThan(0);
    expect(text.slice(ab, text.indexOf('\n}', ab))).toContain('{ readOnly: true }');
  });
});
