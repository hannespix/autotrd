#!/usr/bin/env node
/**
 * Globalen Teil der Plattform-Config nach Firestore `meta/engineConfig`
 * schreiben — die Engine-Function liest ihn je Minute.
 *
 *   node scripts/sync-engine-config.mjs [--config config/platform.yaml] [--dry-run]
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
import { engineConfigDocFrom } from './lib/engineConfig.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const path = resolve(opt('--config', 'config/platform.yaml'));

const cfg = parseConfig(parseYaml(readFileSync(path, 'utf8')));
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
