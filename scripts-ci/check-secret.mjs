/**
 * Diagnose: Existiert ein Secret im Secret Manager — und hat es eine
 * benutzbare Version?
 *
 * ── Warum das eine eigene Prüfung braucht ─────────────────────────────────
 *
 * Ein Secret an eine Function zu binden (`secrets: ['NAME']`) ist eine
 * Einbahnstraße: Existiert es nicht, bricht `firebase deploy` mit „Secret
 * does not exist" ab — und zwar nicht nur für die betroffene Function,
 * sondern für den ganzen Lauf. Genau diese Fehlerklasse hat am 08.08. den
 * Deploy für alle 31 Functions gekippt (aus anderem Grund, gleiche Wirkung).
 *
 * Deshalb wird hier ERST gemessen und dann gebunden. Die Prüfung liest
 * ausschließlich METADATEN (`GET .../secrets/NAME` und die Versionsliste) —
 * der Secret-WERT wird nie abgerufen und kann folglich auch nicht im Log
 * landen. Das ist der Unterschied zwischen `secrets.get` und
 * `secrets.versions.access`, und er ist hier Absicht.
 *
 * Der Schritt ist bewusst NIE rot: Er beantwortet eine Frage, er stellt
 * keine Bedingung.
 *
 * ── Die Aufruf-Konvention von gfetch (erster Anlauf lag hier falsch) ──────
 *
 * `gfetch` gibt bei Erfolg DIREKT die Daten zurück — es gibt kein
 * `.status`-Feld — und WIRFT bei jedem Nicht-2xx, mit `err.status`. Der
 * erste Entwurf hat auf `meta.status === 404` geprüft; das ist bei Erfolg
 * `undefined` und im Fehlerfall unerreichbar, weil der Wurf vorher greift.
 * Ergebnis war eine nutzlose Meldung („unerwartete Antwort HTTP undefined")
 * für ein Secret, das in Wahrheit existierte. Deshalb hier: Erfolg heißt
 * vorhanden, und die Unterscheidung 404/403/sonstiges passiert im catch.
 *
 * Aufruf: node scripts-ci/check-secret.mjs ANTHROPIC_API_KEY [WEITERES…]
 */

import { gfetch, mintAccessToken, projectFromFirebaserc, readServiceAccount } from './gcp-lite.mjs';

/**
 * Ein Secret prüfen — die reine Auswertungslogik, vom Netz getrennt.
 *
 * `hole` bildet die gfetch-Konvention ab (Erfolg → Daten, Fehler → Wurf mit
 * `.status`). Als Parameter statt als Import, damit alle Zweige ohne
 * Anmeldedaten und ohne Netz prüfbar sind — die Unterscheidung
 * „existiert / existiert nicht / keine aktive Version / kein Zugriff" ist
 * genau das, worauf später eine Deploy-Entscheidung aufsetzt.
 */
export async function pruefeSecret(name, basis, hole) {
  let meta;
  try {
    meta = await hole(`${basis}/${name}`);
  } catch (err) {
    if (err.status === 404) return { name, stand: 'fehlt', text: 'EXISTIERT NICHT.' };
    if (err.status === 403) {
      return {
        name,
        stand: 'kein_zugriff',
        text: 'keine Leseberechtigung (403) — dem Deploy-Service-Account fehlt roles/secretmanager.viewer.',
      };
    }
    return { name, stand: 'fehler', text: `Prüfung fehlgeschlagen — ${err.message}` };
  }

  // Existieren reicht nicht — ein Secret ohne aktivierte Version ist beim
  // Binden genauso wertlos wie keines, sieht im „existiert"-Check aber gleich aus.
  const erstellt = meta?.createTime ?? '?';
  let aktive;
  try {
    const vers = await hole(`${basis}/${name}/versions?filter=state:ENABLED`);
    aktive = Array.isArray(vers?.versions) ? vers.versions.length : 0;
  } catch (err) {
    return {
      name,
      stand: 'vorhanden_version_unklar',
      text: `VORHANDEN (angelegt ${erstellt}), Versionsliste nicht lesbar — ${err.message}`,
    };
  }

  return aktive > 0
    ? {
        name,
        stand: 'bereit',
        text: `VORHANDEN mit ${aktive} aktiven Version(en), angelegt ${erstellt}. Bereit zum Binden.`,
      }
    : {
        name,
        stand: 'ohne_version',
        text: `existiert (angelegt ${erstellt}), hat aber KEINE aktive Version — Binden würde zur Laufzeit ins Leere greifen.`,
      };
}

/** Meldungsart je Ausgang: „bereit" und „fehlt" sind Befunde, kein Alarm. */
const ART = {
  bereit: 'notice',
  fehlt: 'notice',
  ohne_version: 'warning',
  kein_zugriff: 'warning',
  vorhanden_version_unklar: 'warning',
  fehler: 'warning',
};

// Ab hier nur noch IO — beim Import (Test) wird nichts davon ausgeführt.
if (import.meta.url === `file://${process.argv[1]}`) {
  const namen = process.argv.slice(2);
  if (namen.length === 0) {
    console.log('Kein Secret-Name übergeben — nichts zu prüfen.');
    process.exit(0);
  }

  // readServiceAccount WIRFT, wenn GOOGLE_APPLICATION_CREDENTIALS fehlt — es
  // gibt kein `null` zurück. Ohne dieses try/catch stürbe der Schritt lokal
  // und in jedem Lauf ohne Anmeldedaten mit Stacktrace.
  let sa;
  try {
    sa = readServiceAccount();
  } catch (err) {
    console.log(`Kein Service-Account verfügbar (${err.message}) — Secret-Diagnose übersprungen.`);
    process.exit(0);
  }

  let token;
  try {
    token = await mintAccessToken(sa);
  } catch (err) {
    console.log(`Token nicht erhältlich (${err.message}) — Secret-Diagnose übersprungen.`);
    process.exit(0);
  }

  const projekt = projectFromFirebaserc();
  const basis = `https://secretmanager.googleapis.com/v1/projects/${projekt}/secrets`;
  const hole = (url) => gfetch(url, { token });

  for (const name of namen) {
    const r = await pruefeSecret(name, basis, hole);
    console.log(`::${ART[r.stand] ?? 'warning'}::Secret ${r.name}: ${r.text}`);
  }
}
