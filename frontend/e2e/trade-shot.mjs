/**
 * Prüfstand des Maschinen-Videos: malt Standbilder aller fünf Akte (Auge)
 * und nimmt den Clip WIRKLICH auf (derselbe Weg wie der Knopf). Ob eine
 * Bühne trägt, sieht man nur gerendert; ob die Aufnahme funktioniert, nur
 * durch Aufnehmen.
 *
 *   node frontend/e2e/trade-shot.mjs        (Playwright + SMOKE_CHROME wie üblich)
 */
import { chromium } from 'playwright';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-trade-video';
const CHROME = process.env.SMOKE_CHROME;
mkdirSync(SHOTS, { recursive: true });

const BUNDLE = `${SHOTS}/trade.iife.js`;
execFileSync(
  'npx',
  ['esbuild', 'frontend/e2e/trade-entry.ts', '--bundle', '--format=iife', '--global-name=__m', `--outfile=${BUNDLE}`, '--log-level=warning'],
  { stdio: 'inherit' },
);
const html = `<!doctype html><html><head><meta charset="utf-8"></head>
  <body><script>
    localStorage.setItem('autotrd-lang', 'de');
    ${readFileSync(BUNDLE, 'utf8')}
    window.__bereit = true;
  </script></body></html>`;
writeFileSync(`${SHOTS}/trade.html`, html);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const seite = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
const fehler = [];
seite.on('pageerror', (e) => fehler.push(`pageerror: ${e.message}`));
await seite.goto(pathToFileURL(`${SHOTS}/trade.html`).href);
await seite.waitForFunction('window.__bereit === true');

// Fixture: ein echter Tages-Trade mit 5-Minuten-Kurve und Journal-Stimmen.
await seite.evaluate(() => {
  // Vorlauf wie in der echten App (kursFenster: ~35 % der Haltespanne).
  const eMs = Date.parse('2026-08-19T14:30:00.000Z');
  const kurse = [];
  for (let i = 0; i < 60; i++) {
    kurse.push({ at: eMs - 80 * 60_000 + i * 5 * 60_000, c: 100 + Math.sin(i / 6) * 3 + i * 0.08 });
  }
  window.__d = {
    symbol: 'NVDA',
    einstiegSeite: 'buy',
    einstiegAt: '2026-08-19T14:30:00.000Z',
    einstiegPreis: 100.4,
    exitAt: '2026-08-19T18:10:00.000Z',
    exitPreis: 104.1,
    riskExit: 'take_profit',
    kontext: { stimmen: ['RSI', 'MACD'], konfluenz: '3/3' },
    kurse,
    scannerSymbole: ['NVDA', 'SMH', 'GLD', 'EWJ', 'BTCUSD', 'AAPL', 'MSFT', 'TSLA', 'SPY', 'QQQ', 'AMD', 'ETHUSD'],
    echtgeld: false,
  };
});

// 1) Standbilder: jeder Akt bei 45 % und 95 %.
const akte = await seite.evaluate(() => window.__m.aktPlan().map((a) => a.id));
console.log('Akte:', akte.join(' → '));
for (const id of akte) {
  for (const p of [0.45, 0.95]) {
    const datenUrl = await seite.evaluate(([sid, sp]) => {
      const plan = window.__m.aktPlan();
      const akt = plan.find((a) => a.id === sid);
      const c = document.createElement('canvas');
      c.width = 1080;
      c.height = 1080;
      const ctx = c.getContext('2d');
      const lage = window.__m.vermesseLage(window.__d);
      ctx.save();
      ctx.scale(1080 / 1200, 1080 / 1200);
      window.__m.maleAkt(ctx, window.__d, lage, sid, sp * akt.dauerMs);
      ctx.restore();
      return c.toDataURL('image/png');
    }, [id, p]);
    writeFileSync(`${SHOTS}/akt-${id}-${String(p).replace('.', '_')}.png`, Buffer.from(datenUrl.split(',')[1], 'base64'));
  }
}

// 2) Die echte Aufnahme (~20 s Echtzeit).
console.log('Aufnahme läuft (Echtzeit, ~20 s) …');
const ergebnis = await seite.evaluate(async () => {
  const datei = await window.__m.baueTradeStoryVideo(window.__d);
  return { name: datei.name, typ: datei.type, groesse: datei.size };
});
console.log('Video:', JSON.stringify(ergebnis));

if (!/^autotrd-maschine-.*\.(mp4|webm)$/.test(ergebnis.name)) fehler.push(`Dateiname unerwartet: ${ergebnis.name}`);
if (ergebnis.groesse < 100_000) fehler.push(`Video verdächtig klein: ${ergebnis.groesse} Bytes`);
if (ergebnis.typ.includes(';')) fehler.push(`Datei-Typ trägt Codec-Parameter: ${ergebnis.typ}`);

await browser.close();
if (fehler.length) {
  console.error('FEHLER:\n' + fehler.map((f) => ` · ${f}`).join('\n'));
  process.exit(1);
}
console.log(`OK — Standbilder in ${SHOTS}`);
