/**
 * UI-Audit-Prüfstand (Owner 20.08.) — Screenshots + automatisierte
 * Messungen gegen die lokale Emulator-Suite.
 *
 * Für jede Breite (360/390/768/1500) × Theme (hell/dunkel):
 *  - Screenshots der Kern-Zustände (Dashboard, Performance, Detail-Sheet,
 *    Drawer am Handy, Options-Modal-Reiter)
 *  - Messungen: horizontaler Overflow, Touch-Ziele unter 40 px (inklusive
 *    der unsichtbaren ::after-Polster aus theme.css), Schriften unter
 *    12 px, ⓘ-Hitboxen, Kontrast-Stichprobe, abgeschnittene Inhalte.
 *
 * Ausführen (wie frontend/e2e/smoke.mjs):
 *   1. frontend/.env.local mit VITE_FIREBASE_USE_EMULATORS=1
 *   2. npm run emulators   3. npm run dev -w frontend
 *   4. SMOKE_CHROME=<chromium> node frontend/e2e/ui-audit.mjs
 *
 * Der Lauf ist der BROWSER-NACHWEIS für Bedienbarkeits-Änderungen —
 * die Pins dazu stehen in frontend/test/uiAudit.test.ts (§6 CLAUDE.md:
 * „kompiliert sauber" ist kein Beleg).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = 'http://127.0.0.1:5173';
const SHOTS = process.env.AUDIT_DIR ?? '/tmp/autotrd-ui-audit';
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'p360', width: 360, height: 740, mobil: true },
  { name: 'p390', width: 390, height: 844, mobil: true },
  { name: 't768', width: 768, height: 1024, mobil: false },
  { name: 'd1500', width: 1500, height: 950, mobil: false },
];
const THEMES = ['dark', 'light'];

const befunde = [];
const melde = (vp, theme, kategorie, text) => {
  befunde.push({ vp, theme, kategorie, text });
  console.log(`  [${vp}/${theme}] ${kategorie}: ${text}`);
};

/** Messungen im Seitenkontext. */
const MESSUNGEN = `(() => {
  const out = { overflow: [], kleineZiele: [], kleineSchrift: [], infoBtns: [], abgeschnitten: [], kontrast: [] };
  const sichtbar = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  // 1. Horizontaler Seiten-Overflow
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    out.overflow.push('SEITE: scrollWidth ' + document.documentElement.scrollWidth + ' > viewport ' + window.innerWidth);
  }
  // Elemente, die rechts aus dem Viewport ragen (Top-3)
  for (const el of document.querySelectorAll('.card, table, .fl-row, .pf-grid, pre')) {
    if (!sichtbar(el)) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.right > window.innerWidth + 4 && s.overflowX !== 'auto' && s.overflowX !== 'scroll') {
      out.overflow.push((el.id || el.className.toString().slice(0, 40)) + ' ragt ' + Math.round(r.right - window.innerWidth) + 'px raus');
      if (out.overflow.length > 6) break;
    }
  }
  // 2. Touch-Ziele < 40x40 (interaktiv, sichtbar) — 44 ist Soll, <40 ist Befund
  for (const el of document.querySelectorAll('button, a, input[type=checkbox], input[type=radio], select, [role=button], .ibtn, .info-btn')) {
    if (!sichtbar(el)) continue;
    // Eine Checkbox IN einem Label ist ueber das ganze Label bedienbar.
    if (el.tagName === 'INPUT' && el.closest('label')) continue;
    const r = el.getBoundingClientRect();
    // Effektive Trefferflaeche: ein ::after-Polster (content gesetzt,
    // negatives inset) zaehlt zur Hit-Test-Flaeche des Knopfs.
    let pad = 0;
    const after = getComputedStyle(el, '::after');
    if (after.content !== 'none' && after.position === 'absolute') {
      const t = parseFloat(after.top);
      if (!Number.isNaN(t) && t < 0) pad = -t;
    }
    const klein = Math.min(r.width, r.height) + 2 * pad;
    if (klein < 40 && klein > 0) {
      const label = (el.id ? '#' + el.id : '') + ' ' + (el.textContent || el.title || '').trim().slice(0, 24);
      out.kleineZiele.push({ label: label.trim() || el.className.toString().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  // 3. Schriften < 12px (sichtbarer Text)
  const gesehen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!sichtbar(el)) continue;
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) {
      const key = el.className.toString().slice(0, 30) + '|' + fs;
      if (!gesehen.has(key)) {
        gesehen.add(key);
        out.kleineSchrift.push({ sel: (el.id ? '#' + el.id : el.className.toString().slice(0, 30)), px: fs, text: (el.textContent || '').trim().slice(0, 30) });
      }
    }
  }
  // 4. ⓘ-Buttons: Größe der Hitbox
  const ibtns = document.querySelectorAll('.ibtn, [data-tip], .info, [class*=infoBtn]');
  let ibtnKlein = 0, ibtnGesamt = 0, ibtnMin = 99;
  for (const el of ibtns) {
    if (!sichtbar(el)) continue;
    ibtnGesamt++;
    const r = el.getBoundingClientRect();
    const m = Math.min(r.width, r.height);
    if (m < ibtnMin) ibtnMin = m;
    if (m < 24) ibtnKlein++;
  }
  out.infoBtns.push({ gesamt: ibtnGesamt, unter24px: ibtnKlein, minPx: ibtnGesamt ? Math.round(ibtnMin) : null });
  // 5. Abgeschnittene Inhalte (scrollWidth > clientWidth ohne overflow-Regel)
  for (const el of document.querySelectorAll('.card .cbody, .fl-tbl, .smv, .lbl')) {
    if (!sichtbar(el)) continue;
    const s = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 6 && s.overflowX === 'visible' && s.textOverflow !== 'ellipsis') {
      out.abgeschnitten.push({ sel: (el.id ? '#' + el.id : el.className.toString().slice(0, 30)), ueberhang: el.scrollWidth - el.clientWidth });
      if (out.abgeschnitten.length > 8) break;
    }
  }
  // 6. Kontrast-Stichprobe: .hint/.lbl/.smv gegen Hintergrund
  const lum = (c) => {
    const m = c.match(/rgba?\\((\\d+), ?(\\d+), ?(\\d+)/);
    if (!m) return null;
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
  };
  const bgVon = (el) => {
    let e = el;
    while (e && e !== document.documentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg && !bg.includes('0, 0, 0, 0') && bg !== 'transparent') return bg;
      e = e.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const geprueft = new Set();
  for (const el of document.querySelectorAll('.hint, .lbl, .smv, .sect, .dim, small')) {
    if (!sichtbar(el)) continue;
    const cls = el.className.toString().slice(0, 20);
    if (geprueft.has(cls)) continue;
    geprueft.add(cls);
    const l1 = lum(getComputedStyle(el).color);
    const l2 = lum(bgVon(el));
    if (l1 === null || l2 === null) continue;
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < 4.5) out.kontrast.push({ sel: cls, ratio: Math.round(ratio * 100) / 100 });
  }
  return out;
})()`;

const browser = await chromium.launch({ executablePath: process.env.SMOKE_CHROME || undefined });

// EIN Login-Kontext je Theme reicht — der User bleibt im localStorage/IndexedDB.
for (const theme of THEMES) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: theme, hasTouch: true });
  const seite = await context.newPage();
  const jsFehler = [];
  seite.on('pageerror', (e) => jsFehler.push(e.message.slice(0, 120)));

  await seite.goto(BASIS, { waitUntil: 'networkidle' });
  await seite.fill('#email', `audit-${theme}-${process.env.AUDIT_SEED ?? '1'}@example.invalid`);
  await seite.fill('#password', 'Testpasswort123!');
  await seite.locator('#signupBtn, button:has-text("Registrieren")').first().click();
  await seite.waitForTimeout(5000);
  // Onboarding-Tour schliessen — ihr Backdrop schluckt sonst jeden Klick.
  await seite.locator('.tour-x, [data-tour="x"]').first().click({ timeout: 3000 }).catch(() => {});
  await seite.waitForTimeout(600);

  for (const vp of VIEWPORTS) {
    await seite.setViewportSize({ width: vp.width, height: vp.height });
    await seite.waitForTimeout(900);
    const tag = `${vp.name}-${theme}`;

    // ── Dashboard oben ──
    await seite.evaluate(() => window.scrollTo(0, 0));
    await seite.waitForTimeout(300);
    await seite.screenshot({ path: `${SHOTS}/${tag}-10-dashboard.png` });
    const m1 = await seite.evaluate(MESSUNGEN);
    for (const o of m1.overflow) melde(vp.name, theme, 'overflow', o);
    if (m1.kleineZiele.length) melde(vp.name, theme, 'touch', `${m1.kleineZiele.length} Ziele <40px: ` + m1.kleineZiele.slice(0, 6).map((z) => `${z.label}(${z.w}x${z.h})`).join(', '));
    if (m1.kleineSchrift.length) melde(vp.name, theme, 'schrift', m1.kleineSchrift.slice(0, 5).map((s) => `${s.sel}:${s.px}px "${s.text}"`).join(' | '));
    const ib = m1.infoBtns[0];
    if (ib && ib.gesamt > 0 && (ib.unter24px > 0 || ib.minPx < 24)) melde(vp.name, theme, 'ibtn', `${ib.unter24px}/${ib.gesamt} ⓘ unter 24px (min ${ib.minPx}px)`);
    for (const a of m1.abgeschnitten) melde(vp.name, theme, 'abgeschnitten', `${a.sel} +${a.ueberhang}px`);
    for (const k of m1.kontrast) melde(vp.name, theme, 'kontrast', `${k.sel} ratio ${k.ratio}`);

    // ── Dashboard Mitte (Performance-Karte) + unten ──
    await seite.evaluate(() => document.querySelector('[data-panel="portfolio"], #pfReibung')?.scrollIntoView({ block: 'center' }));
    await seite.waitForTimeout(400);
    await seite.screenshot({ path: `${SHOTS}/${tag}-11-performance.png` });
    await seite.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await seite.waitForTimeout(400);
    await seite.screenshot({ path: `${SHOTS}/${tag}-12-unten.png` });

    // ── Detail-Sheet (Symbol antippen) ──
    await seite.evaluate(() => window.scrollTo(0, 0));
    await seite.locator('.wl-item, .tile, [data-sym]').first().click({ timeout: 3000 }).catch(() => {});
    await seite.waitForTimeout(1500);
    await seite.screenshot({ path: `${SHOTS}/${tag}-20-detail.png` });
    const m2 = await seite.evaluate(MESSUNGEN);
    for (const o of m2.overflow) melde(vp.name, theme, 'overflow/detail', o);
    await seite.locator('[data-close="detail"], .dclose').first().click({ timeout: 2000 }).catch(() => {});
    await seite.waitForTimeout(500);

    // ── Drawer (nur mobil): Burger links ──
    if (vp.mobil) {
      await seite.locator('#burgL').click({ timeout: 2000 }).catch(() => {});
      await seite.waitForTimeout(700);
      await seite.screenshot({ path: `${SHOTS}/${tag}-25-drawer.png` });
      const mD = await seite.evaluate(MESSUNGEN);
      if (mD.kleineZiele.length > 3) melde(vp.name, theme, 'touch/drawer', `${mD.kleineZiele.length} Ziele <40px`);
      await seite.keyboard.press('Escape');
      await seite.locator('#burgL').click({ timeout: 1500 }).catch(() => {});
      await seite.waitForTimeout(500);
    }

    // ── Options-Modal: Reiter durchgehen ──
    await seite.locator('#optBtn, [title*="Einstellung"]').first().click({ timeout: 3000 }).catch(() => {});
    await seite.waitForTimeout(1000);
    await seite.screenshot({ path: `${SHOTS}/${tag}-30-optionen.png` });
    const reiter = await seite.locator('#optModal [role=tab], #optModal .tab, .opt-tabs button').all().catch(() => []);
    for (let i = 0; i < Math.min(reiter.length, 6); i++) {
      await reiter[i].click().catch(() => {});
      await seite.waitForTimeout(500);
      await seite.screenshot({ path: `${SHOTS}/${tag}-3${i + 1}-optionen-tab.png` });
    }
    const m3 = await seite.evaluate(MESSUNGEN);
    for (const o of m3.overflow) melde(vp.name, theme, 'overflow/optionen', o);
    if (m3.kleineZiele.length > 3) melde(vp.name, theme, 'touch/optionen', `${m3.kleineZiele.length} Ziele <40px: ` + m3.kleineZiele.slice(0, 6).map((z) => `${z.label}(${z.w}x${z.h})`).join(', '));
    await seite.keyboard.press('Escape');
    await seite.waitForTimeout(400);
  }

  if (jsFehler.length) melde('*', theme, 'js', jsFehler.slice(0, 5).join(' | '));
  await context.close();
}

await browser.close();
writeFileSync(`${SHOTS}/befunde.json`, JSON.stringify(befunde, null, 2));
console.log(`\n${befunde.length} Roh-Befunde → ${SHOTS}/befunde.json`);
