/**
 * Scheduler-Diagnose im Deploy (M2-Live-Abnahme): listet die Cloud-Scheduler-
 * Jobs, stößt den Scan-Job einmal an (Force-Run) und prüft danach den
 * öffentlichen Heartbeat meta/health — alles im Actions-Log nachlesbar,
 * ohne dass jemand die GCP-Konsole öffnen muss.
 */

import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const REGION = 'us-central1';
const project = JSON.parse(readFileSync('.firebaserc', 'utf8')).projects.default;
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();
const base = `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/${REGION}/jobs`;

const { data } = await client.request({ url: base });
const jobs = data.jobs ?? [];
console.log(`${jobs.length} Scheduler-Job(s):`);
for (const j of jobs) {
  console.log(
    `- ${j.name.split('/').pop()} · state=${j.state} · schedule="${j.schedule}" (${j.timeZone})` +
      ` · lastAttempt=${j.lastAttemptTime ?? 'nie'} · status=${JSON.stringify(j.status ?? {})}`,
  );
}

const scanJob = jobs.find((j) => j.name.includes('scanMarket'));
if (!scanJob) {
  console.error('✗ Kein scanMarket-Job gefunden!');
  process.exit(1);
}

console.log('Force-Run scanMarket …');
await client.request({ url: `${scanJob.name.startsWith('projects/') ? `https://cloudscheduler.googleapis.com/v1/${scanJob.name}` : scanJob.name}:run`, method: 'POST', data: {} });
await new Promise((r) => setTimeout(r, 25_000));

const res = await fetch(
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/meta/health`,
);
const doc = await res.json();
if (doc.fields) {
  const flat = Object.fromEntries(
    Object.entries(doc.fields).map(([k, v]) => [k, Object.values(v)[0]]),
  );
  console.log('✓ Heartbeat meta/health:', JSON.stringify(flat));
} else {
  console.error('✗ meta/health existiert nach Force-Run NICHT:', JSON.stringify(doc).slice(0, 300));
  console.error('  → Ausführungsfehler der Function; Status oben im Job-Listing prüfen.');
  process.exit(1);
}
