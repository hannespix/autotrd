/**
 * Task 30: Die Gegenrechnung „Sockel ohne Prozent-Marken" ist Verdrahtung
 * im Abendlauf — ohne diesen Wächter wäre die pure Funktion ein toter Helfer.
 * Zweite Fassung nach dem Red-Team der Messung (15.10.): Brutto-Preise,
 * Abruf NACH dem Health-Schreiben mit Fristen, Urteil einmal eingefroren.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');

describe('Sockel-Gegenrechnung im Abendlauf (Task 30)', () => {
  it('sammelt je Konto die Sockel-Buchungen mit Brutto-Preisen (V1)', () => {
    expect(snapshot).toContain("&& quelleDoc === 'sockel') {");
    expect(snapshot).toContain("rawPrice: t.get('rawPrice') as number | undefined,");
    expect(snapshot).toContain("brokerFillPrice: t.get('brokerFillPrice') as number | undefined,");
    expect(snapshot).toContain('const s = sockelAusstiege(sockelRoh);');
    expect(snapshot).toContain('sockelUnklar += s.unklar;');
  });

  it('läuft NACH dem Health-Schreiben und vor MU3, mit Fristen (R5)', () => {
    const health = snapshot.indexOf("await db.doc('meta/health').set(\n");
    const block = snapshot.indexOf('// ── Task 30: Gegenrechnung');
    const mu3 = snapshot.indexOf('// ── MU3 „Bewährte Einstellungen"');
    expect(health).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(health);
    expect(mu3).toBeGreaterThan(block);
    expect(snapshot).toContain('await mitFrist(getMarketSnapshot(sym, \'3mo\'), SOCKEL_KURS_ABRUF_MS);');
    expect(snapshot).toContain('i < symbole.length && Date.now() < frist; i += SOCKEL_KURS_PARALLEL');
  });

  it('bewertet mit dem ET-Tag des Laufs als „heute" (Lookahead-Gate in der puren Funktion)', () => {
    expect(snapshot).toContain('const heute = etTagVon(now.toISOString()) ?? date;');
    expect(snapshot).toContain('sockelFaelle.map((a) => ({ a, b: bewerteSockelAusstieg(a, kerzen.get(a.symbol) ?? [], heute) })),');
    expect(snapshot).toContain('sockelFaelle.filter((f) => f.tagT < heute).map((f) => f.symbol)');
  });

  it('schreibt den Stand öffentlich und friert das erste Urteil EINMAL ein (V4)', () => {
    expect(snapshot).toContain("await db.doc('meta/health').set({ trading: { sockelStopKontrafakt } }, { merge: true });");
    expect(snapshot).toContain(".doc('meta/sockelStopUrteil')\n        .create({ ...sockelStopKontrafakt, eingefrorenAm: now.toISOString() })");
    expect(snapshot).toContain("if (sockelStopKontrafakt.entscheidung !== 'zu_wenig') {");
  });
});
