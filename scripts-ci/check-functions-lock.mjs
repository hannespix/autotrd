/**
 * Guard: `functions/package.json` und `functions/package-lock.json` müssen
 * synchron sein.
 *
 * ── Der Fehler, den das verhindert (Deploy für b8c9fa2, 08.08.) ───────────
 *
 * `functions/` ist Workspace-Mitglied UND hat seit dem 31.07. ein EIGENES
 * Lockfile: firebase-tools paketiert nur den `functions/`-Ordner, und der
 * Cloud-Build macht dort `npm ci` statt einer Neuauflösung (Begründung im
 * Commit f51e0ff — eine frische Auflösung hatte damals `@firebase/app`
 * verloren und die Produktion auf der alten Revision stehen lassen).
 *
 * Genau diese Doppelrolle ist die Falle: Ein `npm install --workspace
 * functions` schreibt das ROOT-Lockfile und fasst das von `functions/` nicht
 * an. Lokal fällt das nie auf — Tests, Lint, Typecheck und `npm ci` auf dem
 * Runner benutzen alle das Root-Lockfile und sind grün. Erst der Cloud-Build
 * bricht ab, und zwar für ALLE Functions gleichzeitig:
 *
 *   npm error `npm ci` can only install packages when your package.json and
 *   package-lock.json … are in sync.
 *   npm error Missing: @anthropic-ai/sdk@0.116.0 from lock file
 *
 * Ein grüner CI-Lauf, dem ein roter Deploy folgt, ist die teuerste Sorte
 * Fehler: Er wird erst nach dem Merge sichtbar. Deshalb prüft das hier VOR
 * dem Merge — netzfrei und in Millisekunden.
 *
 * ── Wie das Lockfile korrekt erneuert wird ────────────────────────────────
 *
 * NICHT `npm install --workspace functions` (schreibt das Root-Lockfile) und
 * auch nicht `npm install` in `functions/` (npm erkennt den Workspace-Root
 * und lässt das lokale Lockfile unverändert). Sondern isoliert, außerhalb des
 * Workspace-Baums:
 *
 *   mkdir /tmp/fnlock && cp functions/package.json /tmp/fnlock/
 *   cd /tmp/fnlock && npm install --package-lock-only
 *   cp /tmp/fnlock/package-lock.json functions/package-lock.json
 */

import { readFileSync } from 'node:fs';

const pj = JSON.parse(readFileSync('functions/package.json', 'utf8'));
const lock = JSON.parse(readFileSync('functions/package-lock.json', 'utf8'));

const deps = pj.dependencies ?? {};
const wurzel = lock.packages?.['']?.dependencies ?? {};
const fehler = [];

for (const [name, version] of Object.entries(deps)) {
  // 1. Steht die Abhängigkeit überhaupt in der Wurzel des Lockfiles?
  if (wurzel[name] === undefined) {
    fehler.push(`${name}: fehlt in der Wurzel von functions/package-lock.json`);
    continue;
  }
  if (wurzel[name] !== version) {
    fehler.push(`${name}: package.json will ${version}, Lockfile-Wurzel nennt ${wurzel[name]}`);
  }
  // 2. Ist sie auch AUFGELÖST? Ohne diesen Eintrag hat `npm ci` nichts zu
  //    installieren — genau der Zustand, der den Cloud-Build gekippt hat.
  const aufgeloest = lock.packages?.[`node_modules/${name}`];
  if (aufgeloest === undefined) {
    fehler.push(`${name}: kein aufgelöster Eintrag node_modules/${name} im Lockfile`);
  } else if (typeof version === 'string' && /^\d/.test(version) && aufgeloest.version !== version) {
    // Nur bei exakt gepinnten Versionen vergleichbar — Caret-Bereiche dürfen
    // abweichen, das ist ihr Zweck.
    fehler.push(`${name}: gepinnt auf ${version}, Lockfile hat ${aufgeloest.version}`);
  }
}

// Umgekehrte Richtung: eine entfernte Abhängigkeit, die im Lockfile
// stehen bleibt, lässt `npm ci` ebenfalls scheitern.
for (const name of Object.keys(wurzel)) {
  if (deps[name] === undefined) {
    fehler.push(`${name}: steht im Lockfile, aber nicht mehr in functions/package.json`);
  }
}

if (fehler.length > 0) {
  console.error('functions/package-lock.json ist NICHT synchron zu functions/package.json:\n');
  for (const f of fehler) console.error(`  · ${f}`);
  console.error(
    '\nDer Cloud-Build würde mit „npm ci can only install packages when your' +
      '\npackage.json and package-lock.json are in sync" abbrechen — und zwar' +
      '\nfür ALLE Functions gleichzeitig.' +
      '\n\nSo wird das Lockfile korrekt erneuert (isoliert, außerhalb des Workspace):' +
      '\n  mkdir -p /tmp/fnlock && cp functions/package.json /tmp/fnlock/' +
      '\n  (cd /tmp/fnlock && npm install --package-lock-only)' +
      '\n  cp /tmp/fnlock/package-lock.json functions/package-lock.json',
  );
  process.exit(1);
}

console.log(
  `functions-Lockfile synchron: ${Object.keys(deps).length} Abhängigkeit(en) geprüft, ` +
    `${Object.keys(lock.packages ?? {}).length} Pakete aufgelöst.`,
);
