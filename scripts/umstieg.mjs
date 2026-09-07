#!/usr/bin/env node
/**
 * Umstieg vom Altsystem auf den Engine-Takt — auf DEMSELBEN Firebase-Projekt.
 *
 *   node scripts/umstieg.mjs [--config config/platform.yaml] [--keep uid1,uid2] [--dry-run]
 *
 * Läuft EINMAL, direkt nach dem Merge/Deploy des Neubaus (Reihenfolge in
 * docs/PLATTFORM.md §7). Drei Schritte, alle idempotent:
 *   1. `meta/engineConfig` aus config/platform.yaml schreiben.
 *   2. Engine für alle Nutzer ausschalten, die nicht Admin sind und nicht in
 *      `--keep` stehen (`settings.strategy.engine.running = false`). Sie
 *      schalten sich bewusst in der neuen Einstellungskarte wieder ein.
 *   3. Alte Positions-Spiegel nach `users/{uid}/positionsArchiv` verschieben.
 *
 * Es wird NICHTS gelöscht, was nicht zugleich archiviert wird; Schlüssel,
 * Trades, Historie und Einstellungen bleiben unberührt. Ohne
 * GOOGLE_APPLICATION_CREDENTIALS oder mit --dry-run wird nur geplant.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../src/core/config.ts';
import { engineConfigDocFrom } from './lib/engineConfig.mjs';
import { planeUmstieg, userSichtVon } from './lib/umstieg.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const behalten = (opt('--keep', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const configPath = resolve(opt('--config', 'config/platform.yaml'));

const cfg = parseConfig(parseYaml(readFileSync(configPath, 'utf8')));
const engineConfig = engineConfigDocFrom(cfg);
console.log(`meta/engineConfig: ${engineConfig.universe.symbols.length} Symbole, Zeitrahmen ${engineConfig.timeframe}, Feed ${engineConfig.broker.feed}`);

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS fehlt — ohne Service-Account kein Zugriff auf Firestore (auch --dry-run liest die Nutzer).');
  process.exit(1);
}
const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
initializeApp();
const db = getFirestore();

// Bestandsaufnahme
const usersSnap = await db.collection('users').get();
const sichten = [];
for (const u of usersSnap.docs) {
  const positions = await u.ref.collection('positions').listDocuments();
  sichten.push(userSichtVon(u.id, u.data(), positions.map((p) => p.id)));
}
const plan = planeUmstieg(sichten, { behalten });
console.log(`Nutzer: ${sichten.length} · Engine an: ${plan.ausschalten.length + plan.behalten.length} · wird ausgeschaltet: ${plan.ausschalten.length} · bleibt an: ${plan.behalten.length} (${plan.behalten.join(', ') || '—'})`);
console.log(`Alte Positions-Spiegel: ${plan.archivieren.reduce((n, a) => n + a.docs.length, 0)} Docs bei ${plan.archivieren.length} Nutzern`);

if (dryRun) {
  console.log('--dry-run: nichts geschrieben.');
  process.exit(0);
}

const now = Timestamp.now();
const nowIso = new Date().toISOString();

// 1. Config
await db.doc('meta/engineConfig').set({ ...engineConfig, updatedAt: now });
console.log('meta/engineConfig geschrieben.');

// 2. Engine aus (Punktpfad, nichts anderes anfassen)
let batch = db.batch();
let inBatch = 0;
const flush = async () => {
  if (inBatch > 0) await batch.commit();
  batch = db.batch();
  inBatch = 0;
};
for (const uid of plan.ausschalten) {
  batch.update(db.doc(`users/${uid}`), {
    'settings.strategy.engine.running': false,
    'engine.lastError': `Umstieg ${nowIso.slice(0, 10)}: Engine ausgeschaltet — bitte Einstellungen prüfen und bewusst einschalten`,
  });
  if (++inBatch >= 400) await flush();
}
await flush();
console.log(`Engine ausgeschaltet für ${plan.ausschalten.length} Nutzer.`);

// 3. Positions-Spiegel archivieren (Kopie + Löschen je Doc, in Batches)
let verschoben = 0;
for (const a of plan.archivieren) {
  for (const id of a.docs) {
    const src = db.doc(`users/${a.uid}/positions/${id}`);
    const snap = await src.get();
    if (!snap.exists) continue;
    batch.set(db.doc(`users/${a.uid}/positionsArchiv/${id}`), { ...snap.data(), archiviertAm: nowIso, archivGrund: 'Umstieg auf den Engine-Takt' });
    batch.delete(src);
    verschoben++;
    if ((inBatch += 2) >= 400) await flush();
  }
}
await flush();
console.log(`Positions-Spiegel archiviert: ${verschoben} Docs.`);
console.log('Umstieg abgeschlossen. Nächster Schritt: Optimierer-Workflow per workflow_dispatch starten (Champion), dann die Engine für das eigene Konto einschalten.');
