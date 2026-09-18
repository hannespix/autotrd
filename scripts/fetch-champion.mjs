#!/usr/bin/env node
/**
 * Den Amtsinhaber holen: `meta/champion` ⇒ `var/champion.json` — NUR LESEN.
 *
 *   node scripts/fetch-champion.mjs --home var
 *
 * ── Warum es das gibt (18.09.2026) ────────────────────────────────────────
 *
 * Der nächtliche Workflow hielt zwischen zwei Nächten nur `var/bars` und
 * `var/universe.json` im Cache — nie `var/champion.json`. Der Optimierer
 * fand deshalb JEDE Nacht keinen Amtsinhaber („erste Beförderung") und
 * entschied von vorn. Die ganze Keep/Demote-Logik von promote.ts — Marge,
 * Re-Score nur auf sauberem OOS nach `fitEnd`, „eine Datenlücke ist kein
 * Beleg gegen den Champion" — hat auf der Plattform nie gegriffen.
 *
 * Sichtbar wurde das, als Lauf #17 und #18 bei identischem Universum und
 * einem Tag Anker-Verschiebung dieselbe Familie einmal durchfallen und
 * einmal bestehen ließen: Ohne Amtsinhaber wäre der Champion von heute
 * morgen wieder abgewählt, und die Engine hätte seine Positionen als
 * führungslos glattgestellt.
 *
 * Quelle ist Firestore, nicht der Actions-Cache: `meta/champion` ist, was
 * die Engine tatsächlich handelt; ein Cache kann verfallen. Fehlt das
 * Dokument, gibt es keinen Amtsinhaber — wie bisher, aber gesagt.
 *
 * Schreibt genau eine Datei. Zugang über GOOGLE_APPLICATION_CREDENTIALS.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ausFirestoreDoc } from './module/championDoc.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const home = resolve(opt('--home', 'var'));

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS fehlt — ohne Service-Account kein Amtsinhaber (der Lauf entscheidet dann von vorn).');
  process.exit(1);
}

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp();
const db = getFirestore();

const snap = await db.doc('meta/champion').get();
const champion = ausFirestoreDoc(snap.exists ? snap.data() : undefined);
if (!champion) {
  console.log('meta/champion fehlt — kein Amtsinhaber, der Lauf entscheidet von vorn.');
  process.exit(0);
}
if (!existsSync(home)) mkdirSync(home, { recursive: true });
const ziel = join(home, 'champion.json');
writeFileSync(ziel, JSON.stringify(champion, null, 2));
console.log(
  `Amtsinhaber geholt: ${ziel} — ${Object.keys(champion.symbols).length} Symbole, ${Object.keys(champion.noTrade).length} noTrade, ` +
    `${Object.keys(champion.erprobung ?? {}).length} Erprobung, Basis ${champion.basis ? 'ja' : 'nein'}, updatedAt ${new Date(champion.updatedAt).toISOString()}`,
);
