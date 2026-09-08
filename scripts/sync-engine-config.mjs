#!/usr/bin/env node
/**
 * Globalen Teil der Plattform-Config nach Firestore `meta/engineConfig`
 * schreiben — die Engine-Function liest ihn je Minute.
 *
 *   node scripts/sync-engine-config.mjs [--config config/platform.yaml]
 *                                       [--universe var/universe.json] [--dry-run]
 *
 * Mit `--universe` gilt die nächtliche Auswahl (`autotrd universe`) statt der
 * committeten Symbolliste. Fehlt die Datei, bleibt es bei der Config; ist sie
 * kaputt oder nennt sie Symbole außerhalb des Kandidatenpools, bricht der
 * Schritt ab — dann steht in Firestore weiter die letzte gültige Config, statt
 * dass die Plattform etwas Unverstandenes handelt.
 *
 * Es wird NUR der nutzerunabhängige Teil übertragen (universe, timeframe,
 * session, costs, engine ohne barGraceSec, broker.feed). Risiko und
 * Benachrichtigung sind je Nutzer und bleiben in dessen Einstellungen. Die Datei wird vorher mit dem
 * Schema des Kerns validiert — eine ungültige Config erreicht Firestore nie.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../src/core/config.ts';
import { ladeUniverseDatei, mitUniverse } from '../src/universe/file.ts';
import { engineConfigDocFrom } from './module/engineConfig.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const path = resolve(opt('--config', 'config/platform.yaml'));

const roh = parseConfig(parseYaml(readFileSync(path, 'utf8')));
const universePath = opt('--universe', null);
let cfg = roh;
if (universePath) {
  const gewaehlt = ladeUniverseDatei(resolve(universePath), roh);
  if (gewaehlt) {
    cfg = mitUniverse(roh, gewaehlt);
    console.error(`Universum aus der Auswahl: ${gewaehlt.length} Symbole (${universePath}).`);
  } else {
    console.error(`Keine Auswahl unter ${universePath} — es gilt das Universum aus der Config (${roh.universe.symbols.length} Symbole).`);
  }
}
const global = engineConfigDocFrom(cfg);
console.log(JSON.stringify(global, null, 2));

if (dryRun) {
  console.log('--dry-run: nichts geschrieben.');
  process.exit(0);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS fehlt — ohne Service-Account kein Schreiben (oder --dry-run).');
  process.exit(1);
}
const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
initializeApp();
await getFirestore().doc('meta/engineConfig').set({ ...global, updatedAt: Timestamp.now() });
console.log('meta/engineConfig geschrieben.');
