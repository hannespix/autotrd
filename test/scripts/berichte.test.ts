/**
 * Firestore-Pfad der Optimierer-Berichte.
 *
 * Der Fall, der Geld gekostet hat: Die erste Veröffentlichung nach dem
 * Umstieg brach mit „documentPath … does not contain an even number of
 * components" ab — und weil Champion und Bericht in EINEM Batch stehen,
 * blieb auch `meta/champion` ungeschrieben. Ohne Champion handelt niemand
 * (`allowWithoutChampion: false`), der Lauf war also still wirkungslos.
 *
 * Firestore-Pfade wechseln Collection und Dokument ab. Diese Tests halten
 * beide Seiten fest: Skript (Dokument, gerade Segmentzahl) und Frontend
 * (Collection, ungerade Segmentzahl) — und dass die Rules denselben Pfad
 * freigeben.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BERICHTE_COLLECTION, BERICHTE_SEGMENTE, berichtPfad } from '../../shared/src/berichte.ts';

describe('Berichts-Pfad', () => {
  it('Collection hat eine ungerade, ein Bericht eine gerade Zahl an Segmenten', () => {
    expect(BERICHTE_SEGMENTE.length % 2).toBe(1);
    expect(BERICHTE_COLLECTION.split('/').length % 2).toBe(1);
    expect(berichtPfad('2026-09-07').split('/').length % 2).toBe(0);
    expect(berichtPfad('2026-09-07')).toBe('meta/optimizeReports/berichte/2026-09-07');
  });

  it('liegt unter meta/, damit die Allowlist der Rules greift', () => {
    expect(BERICHTE_SEGMENTE[0]).toBe('meta');
  });

  it('firestore.rules gibt genau diesen Pfad frei', () => {
    const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
    // Die match-Zeile muss auf ein DOKUMENT zeigen: Collection-Segmente + ein Platzhalter.
    const zeile = new RegExp(`match /${BERICHTE_COLLECTION}/\\{[A-Za-z]+\\} \\{`);
    expect(rules).toMatch(zeile);
  });

  it('niemand schreibt den Pfad noch von Hand aus', () => {
    for (const datei of ['../../scripts/publish-champion.mjs', '../../frontend/src/data.ts']) {
      const text = readFileSync(new URL(datei, import.meta.url), 'utf8');
      // Nur Code prüfen, keine Kommentare: Zeilen mit * oder // am Anfang raus.
      const code = text
        .split('\n')
        .filter((z) => !/^\s*(\*|\/\/|\/\*)/.test(z))
        .join('\n');
      expect(code).not.toContain("'meta', 'optimizeReports'");
      expect(code).not.toMatch(/`meta\/optimizeReports\/\$\{/);
    }
  });
});
