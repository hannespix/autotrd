/**
 * Browser-Smoke gegen die lokale Emulator-Suite.
 *
 * ── Warum es das gibt ─────────────────────────────────────────────────────
 *
 * Typecheck, Build und die Vitest-Suite prüfen alles außer der einen Frage,
 * die bei UI-Arbeit zählt: Sieht das im Browser so aus, wie es soll? Ein
 * einzelner Zugriff auf ein fehlendes Element reißt das ganze Dashboard mit
 * (weißer Screen) — und das findet keine der anderen Stufen. Der Lauf
 * registriert einen frischen Nutzer, wartet auf die Karten und prüft die
 * Anschlussstellen des Auto-Traders: Engine-Karte, Einstellungen,
 * Symbolauswahl, Champion-Karte, Warum-Karte und den Broker-Reiter.
 *
 * ── Warum NICHT in der CI ─────────────────────────────────────────────────
 *
 * Der Lauf braucht Java, die volle Emulator-Suite und einen Browser —
 * zusammen ein Vielfaches der jetzigen CI-Zeit, für eine Prüfung, die bei
 * reinen Logik-Änderungen nichts findet. Er gehört dorthin, wo UI geändert
 * wird: auf den Rechner, der die Änderung macht.
 *
 * ── Ausführen ─────────────────────────────────────────────────────────────
 *
 *   1. frontend/.env.local anlegen (siehe frontend/.env.example),
 *      VITE_FIREBASE_USE_EMULATORS=1, Dummy-Werte reichen
 *   2. npm run emulators                 (wartet auf „All emulators ready")
 *   3. npm run dev -w frontend           (Port 5173)
 *   4. node frontend/e2e/smoke.mjs
 *
 * Playwright ist bewusst KEINE Abhängigkeit des Projekts — `npm i -D
 * playwright --no-save`, wenn es gebraucht wird. Eine 300-MB-Abhängigkeit
 * für ein Werkzeug, das in der CI nicht läuft, wäre schlechter Tausch.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASIS = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173';
const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-smoke';
/** Chromium-Pfad: in dieser Umgebung vorinstalliert, sonst der von Playwright. */
const CHROME = process.env.SMOKE_CHROME;

mkdirSync(SHOTS, { recursive: true });

const fehler = [];
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const seite = await browser.newPage({ viewport: { width: 1500, height: 950 } });
// Konsolenfehler sind das eigentliche Signal: Ein einzelner Zugriff auf ein
// fehlendes Element reißt das ganze Dashboard mit (weißer Screen).
seite.on('pageerror', (e) => fehler.push(`pageerror: ${e.message}`));
seite.on('console', (m) => {
  if (m.type() === 'error') fehler.push(`console: ${m.text().slice(0, 200)}`);
});

const pruefe = (name, ist, soll) => {
  const ok = typeof soll === 'function' ? soll(ist) : ist === soll;
  console.log(`${ok ? '  ok  ' : '  FEHLER '} ${name}: ${String(ist).slice(0, 80)}`);
  if (!ok) fehler.push(`${name}: ${String(ist)}`);
};
const text = async (selektor) => ((await seite.locator(selektor).textContent().catch(() => '')) ?? '').trim();

await seite.goto(BASIS, { waitUntil: 'networkidle' });
pruefe('Titel', await seite.title(), (t) => t.includes('autotrd'));

// Der Auth-Emulator nimmt jede Adresse an — ein frischer Nutzer je Lauf
// hält die Prüfung unabhängig von Altzuständen.
await seite.fill('#email', `smoke-${Date.now()}@example.invalid`).catch(() => {});
await seite.fill('#password', 'Testpasswort123!').catch(() => {});
await seite.locator('#signupBtn, button:has-text("Registrieren")').first().click().catch(() => {});
await seite.waitForTimeout(4000);
pruefe('Karten nach Login', await seite.locator('.card').count(), (n) => n > 5);
await seite.screenshot({ path: `${SHOTS}/01-dashboard.png` });

// Engine-Karte: Ohne Takt steht dort der erklärende Hinweis, nie ein leerer
// Kasten; der Schalter ist da und im Ruhezustand ausgeschaltet.
pruefe('Engine-Status-Text', await text('#engStatus'), (t) => t.length > 10);
pruefe('Engine-Schalter (Start)', await seite.locator('#engStart').count(), 1);
pruefe('Engine-Badge', await text('#engBadge'), (t) => t.length > 0);
// Kommandos: Halt ist klickbar, Resume ohne Halt gesperrt (Grund im title).
pruefe('Halt klickbar', await seite.locator('#engHalt').isEnabled(), true);
pruefe('Resume ohne Halt gesperrt', await seite.locator('#engResume').isDisabled(), true);

// Einstellungen des Auto-Traders: sieben Felder mit sinnvollen Werten aus
// dem gespeicherten Stand (oder der Ableitung aus dem Alt-Schema).
await seite.locator('#asGrid').scrollIntoViewIfNeeded();
await seite.waitForTimeout(400);
await seite.screenshot({ path: `${SHOTS}/02-einstellungen.png` });
pruefe('Risiko je Trade > 0', await seite.locator('#asRisk').inputValue(), (v) => Number(v) > 0);
pruefe('Positionen ≥ 1', await seite.locator('#asMaxN').inputValue(), (v) => Number(v) >= 1);
pruefe('Symbolauswahl gefüllt', await seite.locator('#asSymbols input[type=checkbox]').count(), (n) => n > 0);
pruefe('Symbolzähler', await text('#asSymCount'), (t) => /\d/.test(t));

// Champion- und Warum-Karte: Ohne meta/champion und ohne Takt zeigen beide
// ein Ergebnis mit Worten — kein leerer Kasten, kein „undefined".
pruefe('Champion-Karte', await text('#chList'), (t) => t.length > 5 && !t.includes('undefined'));
pruefe('Warum-Ampel', await seite.locator('#whyAmpel > *').count(), (n) => n > 0);
pruefe('Warum-Gründe', await text('#whyGate'), (t) => !t.includes('undefined'));
await seite.locator('#whyAmpel').scrollIntoViewIfNeeded();
await seite.waitForTimeout(400);
await seite.screenshot({ path: `${SHOTS}/03-warum-champion.png` });

// Optionen → Broker: Schlüsselfelder und Echtgeld-Schalter sind da; ohne
// Verbindung steht der Status als Text, nicht als Platzhalter.
await seite.locator('#optBtn, [title*="Einstellung"]').first().click().catch(() => {});
await seite.waitForTimeout(1200);
await seite.locator('.otab[data-otab="broker"]').click();
await seite.waitForTimeout(1500);
await seite.locator('#bkKey').scrollIntoViewIfNeeded();
await seite.screenshot({ path: `${SHOTS}/04-broker.png` });
pruefe('Schlüsselfeld', await seite.locator('#bkKey').count(), 1);
pruefe('Echtgeld-Schalter', await seite.locator('#lvOn').count(), 1);
pruefe('Broker-Status-Text', await text('#bkOut'), (t) => t.length > 5);
await seite.keyboard.press('Escape');
await seite.waitForTimeout(400);

console.log(`\nJS-Fehler und Abweichungen: ${fehler.length}`);
for (const f of fehler) console.log('  ', f);
console.log(`Screenshots: ${SHOTS}`);
await browser.close();
process.exit(fehler.length === 0 ? 0 : 1);
