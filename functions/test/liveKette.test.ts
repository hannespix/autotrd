/**
 * Quelltext-Wächter: die Echtgeld-Kette am Order-Pfad (Audit 13.08., K-1).
 *
 * Der Befund: `brokerVerbindung()` prüfte für 'live' nur das Env-Flag und
 * den Kill-Switch — der Modus kommt aber aus dem Schlüssel-Präfix. Am Tag
 * von `ALPACA_ALLOW_LIVE=1` hätte jedes Konto mit AK-Schlüssel echt
 * gehandelt, auch mit Paper-Strategie und ohne Reife. Gleichzeitig
 * übersprangen Scan und Puls wirklich live geschaltete Konten KOMPLETT —
 * inklusive Stops, Trailing und Margin-Call.
 *
 * Die pure Kette (`resolveBrokerMode`) ist in `brokerMode.test.ts`
 * getestet. Was dort niemand sieht, ist die VERDRAHTUNG — dieselbe Lücke
 * wie bei flattenOnBreach: alle Funktionen korrekt, nur nicht
 * angeschlossen. Deshalb prüft dieser Wächter den Quelltext selbst.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const lies = (p: string): string => readFileSync(join(hier, p), 'utf8');
const routing = lies('../src/core/orderRouting.ts');
const scan = lies('../src/scheduled/scanMarket.ts');
const puls = lies('../src/scheduled/riskPulse.ts');

describe('Drei-Guard-Kette am Order-Pfad (orderRouting)', () => {
  it('der Live-Zweig konsultiert resolveBrokerMode MIT Reife', () => {
    expect(routing).toMatch(/reifeFuerKonto\(uid\)/);
    expect(routing).toMatch(/resolveBrokerMode\(\{ broker: \{ mode: modus \} \}, reife\)/);
  });

  it('eine nicht bestandene Kette lässt die Order im Buch (return null)', () => {
    // Der Satz im Log ist Teil des Vertrags: Wer bei Alpaca eine fehlende
    // Order sucht, muss im Log lesen können, WARUM sie im Buch blieb.
    expect(routing).toContain('Order bleibt im Buch');
  });

  it('der Nutzer-Schalter kommt aus dem User-Dokument, nicht aus dem Schlüssel', () => {
    expect(routing).toContain("settings.strategy.broker.mode");
  });
});

describe('Live-Verriegelung sperrt nur Einstiege, nie Exits', () => {
  it('der Scan überspringt Live-Konten nicht mehr komplett', () => {
    // Der alte Zustand: `continue; // Echtgeld-Routing kommt in M14` — mit
    // ihm starben Stops und Trailing des Live-Kontos. Er darf nicht
    // zurückkehren.
    expect(scan).not.toContain('continue; // Echtgeld-Routing');
    expect(scan).toMatch(/const liveVerriegelt = resolveBrokerMode\(/);
  });

  it('die Verriegelung sitzt als ERSTER Grund in entrySperre', () => {
    // Vor der Notbremse: Ein lives Konto eröffnet nichts Neues, egal was
    // die anderen Filter sagen — aber eben NUR Einstiege.
    const sperre = scan.slice(scan.indexOf('const entrySperre'));
    const verriegelt = sperre.indexOf("if (liveVerriegelt) return 'live_verriegelt'");
    const breaker = sperre.indexOf("return 'breaker_aktiv'");
    expect(verriegelt).toBeGreaterThan(-1);
    expect(breaker).toBeGreaterThan(-1);
    expect(verriegelt).toBeLessThan(breaker);
  });

  it('der Puls überspringt Live-Konten gar nicht mehr', () => {
    // Der Puls macht ausschließlich Schutzarbeit — es gibt dort nichts zu
    // verriegeln. Ein zurückkehrender resolveBrokerMode-Skip wäre exakt
    // der Audit-Befund H5.
    expect(puls).not.toMatch(/resolveBrokerMode\([^)]*\)\s*!==\s*'paper'\)\s*continue/);
    expect(puls).not.toContain("import { executeTrade, resolveBrokerMode");
  });
});
