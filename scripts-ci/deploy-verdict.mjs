/**
 * Deploy-Verdikt: Liest das firebase-tools-Deploy-Log und entscheidet, ob ein
 * fehlgeschlagener Deploy toleriert werden darf.
 *
 *   node scripts-ci/deploy-verdict.mjs <pfad-zum-deploy-log>
 *
 * Toleriert wird GENAU EIN Fehlerbild: „Failed to upsert schedule function …"
 * — das entsteht, solange der Deploy-SA keine Cloud-Scheduler-Rolle hat
 * (Owner-Klick offen, siehe check-scheduler.mjs). Der Funktions-CODE ist in
 * dem Fall trotzdem vollständig deployt; die Scan-Abnahme übernimmt danach
 * check-scheduler (Direkt-Invoke + Heartbeat-Beweis). JEDER andere Fehler
 * (Build kaputt, Quota, Auth, einzelne Funktion rot) bleibt hart rot.
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Aufruf: node scripts-ci/deploy-verdict.mjs <deploy-log>');
  process.exit(1);
}

// eslint-disable-next-line no-control-regex -- ANSI-Farbcodes aus dem CLI-Log entfernen
const log = readFileSync(path, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');

// firebase-tools listet am Ende jeden Fehler als „- Error <Beschreibung>".
const errLines = [...log.matchAll(/^- Error (.+)$/gm)].map((m) => m[1].trim());

if (errLines.length === 0) {
  console.error('Deploy schlug fehl, aber ohne erkennbare „- Error"-Zeilen — unbekanntes Fehlerbild, bleibt rot.');
  process.exit(1);
}

const tolerated = errLines.filter((l) => /^Failed to upsert schedule function /.test(l));
const hard = errLines.filter((l) => !/^Failed to upsert schedule function /.test(l));

for (const l of tolerated) console.log(`toleriert: ${l}`);
for (const l of hard) console.error(`HART: ${l}`);

if (hard.length > 0) {
  console.error(`${hard.length} nicht-tolerierbare(r) Deploy-Fehler — Job bleibt rot.`);
  process.exit(1);
}

console.log(
  `::warning::Nur Schedule-Upserts fehlgeschlagen (${tolerated.length}×) — Funktions-Code ist deployt. ` +
    'Für die native 5-min-Kadenz: Rolle "Cloud Scheduler Admin" an ' +
    'github-deploy@autotrd-653b0.iam.gserviceaccount.com vergeben (1 Klick, GCP-Konsole → IAM).',
);
