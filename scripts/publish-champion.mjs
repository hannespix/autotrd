#!/usr/bin/env node
/**
 * Champion + Optimierer-Bericht nach Firestore veröffentlichen.
 *
 *   node scripts/publish-champion.mjs --home var [--dry-run]
 *
 * Schreibt `meta/champion` (die champion.json OHNE die OOS-Ketten je Eintrag,
 * siehe scripts/module/championDoc.mjs — samt dem Block `basis` der
 * Basis-Allokation, falls der Lauf ihn geschrieben hat; additiv, Leser ohne
 * Block bleiben unverändert) und den
 * Markdown des jüngsten Berichts nach `meta/optimizeReports/berichte/<YYYY-MM-DD>`
 * (Pfad aus shared/src/berichte.ts — `meta/optimizeReports` ist ein Dokument,
 * die Berichte liegen in seiner Unter-Collection).
 * Beides enthält keine Konto- oder Nutzerdaten; `meta/**` ist absichtlich
 * für alle lesbar, damit das Frontend Champion und Bericht zeigen kann.
 *
 * Zugang über GOOGLE_APPLICATION_CREDENTIALS (Service-Account-JSON), wie
 * beim Functions-Deploy. Ohne Credentials und ohne --dry-run: Fehler.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { berichtPfad } from '../shared/src/berichte.ts';
import { INDEX_WERTE_MAX, fuerFirestore, pruefeDokument } from './module/championDoc.mjs';

const CHAMPION_PFAD = 'meta/champion';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const home = resolve(opt('--home', 'var'));

const championPath = join(home, 'champion.json');
if (!existsSync(championPath)) {
  console.error(`Kein champion.json unter ${home} — zuerst \`autotrd optimize\`.`);
  process.exit(1);
}
const champion = JSON.parse(readFileSync(championPath, 'utf8'));
if (champion.version !== 1 || typeof champion.symbols !== 'object') {
  console.error('champion.json hat ein unbekanntes Format.');
  process.exit(1);
}

const reportsDir = join(home, 'reports');
const reports = existsSync(reportsDir)
  ? readdirSync(reportsDir)
      .filter((f) => /^optimize-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
  : [];
const latestReport = reports[reports.length - 1] ?? null;
const reportDate = latestReport ? latestReport.slice('optimize-'.length, -3) : new Date().toISOString().slice(0, 10);
const reportText = latestReport ? readFileSync(join(reportsDir, latestReport), 'utf8') : '';

// Die Zielpfade gehören in die Ausgabe: Der erste Lauf nach dem Umstieg
// scheiterte an einem Pfad mit ungerader Segmentzahl, und der Trockenlauf
// hätte das nie gezeigt, weil er vor Firestore aufhört.
const basis = champion.basis && typeof champion.basis === 'object' ? champion.basis : null;
const summary = {
  symbols: Object.keys(champion.symbols),
  noTrade: Object.keys(champion.noTrade ?? {}),
  erprobung: Object.keys(champion.erprobung ?? {}),
  // Die Basis-Stufe gehört in die Ausgabe: Ohne diese Zeile sähe man im Lauf nicht, ob ein
  // bestandener Block mitgeht — und die Engine handelt ihn, sobald er in meta/champion steht.
  basis: basis
    ? { label: basis.label, strategy: basis.strategy, pass: basis.pass === true, symbols: basis.symbols ?? [], positionPct: basis.positionPct ?? null }
    : null,
  updatedAt: champion.updatedAt,
  reportDate,
  reportBytes: reportText.length,
  ziele: latestReport ? [CHAMPION_PFAD, berichtPfad(reportDate)] : [CHAMPION_PFAD],
};
console.log(JSON.stringify(summary, null, 2));

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
const db = getFirestore();

// Firestore-Dokumente sind auf 1 MiB begrenzt; ein Bericht darf nicht größer sein.
const MAX_REPORT = 900_000;
const reportDoc = {
  date: reportDate,
  markdown: reportText.length > MAX_REPORT ? reportText.slice(0, MAX_REPORT) + '\n\n… (gekürzt)' : reportText,
  truncated: reportText.length > MAX_REPORT,
  publishedAt: Timestamp.now(),
};

// Ohne die OOS-Ketten je Eintrag (scripts/module/championDoc.mjs): Lauf #18
// (18.09.2026) starb an Firestores Index-Limit, weil 30 beförderte Einträge
// je ~2 200 Array-Elemente trugen. Gezählt wird VOR dem Batch — sonst steht
// wieder nachts um eins ein Champion bereit, den niemand veröffentlichen kann.
const doc = fuerFirestore(champion);
const pruefung = pruefeDokument(doc);
if (!pruefung.ok) {
  console.error(pruefung.grund);
  process.exit(1);
}
console.log(`meta/champion: ${pruefung.werte} indizierbare Werte (Obergrenze ${INDEX_WERTE_MAX}; Firestore-Limit 40 000 Index-Einträge; ohne OOS-Ketten)`);

const batch = db.batch();
batch.set(db.doc(CHAMPION_PFAD), { ...doc, publishedAt: Timestamp.now() });
if (latestReport) batch.set(db.doc(berichtPfad(reportDate)), reportDoc);
await batch.commit();
console.log(
  `Veröffentlicht: meta/champion (${summary.symbols.length} Symbole, ${summary.noTrade.length} noTrade` +
    (summary.erprobung.length ? `, ${summary.erprobung.length} Papier-Erprobung (durchgefallen, nur Papier)` : '') +
    (basis ? `, Basis „${basis.label}" ${basis.pass === true ? 'bestanden' : 'nicht bestanden'}` : ', keine Basis') +
    ')' +
    (latestReport ? `, ${berichtPfad(reportDate)}` : ''),
);
