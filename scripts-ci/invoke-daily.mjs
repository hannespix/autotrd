/**
 * Stößt die TÄGLICHEN Läufe an: snapshotEquity und evalForecasts.
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
 * evalForecasts bewertet nur unbewertete Prognosen und kennt seinen
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
 * Ab wann ein Lauf als endgültig für den Tag gilt: 20:00 UTC liegt nach dem
 * US-Schluss in Sommer- UND Winterzeit (16:00 ET = 20:00/21:00 UTC).
 */
const FINAL_HOUR_UTC = 20;

/**
 * Wurde der Lauf NACH US-Schluss gemacht?
 *
 * Der Unterschied ist wichtig, seit die Läufe auch beim Deploy angestoßen
 * werden: Ein Snapshot um die Mittagszeit ist besser als gar keiner — er
 * füllt die Karte noch heute. Er darf aber den Abend-Lauf nicht verdrängen,
 * sonst stünde in der Equity-Serie dauerhaft ein Mittagswert statt des
 * Schlusskurses, und Sharpe und Drawdown rechneten auf falscher Grundlage.
 * Deshalb sperrt nur ein Lauf nach `FINAL_HOUR_UTC` den Rest des Tages.
 */
export function markerIstEndgueltig(marker) {
  const iso = marker?.at ?? marker?.ts ?? null;
  if (typeof iso !== 'string') return false;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) && d.getUTCHours() >= FINAL_HOUR_UTC;
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
    service: 'momentumrun',
    label: 'Momentum-Ranking + Sockel-Rebalancing',
    // Seit dem Kern-Satelliten (04.08.) ist dieser Lauf nicht mehr nur ein
    // Schattendepot: Er ist der EINZIGE, der den ruhigen Sockel der echten
    // Konten kauft. Solange er nicht lief, ist `engine.corePct` eine
    // Einstellung ohne Wirkung — und das sieht im Dashboard exakt so aus wie
    // ein Sockel, der bewusst in Cash steht. Deshalb gehört er hier dazu.
    //
    // Optional, weil der Cloud Scheduler ihn ohnehin täglich um 18:00 ET
    // fährt: Ein Fehlschlag beim Deploy soll den Deploy nicht rot machen.
    optional: true,
    async spur(project) {
      const doc = await readMeta(project, 'momentum');
      return doc ? { at: doc.at } : null;
    },
  },
  {
    service: 'kibericht',
    label: 'KI-Lagebericht (Tages-Einschätzung)',
    // MUSS nach snapshotequity stehen: Der Bericht liest die
    // Erkenntnis-Chronik, und die entsteht erst in diesem Lauf. Die
    // Reihenfolge dieser Tabelle ist die Ausführungsreihenfolge — auch mit
    // `--only`, weil dort nur gefiltert wird.
    //
    // Optional, weil der Cloud Scheduler ihn ohnehin täglich um 18:25 ET
    // fährt und ein Modell-Anbieter ausfallen kann: Ein Text, der heute
    // fehlt, darf keinen Deploy rot machen. Die eigenen Kosten-Guards
    // (idempotent je Datum, Monatsdeckel) greifen unabhängig davon.
    optional: true,
    async spur(project) {
      const doc = await readMeta(project, 'aiBericht');
      return doc ? { at: doc.at, date: doc.date } : null;
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
    if (!force && tag === today && markerIstEndgueltig(vorher)) {
      log(`• ${run.label}: heute nach US-Schluss bereits gelaufen — übersprungen.`);
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
// node scripts-ci/invoke-daily.mjs [--force] [--only snapshotequity,evalforecasts]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',').filter(Boolean) : null;
  const runs = only ? RUNS.filter((r) => only.includes(r.service)) : RUNS;
  if (only && runs.length === 0) {
    console.log(`::warning::--only ${only.join(',')} passt auf keinen bekannten Lauf.`);
    process.exit(1);
  }
  const { failed } = await runDaily({
    project: projectFromFirebaserc(),
    force: args.includes('--force'),
    runs,
  });
  process.exit(failed > 0 ? 1 : 0);
}
