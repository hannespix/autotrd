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
    expect(text).toContain('const stand = await leseKontostand(db, userDoc.ref, roh - zins);');
  });

  it('und liest die Positionen nicht mehr getrennt daneben', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toContain("await userDoc.ref.collection('positions').get()");
  });

  it('der Zins wird nur EINMAL abgezogen', () => {
    /* Die naheliegende Folgefalle: Der frisch gelesene Saldo enthält die eben
     * gebuchten Zinsen schon. Ein `- zins` darauf zöge sie ein zweites Mal
     * ab — jeden Tag, unbemerkt, und direkt in die Equity-Kurve. */
    const text = readFileSync(pfad, 'utf8');
    expect((text.match(/- zins/g) ?? []).length).toBe(1);
    expect(text).not.toContain('const balance = roh - zins;');
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
