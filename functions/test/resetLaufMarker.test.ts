/**
 * Audit-Befund 11.08. (A7): Der Reset lief ohne Lauf-Marker.
 *
 * Die reine Logik prüft `shared/test/resetSperre.test.ts`. Hier geht es um
 * die Verdrahtung, und die ist bei diesem Befund der eigentliche Punkt: Ein
 * Marker, den niemand setzt, oder eine Sperre, die nur einer der beiden
 * Handelspfade beachtet, wäre schlimmer als keiner — sie erzeugte Vertrauen
 * für beide.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quelle = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

describe('Der Reset meldet sich an und wieder ab', () => {
  const reset = (): string => quelle('callable', 'reset.ts');

  it('setzt den Marker, BEVOR etwas verschwindet', () => {
    /* Danach wäre er sinnlos: Das Archivieren ist der erste Schritt und
     * gleichzeitig der, bei dem ein gleichzeitiger Trade den größten Schaden
     * anrichtet — sein Kauf bliebe unarchiviert zurück. */
    const text = reset();
    const marker = text.indexOf("resetLaeuftSeit: now");
    const archiv = text.indexOf('await archiviereTrades(');
    expect(marker, 'Marker wird nicht gesetzt').toBeGreaterThan(0);
    expect(archiv).toBeGreaterThan(marker);
  });

  it('räumt ihn im SELBEN Schreibvorgang wie den neuen Kontostand ab', () => {
    // Getrennt gäbe es einen Moment, in dem der Handel frei ist und das
    // Wallet noch nicht steht — genau der Zustand, den der Marker verhindern
    // soll, nur am anderen Ende.
    const text = reset();
    const ab = text.indexOf('paperBalance: balance,');
    const bis = text.indexOf('{ merge: true },', ab);
    expect(ab).toBeGreaterThan(0);
    expect(text.slice(ab, bis)).toContain('resetLaeuftSeit: FieldValue.delete()');
  });
});

describe('Beide Handelspfade beachten die Sperre', () => {
  it('der Scan überspringt ein Konto im Reset', () => {
    const text = quelle('scheduled', 'scanMarket.ts');
    expect(text).toContain("resetLaeuft(userDoc.get('risk.resetLaeuftSeit')");
    const ab = text.indexOf("resetLaeuft(userDoc.get('risk.resetLaeuftSeit')");
    expect(text.slice(ab, ab + 200)).toContain('continue;');
  });

  it('und zählt es, statt still zu schweigen', () => {
    // Ein übersprungenes Konto ist ein Nicht-Ereignis. Steht die Zahl über
    // mehrere Scans hinweg > 0, hängt ein Reset — das ist ein Hinweis, den
    // man nur sieht, wenn er gezählt wird.
    const text = quelle('scheduled', 'scanMarket.ts');
    expect(text).toContain('konten.reset_laeuft += 1;');
    expect(text).toContain('reset_laeuft: number;');
    expect(text).toContain('reset_laeuft: 0,');
  });

  it('der manuelle Handel lehnt ab — auch den Verkauf', () => {
    /* Anders als bei der Notbremse, die Verkäufe ausdrücklich durchlässt.
     * Hier geht es nicht um Risiko, sondern um Buchführung: Ein Verkauf
     * mitten im Archivieren hinterlässt einen Trade, den der Reset nicht
     * mehr mitnimmt. */
    const text = quelle('callable', 'trade.ts');
    const ab = text.indexOf("resetLaeuft(userSnap.get('risk.resetLaeuftSeit')");
    expect(ab, 'Reset-Gate fehlt im Handels-Callable').toBeGreaterThan(0);
    const einstieg = text.indexOf('const istEinstieg =');
    expect(ab, 'Gate steht hinter der Einstiegs-Unterscheidung').toBeLessThan(einstieg);
    expect(text.slice(ab, ab + 400)).toContain('HttpsError');
  });

  it('beide benutzen DIESELBE Funktion', () => {
    // Zwei Ableitungen wären zwei Gelegenheiten, das Verfallsfenster
    // verschieden zu setzen.
    for (const pfad of [
      ['scheduled', 'scanMarket.ts'],
      ['callable', 'trade.ts'],
    ] as const) {
      expect(quelle(...pfad)).toContain('resetLaeuft');
    }
  });
});
