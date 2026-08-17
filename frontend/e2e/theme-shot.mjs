/**
 * Prüfstand für die FARBEN — beide Themes, Desktop und Telefon.
 *
 * ── Warum es das gibt (Owner-Meldung 17.08.) ──────────────────────────────
 *
 * „das helle Theme gefällt mir aktuell von den Farben her (Kombination)
 * überhaupt nicht! kann man das harmonischer und schöner gestalten?"
 *
 * Eine Farbkombination ist die eine Eigenschaft der Oberfläche, über die
 * weder typecheck noch eslint noch ein Unit-Test etwas sagen kann. Genau wie
 * beim Chart (`chart-shot.mjs`, Owner 11.08.) gilt: Wer eine Farbänderung
 * ohne Bild behauptet, behauptet sie.
 *
 * Der Prüfstand baut EIN Musterblatt aus der echten `theme.css` — Kopfleiste,
 * Karten, Knöpfe, Reiter, Tabelle, Chips, Eingaben, Zahlen in Gewinn- und
 * Verlustfarbe — und schießt es in beiden Themes. Kein Login, keine
 * Emulatoren, kein Firebase: nur die Stildatei und statisches Markup, damit
 * das Bild ausschließlich von den Farben abhängt.
 *
 *   npm i -D playwright --no-save && node frontend/e2e/theme-shot.mjs
 *
 * Ergebnis: vier PNG in $SMOKE_SHOTS (Standard /tmp/autotrd-theme).
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-theme';
mkdirSync(SHOTS, { recursive: true });
const css = readFileSync('frontend/src/theme.css', 'utf8');
/* Wie in chart-shot.mjs: Eine vorinstallierte Chromium-Binärdatei darf über
 * SMOKE_CHROME vorgegeben werden — Playwright sucht sonst eine Version, die
 * in dieser Umgebung nicht liegt. */
const CHROME = process.env.SMOKE_CHROME;

/* Das Musterblatt zeigt bewusst ALLE Farbrollen nebeneinander: Genau in der
 * Nachbarschaft entsteht der Eindruck „harmonisch" oder „beißt sich" — eine
 * Farbe für sich betrachtet sieht fast immer in Ordnung aus. */
const seite = `
<div class="aurora"></div>
<div class="hdr">
  <span class="logo">autotrd</span>
  <span class="chip">Engine AN</span>
  <span class="chip">Regime: Trend</span>
  <span style="flex:1"></span>
  <button class="btn btn-s">Optionen</button>
  <button class="btn btn-g btn-s">Kaufen</button>
  <button class="btn btn-r btn-s">Verkaufen</button>
</div>
<div style="padding:14px;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">

  <div class="card">
    <div class="card-h"><span class="card-t">Depot</span><span class="chip">live</span></div>
    <div class="vbig c-gn">128.430,55 $</div>
    <div class="hint">Kapitalbasis 100.000 $ · seit 14 Tagen</div>
    <div style="display:flex;gap:6px;margin-top:10px">
      <span class="t-tag t-buy">KAUF</span>
      <span class="t-tag t-sell">VERKAUF</span>
      <span class="t-tag t-hold">HALTEN</span>
    </div>
  </div>

  <div class="card">
    <div class="card-h"><span class="card-t">Kennzahlen</span></div>
    <div class="sgrid">
      <div class="sitem"><div class="slab">Profit-Faktor</div><div class="sval c-gn">1,23</div></div>
      <div class="sitem"><div class="slab">Max. Rückgang</div><div class="sval c-rd">−8,4 %</div></div>
      <div class="sitem"><div class="slab">Sharpe 30</div><div class="sval">0,71</div></div>
      <div class="sitem"><div class="slab">Gebührenanteil</div><div class="sval c-t3">57 %</div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-h"><span class="card-t">Einstellungen</span></div>
    <label class="lb">Watchlist</label>
    <input class="inp" value="BTC-USD, ETH-USD, SPY" />
    <label class="lb" style="margin-top:8px">Zeitbasis</label>
    <select class="sel"><option>5 Minuten</option></select>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="mtab on">Handel</button>
      <button class="mtab">Anzeige</button>
      <button class="mtab">Konto</button>
    </div>
  </div>

  <div class="card" style="grid-column:1/-1">
    <div class="card-h"><span class="card-t">Letzte Trades</span></div>
    <table class="tbl">
      <thead><tr><th>Symbol</th><th>Seite</th><th>Kurs</th><th>Ergebnis</th></tr></thead>
      <tbody>
        <tr><td>BTC-USD</td><td>Kauf</td><td>64.120,00</td><td class="c-gn">+412,80</td></tr>
        <tr><td>ETH-USD</td><td>Verkauf</td><td>3.140,50</td><td class="c-rd">−128,40</td></tr>
        <tr><td>SPY</td><td>Kauf</td><td>551,20</td><td class="c-gn">+64,10</td></tr>
      </tbody>
    </table>
  </div>
</div>`;

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
for (const theme of ['light', 'dark']) {
  for (const [name, breite, hoehe] of [['desktop', 1500, 950], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width: breite, height: hoehe } });
    await page.setContent(
      `<!doctype html><html lang="de" data-theme="${theme}"><head><meta charset="utf-8">` +
        `<style>${css}</style></head><body>${seite}</body></html>`,
    );
    // Die Aurora-Animation läuft 36 s — ohne Anhalten zeigte jeder Lauf
    // einen anderen Verlauf, und ein Vorher/Nachher wäre nicht vergleichbar.
    await page.addStyleTag({ content: '.aurora { animation: none !important; }' });
    await page.waitForTimeout(180);
    await page.screenshot({ path: `${SHOTS}/${theme}-${name}.png` });
    await page.close();
  }
}
await browser.close();
console.log(`Musterblätter in ${SHOTS}`);
