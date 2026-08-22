/**
 * Prüfstand für die Admin-Freischaltungskarte (Owner-Anfrage 22.08.).
 *
 * ── Warum er vor dem Umbau erweitert wurde ────────────────────────────────
 *
 * „Übersichtlicher" ist kein Befund, solange es niemand misst. Der Owner
 * beschrieb ein Bild („verschwenderisch viele und zu große fette buttons");
 * dieser Prüfstand macht daraus Zahlen, die man vorher und nachher
 * vergleichen kann.
 *
 * Zwei Entscheidungen, die den Prüfstand ehrlich halten:
 *
 *  1. Gemessen wird die GANZE Karte, nicht nur `#admList`. Sonst wäre jede
 *     Lösung, die Knöpfe in ein schwebendes Menü an `document.body`
 *     auslagert, trivial grün — ohne dass ein Nutzer etwas gewonnen hätte.
 *  2. Gemessen wird die GEOMETRIE der Zeilen (scrollWidth gegen clientWidth,
 *     Breite der E-Mail-Spalte), nicht nur, ob es hübsch aussieht. Aus
 *     Zeichenzahl geschätzte Breiten liegen bei langen Adressen zuverlässig
 *     daneben — CLAUDE.md §6.
 *
 * ── Ausführen ─────────────────────────────────────────────────────────────
 *
 *   npm i -D playwright --no-save
 *   npm run emulators   +   npm run dev -w frontend
 *   node frontend/e2e/admin-shot.mjs                 (Desktop 1500)
 *   W=390 TAG=nachher node frontend/e2e/admin-shot.mjs
 *
 * Das Konto in MAIL muss admin:true tragen und die Liste muss gefüllt sein
 * — der Nachweis für „bei sehr vielen Nutzern" braucht viele Nutzer.
 */
import { chromium } from 'playwright';
const W = Number(process.env.W ?? 1500);
const TAG = process.env.TAG ?? 'vorher';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: W, height: W > 500 ? 1100 : 844 }, ...(W <= 500 ? { hasTouch: true, isMobile: true } : {}) });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await p.fill('#email', 'warum@autotrd.test');
await p.fill('#password', 'test1234');
await p.keyboard.press('Enter');
await p.waitForTimeout(9000);
// Tour wegklicken, falls sie im Weg ist
for (let i = 0; i < 8; i++) {
  const x = await p.$('button:has-text("FERTIG"), button:has-text("WEITER"), .tour-close, [aria-label="Schließen"]');
  if (!x) break;
  await x.click().catch(() => {});
  await p.waitForTimeout(250);
}
// Auf dem Handy liegt die linke Spalte in einer Schublade — erst oeffnen.
if (W <= 520) {
  await p.evaluate(() => document.getElementById('leftCol')?.classList.add('show'));
  await p.waitForTimeout(500);
}
const karte = await p.$('#adminCard');
if (!karte) { console.log('ADMIN-KARTE NICHT SICHTBAR (kein Admin?)'); await b.close(); process.exit(1); }
await karte.scrollIntoViewIfNeeded();
// Konten laden
const laden = await p.$('#adminCard button');
if (laden) { await laden.click(); await p.waitForTimeout(4000); }
const mass = await p.evaluate(() => {
  const k = document.getElementById('adminCard');
  // Die GANZE Karte messen, nicht nur #admList: Sonst waere jede Loesung,
  // die Knoepfe aus der Liste herausverlagert, trivial gruen.
  const knoepfe = [...k.querySelectorAll('button')].filter((x) => {
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const breiten = knoepfe.map((x) => Math.round(x.getBoundingClientRect().width));
  const zeilen = [...k.querySelectorAll('.adm-k')];
  const ueberlauf = zeilen.filter((z) => z.scrollWidth > z.clientWidth + 1).length;
  const mails = [...k.querySelectorAll('.adm-mail')].map((m) => Math.round(m.getBoundingClientRect().width));
  const flaeche = knoepfe.reduce((a, x) => {
    const r = x.getBoundingClientRect();
    return a + r.width * r.height;
  }, 0);
  const kr = k.getBoundingClientRect();
  const hoehen = knoepfe.map((x) => Math.round(x.getBoundingClientRect().height));
  return {
    karteHoehe: Math.round(kr.height),
    zeilen: zeilen.length || (document.getElementById('admList')?.children.length ?? 0),
    knoepfeGesamt: knoepfe.length,
    knopfBreiteMax: breiten.length ? Math.max(...breiten) : 0,
    vollbreit: breiten.filter((w) => w > 250).length,
    knopfHoeheMin: hoehen.length ? Math.min(...hoehen) : 0,
    knopfflaechePct: Math.round((flaeche / (kr.width * kr.height)) * 1000) / 10,
    zeilenMitUeberlauf: ueberlauf,
    mailBreiteMin: mails.length ? Math.min(...mails) : 0,
    offenZaehler: document.getElementById('admOffen')?.textContent ?? '-',
    notausSichtbar: document.getElementById('admKillBtn') ? !document.getElementById('admKillBtn').hidden : false,
  };
});
console.log(`MASSE ${TAG} @${W}:`, JSON.stringify(mass, null, 1));
await p.evaluate(() => document.getElementById('adminCard')?.scrollIntoView({ block: 'start' }));
await p.waitForTimeout(400);
await p.screenshot({ path: `/tmp/autotrd-smoke/admin-${TAG}-${W}.png`, fullPage: false });
await b.close();
