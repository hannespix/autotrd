/**
 * Browser-Smoke gegen die lokale Emulator-Suite.
 *
 * ── Warum es das gibt ─────────────────────────────────────────────────────
 *
 * Typecheck, Build und die Vitest-Suite prüfen alles außer der einen Frage,
 * die bei UI-Arbeit zählt: Sieht das im Browser so aus, wie es soll? In
 * zwei PRs hintereinander musste die Antwort „nur kompiliert geprüft"
 * lauten — und beim ersten echten Durchlauf fiel sofort ein Layoutfehler
 * auf, den keine der anderen Stufen hätte finden können: `.opt-grid label`
 * setzt `flex-direction: column`, ein Inline-`display:flex` überschreibt
 * nur `display`. Die `flex-basis`-Angaben wirkten dadurch auf die HÖHE, und
 * aus zehn kompakten Regler-Zeilen wurden zehn 120 px hohe Blöcke.
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

await seite.locator('#optBtn, [title*="Einstellung"]').first().click().catch(() => {});
await seite.waitForTimeout(1200);

// Kapital-Regler je Anlageklasse (MG2)
await seite.locator('#owClsRows').scrollIntoViewIfNeeded();
await seite.waitForTimeout(400);
await seite.screenshot({ path: `${SHOTS}/02-klassenregler.png` });
pruefe('Schieberegler', await seite.locator('#owClsRows input[type=range]').count(), (n) => n >= 8);
// Höhe einer Zeile: der Layoutfehler von 04.08. machte daraus ~120 px.
const zeilenHoehe = await seite
  .locator('#owClsRows label')
  .first()
  .evaluate((el) => el.getBoundingClientRect().height);
pruefe('Zeilenhöhe kompakt', Math.round(zeilenHoehe), (h) => h > 0 && h < 60);

await seite
  .locator('#owClsRows input[type=range]')
  .first()
  .evaluate((el) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
await seite.waitForTimeout(300);
pruefe('Anzeige bei 0', await seite.locator('#owClsRows [data-clsval]').first().textContent(), 'aus');

// Tages-Notbremse (M12)
await seite.locator('#bkrState').scrollIntoViewIfNeeded();
await seite.waitForTimeout(400);
await seite.screenshot({ path: `${SHOTS}/03-notbremse.png` });
pruefe('Notbremse-Text', (await seite.locator('#bkrState').textContent())?.trim(), (t) =>
  t.includes('Grenze'),
);
pruefe('Grenze voreingestellt', await seite.locator('#owBreak').inputValue(), (v) => Number(v) > 0);

// Abgleich Buch ↔ Broker-Depot (M13): Ohne verbundenen Broker muss dort die
// erklärende Zeile stehen — nicht der Platzhalter „—", der nichts aussagt.
await seite.locator('#bkAuto').scrollIntoViewIfNeeded();
await seite.waitForTimeout(400);
await seite.screenshot({ path: `${SHOTS}/04-abgleich.png` });
pruefe('Abgleich-Zeile', (await seite.locator('#bkAuto').textContent())?.trim(), (t) =>
  t.includes('automatischer Abgleich'),
);

console.log(`\nJS-Fehler und Abweichungen: ${fehler.length}`);
for (const f of fehler) console.log('  ', f);
console.log(`Screenshots: ${SHOTS}`);
await browser.close();
process.exit(fehler.length === 0 ? 0 : 1);
