#!/usr/bin/env node
/**
 * „Warum hat die Engine dieses Symbol nicht gehandelt?" — NUR LESEN.
 *
 *   node scripts/warum.mjs --symbol BAC --stunden 24
 *   node scripts/warum.mjs --stunden 6            (alle Symbole)
 *
 * Liest die `decision`-Ereignisse aus `users/{uid}/journal` — dort landen die
 * Blockier-Gründe aus `decide()` (engine.ts), nicht in Cloud Logging. Ohne
 * dieses Werkzeug ist „im Log steht nichts" nicht von „die Engine hat nichts
 * entschieden" zu unterscheiden; genau daran bin ich am 16.09.2026 beim
 * BAC-Signal hängengeblieben.
 *
 * Schreibt nichts. Zugang über GOOGLE_APPLICATION_CREDENTIALS.
 */
import { ERKLAEREND, alsMarkdown } from './module/warum.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const symbolRoh = opt('--symbol', '').trim().toUpperCase();
const stunden = Number(opt('--stunden', '24'));
const limit = Number(opt('--limit', '400'));

if (symbolRoh && !/^[A-Z0-9.\-/]{1,12}$/.test(symbolRoh)) {
  console.error(`Symbol „${symbolRoh}" sieht nicht wie ein Symbol aus.`);
  process.exit(1);
}
if (!Number.isFinite(stunden) || stunden <= 0 || stunden > 24 * 30) {
  console.error('--stunden muss zwischen 1 und 720 liegen.');
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS fehlt — ohne Service-Account kein Blick auf Firestore.');
  process.exit(1);
}

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp();
const db = getFirestore();

const seit = Date.now() - stunden * 3_600_000;
const users = await db.collection('users').get();

const nutzer = [];
for (const u of users.docs) {
  // Nur Konten mit eingeschalteter Engine — die übrigen haben kein Journal,
  // und eine Seite voll „kein Eintrag" verdeckt den einen Nutzer, um den es geht.
  const auto = u.data()?.settings?.auto;
  if (auto && auto.enabled === false) continue;
  const snap = await db.collection(`users/${u.id}/journal`).where('ts', '>=', seit).orderBy('ts', 'asc').limit(limit).get();
  const events = snap.docs
    .map((d) => d.data())
    .filter((ev) => ERKLAEREND.includes(String(ev?.kind)))
    .filter((ev) => !symbolRoh || String(ev?.symbol ?? '') === symbolRoh);
  if (snap.empty && events.length === 0 && users.docs.length > 3) continue;
  nutzer.push({ uid: u.id, events });
}

console.log(alsMarkdown(nutzer, { ...(symbolRoh ? { symbol: symbolRoh } : {}), stunden }));
