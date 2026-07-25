/**
 * Direkt-Invoke des scanMarket-Laufs — der Cloud-Scheduler-unabhängige Weg,
 * einen Scan auszulösen. Funktioniert mit den Rollen, die der Deploy-SA
 * sicher hat (Cloud Run Admin + Service Account User):
 *
 *   1. Heartbeat meta/health lesen (öffentlich). Mit --if-stale N wird nur
 *      weitergemacht, wenn der letzte Lauf älter als N Minuten ist (Watchdog-
 *      Modus: kein Doppel-Scan, wenn der echte Scheduler längst läuft).
 *   2. scanmarket-Cloud-Run-Service holen, dem SA selbst roles/run.invoker
 *      geben (idempotent) und den Service mit ID-Token per POST aufrufen.
 *   3. Heartbeat erneut prüfen — erst der beweist den erfolgreichen Lauf.
 *
 * Dependency-frei (gcp-lite), damit der Watchdog ohne npm ci auskommt.
 */

import {
  gfetch,
  mintAccessToken,
  mintIdToken,
  projectFromFirebaserc,
  readServiceAccount,
} from './gcp-lite.mjs';

const REGION = 'us-central1';
const SERVICE = 'scanmarket';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readHeartbeat(project) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/meta/health`,
  );
  if (res.status === 404) return null;
  const doc = await res.json();
  if (!doc.fields) return null;
  const flat = Object.fromEntries(
    Object.entries(doc.fields).map(([k, v]) => [k, Object.values(v)[0]]),
  );
  return flat;
}

function heartbeatAgeMin(hb) {
  const ts = hb?.lastRunAt ?? hb?.lastScanAt;
  if (!ts) return Infinity;
  const age = (Date.now() - Date.parse(ts)) / 60_000;
  return Number.isFinite(age) ? age : Infinity;
}

/**
 * Holt den scanmarket-Service und stellt sicher, dass der Deploy-SA selbst
 * roles/run.invoker hat (idempotent). Liefert die Service-URL — auch die
 * Scheduler-Job-Anlage in check-scheduler.mjs nutzt genau diese Funktion.
 */
export async function ensureSelfInvoker({ sa, token, project }) {
  const svcName = `projects/${project}/locations/${REGION}/services/${SERVICE}`;
  const svc = await gfetch(`https://run.googleapis.com/v2/${svcName}`, { token });
  const url = svc.uri;
  if (!url) throw new Error(`Cloud-Run-Service ${SERVICE} hat keine URI`);
  console.log(`Service ${SERVICE}: ${url}`);

  const member = `serviceAccount:${sa.client_email}`;
  const policy = await gfetch(`https://run.googleapis.com/v2/${svcName}:getIamPolicy`, { token });
  const bindings = policy.bindings ?? [];
  let inv = bindings.find((b) => b.role === 'roles/run.invoker');
  if (!inv) {
    inv = { role: 'roles/run.invoker', members: [] };
    bindings.push(inv);
  }
  if (!inv.members?.includes(member)) {
    inv.members = [...(inv.members ?? []), member];
    await gfetch(`https://run.googleapis.com/v2/${svcName}:setIamPolicy`, {
      token,
      method: 'POST',
      body: { policy: { ...policy, bindings } },
    });
    console.log(`Invoker-Grant für ${sa.client_email} gesetzt (IAM braucht ggf. kurz).`);
  } else {
    console.log(`${sa.client_email} ist bereits Invoker.`);
  }
  return url;
}

/** Stößt genau einen Scan an; liefert true, wenn danach ein Heartbeat existiert. */
export async function invokeScanNow({ waitSec = 25 } = {}) {
  const sa = readServiceAccount();
  const project = projectFromFirebaserc();
  const token = await mintAccessToken(sa);
  const url = await ensureSelfInvoker({ sa, token, project });

  const idToken = await mintIdToken(sa, url);
  // Retries: 401/403 = IAM-Propagation (~1 min); 5xx = transienter Cloud-Run-
  // Zustand (Revision-Rollout nach Deploy, Scale-down der letzten Instanz) —
  // beides beobachtet (25.07.), beides heilt in Sekunden. Erst nach 4
  // Fehlversuchen ist der Fehler echt.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      console.log(`✓ Scan-Invoke: HTTP ${res.status}`);
      break;
    }
    const bodyText = (await res.text()).slice(0, 200);
    const retriable = res.status === 401 || res.status === 403 || res.status >= 500;
    if (retriable && attempt < 4) {
      const grund = res.status >= 500 ? 'transient (Rollout/Scale-down)' : 'IAM-Propagation';
      console.log(`  Versuch ${attempt}: HTTP ${res.status} — ${grund}, neuer Versuch …`);
      await sleep(attempt * 15_000);
      continue;
    }
    throw new Error(`Scan-Invoke fehlgeschlagen: HTTP ${res.status} ${bodyText}`);
  }

  await sleep(waitSec * 1000);
  const hb = await readHeartbeat(project);
  if (hb) {
    console.log('✓ Heartbeat meta/health:', JSON.stringify(hb).slice(0, 300));
    return true;
  }
  console.error('✗ meta/health existiert auch nach dem Invoke nicht.');
  return false;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// node scripts-ci/invoke-scan.mjs [--if-stale <minuten>]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--if-stale');
  const staleMin = idx >= 0 ? Number(args[idx + 1]) : null;

  const project = projectFromFirebaserc();
  const hb = await readHeartbeat(project);
  const age = heartbeatAgeMin(hb);
  if (staleMin !== null && age <= staleMin) {
    console.log(`Heartbeat ist ${age.toFixed(1)} min alt (≤ ${staleMin}) — nichts zu tun.`);
    process.exit(0);
  }
  if (hb) console.log(`Heartbeat ist ${age === Infinity ? 'ohne Zeitstempel' : `${age.toFixed(1)} min alt`} — stoße Scan an.`);
  else console.log('Kein Heartbeat vorhanden — stoße Scan an.');

  const ok = await invokeScanNow();
  process.exit(ok ? 0 : 1);
}
