/**
 * Stößt die TÄGLICHEN Läufe an: snapshotEquity, evalForecasts, tunerReview.
 *
 * Warum es dieses Skript überhaupt gibt (Diagnose 27.07.):
 * Der Owner meldete, dass Performance-Kurve, Prognose-Genauigkeit und
 * Prognose-Labor dauerhaft leer bleiben. Die Prüfung der Live-Daten zeigte
 * die gemeinsame Ursache — es existiert im Projekt KEIN einziger
 * Cloud-Scheduler-Job, weil dem Deploy-Service-Account die Rolle fehlt
 * ("Deploy-SA hat KEINE Cloud-Scheduler-Berechtigung" im Deploy-Log). Der
 * 5-Minuten-Scan hing schon vorher am Watchdog; die drei täglichen Läufe
 * hatten gar keinen Ersatzweg und liefen deshalb nie. Beweis in den Daten:
 * meta/forecastStats fehlte, obwohl evaluateDue() das Dokument bedingungslos
 * schreibt — die Funktion war schlicht nie aufgerufen worden.
 *
 * Dieses Skript geht denselben Weg wie der echte Cloud Scheduler (HTTP-POST
 * mit OIDC-Token gegen den Cloud-Run-Service) und braucht nur die Rollen, die
 * der Deploy-SA sicher hat. Sobald der Owner die Scheduler-Rolle vergibt oder
 * die Supabase-Migration übernimmt, wird es überflüssig — das Tages-Gate
 * unten sorgt dafür, dass es dann von selbst zum No-Op wird.
 *
 * Jeder Lauf ist idempotent: snapshotEquity schreibt auf die Datums-Doc-ID,
 * evalForecasts bewertet nur unbewertete Prognosen, tunerReview kennt seinen
 * pendingBatchId. Ein Doppelaufruf am selben Tag schadet also nicht — das
 * Gate spart trotzdem Laufzeit und macht das Actions-Log lesbar.
 *
 * Aufruf: node scripts-ci/invoke-daily.mjs [--force]
 * Exit 1, wenn ein angestoßener Lauf danach KEINE frische Spur hinterlässt.
 */

import { projectFromFirebaserc } from './gcp-lite.mjs';
import { invokeService } from './invoke-scan.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Firestore-REST-Werte in normales JS auspacken (auch verschachtelte Maps). */
export function unwrap(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) {
    return Object.fromEntries(
      Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, unwrap(x)]),
    );
  }
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(unwrap);
  const raw = Object.values(v)[0];
  if ('integerValue' in v || 'doubleValue' in v) return Number(raw);
  if ('booleanValue' in v) return Boolean(raw);
  return raw;
}

/** meta/{docId} öffentlich lesen (meta ist per Rules ohne Anmeldung lesbar). */
export async function readMeta(project, docId) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/meta/${docId}`,
  );
  if (!res.ok) return null;
  const doc = await res.json();
  if (!doc.fields) return null;
  return Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, unwrap(v)]));
}

const today = new Date().toISOString().slice(0, 10);

/** Datumsanteil eines ISO-Zeitstempels — egal ob als `at`, `ts` oder `date`. */
export function markerDay(marker) {
  if (!marker) return null;
  const iso = marker.date ?? marker.at ?? marker.ts ?? null;
  return typeof iso === 'string' ? iso.slice(0, 10) : null;
}

/**
 * Die drei Läufe. `spur` liest den Nachweis, den die Funktion selbst
 * hinterlässt — nicht den HTTP-Status. Ein 200 beweist nur, dass der
 * Container antwortete; erst die frische Spur beweist, dass er gearbeitet hat.
 */
export const RUNS = [
  {
    service: 'snapshotequity',
    label: 'Equity-Snapshot (Performance-Kurve)',
    async spur(project) {
      return (await readMeta(project, 'health'))?.equitySnapshot ?? null;
    },
  },
  {
    service: 'evalforecasts',
    label: 'Prognose-Bewertung (Genauigkeit + Labor)',
    async spur(project) {
      return (await readMeta(project, 'health'))?.forecastEval ?? null;
    },
  },
  {
    service: 'tunerreview',
    // Optional: Der Tuner hängt am Anthropic-Batch-API. Wartet ein Batch vom
    // Vortag noch auf sein Ergebnis, kehrt der Lauf bewusst ohne neue Spur
    // zurück — das ist korrektes Verhalten, kein Ausfall, und darf den
    // Watchdog deshalb nicht rot färben. Das empirische Tuning läuft ohnehin
    // unabhängig von der KI weiter.
    optional: true,
    label: 'KI-Tuner-Review',
    async spur(project) {
      return await readMeta(project, 'tuner');
    },
  },
];

/**
 * Führt die Läufe aus. `invoke` und `wait` sind injizierbar, damit der Test
 * die Ablauflogik prüfen kann, ohne echte Cloud-Run-Dienste anzufassen —
 * genau die Logik (Tages-Gate, optionaler Lauf, Nachweis statt HTTP-Status)
 * entscheidet, ob der Owner morgen Zahlen sieht.
 */
export async function runDaily({
  project,
  force = false,
  runs = RUNS,
  invoke = invokeService,
  wait = sleep,
  log = console.log,
} = {}) {
  let failed = 0;
  let ran = 0;
  let skipped = 0;

  for (const run of runs) {
    const vorher = await run.spur(project);
    const tag = markerDay(vorher);
    if (!force && tag === today) {
      log(`• ${run.label}: heute (${tag}) bereits gelaufen — übersprungen.`);
      skipped += 1;
      continue;
    }
    log(`• ${run.label}: letzte Spur ${tag ?? 'keine'} — stoße ${run.service} an …`);
    try {
      await invoke(run.service);
    } catch (err) {
      log(`::warning::${run.label} — Invoke fehlgeschlagen: ${err.message}`);
      if (!run.optional) failed += 1;
      continue;
    }
    ran += 1;

    // Der Schreibvorgang landet asynchron in Firestore; zweimal nachsehen
    // reicht erfahrungsgemäß und hält den Lauf kurz.
    let nachher = null;
    for (const sec of [8, 20]) {
      await wait(sec * 1000);
      nachher = await run.spur(project);
      if (markerDay(nachher) === today) break;
    }
    if (markerDay(nachher) === today) {
      log(`  ✓ ${run.label}: ${JSON.stringify(nachher).slice(0, 220)}`);
    } else {
      log(
        `::warning::${run.label} — Invoke war HTTP-2xx, aber keine frische Spur ` +
          `(zuletzt ${markerDay(nachher) ?? 'keine'}). Siehe Cloud Logging.`,
      );
      if (!run.optional) failed += 1;
    }
  }

  log(`\nErgebnis: ${ran} angestoßen, ${skipped} übersprungen, ${failed} ohne Nachweis.`);
  return { ran, skipped, failed };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { failed } = await runDaily({
    project: projectFromFirebaserc(),
    force: process.argv.includes('--force'),
  });
  process.exit(failed > 0 ? 1 : 0);
}
