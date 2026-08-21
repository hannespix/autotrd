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

/**
 * Wie viele Pixel einer bestimmten Farbe stehen auf der Zeichenfläche?
 *
 * ── Warum das die entscheidende Messung ist (Owner 11.08.) ────────────────
 *
 * „bei Linie, Berg, baseline, Bars … werden die Punkte und die ganzen
 * anderen Nachrichten-Zeichnungen einfach nicht im Chart gerendert!"
 *
 * Die erste Fassung dieses Prüfstands zählte nur, ob die Fläche ÜBERHAUPT
 * Inhalt hat. Der Kurs allein füllt sie — und damit war jeder Chart-Typ
 * „grün", während genau die Marker fehlten, um die es geht. Ein Prüfstand,
 * der die gemeldete Sache nicht messen kann, ist schlimmer als keiner: Er
 * bescheinigt Fehlerfreiheit.
 *
 * Also wird nach FARBE gesucht — aber nur nach Farben, die es sonst NIRGENDS
 * im Bild gibt. Der erste Versuch färbte Marker wie in der App (`#e8c76a`
 * News-Gelb, `#26cf9d` Kauf-Grün) und zählte damit die Preislinie in
 * derselben Gelbtönung und jede steigende Kerze mit: alle sieben Typen
 * meldeten vierstellige Trefferzahlen, auch die kaputten. Zweiter
 * Fehlschlag derselben Familie — der Prüfstand konnte die gemeldete Sache
 * nicht messen und bescheinigte trotzdem Fehlerfreiheit.
 *
 * Deshalb bekommen Marker hier Signalfarben (Magenta/Cyan/Reingelb), die im
 * Kursbild nicht vorkommen, und die Toleranz ist eng genug, dass Kerzen-Grün
 * (38,207,157) nicht als Cyan (0,255,255) durchgeht.
 *
 * `bereich` schränkt die Zählung auf einen CSS-Pixel-Streifen ein (`xVon`,
 * `xBis`). Damit lässt sich auch etwas isolieren, dessen Farbe man NICHT frei
 * wählen kann — die Prognose-Linie ist in `chart.ts` fest auf `#25d0ee`
 * gesetzt, dieselbe Farbe wie die Linien-/Berg-Serie. Rechts vom letzten Bar
 * liegt aber nur die Prognose, und dort ist die Farbe wieder eindeutig.
 */
const farbPixel = (hex, toleranz = 30, bereich = null) =>
  seite.evaluate(
    ([h, tol, ber]) => {
      const r0 = parseInt(h.slice(1, 3), 16);
      const g0 = parseInt(h.slice(3, 5), 16);
      const b0 = parseInt(h.slice(5, 7), 16);
      let n = 0;
      for (const c of document.querySelectorAll('#chartArea canvas')) {
        if (c.width === 0 || c.height === 0) continue;
        const ctx = c.getContext('2d');
        if (!ctx) continue;
        // Canvas-Pixel je CSS-Pixel (Retina/deviceScaleFactor)
        const s = c.clientWidth > 0 ? c.width / c.clientWidth : 1;
        const xVon = ber ? Math.max(0, Math.round(ber.xVon * s)) : 0;
        const xBis = ber ? Math.min(c.width, Math.round(ber.xBis * s)) : c.width;
        if (xBis <= xVon) continue;
        const d = ctx.getImageData(xVon, 0, xBis - xVon, c.height).data;
        for (let i = 0; i < d.length; i += 4) {
          if (
            Math.abs(d[i] - r0) < tol &&
            Math.abs(d[i + 1] - g0) < tol &&
            Math.abs(d[i + 2] - b0) < tol
          ) {
            n++;
          }
        }
      }
      return n;
    },
    [hex, toleranz, bereich],
  );

/* Signalfarben nur für den Prüfstand — im Kursbild kommt keine davon vor,
 * also ist jeder Treffer nachweislich die gesuchte Zeichnung.
 *   Magenta = News-Marker · Cyan = Kauf-Marker · Reingelb = Preislinie */
const M_NEWS = '#ff00ff';
const M_KAUF = '#00ffff';
const L_EINSTIEG = '#ffff00';
const O_INDIKATOR = '#ff7f00'; // Overlay (SMA/EMA/BB/VWAP) — frei wählbar
const P_PROGNOSE = '#25d0ee'; // Prognose-Linie — in chart.ts fest verdrahtet

const TYPEN = ['candles', 'hollow', 'heikin', 'line', 'area', 'baseline', 'bars'];
const fehler = [];
const zeilen = [];

// Daten, Marker und Preislinien setzen — wie das Dashboard es tut.
await seite.evaluate(
  ([bs, m, l]) => {
    const c = window.__chart;
    c.setBars(bs);
    c.setMarkers([
      { key: 'news', time: m.date, position: 'aboveBar', color: '#ff00ff', shape: 'circle', text: 'N' },
      { key: 'entry', time: l.date, position: 'belowBar', color: '#00ffff', shape: 'arrowUp', text: 'Kauf' },
    ]);
    c.setPriceLines([
      { key: 'entry', price: m.close, color: '#ffff00', title: '', axisLabel: true },
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
  /* Die Marker müssen SICHTBAR sein, nicht nur gesetzt. Genau hier lag der
   * gemeldete Fehler: gesetzt waren sie immer, gezeichnet nur bei Kerzen. */
  const mNews = await farbPixel(M_NEWS);
  const mKauf = await farbPixel(M_KAUF);
  const lEin = await farbPixel(L_EINSTIEG);

  const ok =
    pixel > 500 &&
    co.y !== null &&
    co.x !== null &&
    seitenFehler.length === 0 &&
    mNews > 10 &&
    mKauf > 10 &&
    lEin > 10;
  zeilen.push(
    `${ok ? 'OK  ' : 'FEHL'} ${typ.padEnd(9)} pixel=${String(pixel).padStart(6)} ` +
      `news=${String(mNews).padStart(4)} kauf=${String(mKauf).padStart(4)} linie=${String(lEin).padStart(4)} ` +
      `coords.y=${co.y === null ? 'null' : Math.round(co.y)}` +
      (seitenFehler.length ? ` JS=${seitenFehler.join(' | ')}` : ''),
  );
  if (!ok) {
    fehler.push(
      `${typ}: pixel=${pixel} news=${mNews} kauf=${mKauf} linie=${lEin} coords=${JSON.stringify(co)} js=${JSON.stringify(seitenFehler)}`,
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
      { key: 'n', time: bs[100].time, position: 'aboveBar', color: '#ff00ff', shape: 'circle', text: 'N' },
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
    const mNews = await farbPixel(M_NEWS);
    const ok = pixel > 500 && co.y !== null && co.x !== null && mNews > 10;
    zeilen.push(
      `${ok ? 'OK  ' : 'FEHL'} intraday:${typ.padEnd(7)} pixel=${String(pixel).padStart(6)} ` +
        `news=${String(mNews).padStart(4)} ` +
        `coords.x=${co.x === null ? 'null' : Math.round(co.x)} coords.y=${co.y === null ? 'null' : Math.round(co.y)}`,
    );
    if (!ok) fehler.push(`intraday ${typ}: pixel=${pixel} news=${mNews} coords=${JSON.stringify(co)}`);
  }
  await seite.screenshot({ path: `${SHOTS}/intraday.png` });
}

/* ── Indikatoren, Prognose und Flächen-Verlauf — in JEDEM Chart-Typ ───────
 *
 * Zweite Hälfte der Owner-Meldung 11.08.: „die News Punkte und die
 * INDIKATOREN funktionieren nicht so richtig". Der erste Prüfstand legte
 * Overlays nur auf Kerzen — und beantwortete die Frage damit nicht.
 *
 * Overlays bekommen eine Signalfarbe (Orange), die Prognose ist in
 * `chart.ts` fest auf `#25d0ee` verdrahtet — dieselbe Farbe wie die
 * Linien-/Berg-Serie. Sie wird deshalb im Streifen RECHTS vom letzten Bar
 * gezählt, wo nur sie liegen kann. */
// Prognose-Tage LIEGEN IN DER ZUKUNFT — wie in der App. Auf vergangene Tage
// gelegt verschwindet sie unter der Kurslinie und wäre nicht isolierbar.
const zukunft = Array.from({ length: 10 }, (_, i) => ({
  date: new Date(Date.parse(`${letzter.date}T00:00:00Z`) + (i + 1) * 86_400_000).toISOString().slice(0, 10),
  value: letzter.close + (i + 1) * 0.5,
}));
await seite.evaluate(
  ([bs, zk, l]) => {
    const c = window.__chart;
    c.setBars(bs, { fit: true });
    c.setRightOffset(14); // Platz für die Prognose rechts der letzten Kerze
    c.setOverlays([
      { key: 'sma20', color: '#ff7f00', points: bs.map((b, i) => ({ time: b.date, value: b.close * (1 + i * 0.0002) })) },
      { key: 'bb-up', color: '#7f8fb0', points: bs.map((b) => ({ time: b.date, value: b.close * 1.04 })) },
    ]);
    c.setForecast(
      {
        points: zk.map((p) => ({ time: p.date, value: p.value })),
        band: zk.map((p) => ({ time: p.date, upper: p.value + 2, lower: p.value - 2 })),
      },
      { time: l.date, value: l.close },
    );
    c.setArea(bs.slice(-40).map((b) => ({ time: b.date, value: b.close })));
  },
  [bars, zukunft, letzter],
);
await seite.waitForTimeout(300);
for (const typ of TYPEN) {
  await seite.evaluate((t) => window.__chart.setChartType(t), typ);
  await seite.waitForTimeout(180);
  const pixel = await gezeichnet();
  const co = await seite.evaluate(
    ([zeit, preis]) => window.__chart.coords(zeit, preis),
    [letzter.date, letzter.close],
  );
  const seitenFehler = await seite.evaluate(() => window.__fehler.slice());
  const ind = await farbPixel(O_INDIKATOR);
  // Prognose: nur rechts vom letzten Bar zählen (dort ist `#25d0ee` eindeutig).
  const prog = co.x === null ? 0 : await farbPixel(P_PROGNOSE, 30, { xVon: co.x + 8, xBis: 900 });
  const ok = pixel > 500 && co.y !== null && seitenFehler.length === 0 && ind > 50 && prog > 20;
  zeilen.push(
    `${ok ? 'OK  ' : 'FEHL'} ind:${typ.padEnd(9)} pixel=${String(pixel).padStart(6)} ` +
      `indikator=${String(ind).padStart(4)} prognose=${String(prog).padStart(4)} ` +
      `coords.y=${co.y === null ? 'null' : Math.round(co.y)}` +
      (seitenFehler.length ? ` JS=${seitenFehler.join(' | ')}` : ''),
  );
  if (!ok) {
    fehler.push(
      `ind ${typ}: pixel=${pixel} indikator=${ind} prognose=${prog} coords=${JSON.stringify(co)} js=${JSON.stringify(seitenFehler)}`,
    );
  }
  await seite.screenshot({ path: `${SHOTS}/ind-${typ}.png` });
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

/* ── Y-Modi und Preisskalen ───────────────────────────────────────────────
 *
 * Vier Zustände, die die Oberfläche anbietet und die der Prüfstand bis eben
 * nicht kannte:
 *
 *   yMode 'fix'   — feste Spanne über `autoscaleInfoProvider`. Liefert der
 *                   Provider Unsinn, zieht LWC die Skala auf einen Strich
 *                   zusammen oder zeichnet gar nichts.
 *   yMode 'frei'  — der Nutzer zieht selbst.
 *   Skala log     — bricht bei Werten <= 0.
 *   Skala prozent — eigene Rechnung relativ zum ersten sichtbaren Bar.
 *
 * Der Owner arbeitet mit diesen Schaltern; ein Prüfstand, der nur den
 * Standardzustand kennt, prüft nicht seinen Chart. */
await seite.evaluate((bs) => {
  const c = window.__chart;
  c.setChartType('candles');
  c.setOverlays([]);
  c.setForecast(null);
  c.setArea(null);
  c.setBars(bs);
}, bars);
await seite.waitForTimeout(200);

for (const [name, wirkung] of [
  ['y:auto', (c) => c.setYMode('auto')],
  ['y:fix', (c) => c.setYMode('fix')],
  ['y:frei', (c) => c.setYMode('frei')],
  ['skala:log', (c) => { c.setYMode('auto'); c.setPriceScaleMode(1); }],
  ['skala:pct', (c) => c.setPriceScaleMode(2)],
  ['skala:lin', (c) => c.setPriceScaleMode(0)],
]) {
  await seite.evaluate(`(${wirkung.toString()})(window.__chart)`);
  await seite.waitForTimeout(180);
  const pixel = await gezeichnet();
  const co = await seite.evaluate(
    ([zeit, preis]) => window.__chart.coords(zeit, preis),
    [letzter.date, letzter.close],
  );
  const seitenFehler = await seite.evaluate(() => window.__fehler.slice());
  const ok = pixel > 500 && co.y !== null && seitenFehler.length === 0;
  zeilen.push(
    `${ok ? 'OK  ' : 'FEHL'} ${name.padEnd(10)} pixel=${String(pixel).padStart(6)} ` +
      `coords.y=${co.y === null ? 'null' : Math.round(co.y)}` +
      (seitenFehler.length ? ` JS=${seitenFehler.join(' | ')}` : ''),
  );
  if (!ok) fehler.push(`${name}: pixel=${pixel} coords=${JSON.stringify(co)} js=${JSON.stringify(seitenFehler)}`);
  await seite.screenshot({ path: `${SHOTS}/${name.replace(':', '-')}.png` });
}

/* ── Symbolwechsel-Y-Fit (Owner 21.08.) ───────────────────────────────────
 *
 * „Manchmal sind die Kerzen so kurz, dass man sie gar nicht erkennt,
 * manchmal ragen sie aus dem Screen": Nach einer manuellen Achsen-Geste
 * (frei/fix) behielt die Preisskala die Spanne des VORHERIGEN Symbols —
 * DOGE (0,08) erschien in einer ±15er-Skala, BTC in einer eingefrorenen
 * 1.000er-Spanne. Der Fit eines Symbolwechsels muss die Y-Achse fürs neue
 * Preisniveau frisch rechnen, in JEDEM Y-Modus. Der Prüfstand wechselt vom
 * 100er-Niveau auf das 1000-fache und verlangt, dass die letzte Kerze
 * wieder im Sichtfenster (0…420 px) liegt. */
{
  const bars1000 = bars.map((b) => ({
    ...b,
    open: b.open * 1000,
    high: b.high * 1000,
    low: b.low * 1000,
    close: b.close * 1000,
  }));
  for (const modus of ['frei', 'fix']) {
    await seite.evaluate((m) => {
      const c = window.__chart;
      c.setPriceScaleMode(0);
      c.setBars(window.__bars, { fit: true });
      c.setYMode(m); // Nutzer übernimmt die Achse auf dem ALTEN Niveau
    }, modus);
    await seite.waitForTimeout(200);
    await seite.evaluate((bs) => {
      window.__chart.setBars(bs, { fit: true }); // Symbolwechsel: neues Niveau
    }, bars1000);
    await seite.waitForTimeout(250);
    const pixel = await gezeichnet();
    const co = await seite.evaluate(
      ([zeit, preis]) => window.__chart.coords(zeit, preis),
      [letzter.date, letzter.close * 1000],
    );
    const drin = co.y !== null && co.y >= 0 && co.y <= 420;
    const ok = pixel > 500 && drin;
    zeilen.push(
      `${ok ? 'OK  ' : 'FEHL'} wechsel:${modus.padEnd(4)} pixel=${String(pixel).padStart(6)} ` +
        `coords.y=${co.y === null ? 'null' : Math.round(co.y)} (Soll: 0…420)`,
    );
    if (!ok) fehler.push(`wechsel:${modus}: pixel=${pixel} coords=${JSON.stringify(co)}`);
    await seite.screenshot({ path: `${SHOTS}/wechsel-${modus}.png` });
  }
  // Zurück in den Grundzustand für die folgenden Fälle.
  await seite.evaluate(() => {
    window.__chart.setYMode('auto');
    window.__chart.setBars(window.__bars, { fit: true });
  });
  await seite.waitForTimeout(200);
}

/* ── Reihenfolgen und Domänenwechsel ──────────────────────────────────────
 *
 * Alles, was oben geprüft wird, läuft in der bequemen Reihenfolge: erst
 * Kurse, dann Marker. Die App hält sich nicht immer daran — ein Symbolwechsel
 * setzt Marker aus dem alten Zustand, bevor die neuen Kurse da sind, und der
 * Zeitrahmen-Umschalter wirft die Zeit-Domäne um (ISO-Tag ↔ Unix-Sekunden),
 * während Marker der alten Domäne noch hängen.
 *
 * Diese Fälle sind die wahrscheinlichsten Ursachen eines Totalausfalls, denn
 * Lightweight Charts wirft bei unsortierten oder domänenfremden Daten hart —
 * und ein geworfener Fehler im Aufbau lässt die Fläche leer. Deshalb stehen
 * sie hier, nicht im Kommentar. */
{
  const intra2 = [];
  const s2 = Date.UTC(2026, 7, 11, 13, 30) / 1000;
  for (let i = 0; i < 80; i++) {
    const k = 100 + Math.sin(i / 5) * 0.8;
    intra2.push({ time: s2 + i * 300, open: k, high: k + 0.4, low: k - 0.4, close: k, volume: 1000 });
  }
  const faelle = [
    [
      'marker-vor-bars',
      async () => {
        await seite.evaluate(
          ([m, l]) => {
            const c = window.__chart;
            c.setBars([]);
            c.setMarkers([
              { key: 'n', time: m.date, position: 'aboveBar', color: '#ff00ff', shape: 'circle', text: 'N' },
              { key: 'e', time: l.date, position: 'belowBar', color: '#00ffff', shape: 'arrowUp', text: 'K' },
            ]);
            c.setPriceLines([{ key: 'entry', price: m.close, color: '#ffff00', title: '', axisLabel: true }]);
          },
          [mitte, letzter],
        );
        await seite.waitForTimeout(120);
        await seite.evaluate((bs) => window.__chart.setBars(bs, { fit: true }), bars);
      },
    ],
    [
      'tag→intraday',
      async () => {
        // Preislinie mitziehen: Ein Preis aus dem Tages-Niveau läge außerhalb
        // der Intraday-Spanne und wäre zu Recht unsichtbar — das wäre eine
        // Prüfung der Skala, nicht der Zeichnung.
        await seite.evaluate((bs) => {
          const c = window.__chart;
          c.setBars(bs, { intraday: true, fit: true });
          c.setPriceLines([{ key: 'entry', price: bs[0].close, color: '#ffff00', title: '', axisLabel: true }]);
        }, intra2);
      },
    ],
    [
      'intraday→tag',
      async () => {
        await seite.evaluate(
          ([bs, m, l]) => {
            const c = window.__chart;
            c.setBars(bs, { fit: true });
            c.setMarkers([
              { key: 'n', time: m.date, position: 'aboveBar', color: '#ff00ff', shape: 'circle', text: 'N' },
              { key: 'e', time: l.date, position: 'belowBar', color: '#00ffff', shape: 'arrowUp', text: 'K' },
            ]);
          },
          [bars, mitte, letzter],
        );
      },
    ],
  ];
  for (const [name, wirkung] of faelle) {
    await wirkung();
    await seite.waitForTimeout(220);
    const pixel = await gezeichnet();
    const seitenFehler = await seite.evaluate(() => window.__fehler.slice());
    // Nach jedem Fall müssen Marker UND Preislinie wieder stehen — außer im
    // Intraday-Zwischenschritt, dessen Marker einer anderen Domäne gehören.
    const mNews = await farbPixel(M_NEWS);
    const lEin = await farbPixel(L_EINSTIEG);
    const brauchtMarker = name !== 'tag→intraday';
    const ok = pixel > 500 && seitenFehler.length === 0 && lEin > 10 && (!brauchtMarker || mNews > 10);
    zeilen.push(
      `${ok ? 'OK  ' : 'FEHL'} ${name.padEnd(16)} pixel=${String(pixel).padStart(6)} ` +
        `news=${String(mNews).padStart(4)} linie=${String(lEin).padStart(4)}` +
        (seitenFehler.length ? ` JS=${seitenFehler.join(' | ')}` : ''),
    );
    if (!ok) fehler.push(`${name}: pixel=${pixel} news=${mNews} linie=${lEin} js=${JSON.stringify(seitenFehler)}`);
  }
}

/* ── Klick-Umrechnung (Zeichenwerkzeuge) ──────────────────────────────────
 *
 * `onClick` liefert den Preis unter dem Mauszeiger; daran hängen Trendlinie,
 * Horizontale, Rechteck und der Prognose-Pfeil. Läuft die Umrechnung über
 * eine unsichtbare Serie, kommt `null` zurück und jedes Zeichenwerkzeug
 * setzt ins Leere — sichtbar nur so. */
for (const [i, typ] of ['candles', 'line', 'bars'].entries()) {
  await seite.evaluate((t) => {
    window.__klick = undefined;
    window.__chart.setChartType(t);
    window.__chart.onClick((p) => {
      window.__klick = p;
    });
  }, typ);
  await seite.waitForTimeout(400);
  // Jeder Klick an eine andere Stelle und mit Abstand: dreimal dieselbe
  // Koordinate in Folge wertet Chromium als Doppel-/Dreifachklick, den
  // Lightweight Charts nicht als Klick meldet.
  await seite.mouse.click(380 + i * 60, 170 + i * 30);
  await seite.waitForTimeout(200);
  const preis = await seite.evaluate(() => window.__klick);
  const ok = typeof preis === 'number' && Number.isFinite(preis);
  zeilen.push(`${ok ? 'OK  ' : 'FEHL'} klick:${typ.padEnd(11)} preis=${ok ? preis.toFixed(2) : String(preis)}`);
  if (!ok) fehler.push(`klick ${typ}: preis=${String(preis)}`);
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
