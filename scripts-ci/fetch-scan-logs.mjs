/**
 * Holt die jüngsten scanmarket-Logs aus Cloud Logging — die Diagnose-Brücke,
 * wenn ein Direkt-Invoke 500 liefert und niemand die GCP-Konsole offen hat.
 *
 *   node scripts-ci/fetch-scan-logs.mjs [minuten] [severity] [dienst] [ende] [suche]
 *
 * `ende` (24.11.): Das Fenster endet so viele Minuten VOR jetzt — sonst sind
 * nur die 50 jüngsten Einträge lesbar und ein Lauf von vorgestern liegt
 * hinter dem von heute. `suche`: nur Einträge, deren Text diese Zeichenfolge
 * enthält (z. B. „HTTP 403"), damit die 50 Zeilen nicht im Rauschen enden.
 *
 * Default: 30 Minuten, severity>=WARNING, Dienst scanmarket. Der Dienst ist
 * seit 22.10. wählbar: Der Umkehr-Abendlauf scheiterte geplant (Scheduler
 * code 13) und beim Deploy-Anstoß (HTTP 500), und keine Zeile davon war
 * ohne GCP-Konsole lesbar. Dependency-frei (gcp-lite), damit
 * es wie invoke-scan.mjs ohne npm ci in Workflows laufen kann. Log-Payloads
 * werden 1:1 ausgegeben — unsere Functions loggen nie Secrets (CLAUDE.md §7).
 */

import { gfetch, mintAccessToken, projectFromFirebaserc, readServiceAccount } from './gcp-lite.mjs';

const minutes = Number(process.argv[2] ?? 30);
const severity = process.argv[3] ?? 'WARNING';
const dienst = process.argv[4] ?? 'scanmarket';
// Der Dienstname landet im Logging-Filter — nur Cloud-Run-Namen zulassen.
if (!/^[a-z][a-z0-9-]{0,62}$/.test(dienst)) {
  console.error(`Ungültiger Dienstname: ${dienst}`);
  process.exit(2);
}

const ende = Number(process.argv[5] ?? 0);
if (!Number.isFinite(minutes) || !Number.isFinite(ende) || ende < 0 || ende >= minutes) {
  console.error(`Ungültiges Fenster: minuten=${process.argv[2]} ende=${process.argv[5]}`);
  process.exit(2);
}
// Der Suchtext landet im Logging-Filter — nur harmlose Zeichen zulassen.
const suche = process.argv[6] ?? '';
if (suche && !/^[A-Za-z0-9ÄÖÜäöüß _.:()-]{1,60}$/.test(suche)) {
  console.error('Ungültiger Suchtext (erlaubt: Buchstaben, Ziffern, Leerzeichen, _ . : ( ) -, höchstens 60 Zeichen)');
  process.exit(2);
}

const sa = readServiceAccount();
const project = projectFromFirebaserc();
const token = await mintAccessToken(sa);

const since = new Date(Date.now() - minutes * 60_000).toISOString();
const filter = [
  'resource.type="cloud_run_revision"',
  `resource.labels.service_name="${dienst}"`,
  `timestamp>="${since}"`,
  ...(ende > 0 ? [`timestamp<="${new Date(Date.now() - ende * 60_000).toISOString()}"`] : []),
  `severity>=${severity}`,
  ...(suche ? [`(textPayload:"${suche}" OR jsonPayload.message:"${suche}")`] : []),
].join(' AND ');

const data = await gfetch('https://logging.googleapis.com/v2/entries:list', {
  token,
  method: 'POST',
  body: {
    resourceNames: [`projects/${project}`],
    filter,
    orderBy: 'timestamp desc',
    pageSize: 50,
  },
});

const entries = (data.entries ?? []).reverse();
if (entries.length === 0) {
  console.log(`Keine ${dienst}-Logs in den letzten ${minutes} min (severity>=${severity}).`);
  process.exit(0);
}
for (const e of entries) {
  const payload =
    e.textPayload ??
    (e.jsonPayload ? JSON.stringify(e.jsonPayload) : JSON.stringify(e.protoPayload ?? {}));
  console.log(`${e.timestamp} ${e.severity ?? ''} ${payload}`.slice(0, 3000));
}
