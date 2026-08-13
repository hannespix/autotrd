/**
 * Functions-Zustands-Check: Fragt die GCF-v2-API nach dem ECHTEN Zustand
 * aller Functions und wird rot, wenn eine nicht ACTIVE ist.
 *
 *   node scripts-ci/check-functions-state.mjs
 *
 * Anlass (13.08., Run 31728464674 → 31733591971): Google brach alle Cloud
 * Builds eines Deploys ab (CANCELLED) — der Deploy war rot, aber die
 * Functions trugen danach trotzdem die NEUEN Quell-Hash-Metadaten. Der
 * nächste Deploy verglich Hashes, meldete „Skipped (No changes detected)"
 * für alle 37 Functions und wurde grün — während produktiv weiter der alte
 * Code lief. „Deploy complete!" heißt bei firebase-tools nur „keine Fehler
 * gemeldet", nicht „der Code läuft". Dieser Check fragt deshalb nicht das
 * CLI, sondern die API: Eine Function, deren letzter Rollout scheiterte,
 * steht dort nicht auf ACTIVE.
 *
 * Der Workflow nutzt das als Auslöser der Selbstheilung: Bei Befund ändert
 * eine Stempel-Datei im Functions-Paket den Tarball-Hash, der nächste
 * Deploy kann nichts mehr überspringen und ersetzt die Functions wirklich.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GoogleAuth } from 'google-auth-library';

const REGION = 'us-central1';

/**
 * Pure Bewertung der API-Antwort: alles außer ACTIVE ist kaputt — auch ein
 * fehlender/unbekannter Zustand, denn ein Wert, den wir nicht deuten können,
 * ist kein Beleg dafür, dass der Code läuft.
 */
export function bewerteFunktionsZustaende(fns) {
  const liste = Array.isArray(fns) ? fns : [];
  const kaputt = [];
  for (const f of liste) {
    const name = String(f?.name ?? '').split('/').pop() || '(unbenannt)';
    const state = typeof f?.state === 'string' && f.state !== '' ? f.state : 'UNBEKANNT';
    if (state !== 'ACTIVE') {
      const meldung = (f?.stateMessages ?? [])
        .map((m) => m?.message)
        .filter(Boolean)
        .join(' | ');
      kaputt.push({ name, state, meldung });
    }
  }
  return { gesamt: liste.length, kaputt };
}

const alsSkript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (alsSkript) {
  const project = JSON.parse(readFileSync('.firebaserc', 'utf8')).projects.default;
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();

  const fns = [];
  let pageToken;
  do {
    const url =
      `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/${REGION}` +
      `/functions?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const { data } = await client.request({ url });
    fns.push(...(data.functions ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  if (fns.length === 0) {
    console.error('Keine Functions in der API-Antwort — das ist selbst ein Fehler (falsches Projekt/Region?).');
    process.exit(1);
  }

  // updateTime mit ausgeben: Bei einem stalen Skip zeigt es, WELCHER Deploy
  // die Metadaten zuletzt anfasste — ohne GCP-Konsole lesbar.
  for (const f of fns) {
    const kurz = String(f?.name ?? '').split('/').pop();
    console.log(`  ${f?.state === 'ACTIVE' ? '✓' : '✗'} ${kurz}: state=${f?.state} · updateTime=${f?.updateTime ?? '?'}`);
  }

  const { gesamt, kaputt } = bewerteFunktionsZustaende(fns);
  if (kaputt.length === 0) {
    console.log(`✓ Alle ${gesamt} Functions sind ACTIVE.`);
    process.exit(0);
  }
  for (const k of kaputt) {
    console.error(`✗ ${k.name}: state=${k.state}${k.meldung ? ` — ${k.meldung}` : ''}`);
  }
  console.error(`${kaputt.length} von ${gesamt} Functions nicht ACTIVE — der letzte Rollout hat sie NICHT ersetzt.`);
  process.exit(1);
}
