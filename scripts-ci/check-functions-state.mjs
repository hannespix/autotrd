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
 *
 * ── Zweite Prüfung: Frische der dienenden Revision ────────────────────────
 *
 * ACTIVE allein reicht nicht (Beleg 19:30-Lauf, Run 31736108192): GCF rollt
 * nach einem abgebrochenen Build auf ACTIVE mit der ALTEN Revision zurück,
 * stempelt aber updateTime und Quell-Metadaten der neuen Quelle — alle 37
 * Functions standen ACTIVE mit updateTime 18:10–18:22 (den Endzeiten der
 * abgebrochenen Builds), während die dienende Cloud-Run-Revision von 17:44
 * stammte. Bei einem GESUNDEN Update entsteht die Revision am ENDE des
 * Builds, Sekunden vor dem updateTime-Stempel. Liegt updateTime deutlich
 * NACH der Revisions-Erzeugung, hat der letzte Update-Versuch nie Code
 * ausgerollt — genau der stale Zustand, den der Hash-Skip danach für
 * „aktuell" hält.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GoogleAuth } from 'google-auth-library';

const REGION = 'us-central1';

/**
 * Wie weit updateTime der Revisions-Erzeugung nacheilen darf. Bei Erfolg
 * sind es Sekunden (Revision fertig → Operation schließt ab); die 10 Minuten
 * decken auch zähe Rollouts. Der Schadensfall lag bei ~37 Minuten.
 */
export const FRISCHE_TOLERANZ_MS = 10 * 60 * 1000;

/**
 * Pure Frische-Entscheidung: Ist der letzte Update-Stempel deutlich jünger
 * als die dienende Revision, hat der Versuch keinen Code ausgerollt.
 * Unlesbare Zeiten sind KEIN Befund (sonst würde ein API-Formatwechsel
 * flächendeckend heilen lassen) — sie werden getrennt gemeldet.
 */
export function istVeraltet(updateTime, revisionCreateTime, toleranzMs = FRISCHE_TOLERANZ_MS) {
  const u = Date.parse(updateTime ?? '');
  const r = Date.parse(revisionCreateTime ?? '');
  if (!Number.isFinite(u) || !Number.isFinite(r)) return null;
  return u - r > toleranzMs;
}

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

  // Frische je Function: createTime der dienenden Cloud-Run-Revision holen
  // (serviceConfig.service + .revision stehen am Function-Objekt). Die
  // Deploy-SA hat run.admin (Beleg: set-public-invoker setzt IAM-Policies).
  const veraltet = [];
  let unpruefbar = 0;
  for (const f of fns) {
    const kurz = String(f?.name ?? '').split('/').pop();
    const dienst = f?.serviceConfig?.service;
    const revision = f?.serviceConfig?.revision;
    let revZeit = null;
    if (dienst && revision) {
      try {
        const { data } = await client.request({
          url: `https://run.googleapis.com/v2/${dienst}/revisions/${revision}`,
        });
        revZeit = data?.createTime ?? null;
      } catch {
        revZeit = null;
      }
    }
    const stale = istVeraltet(f?.updateTime, revZeit);
    if (stale === null) unpruefbar += 1;
    else if (stale) veraltet.push({ name: kurz, updateTime: f?.updateTime, revZeit });
    console.log(
      `  ${f?.state === 'ACTIVE' && stale !== true ? '✓' : '✗'} ${kurz}: state=${f?.state}`
        + ` · updateTime=${f?.updateTime ?? '?'} · revision=${revZeit ?? 'unpruefbar'}`,
    );
  }

  const { gesamt, kaputt } = bewerteFunktionsZustaende(fns);
  if (unpruefbar === gesamt) {
    // Kein einziger Revisions-Blick möglich — das ist ein Rechte-/API-Problem
    // und macht die Frische-Garantie wertlos. Rot, aber NICHT „veraltet":
    // Eine Heilung auf blinden Augen würde bei jedem Lauf neu deployen.
    console.error('Frische unprüfbar: keine einzige Revisions-Erzeugungszeit lesbar (Rechte/API?).');
    process.exit(1);
  }
  if (kaputt.length === 0 && veraltet.length === 0) {
    console.log(`✓ Alle ${gesamt} Functions sind ACTIVE und ihre Revisionen frisch.`
      + (unpruefbar > 0 ? ` (${unpruefbar} ohne prüfbare Revisionszeit)` : ''));
    process.exit(0);
  }
  for (const k of kaputt) {
    console.error(`✗ ${k.name}: state=${k.state}${k.meldung ? ` — ${k.meldung}` : ''}`);
  }
  for (const v of veraltet) {
    console.error(
      `✗ ${v.name}: VERALTET — letzter Update-Versuch ${v.updateTime} rollte keinen Code aus `
        + `(dienende Revision von ${v.revZeit}).`,
    );
  }
  console.error(
    `${kaputt.length + veraltet.length} von ${gesamt} Functions kaputt oder veraltet — `
      + 'der letzte Rollout hat sie NICHT ersetzt.',
  );
  process.exit(1);
}
