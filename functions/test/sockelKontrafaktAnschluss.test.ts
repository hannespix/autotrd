/**
 * Task 30: Die Gegenrechnung „Sockel ohne Prozent-Marken" ist Verdrahtung
 * im Abendlauf — ohne diesen Wächter wäre die pure Funktion ein toter Helfer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');

describe('Sockel-Gegenrechnung im Abendlauf (Task 30)', () => {
  it('sammelt je Konto die Sockel-Buchungen und leitet die Ausstiege daraus ab', () => {
    expect(snapshot).toContain("&& quelleDoc === 'sockel') {");
    expect(snapshot).toContain('sockelFaelle.push(...sockelAusstiege(sockelRoh));');
  });

  it('bewertet mit dem ET-Tag des Laufs als „heute" (Lookahead-Gate in der puren Funktion)', () => {
    expect(snapshot).toContain('const heute = etTagVon(now.toISOString()) ?? date;');
    expect(snapshot).toContain('sockelFaelle.map((a) => ({ a, b: bewerteSockelAusstieg(a, kerzen.get(a.symbol) ?? [], heute) })),');
  });

  it('holt Kurse nur für bewertbare Fälle und schreibt das Ergebnis öffentlich unter trading', () => {
    expect(snapshot).toContain('sockelFaelle.filter((f) => f.tagT < heute).map((f) => f.symbol)');
    expect(snapshot).toContain('...(sockelStopKontrafakt ? { sockelStopKontrafakt } : {}),');
  });
});
