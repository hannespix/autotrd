/**
 * Quelltext-Wächter: flattenOnBreach hat eine Maschine (Audit 13.08., K-3).
 *
 * Der Befund war ein Schalter ohne Wirkung: `pruefeBreaker` lieferte die
 * Stufe 'glattstellen', der Klartext versprach Glattstellung — und kein
 * Code stellte glatt. Ein Unit-Test der puren Funktionen hätte das nie
 * bemerkt, denn die Funktionen stimmten; es fehlte die VERDRAHTUNG.
 *
 * Deshalb prüft dieser Test den Quelltext des Scans selbst: Die
 * Risiko-Exit-Schleife muss `notbremsenExit` konsultieren und dessen Grund
 * VOR den normalen Stops verwenden. Verschwindet die Verdrahtung in einem
 * Refactoring, wird der Schalter wieder still zur Kulisse — genau die
 * Rückkehr, die dieser Wächter verhindert. (Gleiche Bauart wie
 * `chartAnkerSerie.test.ts` im Frontend, aus demselben Grund.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

describe('Notbremsen-Glattstellung ist verdrahtet', () => {
  it('der Scan konsultiert notbremsenExit mit dem Breaker-Befund', () => {
    expect(scan).toMatch(/const zwangsGrund = notbremsenExit\(breaker\)/);
  });

  it('der Zwangs-Grund übersteuert die normalen Stops in der Exit-Schleife', () => {
    // zwangsGrund ?? riskExitReason — die Reihenfolge ist die Aussage:
    // Bei Stufe 'glattstellen' wird verkauft, egal was Stop/Trailing sagen.
    expect(scan).toMatch(/zwangsGrund\s*\n?\s*\?\?\s*riskExitReason\(/);
  });

  it('die Glattstellung nutzt KEINEN eigenen Verkaufsweg', () => {
    // Es darf keinen zweiten executeTrade-Aufruf nur für die Glattstellung
    // geben — sie läuft als Grund durch die EINE Exit-Schleife. Ein eigener
    // Pfad hätte eigene Fehler (kein Cooldown, kein Fill-vor-Buchung).
    const treffer = scan.match(/notbremsenExit/g) ?? [];
    // Import + ein Aufruf + Kommentar-Erwähnung — aber kein Code-Aufruf
    // außerhalb der einen Stelle. Wir zählen die Aufrufe mit Klammer:
    const aufrufe = scan.match(/notbremsenExit\(/g) ?? [];
    expect(aufrufe.length).toBe(1);
    expect(treffer.length).toBeGreaterThanOrEqual(2); // Import + Aufruf
  });
});
