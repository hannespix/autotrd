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
 * keine Bedingung. Fehlt die Berechtigung oder der Service-Account, wird
 * das gemeldet und mit Erfolg beendet.
 *
 * Aufruf: node scripts-ci/check-secret.mjs ANTHROPIC_API_KEY [WEITERES…]
 */

import { gfetch, mintAccessToken, projectFromFirebaserc, readServiceAccount } from './gcp-lite.mjs';

const namen = process.argv.slice(2);
if (namen.length === 0) {
  console.log('Kein Secret-Name übergeben — nichts zu prüfen.');
  process.exit(0);
}

// readServiceAccount WIRFT, wenn GOOGLE_APPLICATION_CREDENTIALS fehlt — es
// gibt kein `null` zurück. Ohne dieses try/catch stürbe der Schritt lokal und
// in jedem Lauf ohne Anmeldedaten mit Stacktrace, statt eine Zeile zu melden.
let sa;
try {
  sa = readServiceAccount();
} catch (err) {
  console.log(`Kein Service-Account verfügbar (${err.message}) — Secret-Diagnose übersprungen.`);
  process.exit(0);
}

const projekt = projectFromFirebaserc();
let token;
try {
  token = await mintAccessToken(sa);
} catch (err) {
  console.log(`Token nicht erhältlich (${err.message}) — Secret-Diagnose übersprungen.`);
  process.exit(0);
}

const basis = `https://secretmanager.googleapis.com/v1/projects/${projekt}/secrets`;

for (const name of namen) {
  try {
    const meta = await gfetch(`${basis}/${name}`, { token });
    if (meta.status === 404) {
      console.log(`::notice::Secret ${name}: EXISTIERT NICHT.`);
      continue;
    }
    if (meta.status === 403) {
      console.log(
        `::warning::Secret ${name}: keine Leseberechtigung (403). ` +
          `Dem Deploy-Service-Account fehlt roles/secretmanager.viewer.`,
      );
      continue;
    }
    if (meta.status !== 200) {
      console.log(`::warning::Secret ${name}: unerwartete Antwort HTTP ${meta.status}.`);
      continue;
    }

    // Existieren reicht nicht — ein Secret ohne aktivierte Version ist beim
    // Binden genauso wertlos wie keines.
    const vers = await gfetch(`${basis}/${name}/versions?filter=state:ENABLED`, { token });
    const anzahl = Array.isArray(vers.data?.versions) ? vers.data.versions.length : 0;
    const erstellt = meta.data?.createTime ?? '?';
    console.log(
      anzahl > 0
        ? `::notice::Secret ${name}: VORHANDEN mit ${anzahl} aktiven Version(en), angelegt ${erstellt}. Bereit zum Binden.`
        : `::warning::Secret ${name}: existiert (angelegt ${erstellt}), hat aber KEINE aktive Version — Binden würde zur Laufzeit ins Leere greifen.`,
    );
  } catch (err) {
    console.log(`::warning::Secret ${name}: Prüfung fehlgeschlagen — ${err.message}`);
  }
}
