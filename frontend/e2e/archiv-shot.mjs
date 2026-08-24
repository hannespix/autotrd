/**
 * Nachweis für den Archiv-Zustand (24.08.) — misst, nicht meint (§6):
 *  1. Archivierte Zeilen sind standardmäßig NICHT sichtbar.
 *  2. Der Archiv-Schalter zeigt die Zahl (2).
 *  3. Haken gesetzt ⇒ die zwei Zeilen erscheinen, mit Badge und
 *     „Zurückholen"-Knopf (einstufig, grün).
 *  4. Eine freigeschaltete Zeile trägt den armierten „Archivieren"-Knopf.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await p.fill('#email', 'warum@autotrd.test');
await p.fill('#password', 'test1234');
await p.keyboard.press('Enter');
await p.waitForTimeout(9000);
for (let i = 0; i < 8; i++) {
  const x = await p.$('button:has-text("FERTIG"), button:has-text("WEITER"), .tour-close, [aria-label="Schließen"]');
  if (!x) break; await x.click().catch(() => {}); await p.waitForTimeout(300);
}
await p.click('#admReload');
await p.waitForTimeout(4000);

const sichtbar = async () => p.$$eval('.adm-k:not([hidden])', (ks) => ks.map((k) => k.dataset.mail));
const vor = await sichtbar();
const archivVor = vor.filter((m) => m.includes('ablage'));
console.log('sichtbar ohne Haken:', vor.length, '| davon ablage*:', archivVor.length);

const label = await p.$('.adm-archiv:not([hidden])');
const zahl = await p.$eval('#admArchivZahl', (e) => e.textContent);
console.log('Archiv-Schalter sichtbar:', !!label, '| Zahl:', JSON.stringify(zahl));

await p.check('#admArchiv');
await p.waitForTimeout(400);
const nach = await sichtbar();
const archivNach = nach.filter((m) => m.includes('ablage'));
console.log('sichtbar mit Haken:', nach.length, '| davon ablage*:', archivNach.length);

// Badge + Knopf an einer archivierten Zeile
const zeile = await p.$('.adm-k[data-stufe="archiviert"]:not([hidden])');
const badge = zeile ? await zeile.$eval('.adm-meta', (e) => e.textContent).catch(() => null) : null;
const knopf = zeile ? await zeile.evaluate((k) => {
  const s = k.querySelector('.adm-strip');
  return s ? [...s.querySelectorAll('button')].map((b2) => b2.textContent?.trim()) : [];
}) : [];
// Streifen der Zeile aufklappen (⋯), dann Knöpfe lesen
if (zeile && (!knopf || knopf.length === 0)) {
  const dots = await zeile.$('button.adm-mehr, .adm-dots, button:has-text("⋯")');
  if (dots) { await dots.click(); await p.waitForTimeout(300); }
}
const knopf2 = zeile ? await zeile.evaluate((k) => [...k.querySelectorAll('button')].map((b2) => b2.textContent?.trim()).filter(Boolean)) : [];
console.log('archivierte Zeile — Badge:', JSON.stringify(badge), '| Knöpfe:', JSON.stringify(knopf2));

// Badge sauber: ALLE adm-meta der archivierten Zeile, nicht das erste.
const metas = zeile ? await zeile.$$eval('.adm-meta', (es) => es.map((e) => e.textContent)) : [];
console.log('archivierte Zeile — alle Metas:', JSON.stringify(metas));

/* Der Archivieren-Knopf sitzt BEWUSST nur an wartenden/gesperrten Zeilen:
 * Ein aktives Konto legt man nicht direkt ab — erst sperren, dann
 * archivieren. Der Zustandsweg ist approved → blocked → archiviert. */
const knoepfe = async (sel) => {
  const z = await p.$(sel);
  if (!z) return null;
  const dots = await z.$('button.adm-mehr, .adm-dots, button:has-text("⋯")');
  if (dots) { await dots.click(); await p.waitForTimeout(300); }
  return z.evaluate((k) => [...k.querySelectorAll('button')].map((b2) => b2.textContent?.trim()).filter(Boolean));
};
console.log('freie Zeile — Knöpfe:', JSON.stringify(await knoepfe('.adm-k[data-stufe="approved"]:not([hidden])')));
console.log('gesperrte Zeile — Knöpfe:', JSON.stringify(await knoepfe('#admRegBox .adm-k[data-stufe="blocked"]:not([hidden])')));
console.log('wartende Zeile — Knöpfe:', JSON.stringify(await knoepfe('#admRegBox .adm-k[data-stufe="pending"]:not([hidden])')));

await p.screenshot({ path: 'frontend/e2e/shots/archiv-1500.png', fullPage: false });
const karte = await p.$('[data-panel="admin"], #admList');
if (karte) await karte.screenshot({ path: 'frontend/e2e/shots/archiv-karte.png' }).catch(() => {});
// Die Gruppen-Überschrift ist die Zustands-Kennzeichnung im Register.
const gruppen = await p.$$eval('#admRegBox .adm-grp', (es) => es.map((e) => e.textContent?.trim()));
console.log('Register-Gruppen:', JSON.stringify(gruppen));
console.log('Screenshots: frontend/e2e/shots/archiv-*.png');
await b.close();
