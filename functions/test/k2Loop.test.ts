/**
 * Quelltext-Wächter: der Wiederholungskauf-Loop bleibt geschlossen
 * (Audit 13.08., K-2a/K-2b).
 *
 * Die Routing-Pfade (Storno, Duplicate-Nachschlag) sind in
 * `orderRouting.test.ts` verhaltensgetestet. Zwei Dinge kann dort niemand
 * sehen — und beide waren der Kern des Befunds:
 *
 *   1. Der Cooldown-Stempel nach einer Buchungs-Panne. Ohne ihn kaufte der
 *      nächste 5-Minuten-Scan dasselbe Signal ERNEUT echt (NVDA-Loop
 *      11.08.), solange es stand.
 *   2. Dass `unbookedFills` überhaupt jemand KONSUMIERT. Der Friedhof mit
 *      Beschriftung („mit allem, was zum Nachbuchen nötig ist") lag da,
 *      und kein Code hat je nachgebucht.
 *
 * Beides ist Verdrahtung, keine Funktion — dieselbe Fehlerklasse wie
 * flattenOnBreach. Deshalb prüft dieser Wächter den Quelltext.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const broker = readFileSync(join(hier, '../src/core/broker.ts'), 'utf8');
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

describe('K-2a: Fill-Panne stempelt den Cooldown', () => {
  it('der unbooked-Zweig schreibt engineCooldowns für das Symbol', () => {
    const zweig = broker.slice(broker.indexOf('FILL NICHT GEBUCHT'));
    expect(zweig).toContain('engineCooldowns');
    // Und zwar VOR dem nächsten Funktions-Ende — im selben Fehlerzweig.
    const stempel = zweig.indexOf('engineCooldowns');
    const schutz = zweig.indexOf('schutzAnlegen');
    expect(stempel).toBeGreaterThan(-1);
    expect(stempel).toBeLessThan(schutz);
  });
});

describe('K-2b: unbookedFills hat einen Konsumenten', () => {
  it('bucheUnverbuchteFills existiert und löscht erst NACH der Buchung', () => {
    expect(broker).toMatch(/export async function bucheUnverbuchteFills/);
    const fn = broker.slice(broker.indexOf('export async function bucheUnverbuchteFills'));
    // Reihenfolge: Die Löschung des ERFOLGSFALLS steht NACH der Buchung.
    // (Der frühere delete im Dedupe-Zweig — Kennung schon in der Historie —
    // ist legitim: Dort ist längst gebucht.)
    const buchung = fn.indexOf('executePaperTrade');
    expect(buchung).toBeGreaterThan(-1);
    expect(fn.lastIndexOf('doc.ref.delete()')).toBeGreaterThan(buchung);
    // Doppelbuchungs-Schutz: die Order-Kennung wird gegen die Historie geprüft.
    expect(fn).toContain("where('brokerOrderId'");
  });

  it('der Scan ruft den Nachbucher je Konto auf — VOR den Positionen', () => {
    const aufruf = scan.indexOf('bucheUnverbuchteFills(uid');
    const positionen = scan.indexOf("collection('positions').get()");
    expect(aufruf).toBeGreaterThan(-1);
    expect(aufruf).toBeLessThan(positionen);
  });

  it('eröffnende Orders werden mit Storno-Flag geroutet', () => {
    expect(broker).toContain('stornoBeiKeinFill: eroeffnet');
  });
});
