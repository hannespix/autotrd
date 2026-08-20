/**
 * Smoke gegen das GEBAUTE Bundle — die Schicht, die live läuft.
 *
 * Alle anderen Prüfstände (smoke, chart:shot, ui-audit) fahren gegen den
 * Vite-Dev-Server, also unbundeltes ESM. Das Rollup-Bundle wurde vor dem
 * Live-Vorfall 20.08. nie im Browser ausgeführt — ein Bundle-only-Fehler
 * (z. B. Import-Umordnung) wäre erst in fremden Browsern aufgefallen.
 *
 * Ablauf: erwartet ein frisches `npm run build -w frontend` (dist/ mit der
 * .env.local-Emulator-Konfiguration), startet `vite preview` auf :4173 und
 * lässt den normalen smoke.mjs mit SMOKE_URL dagegen laufen — gleiche
 * Prüfungen, andere Auslieferung. Emulator-Suite muss laufen (wie beim
 * Dev-Smoke).
 */
import { spawn } from 'node:child_process';
import { setTimeout as warte } from 'node:timers/promises';

const PORT = 4173;
const BASIS = `http://127.0.0.1:${PORT}`;

/* detached + Gruppen-Kill: `npx` startet vite als Kind — nur den Wrapper zu
 * beenden ließe einen Waisen-Server auf dem Port zurück (beim ersten Lauf
 * passiert), und der nächste strictPort-Start schlüge fehl. */
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: 'frontend',
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
server.stderr.on('data', (d) => process.stderr.write(d));

const beenden = (code) => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* Gruppe schon weg */
  }
  process.exit(code);
};
process.on('SIGINT', () => beenden(130));

// Warten, bis der Preview-Server antwortet (max. ~20 s).
let bereit = false;
for (let i = 0; i < 40 && !bereit; i++) {
  await warte(500);
  bereit = await globalThis
    .fetch(BASIS)
    .then((r) => r.ok)
    .catch(() => false);
}
if (!bereit) {
  console.error(`preview-smoke: ${BASIS} antwortet nicht — dist/ gebaut? (npm run build -w frontend)`);
  beenden(1);
}

const smoke = spawn('node', ['frontend/e2e/smoke.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, SMOKE_URL: BASIS, SMOKE_SHOTS: process.env.SMOKE_SHOTS ?? '/tmp/autotrd-preview-smoke' },
});
smoke.on('exit', (code) => beenden(code ?? 1));
