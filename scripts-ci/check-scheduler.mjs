/**
 * Scheduler-Diagnose + Selbstheilung im Deploy (Live-Abnahme im Actions-Log):
 *
 *   1. Cloud-Scheduler-Jobs listen. Fehlt dem Deploy-SA die Berechtigung
 *      (403), wird die exakte Owner-Anweisung inkl. SA-E-Mail geloggt und der
 *      Scheduler-Pfad übersprungen — der Deploy wird davon NICHT rot.
 *   2. Existiert kein scanMarket-Job, wird er SELBST angelegt (alle 5 min,
 *      OIDC = Deploy-SA, Invoker-Grant inklusive) — genau das Artefakt, das
 *      firebase-tools in früheren kaputten Deploys nie erzeugt hat.
 *   3. Force-Run des Jobs; heilt danach kein Heartbeat, wird die Job-Identität
 *      auf den Deploy-SA gepatcht und erneut versucht.
 *   4. Letzte Eskalation: Direkt-Invoke des Cloud-Run-Services (invoke-scan).
 *
 * Exit 1 NUR, wenn am Ende kein Heartbeat meta/health existiert — also kein
 * einziger Weg zum laufenden Scan führte.
 */

import {
  gfetch,
  mintAccessToken,
  projectFromFirebaserc,
  readServiceAccount,
} from './gcp-lite.mjs';
import { ensureSelfInvoker, invokeScanNow, readHeartbeat } from './invoke-scan.mjs';

const REGION = 'us-central1';
const JOB_ID = 'firebase-schedule-scanMarket-us-central1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sa = readServiceAccount();
const project = projectFromFirebaserc();
const token = await mintAccessToken(sa);
const base = `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/${REGION}/jobs`;

console.log(`Deploy-SA: ${sa.client_email}`);

let schedulerOk = true;
let jobs = [];
try {
  const data = await gfetch(base, { token });
  jobs = data.jobs ?? [];
} catch (err) {
  if (err.status === 403) {
    schedulerOk = false;
    console.log(
      `::warning::Deploy-SA hat KEINE Cloud-Scheduler-Berechtigung. ` +
        `Fix (1 Klick in der GCP-Konsole → IAM): Rolle "Cloud Scheduler Admin" an ${sa.client_email} vergeben. ` +
        `Bis dahin übernimmt der Scan-Watchdog (alle 30 min zu US-Marktzeiten).`,
    );
  } else {
    throw err;
  }
}

let heartbeat = null;

if (schedulerOk) {
  console.log(`${jobs.length} Scheduler-Job(s):`);
  for (const j of jobs) {
    console.log(
      `- ${j.name.split('/').pop()} · state=${j.state} · schedule="${j.schedule}" (${j.timeZone})` +
        ` · lastAttempt=${j.lastAttemptTime ?? 'nie'} · status=${JSON.stringify(j.status ?? {})}`,
    );
  }

  const url = await ensureSelfInvoker({ sa, token, project });
  let job = jobs.find((j) => j.name.endsWith(`/${JOB_ID}`) || j.name.includes('scanMarket'));
  let freshlyCreated = false;

  if (!job) {
    console.log(`Kein scanMarket-Job — lege ${JOB_ID} an (alle 5 min, OIDC=${sa.client_email}) …`);
    job = await gfetch(base, {
      token,
      method: 'POST',
      body: {
        name: `projects/${project}/locations/${REGION}/jobs/${JOB_ID}`,
        schedule: '*/5 * * * *',
        timeZone: 'America/New_York',
        httpTarget: {
          uri: url,
          httpMethod: 'POST',
          oidcToken: { serviceAccountEmail: sa.client_email, audience: url },
        },
      },
    });
    freshlyCreated = true;
    console.log(`✓ Job angelegt: state=${job.state}`);
  }

  console.log('Force-Run scanMarket …');
  await gfetch(`https://cloudscheduler.googleapis.com/v1/${job.name}:run`, {
    token,
    method: 'POST',
    body: {},
  });
  await sleep(25_000);
  heartbeat = await readHeartbeat(project);

  if (!heartbeat && !freshlyCreated) {
    // Bestehender Job feuert ins Leere → Identität/Ziel auf den Deploy-SA
    // umbiegen (der hat nachweislich Invoker) und noch einmal versuchen.
    console.log('Kein Heartbeat nach Force-Run — patche Job-Identität auf den Deploy-SA …');
    await gfetch(`https://cloudscheduler.googleapis.com/v1/${job.name}?updateMask=httpTarget`, {
      token,
      method: 'PATCH',
      body: {
        name: job.name,
        httpTarget: {
          uri: url,
          httpMethod: 'POST',
          oidcToken: { serviceAccountEmail: sa.client_email, audience: url },
        },
      },
    });
    await gfetch(`https://cloudscheduler.googleapis.com/v1/${job.name}:run`, {
      token,
      method: 'POST',
      body: {},
    });
    await sleep(25_000);
    heartbeat = await readHeartbeat(project);
  }
}

if (!heartbeat) {
  console.log('Eskalation: Direkt-Invoke des scanmarket-Services …');
  const ok = await invokeScanNow();
  heartbeat = ok ? await readHeartbeat(project) : null;
}

if (heartbeat) {
  console.log('✓ Heartbeat meta/health:', JSON.stringify(heartbeat).slice(0, 300));
  if (!schedulerOk) {
    console.log(
      '::warning::Scan lief nur per Direkt-Invoke. Für die native 5-min-Kadenz: Rolle "Cloud Scheduler Admin" an den Deploy-SA (siehe oben).',
    );
  } else {
    console.log('✓ Scheduler-Pfad funktioniert — Scans laufen nativ alle 5 Minuten.');
  }
  process.exit(0);
}

console.error('✗ meta/health existiert trotz aller Eskalationsstufen NICHT.');
console.error('  → Die Function selbst schlägt fehl; Cloud-Logging des scanmarket-Services prüfen.');
process.exit(1);
