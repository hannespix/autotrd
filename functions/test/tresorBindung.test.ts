/**
 * Wächter: `BROKER_MASTER_KEY` ist an jede Function gebunden, die
 * Broker-Zugangsdaten liest (Rückbau 03.10.).
 *
 * `keyVault.ts` entschlüsselt `v1:`-Zugangsdaten mit diesem Schlüssel. Fehlt
 * die Bindung, liefert `brokerVerbindungLesend` für jedes verschlüsselte
 * Konto still `null` — das Konto gilt dann als „ohne Broker", handelt nur im
 * eigenen Buch, und die Positionen beim Broker bleiben unbeaufsichtigt. Kein
 * Fehler, nur eine Logzeile. Genau deshalb muss die Bindung per Quelltext
 * festgenagelt sein: Ein Unit-Test der Entschlüsselung sähe die Lücke nie.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dirname, '..', 'src');
const lies = (...teile: string[]): string => readFileSync(join(src, ...teile), 'utf8');

/** ALLE Optionsblöcke nach `onSchedule(` — eine Datei kann mehrere
 *  zeitgesteuerte Functions tragen (momentumRun + momentumAusfuehrung). */
function scheduleOptionen(text: string): string[] {
  const bloecke: string[] = [];
  let ab = text.indexOf('onSchedule(');
  expect(ab).toBeGreaterThan(-1);
  while (ab > -1) {
    bloecke.push(text.slice(ab, text.indexOf('async', ab)));
    ab = text.indexOf('onSchedule(', ab + 1);
  }
  return bloecke;
}

describe('Tresor-Schlüssel ist gebunden', () => {
  it('alle Callables über CALLABLE_OPTS', () => {
    const appcheck = lies('core', 'appcheck.ts');
    const ab = appcheck.indexOf('export const CALLABLE_OPTS');
    const block = appcheck.slice(ab, appcheck.indexOf('};', ab));
    expect(block).toContain("secrets: ['BROKER_MASTER_KEY']");
  });

  it('jede zeitgesteuerte Function mit Broker-Zugriff', () => {
    const brokerModul =
      /from '\.\.\/core\/(broker|orderRouting|brokerAbgleich|marktUhr|keyVault|schutzStop|orderRaeumung)\.js'/;
    const geprueft: string[] = [];
    for (const name of readdirSync(join(src, 'scheduled'))) {
      const text = lies('scheduled', name);
      if (!brokerModul.test(text) || !text.includes('onSchedule(')) continue;
      geprueft.push(name);
      for (const block of scheduleOptionen(text)) expect(block, name).toContain("'BROKER_MASTER_KEY'");
    }
    // Schranke gegen einen leeren Scan: Diese fünf lesen nachweislich Zugangsdaten
    // (fillSync seit Drift-Paket 2, 08.10.: der Ereigniskanal liest je Konto).
    expect(geprueft.sort()).toEqual(
      ['fillSync.ts', 'momentumRun.ts', 'riskPulse.ts', 'scanMarket.ts', 'snapshotEquity.ts'],
    );
  });

  it('jedes Callable, das nicht CALLABLE_OPTS nutzt, fällt auf', () => {
    // Ein Callable mit eigenen Optionen ohne `...CALLABLE_OPTS` verlöre die
    // Bindung still. Alle müssen sie mitnehmen.
    for (const name of readdirSync(join(src, 'callable'))) {
      const text = lies('callable', name);
      let ab = text.indexOf('onCall(');
      while (ab > -1) {
        const kopf = text.slice(ab, text.indexOf('async', ab));
        expect(kopf, `${name}: onCall ohne CALLABLE_OPTS`).toContain('CALLABLE_OPTS');
        ab = text.indexOf('onCall(', ab + 1);
      }
    }
  });
});
