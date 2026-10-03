/**
 * Quelltext-Wächter: Die Handeingabe steht unter dem Kurs-Zeitdeckel
 * (Audit 13.08., B-2).
 *
 * Die pure Alters-Entscheidung testet `shared/test/kursAlter.test.ts`.
 * Hier steht die Verdrahtung — der Befund war ja gerade, dass
 * `quote.updatedAt` GESCHRIEBEN, aber von keinem Leser geprüft wurde:
 * Eine Funktion, die es prüfen könnte, ändert daran nichts, solange der
 * Order-Pfad sie nicht ruft.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const trade = readFileSync(join(hier, '../src/callable/trade.ts'), 'utf8');

describe('Kurs-Zeitdeckel — die Verdrahtung', () => {
  it('die Handeingabe prüft das Kurs-Alter VOR der Ausführung', () => {
    const deckel = trade.indexOf('kursZuAlt(quote.updatedAt');
    const ausfuehrung = trade.indexOf('await executeTrade(');
    expect(deckel, 'Zeitdeckel fehlt im Handels-Callable').toBeGreaterThan(0);
    expect(deckel).toBeLessThan(ausfuehrung);
    // Ein zu alter Kurs führt zur Ablehnung, nicht zu einem Log-Eintrag.
    expect(trade.slice(deckel, deckel + 400)).toContain('HttpsError');
  });
});
