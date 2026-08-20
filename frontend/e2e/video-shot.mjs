/**
 * Prüfstand des Story-Videos: nimmt den Clip WIRKLICH auf (denselben Weg,
 * den die App geht — captureStream + MediaRecorder) und legt zusätzlich
 * Standbilder markanter Momente ab. Ob eine Animation gut aussieht, sieht
 * man nur gerendert; ob die Aufnahme funktioniert, nur durch Aufnehmen.
 *
 *   node frontend/e2e/video-shot.mjs        (Playwright + SMOKE_CHROME wie üblich)
 */
import { chromium } from 'playwright';
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-video';
const CHROME = process.env.SMOKE_CHROME;
mkdirSync(SHOTS, { recursive: true });

/* IIFE mit globalem Namen und INLINE eingebettet: Modul-Skripte auf file://
 * blockt Chromium (CORS) — ein gewöhnliches Skript nicht. */
const BUNDLE = `${SHOTS}/video.iife.js`;
execFileSync(
  'npx',
  ['esbuild', 'frontend/e2e/video-entry.ts', '--bundle', '--format=iife', '--global-name=__m', `--outfile=${BUNDLE}`, '--log-level=warning'],
  { stdio: 'inherit' },
);
const { readFileSync } = await import('node:fs');
const html = `<!doctype html><html><head><meta charset="utf-8"></head>
  <body><script>
    localStorage.setItem('autotrd-lang', 'de');
    ${readFileSync(BUNDLE, 'utf8')}
    window.__bereit = true;
  </script></body></html>`;
writeFileSync(`${SHOTS}/video.html`, html);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const seite = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
const fehler = [];
seite.on('pageerror', (e) => fehler.push(`pageerror: ${e.message}`));
await seite.goto(pathToFileURL(`${SHOTS}/video.html`).href);
await seite.waitForFunction('window.__bereit === true');

// Fixture im Browser bauen (zerlegeDepot kommt aus dem Bundle).
await seite.evaluate(() => {
  const tage = [
    { date: '2026-08-14', equity: 10_000 },
    { date: '2026-08-15', equity: 10_260 },
    { date: '2026-08-18', equity: 10_120 },
    { date: '2026-08-19', equity: 10_450 },
  ];
  const trades = ['NVDA', 'SMH', 'GLD', 'EWJ'].map((symbol, i) => ({
    symbol, side: 'sell', qty: 1, price: 100, pnl: [220, 140, 95, -80][i],
    executedAt: `2026-08-1${5 + i}T19:00:00.000Z`,
  }));
  window.__d = {
    zerlegung: window.__m.zerlegeDepot(tage, trades),
    renditePct: 4.5, ergebnis: 450, waehrung: 'USD', trefferquotePct: 75,
    profitFaktor: 5.7, trades: 4, maxDrawdownPct: -1.4,
    bestes: { label: 'NVDA', pct: 2.2 }, schlechtestes: { label: 'EWJ', pct: -0.8 },
    echtgeld: false, betraege: false, tradeBilanz: 375,
    vonTag: '2026-08-15', bisTag: '2026-08-18',
  };
});

// 1) Standbilder markanter Momente — je Szene Mitte und Ende.
const szenen = await seite.evaluate(() => window.__m.videoSzenen(window.__d).map((s) => s.id));
console.log('Szenen:', szenen.join(' → '));
for (const id of szenen) {
  for (const p of [0.45, 1]) {
    const datenUrl = await seite.evaluate(([sid, sp]) => {
      const c = document.createElement('canvas');
      c.width = 1080;
      c.height = 1080;
      const ctx = c.getContext('2d');
      ctx.save();
      ctx.scale(1080 / 1200, 1080 / 1200);
      window.__m.maleSzene(ctx, window.__d, sid, sp);
      ctx.restore();
      return c.toDataURL('image/png');
    }, [id, p]);
    writeFileSync(`${SHOTS}/still-${id}-${String(p).replace('.', '_')}.png`, Buffer.from(datenUrl.split(',')[1], 'base64'));
  }
}

// 2) Die echte Aufnahme — derselbe Weg wie der Teilen-Knopf.
console.log('Aufnahme läuft (Echtzeit, ~13 s) …');
const ergebnis = await seite.evaluate(async () => {
  const datei = await window.__m.baueStoryVideo(window.__d);
  return { name: datei.name, typ: datei.type, groesse: datei.size };
});
console.log('Video:', JSON.stringify(ergebnis));

if (!/^autotrd-story-.*\.(mp4|webm)$/.test(ergebnis.name)) fehler.push(`Dateiname unerwartet: ${ergebnis.name}`);
if (ergebnis.groesse < 100_000) fehler.push(`Video verdächtig klein: ${ergebnis.groesse} Bytes`);

await browser.close();
if (fehler.length) {
  console.error('FEHLER:\n' + fehler.map((f) => ` · ${f}`).join('\n'));
  process.exit(1);
}
console.log(`OK — Standbilder in ${SHOTS}`);
