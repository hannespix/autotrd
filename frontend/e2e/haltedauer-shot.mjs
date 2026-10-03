/**
 * Layout-Prüfstand für die Haltedauer-Karte.
 *
 * ── Warum ─────────────────────────────────────────────────────────────────
 *
 * Typecheck und Unit-Tests prüfen den Inhalt der Tabelle. Sie können nicht
 * prüfen, ob sechs Zahlenspalten auf einem 390-px-Telefon nebeneinander
 * passen — und genau dort brechen Karten in diesem Projekt reihenweise (siehe
 * die CSS-Kommentare zu `.fl-tbl` und `.tn-h`).
 *
 * Der Prüfstand baut seine Seite aus DEMSELBEN Modul wie die App
 * (`haltedauerCard`) und derselben `theme.css`. Ein Prüfstand, der das Markup
 * nachbaut, prüft irgendwann etwas anderes als die App zeigt.
 *
 * Er braucht weder Emulatoren noch Login — nur Chromium.
 *
 *   node frontend/e2e/haltedauer-shot.mjs
 *
 * Er schlägt fehl, wenn eine Zeile breiter ist als die Karte (Überlauf) oder
 * wenn Zellen ihren Nachbarn überlappen.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-haltedauer';
const CHROME = process.env.SMOKE_CHROME;
mkdirSync(SHOTS, { recursive: true });

// Karten-Bausteine UND Auswertung über esbuild aus dem TS ziehen — dieselbe
// Quelle wie die App, ohne einen zweiten Build-Pfad zu erfinden.
const BUNDLE = `${SHOTS}/karte.mjs`;
execFileSync(
  'npx',
  [
    'esbuild',
    'frontend/e2e/haltedauer-entry.ts',
    '--bundle',
    '--format=esm',
    `--outfile=${BUNDLE}`,
    '--log-level=warning',
  ],
  { stdio: 'inherit' },
);
const { haltedauerTabelle, haltedauerFazit, haltedauerMeta, haltedauerZeilen, besteHaltedauer } =
  await import(BUNDLE);

/* Echte Größenordnungen: die SPY-Messung vom 09.08. über 25 Jahre, plus eine
 * bewusst zu dünne Zeile, damit auch der blasse Zustand im Bild ist. */
const horizonte = {
  1: { klasse: k(327, 31.3), buy: k(52, 34.0), sell: k(275, -25.9) },
  2: { klasse: k(327, 37.1), buy: k(52, 37.1), sell: k(275, -24.9) },
  3: { klasse: k(327, 68.9), buy: k(52, 56.6), sell: k(275, -24.3) },
  5: { klasse: k(327, 102.2), buy: k(52, 81.8), sell: k(275, -32.0) },
  10: { klasse: k(12, 1.4), buy: k(3, 2.8), sell: k(9, -2.3) },
};
function k(n, summePct) {
  return { n, summePct, treffer: Math.round(n * 0.52), summeRohPct: summePct + n * 0.1, nRoh: n };
}

const zeilen = haltedauerZeilen(horizonte);
const beste = besteHaltedauer(zeilen);
const css = readFileSync('frontend/src/theme.css', 'utf8');

const html = `<!doctype html><html lang="de" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><div class="wrap" style="padding:12px;max-width:520px">
<div class="card" data-panel="haltedauer"><div class="sect">Wie lange halten?
  <span id="hdStand" class="tn-tag" style="float:right">Stand 2026-08-10</span>
</div><div class="cbody">
  <div class="hint">Dieselben Kaufsignale, nur unterschiedlich lange gehalten — gerechnet auf der
    gespeicherten Tages-Historie, jeweils nach Abzug der klassenechten Kosten.</div>
  <div id="hdTbl" class="hd-tbl" style="margin-top:8px">${haltedauerTabelle(zeilen, beste)}</div>
  <div id="hdFazit" class="tn-r">${haltedauerFazit(beste)}</div>
  <div id="hdMeta" class="tn-n mono">${haltedauerMeta({ symbole: 164, fenster: 6000, version: 3 })}</div>
</div></div></div></body></html>`;

const datei = `${SHOTS}/karte.html`;
writeFileSync(datei, html);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const fehler = [];

for (const [name, breite] of [
  ['desktop', 1500],
  ['phone', 390],
]) {
  const seite = await browser.newPage({
    viewport: { width: breite, height: 800 },
    reducedMotion: 'reduce',
  });
  seite.on('pageerror', (e) => fehler.push(`${name}: pageerror ${e.message}`));
  await seite.goto(pathToFileURL(datei).href);
  await seite.waitForSelector('.hd-row');

  const mass = await seite.evaluate(() => {
    const karte = document.querySelector('.hd-tbl');
    const zeilen = [...document.querySelectorAll('.hd-row')];
    const ueberlauf = zeilen
      .map((z) => Math.round(z.scrollWidth - z.clientWidth))
      .filter((d) => d > 0);
    // Überlappen Zellen ihre Nachbarn? Bei zu engen Spalten schiebt sich der
    // Text übereinander, ohne dass irgendetwas „überläuft".
    const kollisionen = zeilen.flatMap((z) => {
      const s = [...z.querySelectorAll('span')].map((e) => e.getBoundingClientRect());
      return s.slice(1).filter((r, i) => r.left < s[i].right - 0.5).length ? [z.className] : [];
    });
    return {
      karteBreite: Math.round(karte.getBoundingClientRect().width),
      seiteScroll: Math.round(document.documentElement.scrollWidth),
      fensterBreite: window.innerWidth,
      zeilen: zeilen.length,
      ueberlauf,
      kollisionen,
      besteMarkiert: document.querySelectorAll('.hd-best').length,
      blass: document.querySelectorAll('.hd-dim').length,
    };
  });
  await seite.screenshot({ path: `${SHOTS}/haltedauer-${name}.png`, fullPage: true });
  console.log(name, JSON.stringify(mass));

  if (mass.ueberlauf.length) fehler.push(`${name}: ${mass.ueberlauf.length} Zeilen laufen über`);
  if (mass.kollisionen.length) fehler.push(`${name}: Zellen überlappen (${mass.kollisionen.join(', ')})`);
  if (mass.seiteScroll > mass.fensterBreite + 1) {
    fehler.push(`${name}: Seite scrollt waagerecht (${mass.seiteScroll} > ${mass.fensterBreite})`);
  }
  if (mass.besteMarkiert !== 1) fehler.push(`${name}: ${mass.besteMarkiert} beste Zeilen statt 1`);
  if (mass.blass !== 1) fehler.push(`${name}: ${mass.blass} blasse Zeilen statt 1`);
  await seite.close();
}

await browser.close();
if (fehler.length) {
  console.error('FEHLER:\n' + fehler.map((f) => ` · ${f}`).join('\n'));
  process.exit(1);
}
console.log(`OK — Bilder in ${SHOTS}`);
