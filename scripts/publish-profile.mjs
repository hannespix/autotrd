#!/usr/bin/env node
/**
 * Symbolprofil nach Firestore veröffentlichen — das Schwester-Skript von
 * `publish-champion.mjs`, vom Optimierer-Workflow NACH dem Champion
 * aufgerufen.
 *
 *   node scripts/publish-profile.mjs --home var [--dry-run]
 *
 * Liest `<home>/profile.json` (geschrieben von `autotrd optimize` am Ende des
 * Laufs bzw. `autotrd profile`) und schreibt es unverändert plus
 * `publishedAt` nach `meta/symbolProfile` — EIN Dokument (Größe wird
 * geprüft, `scripts/module/symbolProfile.mjs`). Das Profil ist Anzeige und
 * Erklärung: was die Engine je Symbol tut und warum. Es enthält keine
 * Konto- oder Nutzerdaten und ist wie `meta/champion` öffentlich lesbar.
 *
 * Fehlt die Datei, ist das ein Fehler: Der Workflow ruft dieses Skript nur
 * nach einem Lauf, der `optimize` durchlaufen hat — und der schreibt das
 * Profil. Zugang über GOOGLE_APPLICATION_CREDENTIALS wie beim Champion.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { profilDokument, profilZusammenfassung, pruefeProfil, veroeffentlicheProfil } from './module/symbolProfile.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const home = resolve(opt('--home', 'var'));

const profilPfad = join(home, 'profile.json');
if (!existsSync(profilPfad)) {
  console.error(`Kein profile.json unter ${home} — zuerst \`autotrd optimize\` (schreibt es am Ende) oder \`autotrd profile\`.`);
  process.exit(1);
}
const profil = JSON.parse(readFileSync(profilPfad, 'utf8'));
const fehler = pruefeProfil(profil);
if (fehler !== null) {
  console.error(`profile.json: ${fehler}`);
  process.exit(1);
}
// Größe VOR dem Trockenlauf-Ausstieg prüfen: Ein zu großes Profil soll schon
// im Trockenlauf auffallen, nicht erst nachts gegen Firestore.
const { bytes } = profilDokument(profil, null);
console.log(JSON.stringify({ ...profilZusammenfassung(profil), bytes }, null, 2));

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
const ergebnis = await veroeffentlicheProfil(getFirestore(), profil, Timestamp.now());
console.log(`Veröffentlicht: ${ergebnis.pfad} (${ergebnis.symbole} Symbole, ${ergebnis.bytes} Bytes)`);
