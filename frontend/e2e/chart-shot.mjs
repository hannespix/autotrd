/**
 * Prüfstand für den Kurs-Chart — alle Typen, alle Einblendungen.
 *
 * ── Warum es das gibt (Owner-Meldung 11.08.) ──────────────────────────────
 *
 * „jetzt funktioniert die Chart gar nicht mehr."
 *
 * Zwei Änderungen an `chart.ts` gingen an diesem Tag live, beide mit grünem
 * typecheck, grünem eslint und 1951 grünen Unit-Tests. Keine dieser Stufen
 * kann die einzige Frage beantworten, die bei einem Chart zählt: **Zeichnet
 * er?** Die Unit-Tests prüfen den QUELLTEXT von `chart.ts` — ob die richtige
 * Serie angesprochen wird —, nie das Ergebnis im Browser.
 *
 * Genau diese Lücke schließt dieser Prüfstand. Er baut den Chart aus
 * DEMSELBEN Modul wie die App, füttert ihn mit Kursen, schaltet durch alle
 * sieben Chart-Typen und prüfe nach jedem Schritt:
 *
 *   - Ist auch nur ein Fehler in der Browser-Konsole aufgelaufen?
 *   - Hat die Zeichenfläche überhaupt Inhalt (Canvas-Pixel)?
 *   - Kommen `coords()` und `onClick()` mit brauchbaren Zahlen zurück —
 *     also funktionieren Zeichenwerkzeuge und Prognose-Pfeil?
 *   - Bleiben Marker und Preislinien gesetzt?
 *
 * Er braucht weder Emulatoren noch Login, nur Chromium:
 *
 *   node frontend/e2e/chart-shot.mjs
 *
 * Playwright ist bewusst KEINE Projekt-Abhängigkeit (siehe smoke.mjs):
 *   npm i -D playwright --no-save
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-chart';
const CHROME = process.env.SMOKE_CHROME;
mkdirSync(SHOTS, { recursive: true });

const BUNDLE = `${SHOTS}/chart.mjs`;
execFileSync(
  'npx',
  [
    'esbuild',
    'frontend/e2e/chart-entry.ts',
    '--bundle',
    // IIFE und INLINE eingebettet, nicht als externes Modul: Chromium
    // blockiert `import` von einer file://-Seite per CORS.
    '--format=iife',
    '--global-name=ChartApi',
    `--outfile=${BUNDLE}`,
    '--log-level=warning',
  ],
  { stdio: 'inherit' },
);

/* 120 Handelstage, deterministisch erzeugt — zwei Läufe ergeben dasselbe
 * Bild. Eine leichte Aufwärtsbewegung mit Gegenbewegung, damit Baseline und
 * Flächen-Verlauf etwas zu zeigen haben. */
const bars = [];
let kurs = 100;
for (let i = 0; i < 120; i++) {
  const d = new Date(Date.UTC(2026, 3, 1) + i * 86_400_000);
  const schwung = Math.sin(i / 9) * 3 + i * 0.12;
  const open = kurs;
  const close = 100 + schwung;
  const high = Math.max(open, close) + 1.2;
  const low = Math.min(open, close) - 1.1;
  kurs = close;
  bars.push({
    date: d.toISOString().slice(0, 10),
    open: +open.toFixed(2),
    high: +high.toFixed(2),
    low: +low.toFixed(2),
    close: +close.toFixed(2),
    volume: 1_000_000 + i * 5_000,
  });
}
const letzter = bars[bars.length - 1];
const mitte = bars[Math.floor(bars.length / 2)];

writeFileSync(
  `${SHOTS}/index.html`,
  `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>
  :root { --t3:#6b7a92; --f-num:monospace; }
  body { margin:0; background:#05080f; }
  #chartArea { width: 900px; height: 420px; }
</style></head><body><div id="chartArea"></div>
<script>${readFileSync(BUNDLE, 'utf8')}</script>
<script>
  const { buildPriceChart } = window.ChartApi;
  window.__bars = ${JSON.stringify(bars)};
  window.__fehler = [];
  window.addEventListener('error', (e) => window.__fehler.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__fehler.push('rejection: ' + String(e.reason)));
  window.__bereit = (async () => {
    const h = await buildPriceChart(document.getElementById('chartArea'), 'PRUEFSTAND');
    window.__chart = h;
    return h !== null;
  })();
</script></body></html>`,
);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const seite = await browser.newPage({ viewport: { width: 960, height: 520 } });
const konsole = [];
seite.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') konsole.push(`${m.type()}: ${m.text()}`);
});
seite.on('pageerror', (e) => konsole.push(`pageerror: ${e.message}`));

await seite.goto(`file://${SHOTS}/index.html`);
const gebaut = await seite.evaluate(() => window.__bereit);
if (!gebaut) {
  console.error('FEHLER: buildPriceChart lieferte null — Bibliothek nicht geladen.');
  await browser.close();
  process.exit(1);
}

/** Anteil nicht-schwarzer Pixel der Zeichenfläche — 0 heißt: nichts gezeichnet. */
const gezeichnet = () =>
  seite.evaluate(() => {
    const cs = [...document.querySelectorAll('#chartArea canvas')];
    let gesamt = 0;
    for (const c of cs) {
      const w = c.width;
      const h = c.height;
      if (w === 0 || h === 0) continue;
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, w, h).data;
      // Jeden 40. Pixel abtasten — reicht für „da ist etwas" und ist schnell.
      for (let i = 0; i < d.length; i += 160) {
        if (d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24) gesamt++;
      }
    }
    return gesamt;
  });

const TYPEN = ['candles', 'hollow', 'heikin', 'line', 'area', 'baseline', 'bars'];
const fehler = [];
const zeilen = [];

// Daten, Marker und Preislinien setzen — wie das Dashboard es tut.
await seite.evaluate(
  ([bs, m, l]) => {
    const c = window.__chart;
    c.setBars(bs);
    c.setMarkers([
      { key: 'news', time: m.date, position: 'aboveBar', color: '#e8c76a', shape: 'circle', text: 'N' },
      { key: 'entry', time: l.date, position: 'belowBar', color: '#26cf9d', shape: 'arrowUp', text: 'Kauf' },
    ]);
    c.setPriceLines([
      { key: 'entry', price: m.close, color: '#e8c76a', title: '', axisLabel: true },
      { key: 'stop', price: m.close * 0.95, color: '#f2586b', title: '', axisLabel: true },
    ]);
  },
  [bars, mitte, letzter],
);
await seite.waitForTimeout(200);

for (const typ of TYPEN) {
  await seite.evaluate((t) => window.__chart.setChartType(t), typ);
  await seite.waitForTimeout(150);

  const pixel = await gezeichnet();
  // coords(): Preis → Pixel. Daran hängen Zeichnungen und Prognose-Pfeil.
  const co = await seite.evaluate(
    ([zeit, preis]) => window.__chart.coords(zeit, preis),
    [letzter.date, letzter.close],
  );
  const seitenFehler = await seite.evaluate(() => window.__fehler.slice());

  const ok = pixel > 500 && co.y !== null && co.x !== null && seitenFehler.length === 0;
  zeilen.push(
    `${ok ? 'OK  ' : 'FEHL'} ${typ.padEnd(9)} pixel=${String(pixel).padStart(6)} ` +
      `coords.x=${co.x === null ? 'null' : Math.round(co.x)} coords.y=${co.y === null ? 'null' : Math.round(co.y)}` +
      (seitenFehler.length ? ` JS=${seitenFehler.join(' | ')}` : ''),
  );
  if (!ok) {
    fehler.push(
      `${typ}: pixel=${pixel} coords=${JSON.stringify(co)} js=${JSON.stringify(seitenFehler)}`,
    );
  }
  await seite.screenshot({ path: `${SHOTS}/${typ}.png` });
}

/* ── Intraday-Pfad ────────────────────────────────────────────────────────
 *
 * Eigene Zeit-Domäne (Unix-Sekunden statt YYYY-MM-DD) und eigener
 * Umrechnungsweg in `zuAchse`. Ein Chart, der auf Tagesdaten zeichnet, kann
 * hier trotzdem leer bleiben — deshalb dieselben Prüfungen noch einmal. */
{
  const intra = [];
  const start = Date.UTC(2026, 7, 10, 13, 30) / 1000;
  let k = 100;
  for (let i = 0; i < 200; i++) {
    k += Math.sin(i / 7) * 0.4;
    intra.push({
      time: start + i * 300,
      open: +(k - 0.2).toFixed(2),
      high: +(k + 0.5).toFixed(2),
      low: +(k - 0.6).toFixed(2),
      close: +k.toFixed(2),
      volume: 50_000,
    });
  }
  await seite.evaluate((bs) => {
    const c = window.__chart;
    c.setChartType('candles');
    c.setCandlesVisible(true);
    c.setBars(bs, { intraday: true });
    c.setMarkers([
      { key: 'n', time: bs[100].time, position: 'aboveBar', color: '#e8c76a', shape: 'circle', text: 'N' },
    ]);
  }, intra);
  await seite.waitForTimeout(250);
  for (const typ of ['candles', 'line', 'bars']) {
    await seite.evaluate((t) => window.__chart.setChartType(t), typ);
    await seite.waitForTimeout(120);
    const pixel = await gezeichnet();
    const co = await seite.evaluate(
      ([zeit, preis]) => window.__chart.coords(zeit, preis),
      [intra[150].time, intra[150].close],
    );
    const ok = pixel > 500 && co.y !== null && co.x !== null;
    zeilen.push(
      `${ok ? 'OK  ' : 'FEHL'} intraday:${typ.padEnd(7)} pixel=${String(pixel).padStart(6)} ` +
        `coords.x=${co.x === null ? 'null' : Math.round(co.x)} coords.y=${co.y === null ? 'null' : Math.round(co.y)}`,
    );
    if (!ok) fehler.push(`intraday ${typ}: pixel=${pixel} coords=${JSON.stringify(co)}`);
  }
  await seite.screenshot({ path: `${SHOTS}/intraday.png` });
}

/* ── Overlays, Prognose und Flächen-Verlauf ───────────────────────────────
 *
 * Sie legen zusätzliche Serien auf dieselbe Preisskala. Eine falsch
 * skalierte Zusatzserie kann den Kurs auf einen Strich zusammendrücken —
 * sichtbar nur als Bild, nie in einem Unit-Test. */
await seite.evaluate((bs) => {
  const c = window.__chart;
  c.setChartType('candles');
  c.setBars(bs);
  c.setOverlays([
    { key: 'sma20', color: '#e8c76a', points: bs.map((b, i) => ({ time: b.date, value: b.close * (1 + i * 0.0002) })) },
    { key: 'bb-up', color: '#7f8fb0', points: bs.map((b) => ({ time: b.date, value: b.close * 1.04 })) },
  ]);
  c.setForecast({
    points: bs.slice(-10).map((b, i) => ({ time: b.date, value: b.close + i * 0.4 })),
    band: bs.slice(-10).map((b, i) => ({ time: b.date, upper: b.close + i * 0.4 + 2, lower: b.close + i * 0.4 - 2 })),
  });
  c.setArea(bs.slice(-40).map((b) => ({ time: b.date, value: b.close })));
}, bars);
await seite.waitForTimeout(250);
{
  const pixel = await gezeichnet();
  const co = await seite.evaluate(
    ([zeit, preis]) => window.__chart.coords(zeit, preis),
    [letzter.date, letzter.close],
  );
  const seitenFehler = await seite.evaluate(() => window.__fehler.slice());
  const ok = pixel > 500 && co.y !== null && seitenFehler.length === 0;
  zeilen.push(
    `${ok ? 'OK  ' : 'FEHL'} overlays  pixel=${String(pixel).padStart(6)} ` +
      `coords.y=${co.y === null ? 'null' : Math.round(co.y)}` +
      (seitenFehler.length ? ` JS=${seitenFehler.join(' | ')}` : ''),
  );
  if (!ok) fehler.push(`overlays: pixel=${pixel} coords=${JSON.stringify(co)} js=${JSON.stringify(seitenFehler)}`);
  await seite.screenshot({ path: `${SHOTS}/overlays.png` });
}

/* ── Leere und einelementige Daten ────────────────────────────────────────
 *
 * Ein Symbol ohne Historie darf keinen Fehler werfen und den Chart nicht in
 * einen Zustand bringen, aus dem er sich nicht mehr erholt. */
await seite.evaluate(() => window.__chart.setBars([]));
await seite.waitForTimeout(120);
await seite.evaluate((bs) => window.__chart.setBars(bs.slice(0, 1)), bars);
await seite.waitForTimeout(120);
await seite.evaluate((bs) => window.__chart.setBars(bs), bars);
await seite.waitForTimeout(200);
{
  const pixel = await gezeichnet();
  const seitenFehler = await seite.evaluate(() => window.__fehler.slice());
  const ok = pixel > 500 && seitenFehler.length === 0;
  zeilen.push(
    `${ok ? 'OK  ' : 'FEHL'} leer→voll pixel=${String(pixel).padStart(6)}` +
      (seitenFehler.length ? ` JS=${seitenFehler.join(' | ')}` : ''),
  );
  if (!ok) fehler.push(`leer→voll: pixel=${pixel} js=${JSON.stringify(seitenFehler)}`);
}

// „Kerzen aus" (Vektor-Look) — der zweite Weg, die Kerzen-Serie zu verstecken.
await seite.evaluate(() => {
  window.__chart.setChartType("candles");
  window.__chart.setCandlesVisible(false);
});
await seite.waitForTimeout(150);
{
  const pixel = await gezeichnet();
  const co = await seite.evaluate(
    ([zeit, preis]) => window.__chart.coords(zeit, preis),
    [letzter.date, letzter.close],
  );
  const ok = pixel > 500 && co.y !== null;
  zeilen.push(`${ok ? 'OK  ' : 'FEHL'} kerzen-aus pixel=${pixel} coords.y=${co.y === null ? 'null' : Math.round(co.y)}`);
  if (!ok) fehler.push(`kerzen-aus: pixel=${pixel} coords=${JSON.stringify(co)}`);
  await seite.screenshot({ path: `${SHOTS}/kerzen-aus.png` });
}

console.log(zeilen.join('\n'));
if (konsole.length > 0) console.log('\nKonsole:\n' + konsole.join('\n'));
console.log(`\nBilder: ${SHOTS}`);

await browser.close();
if (fehler.length > 0) {
  console.error(`\n${fehler.length} Prüfung(en) fehlgeschlagen:\n` + fehler.join('\n'));
  process.exit(1);
}
console.log('\nAlle Chart-Typen zeichnen, coords/Marker/Preislinien intakt.');
