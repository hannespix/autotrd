/**
 * Scheduler-Diagnose + Selbstheilung im Deploy (Live-Abnahme im Actions-Log):
 *
 *   1. Cloud-Scheduler-Jobs listen. Fehlt dem Deploy-SA die Berechtigung
 *      (403), wird die exakte Owner-Anweisung inkl. SA-E-Mail geloggt und der
 *      Scheduler-Pfad übersprungen — der Deploy wird davon NICHT rot.
 *   2. JEDER fehlende Zeitplan wird SELBST angelegt (OIDC = Deploy-SA,
 *      Invoker-Grant inklusive) — genau die Artefakte, die firebase-tools in
 *      früheren kaputten Deploys nie erzeugt hat.
 *   3. Force-Run des Scan-Jobs; heilt danach kein Heartbeat, wird die
 *      Job-Identität auf den Deploy-SA gepatcht und erneut versucht.
 *   4. Letzte Eskalation: Direkt-Invoke des Cloud-Run-Services (invoke-scan).
 *
 * Exit 1 NUR, wenn am Ende kein Heartbeat meta/health existiert — also kein
 * einziger Weg zum laufenden Scan führte.
 *
 * **Warum alle Zeitpläne und nicht nur der Scan** (Befund 27.07., Deploy #104):
 * Nachdem der Owner die Cloud-Scheduler-Rolle vergeben hatte, legte dieser
 * Schritt den Scan-Job an — die vier Tages-Läufe blieben aber aus, weil
 * firebase-tools im selben Lauf an einem transienten Google-503 abbrach,
 * BEVOR es die Zeitpläne schreiben konnte. Ein Zeitplan, der nur bei einem
 * vollständig fehlerfreien Deploy entsteht, ist genau dann nicht da, wenn man
 * ihn braucht. Hier steht die Wahrheit über die Zeitpläne deshalb im Repo,
 * nicht in der Laune eines Deploy-Laufs.
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

/**
 * Die Zeitpläne — Spiegel der `onSchedule`-Deklarationen in functions/src/.
 *
 * `fn` ist der Export-Name (bestimmt die Job-ID nach Firebase-Konvention),
 * `service` der daraus abgeleitete Cloud-Run-Dienst (immer kleingeschrieben).
 * Weicht hier etwas vom Code ab, gewinnt der Code beim nächsten erfolgreichen
 * Deploy — diese Tabelle ist die Absicherung, nicht die Quelle der Wahrheit.
 */
const SCHEDULES = [
  { fn: 'scanMarket', service: 'scanmarket', cron: '*/5 * * * *', was: 'Marktscan' },
  // Der Ausstiegs-Wächter läuft MINÜTLICH: Ein Stop-Loss, der fünf Minuten
  // zu spät auslöst, kostet Geld — ein Einstieg fünf Minuten später fast
  // nichts (Owner-Wunsch 28.07., Begründung in riskPulse.ts).
  { fn: 'riskPulse', service: 'riskpulse', cron: '* * * * *', was: 'Risiko-Puls' },
  { fn: 'evalForecasts', service: 'evalforecasts', cron: '30 16 * * 1-5', was: 'Prognose-Bewertung' },
  { fn: 'snapshotEquity', service: 'snapshotequity', cron: '15 17 * * *', was: 'Equity-Snapshot' },
  { fn: 'autoTune', service: 'autotune', cron: '45 17 * * *', was: 'Auto-Tuner' },
  { fn: 'momentumRun', service: 'momentumrun', cron: '0 18 * * *', was: 'Momentum-Ranking' },
];

const TZ = 'America/New_York';
const jobId = (fn) => `firebase-schedule-${fn}-${REGION}`;

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
/** Zeitpläne, die am Ende nachweislich stehen — für die Schlussbilanz. */
const stehen = [];
/** Der Scan-Job und seine Ziel-URL — der Force-Run unten braucht beide. */
let job = null;
let url = null;
let freshlyCreated = false;

if (schedulerOk) {
  console.log(`${jobs.length} Scheduler-Job(s):`);
  for (const j of jobs) {
    console.log(
      `- ${j.name.split('/').pop()} · state=${j.state} · schedule="${j.schedule}" (${j.timeZone})` +
        ` · lastAttempt=${j.lastAttemptTime ?? 'nie'} · status=${JSON.stringify(j.status ?? {})}`,
    );
  }

  // Jeden fehlenden Zeitplan anlegen. Fehlschläge einzelner Läufe sind hier
  // bewusst nicht tödlich: Ein fehlender Tages-Lauf darf den Deploy nicht rot
  // machen, solange der Scan steht — er kostet einen Tag Kennzahlen, kein Geld.
  url = await ensureSelfInvoker({ sa, token, project });
  job = jobs.find((j) => j.name.endsWith(`/${JOB_ID}`) || j.name.includes('scanMarket')) ?? null;

  for (const s of SCHEDULES) {
    const id = jobId(s.fn);
    const vorhanden = jobs.find((j) => j.name.endsWith(`/${id}`));
    if (vorhanden) {
      // Falsche Kadenz still zu dulden wäre schlimmer als sie zu korrigieren:
      // Ein Job mit altem Zeitplan sieht im Log genauso grün aus.
      if (vorhanden.schedule !== s.cron) {
        console.log(`~ ${s.was}: Zeitplan "${vorhanden.schedule}" ≠ Code "${s.cron}" — korrigiere …`);
        await gfetch(`https://cloudscheduler.googleapis.com/v1/${vorhanden.name}?updateMask=schedule`, {
          token,
          method: 'PATCH',
          body: { name: vorhanden.name, schedule: s.cron },
        }).catch((err) => console.log(`::warning::${s.was}: Zeitplan-Korrektur fehlgeschlagen — ${err.message}`));
      }
      stehen.push(s.was);
      continue;
    }
    try {
      const zielUrl =
        s.service === 'scanmarket'
          ? url
          : await ensureSelfInvoker({ sa, token, project, service: s.service });
      const neu = await gfetch(base, {
        token,
        method: 'POST',
        body: {
          name: `projects/${project}/locations/${REGION}/jobs/${id}`,
          schedule: s.cron,
          timeZone: TZ,
          httpTarget: {
            uri: zielUrl,
            httpMethod: 'POST',
            oidcToken: { serviceAccountEmail: sa.client_email, audience: zielUrl },
          },
        },
      });
      console.log(`✓ ${s.was} (${id}): angelegt, state=${neu.state}, schedule="${s.cron}" ${TZ}`);
      stehen.push(s.was);
      if (s.service === 'scanmarket') {
        job = neu;
        freshlyCreated = true;
      }
    } catch (err) {
      console.log(`::warning::${s.was} (${id}) konnte nicht angelegt werden — ${err.message}`);
    }
  }

  if (!job) {
    console.error('✗ Kein scanMarket-Job vorhanden und Anlage fehlgeschlagen — eskaliere auf Direkt-Invoke.');
  }
}

if (schedulerOk && job) {
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
    console.log(`✓ ${stehen.length}/${SCHEDULES.length} Zeitpläne stehen: ${stehen.join(' · ')}`);
    if (stehen.length < SCHEDULES.length) {
      const fehlend = SCHEDULES.filter((s) => !stehen.includes(s.was)).map((s) => s.was);
      console.log(`::warning::Ohne Zeitplan: ${fehlend.join(', ')} — siehe Meldungen oben.`);
    }
  }
  process.exit(0);
}

console.error('✗ meta/health existiert trotz aller Eskalationsstufen NICHT.');
console.error('  → Die Function selbst schlägt fehl; Cloud-Logging des scanmarket-Services prüfen.');
process.exit(1);
