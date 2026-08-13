/**
 * Deploy-Verdikt: Liest das firebase-tools-Deploy-Log und entscheidet, wie mit
 * einem fehlgeschlagenen Deploy umzugehen ist.
 *
 *   node scripts-ci/deploy-verdict.mjs <pfad-zum-deploy-log>
 *
 * Drei Ausgänge, und die Unterscheidung ist der ganze Zweck:
 *
 *   **0 — toleriert.** Genau ein Bild: „Failed to upsert schedule function …",
 *   solange dem Deploy-SA die Cloud-Scheduler-Rolle fehlt. Der Funktions-CODE
 *   ist dann vollständig deployt; die Zeitpläne legt check-scheduler an.
 *
 *   **2 — transient, bitte wiederholen.** Google-seitige Aussetzer: 5xx von
 *   den Steuerungs-APIs, abgerissene Verbindungen, Zeitüberschreitungen. Der
 *   Deploy ist dabei NICHT durchgelaufen — Toleranz wäre hier eine Lüge, denn
 *   der neue Code läge nicht live. Der Aufrufer wiederholt stattdessen.
 *   (Beobachtet am 27.07., Deploy #104: HTTP 503 von serviceusage.googleapis
 *   mitten im API-Check, ohne jeden Bezug zum Projektzustand.)
 *
 *   **1 — hart rot.** Alles andere: kaputter Build, Quota, Auth, einzelne
 *   Funktion rot. Ein unbekannter Fehler, den man durchwinkt, ist gefährlicher
 *   als ein Fehlalarm.
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Aufruf: node scripts-ci/deploy-verdict.mjs <deploy-log>');
  process.exit(1);
}

// eslint-disable-next-line no-control-regex -- ANSI-Farbcodes aus dem CLI-Log entfernen
const log = readFileSync(path, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Fehlerbilder, die nachweislich von selbst heilen. Bewusst eng gefasst: Jedes
 * Muster hier verwandelt einen roten Deploy in einen zweiten Versuch, und ein
 * zu weites Muster würde echte Fehler in einer Schleife verstecken.
 */
const TRANSIENT = [
  /HTTP Error:\s*5\d\d/i, // 500/502/503/504 der GCP-Steuerungs-APIs
  /The service is currently unavailable/i,
  /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/,
  /socket hang up/i,
  /network timeout|Client network socket disconnected/i,
];

const istTransient = (text) => TRANSIENT.some((re) => re.test(text));

/**
 * Google bricht Cloud Builds gelegentlich selbst ab: Status CANCELLED mit
 * „An unexpected error occurred" (beobachtet 13.08., Deploy für 8afce0d —
 * alle 37 Functions „Failed to update", Ursache ausschließlich Google-seitig
 * abgebrochene Builds). Die „- Error"-Summenzeilen tragen den Grund NICHT,
 * er steht nur im Log-Körper — deshalb wird er dort gesucht. Bewusst beide
 * Teile im Muster: ein echter Build-Fehler meldet Status FAILURE, ein von
 * Menschen abgebrochener Build kommt ohne „unexpected error".
 */
const BUILD_ABBRUCH = /Build failed with status: CANCELLED and message: An unexpected error occurred/;

/**
 * „Failed to update/create function X" ist nur die Summenzeile — transient
 * genau dann, wenn der Log-Körper den Google-seitigen Build-Abbruch zeigt.
 * Jede andere Fehlerzeile daneben bleibt hart und überstimmt (hard gewinnt
 * unten vor transient), und ohne den Abbruch-Marker bleibt die Summenzeile
 * hart wie bisher.
 */
const istFunktionsSummenzeile = (text) => /^Failed to (update|create) function /.test(text);

// firebase-tools listet am Ende jeden Fehler als „- Error <Beschreibung>".
const errLines = [...log.matchAll(/^- Error (.+)$/gm)].map((m) => m[1].trim());

if (errLines.length === 0) {
  // Abbruch VOR der Fehlerliste — dann steht der Grund als nackte
  // „Error: …"-Zeile im Log (so kam der 503 vom 27.07. herein).
  const roh = [...log.matchAll(/^Error:\s*(.+)$/gm)].map((m) => m[1].trim());
  const transient = roh.find((l) => istTransient(l));
  if (transient) {
    console.log(`transient: ${transient}`);
    console.log('::warning::Google-seitiger Aussetzer beim Deploy — wird wiederholt.');
    process.exit(2);
  }
  for (const l of roh) console.error(`HART: ${l}`);
  console.error('Deploy schlug fehl, aber ohne erkennbare „- Error"-Zeilen — unbekanntes Fehlerbild, bleibt rot.');
  process.exit(1);
}

const buildAbbruch = BUILD_ABBRUCH.test(log);
const tolerated = errLines.filter((l) => /^Failed to upsert schedule function /.test(l));
const rest = errLines.filter((l) => !/^Failed to upsert schedule function /.test(l));
const transient = rest.filter((l) => istTransient(l) || (buildAbbruch && istFunktionsSummenzeile(l)));
const hard = rest.filter((l) => !istTransient(l) && !(buildAbbruch && istFunktionsSummenzeile(l)));

for (const l of tolerated) console.log(`toleriert: ${l}`);
for (const l of transient) console.log(`transient: ${l}`);
for (const l of hard) console.error(`HART: ${l}`);

if (hard.length > 0) {
  console.error(`${hard.length} nicht-tolerierbare(r) Deploy-Fehler — Job bleibt rot.`);
  process.exit(1);
}

if (transient.length > 0) {
  console.log(`::warning::${transient.length} transiente(r) Google-Fehler — wird wiederholt.`);
  process.exit(2);
}

console.log(
  `::warning::Nur Schedule-Upserts fehlgeschlagen (${tolerated.length}×) — Funktions-Code ist deployt. ` +
    'Für die native 5-min-Kadenz: Rolle "Cloud Scheduler Admin" an ' +
    'github-deploy@autotrd-653b0.iam.gserviceaccount.com vergeben (1 Klick, GCP-Konsole → IAM).',
);
