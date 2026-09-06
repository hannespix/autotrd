/**
 * Geister-Dokument-Schutz (Befund 24.08., im Zug der Konto-Löschung).
 *
 * `shared/src/zugang.ts`: Ein FEHLENDES `accessLevel`-Feld gilt als
 * `approved` — Absicht für Bestandskonten, aber eine Falle für jedes
 * `set({...}, {merge:true})` auf `users/{uid}`: Existiert das Dokument
 * nicht mehr (nach einer künftigen Löschung), legt `set(merge)` es NEU an
 * — ohne `accessLevel` — und das Geister-Dokument gilt sofort wieder als
 * freigeschaltet.
 *
 * Der verbliebene Hintergrundlauf, der unbeaufsichtigt (Minuten Laufzeit
 * über viele Konten, kein Gate) auf das User-Root-Dokument schreibt, ist
 * `snapshotEquity` (täglich, ALLE Konten, kein resetLaeuft-Gate). Dieser
 * Test prüft, dass die Stelle `update()` mit einzelnen `FieldPath`s statt
 * `set(merge)` mit einem verschachtelten Objekt-Literal benutzt —
 * `update()` auf ein fehlendes Dokument wirft (vom bestehenden `.catch()`
 * geschluckt) statt es wiederauferstehen zu lassen, und der einzelne
 * FieldPath verhindert, dass Geschwisterfelder unter `risk` (u. a. das
 * `resetLaeuftSeit`-Sperrfeld selbst!) beim Schreiben verloren gehen.
 *
 * Reine Quelltext-Wächter: Firestore-`update()`-Semantik lässt sich nicht
 * sinnvoll nachbauen, ohne am Ende nur die Nachbildung zu prüfen (dieselbe
 * Lehre wie bei `watchlistUnion.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lese = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', ...teile), 'utf8');

describe('snapshotEquity.ts — Breaker-Armierung per FieldPath je Feld', () => {
  const text = lese('src', 'scheduled', 'snapshotEquity.ts');

  it('alle fünf risk-Felder einzeln, kein verschachteltes risk-Objekt', () => {
    const ab = text.indexOf('Breaker-Armierung');
    const block = text.slice(Math.max(0, ab - 400), ab + 100);
    for (const feld of [
      'vortagEquity',
      'vortagEquityAm',
      'breakerAusgeloestAm',
      'breakerGrund',
      'breakerVerlustPct',
    ]) {
      expect(block).toContain(`new FieldPath('risk', '${feld}')`);
    }
    expect(block).not.toContain('risk: {');
  });
});
