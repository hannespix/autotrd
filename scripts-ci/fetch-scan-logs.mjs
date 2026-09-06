/**
 * Holt die jüngsten Logs eines Cloud-Run-Dienstes aus Cloud Logging — die
 * Diagnose-Brücke, wenn ein Direkt-Invoke 500 liefert und niemand die
 * GCP-Konsole offen hat.
 *
 *   node scripts-ci/fetch-scan-logs.mjs [minuten] [severity] [dienst]
 *
 * Default: 30 Minuten, severity>=WARNING, Dienst `enginetick` (der
 * Engine-Takt — Firebase leitet den Dienstnamen kleingeschrieben aus dem
 * Export-Namen ab; bis zum Rückbau der Handelsplattform stand hier
 * `scanmarket`). Dependency-frei (gcp-lite), damit es wie invoke-scan.mjs
 * ohne npm ci in Workflows laufen kann. Log-Payloads werden 1:1 ausgegeben —
 * unsere Functions loggen nie Secrets (CLAUDE.md §0.8).
 */

import { gfetch, mintAccessToken, projectFromFirebaserc, readServiceAccount } from './gcp-lite.mjs';

const minutes = Number(process.argv[2] ?? 30);
const severity = process.argv[3] ?? 'WARNING';
const service = process.argv[4] ?? 'enginetick';

const sa = readServiceAccount();
const project = projectFromFirebaserc();
const token = await mintAccessToken(sa);

const since = new Date(Date.now() - minutes * 60_000).toISOString();
const filter = [
  'resource.type="cloud_run_revision"',
  `resource.labels.service_name="${service}"`,
  `timestamp>="${since}"`,
  `severity>=${severity}`,
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
  console.log(`Keine ${service}-Logs in den letzten ${minutes} min (severity>=${severity}).`);
  process.exit(0);
}
for (const e of entries) {
  const payload =
    e.textPayload ??
    (e.jsonPayload ? JSON.stringify(e.jsonPayload) : JSON.stringify(e.protoPayload ?? {}));
  console.log(`${e.timestamp} ${e.severity ?? ''} ${payload}`.slice(0, 3000));
}
