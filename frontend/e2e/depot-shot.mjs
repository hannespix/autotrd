/**
 * Layout-Prüfstand für den zerlegten Depot-Verlauf.
 *
 * ── Warum ─────────────────────────────────────────────────────────────────
 *
 * Die Unit-Tests prüfen, dass die Treppe rechnerisch auf der Depot-Linie
 * endet. Ob man das auf einem 390-px-Telefon auch SIEHT — ob die Achsen
 * lesbar bleiben, der Tooltip in der Karte steht und die Legende umbricht
 * statt zu überlaufen —, kann kein Unit-Test beantworten.
 *
 * Der Prüfstand baut seine Seite aus DEMSELBEN Modul wie die App und
 * derselben `theme.css`. Er braucht weder Emulatoren noch Login, nur
 * Chromium:
 *
 *   node frontend/e2e/depot-shot.mjs
 *
 * Er schlägt fehl bei waagerechtem Seiten-Scroll, wenn der Tooltip aus der
 * Karte ragt, oder wenn Equity-Linie und Treppenende auseinanderliegen.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-depot';
const CHROME = process.env.SMOKE_CHROME;
mkdirSync(SHOTS, { recursive: true });

const BUNDLE = `${SHOTS}/depot.mjs`;
execFileSync(
  'npx',
  ['esbuild', 'frontend/e2e/depot-entry.ts', '--bundle', '--format=esm', `--outfile=${BUNDLE}`, '--log-level=warning'],
  { stdio: 'inherit' },
);
const { depotChart, zerlegeDepot } = await import(BUNDLE);

/* Vier Wochen Handelstage, sechs Symbole, gemischte Ergebnisse — nah an dem,
 * was ein Papierkonto nach ein paar Wochen zeigt. Deterministisch erzeugt
 * (keine Zufallszahlen), damit zwei Läufe dasselbe Bild ergeben. */
const symbole = ['SPY', 'AAPL', 'NVDA', 'BTC-USD', 'EWJ', 'GLD'];
const tage = [];
const trades = [];
let eq = 10_000;
for (let d = 0; d < 28; d++) {
  const datum = new Date(Date.UTC(2026, 6, 6) + d * 86_400_000);
  const wochentag = datum.getUTCDay();
  if (wochentag === 0 || wochentag === 6) continue;
  const iso = datum.toISOString().slice(0, 10);
  eq += Math.round((Math.sin(d / 3) * 60 + d * 4) * 100) / 100;
  tage.push({ date: iso, equity: Math.round(eq * 100) / 100 });
  if (d % 3 === 1) {
    const sym = symbole[d % symbole.length];
    const pnl = Math.round((Math.cos(d / 2) * 85 + 12) * 100) / 100;
    trades.push({ symbol: sym, side: 'sell', qty: 1, price: 100, pnl, executedAt: `${iso}T19:30:00.000Z` });
  }
}

const z = zerlegeDepot(tage, trades);
const { svg, legende } = depotChart(z);
const css = readFileSync('frontend/src/theme.css', 'utf8');

const html = `<!doctype html><html lang="de" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><div class="wrap" style="padding:12px;max-width:520px">
<div class="card" data-panel="depotVerlauf"><div class="sect">Depot-Verlauf
  <span class="dc-modus"><button aria-pressed="true">je Symbol</button><button aria-pressed="false">je Trade</button></span>
</div><div class="cbody">
  <div class="hint">Die dicke Linie ist dein Depot. Grün baut auf, Rot trägt wieder ab, zuletzt
    korrigiert der Buchwert der offenen Positionen auf den tatsächlichen Stand.</div>
  <div class="dc-wrap" id="dcWrap"><div id="dcChart">${svg}</div>
    <div class="dc-tt" id="dcTip" style="left:120px;top:2px">
      <div class="dc-tt-h"><b>2026-07-22</b><span class="mono">10.412,55</span></div>
      <div class="dc-tt-d"><span>seit 2026-07-06</span><b class="c-gn">+412,55</b></div>
      <div class="dc-tt-l"><div><span>NVDA</span><b class="c-gn">+96,20</b></div>
        <div><span>EWJ</span><b class="c-rd">-41,10</b></div>
        <div><span>Offene Positionen</span><b class="c-gn">+357,45</b></div></div>
    </div></div>
  <div class="dc-legende" id="dcLegende">${legende}</div>
  <div class="tn-n mono">${z.tage[0]} → ${z.tage[z.tage.length - 1]} · ${trades.length} Trades im Bild</div>
</div></div></div></body></html>`;

const datei = `${SHOTS}/depot.html`;
writeFileSync(datei, html);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const fehler = [];

for (const [name, breite] of [['desktop', 1500], ['phone', 390]]) {
  const seite = await browser.newPage({ viewport: { width: breite, height: 900 }, reducedMotion: 'reduce' });
  seite.on('pageerror', (e) => fehler.push(`${name}: pageerror ${e.message}`));
  await seite.goto(pathToFileURL(datei).href);
  await seite.waitForSelector('.dc-svg');

  const mass = await seite.evaluate(() => {
    const karte = document.querySelector('.card').getBoundingClientRect();
    const tip = document.querySelector('.dc-tt').getBoundingClientRect();
    const leg = document.querySelector('.dc-legende').getBoundingClientRect();
    const svgEl = document.querySelector('.dc-svg');
    const kasten = svgEl.getBoundingClientRect();
    // Sitzt die Equity-Linie auf dem Ende der Treppe? Im gerenderten SVG
    // gemessen, nicht im Quelltext — Skalierung und viewBox zählen mit.
    const eq = svgEl.querySelector('.dc-eq').getBBox();
    const baender = [...svgEl.querySelectorAll('.dc-band')];
    const letztes = baender[baender.length - 1].getBBox();
    return {
      seiteScroll: Math.round(document.documentElement.scrollWidth),
      fensterBreite: window.innerWidth,
      svgHoehe: Math.round(kasten.height),
      baender: baender.length,
      legendeZeilen: Math.round(leg.height),
      tipRagtRaus: Math.round(Math.max(0, karte.right - tip.right < 0 ? tip.right - karte.right : 0, karte.left - tip.left)),
      eqOben: Math.round(eq.y * 100) / 100,
      eqUnten: Math.round((eq.y + eq.height) * 100) / 100,
      letztesOben: Math.round(letztes.y * 100) / 100,
      letztesUnten: Math.round((letztes.y + letztes.height) * 100) / 100,
      achsen: svgEl.querySelectorAll('.dc-ax').length,
    };
  });
  await seite.screenshot({ path: `${SHOTS}/depot-${name}.png`, fullPage: true });
  console.log(name, JSON.stringify(mass));

  if (mass.seiteScroll > mass.fensterBreite + 1) {
    fehler.push(`${name}: Seite scrollt waagerecht (${mass.seiteScroll} > ${mass.fensterBreite})`);
  }
  if (mass.tipRagtRaus > 0) fehler.push(`${name}: Tooltip ragt ${mass.tipRagtRaus}px aus der Karte`);
  if (mass.baender < 3) fehler.push(`${name}: nur ${mass.baender} Bänder gezeichnet`);
  if (mass.achsen < 5) fehler.push(`${name}: nur ${mass.achsen} Achsenbeschriftungen`);
  // Die Equity-Linie muss innerhalb des letzten Bandes verlaufen (dessen
  // Hüllkasten sie berührt) — sonst endet die Treppe woanders als die Linie.
  if (mass.eqOben < mass.letztesOben - 1 || mass.eqUnten > mass.letztesUnten + 1) {
    fehler.push(`${name}: Equity-Linie (${mass.eqOben}…${mass.eqUnten}) liegt außerhalb des letzten Bandes (${mass.letztesOben}…${mass.letztesUnten})`);
  }
  await seite.close();
}

await browser.close();
if (fehler.length) {
  console.error('FEHLER:\n' + fehler.map((f) => ` · ${f}`).join('\n'));
  process.exit(1);
}
console.log(`OK — Bilder in ${SHOTS}`);
