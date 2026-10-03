/**
 * Bild-Prüfstand der teilbaren Ergebnis-Grafik.
 *
 * Die Unit-Tests prüfen, WAS im SVG steht. Ob das Ergebnis als Bild taugt —
 * ob Texte sich überlappen, ob die große Zahl aus dem Rahmen läuft, ob das
 * Siegel lesbar ist — sieht man nur gerendert. Und weil die Grafik geteilt
 * wird, ist ein Schönheitsfehler hier teurer als anderswo: Er ist dann in
 * fremden Zeitleisten.
 *
 *   node frontend/e2e/share-shot.mjs
 *
 * Der Prüfstand rastert zusätzlich über eine Canvas nach PNG — denselben Weg,
 * den die App beim Teilen geht. Fällt das durch, wäre der Teilen-Knopf in der
 * App kaputt, ohne dass ein Unit-Test es merkt.
 *
 * ── Beide Sprachen (Tranche 5e, 18.08.) ─────────────────────────────────
 *
 * Seit die Karte übersetzt ist, wird jeder Fall ZWEIMAL gerendert. Der Grund
 * ist nicht Gründlichkeit, sondern Arithmetik: Englische Beschriftung ist an
 * manchen Stellen länger (PAPER ACCOUNT gegen PAPIERKONTO), und die Karte hat
 * feste Koordinaten. Ein Prüfstand, der nur Deutsch misst, bescheinigt einer
 * englischen Karte Fehlerfreiheit, die er nie gesehen hat (CLAUDE.md §6).
 *
 * `t()` liest die Wahl aus localStorage — in Node gibt es das nicht, also
 * wird es hier gestellt: derselbe Weg wie im Browser, nur ohne Browser.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-share';
const CHROME = process.env.SMOKE_CHROME;
mkdirSync(SHOTS, { recursive: true });

const BUNDLE = `${SHOTS}/share.mjs`;
execFileSync(
  'npx',
  ['esbuild', 'frontend/e2e/share-entry.ts', '--bundle', '--format=esm', `--outfile=${BUNDLE}`, '--log-level=warning'],
  { stdio: 'inherit' },
);
let spracheJetzt = 'de';
globalThis.localStorage = {
  getItem: (k) => (k === 'autotrd-lang' ? spracheJetzt : null),
  setItem: () => undefined,
};
const { shareStory, zerlegeDepot, KARTE } = await import(BUNDLE);

const tage = [];
const trades = [];
let eq = 10_000;
const symbole = ['NVDA', 'SPY', 'BTC-USD', 'EWJ', 'GLD'];
for (let d = 0; d < 40; d++) {
  const datum = new Date(Date.UTC(2026, 5, 29) + d * 86_400_000);
  if (datum.getUTCDay() === 0 || datum.getUTCDay() === 6) continue;
  const iso = datum.toISOString().slice(0, 10);
  eq += Math.round((Math.sin(d / 4) * 70 + d * 5) * 100) / 100;
  tage.push({ date: iso, equity: Math.round(eq * 100) / 100 });
  if (d % 4 === 2) {
    trades.push({
      symbol: symbole[d % symbole.length],
      side: 'sell', qty: 1, price: 100,
      pnl: Math.round((Math.cos(d / 3) * 120 + 20) * 100) / 100,
      executedAt: `${iso}T19:00:00.000Z`,
    });
  }
}
const zerlegung = zerlegeDepot(tage, trades);
const letzte = zerlegung.equity[zerlegung.equity.length - 1];

const faelle = {
  gewinn: {
    zerlegung, renditePct: ((letzte - zerlegung.basis) / zerlegung.basis) * 100,
    ergebnis: letzte - zerlegung.basis, waehrung: 'USD',
    trefferquotePct: 52.4, profitFaktor: 1.83, trades: trades.length, maxDrawdownPct: -6.8,
    bestes: { label: 'NVDA', pct: 3.1 }, schlechtestes: { label: 'EWJ', pct: -1.4 },
    echtgeld: false, betraege: false,
    /* Depot-Karte (21:14) mit den Kanten, die weh tun: langes Krypto-Symbol,
     * ein SHORT (dessen Tag im Englischen anders breit ist), eine Position
     * OHNE Kurs, ein dreistelliger Prozentwert und mehr als sieben Zeilen —
     * die „+N weitere"-Zeile muss auch gerendert stehen. */
    investiertPct: 62.5,
    positionen: [
      { symbol: 'BTC-USD', short: false, einstieg: 61234.5, aktuell: 68999.12, pnlPct: 12.68, pnl: 7764.62, qty: 0.42 },
      { symbol: 'NVDA', short: false, einstieg: 118.4, aktuell: 131.02, pnlPct: 10.66, pnl: 126.2, qty: 10 },
      { symbol: 'SPY', short: true, einstieg: 630.11, aktuell: 640.96, pnlPct: -1.72, pnl: -32.55, qty: 3 },
      { symbol: 'EWJ', short: true, einstieg: 74.2, aktuell: 70.05, pnlPct: 5.59, pnl: 41.5, qty: 10 },
      { symbol: 'GLD', short: false, einstieg: 240.9, aktuell: 238.11, pnlPct: -1.16, pnl: -27.9, qty: 10 },
      { symbol: 'QQQ', short: false, einstieg: 690, aktuell: 712.88, pnlPct: 3.32, pnl: 114.4, qty: 5 },
      { symbol: 'TSLA', short: false, einstieg: 350, aktuell: null, pnlPct: null, pnl: null, qty: 2 },
      { symbol: 'MSFT', short: false, einstieg: 482.7, aktuell: 483.02, pnlPct: 0.07, pnl: 0.31, qty: 1 },
      { symbol: 'LIT', short: false, einstieg: 74, aktuell: 76.52, pnlPct: 3.4, pnl: 812.35, qty: 323 },
    ],
    tradeBilanz: trades.reduce((a, t) => a + t.pnl, 0),
    vonTag: trades[0]?.executedAt.slice(0, 10),
    bisTag: trades[trades.length - 1]?.executedAt.slice(0, 10),
  },
};
faelle.verlust = { ...faelle.gewinn, renditePct: -12.37, ergebnis: -1237, maxDrawdownPct: -18.4, betraege: true };

/* ── Der Anlassfall vom 12.08.: Trades ohne Kurve ────────────────────────
 *
 * Die Karte zeigte „0,00 %" in GRÜN neben Profit-Faktor 0,12, dazu „noch
 * kein Zeitraum" und ein leeres „WOMIT". Sie geht mit Markenlogo nach
 * aussen — hier gehoert der Fall als Bild geprueft und nicht nur als Text:
 * Ob die grosse Zeile gruen oder rot ist, steht im gerenderten Pixel, nicht
 * im SVG-Quelltext, wo eine Farbe nur eine Zeichenkette ist. */
faelle.ohne_kurve = {
  ...faelle.gewinn,
  zerlegung: zerlegeDepot([], []),
  renditePct: 0,
  ergebnis: 0,
  trades: 9,
  tradeBilanz: -1719.54,
  trefferquotePct: 33.3,
  profitFaktor: 0.12,
  maxDrawdownPct: null,
  bestes: null,
  schlechtestes: null,
  betraege: true,
  vonTag: '2026-08-10',
  bisTag: '2026-08-12',
};
faelle.ganz_leer = {
  ...faelle.ohne_kurve,
  trades: 0,
  tradeBilanz: 0,
  vonTag: undefined,
  bisTag: undefined,
};

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const fehler = [];

for (const [fall, d] of Object.entries(faelle)) {
for (const sprache of ['de', 'en']) {
  spracheJetzt = sprache;
  /* Seit der Story (20.08.) wird jede KARTE des Falls einzeln gerastert und
   * vermessen — die CTA-Karte trägt bewusst kein Siegel und weniger Text. */
  for (const karte of shareStory(d)) {
  const name = `${fall}-${karte.id}-${sprache}`;
  const svg = karte.svg;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#000} svg{display:block}</style></head>
    <body>${svg}<script>
      window.__png = async () => {
        const s = new XMLSerializer().serializeToString(document.querySelector('svg'));
        const url = URL.createObjectURL(new Blob([s], {type:'image/svg+xml;charset=utf-8'}));
        const bild = new Image();
        await new Promise((ok, no) => { bild.onload = ok; bild.onerror = no; bild.src = url; });
        const c = document.createElement('canvas');
        c.width = ${KARTE}; c.height = ${KARTE};
        c.getContext('2d').drawImage(bild, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        return c.toDataURL('image/png').length;
      };
    </script></body></html>`;
  const datei = `${SHOTS}/share-${name}.html`;
  writeFileSync(datei, html);

  const seite = await browser.newPage({ viewport: { width: KARTE, height: KARTE }, reducedMotion: 'reduce' });
  seite.on('pageerror', (e) => fehler.push(`${name}: pageerror ${e.message}`));
  await seite.goto(pathToFileURL(datei).href);
  await seite.waitForSelector('svg');

  const mass = await seite.evaluate(async ({ kante, siegelErwartet }) => {
    const raus = [];
    for (const t of document.querySelectorAll('text')) {
      const b = t.getBBox();
      if (b.x < 40 || b.y < 40 || b.x + b.width > kante - 40 || b.y + b.height > kante - 40) {
        raus.push(`${t.textContent.slice(0, 24)} @${Math.round(b.x)},${Math.round(b.y)}`);
      }
    }
    // Überdecken sich zwei Texte? Der Rahmen-Test allein reicht nicht: Im
    // ersten Entwurf lief die große Prozentzahl über den Zeitraum, beide
    // sauber INNERHALB des Rahmens. Gesehen hat es erst das Auge.
    const kaesten = [...document.querySelectorAll('text')].map((t) => ({
      t: t.textContent.slice(0, 20), b: t.getBBox(),
    }));
    const ueberlappt = [];
    for (let i = 0; i < kaesten.length; i++) {
      for (let k = i + 1; k < kaesten.length; k++) {
        const a = kaesten[i].b, c = kaesten[k].b;
        const dx = Math.min(a.x + a.width, c.x + c.width) - Math.max(a.x, c.x);
        const dy = Math.min(a.y + a.height, c.y + c.height) - Math.max(a.y, c.y);
        if (dx > 2 && dy > 2) ueberlappt.push(`"${kaesten[i].t}" / "${kaesten[k].t}"`);
      }
    }

    // Sitzt das Siegel in seinem Kasten? Der Rahmen ist fest 232 px breit;
    // die Überlappungs-Prüfung oben sieht ihn nicht, weil sie nur <text>
    // gegen <text> vergleicht. Ein Siegel, das über seinen Rahmen läuft, ist
    // genau der Schaden, den der Rahmen verhindern soll.
    let siegelRaus = '';
    const sT = document.querySelector('[data-rolle="siegel"]');
    const sR = document.querySelector('[data-rolle="siegelRahmen"]');
    if (!sT || !sR) {
      if (siegelErwartet) siegelRaus = 'Siegel oder Rahmen fehlt';
    } else {
      const bt = sT.getBBox();
      const br = sR.getBBox();
      if (bt.x < br.x + 6 || bt.x + bt.width > br.x + br.width - 6) {
        siegelRaus = `"${sT.textContent}" ${Math.round(bt.width)} px in ${Math.round(br.width)} px`;
      }
    }

    // Rastern auf demselben Weg wie die App — schlägt das fehl, ist der
    // Teilen-Knopf kaputt.
    let pngLaenge = 0;
    let pngFehler = '';
    try { pngLaenge = await window.__png(); } catch (e) { pngFehler = String(e); }
    return { raus, ueberlappt, siegelRaus, texte: kaesten.length, pngLaenge, pngFehler };
  }, { kante: KARTE, siegelErwartet: karte.id !== 'cta' });

  await seite.screenshot({ path: `${SHOTS}/share-${name}.png` });
  console.log(name, JSON.stringify({ ...mass, raus: mass.raus.length ? mass.raus : 'keine', ueberlappt: mass.ueberlappt.length ? mass.ueberlappt : 'keine' }));

  if (mass.raus.length) fehler.push(`${name}: Text außerhalb des Rahmens — ${mass.raus.join('; ')}`);
  if (mass.ueberlappt.length) fehler.push(`${name}: Texte überdecken sich — ${mass.ueberlappt.join('; ')}`);
  if (mass.siegelRaus) fehler.push(`${name}: Siegel passt nicht in seinen Rahmen — ${mass.siegelRaus}`);
  if (mass.texte < (karte.id === 'cta' ? 8 : 10)) fehler.push(`${name}: nur ${mass.texte} Textelemente`);
  if (mass.pngFehler) fehler.push(`${name}: Rastern fehlgeschlagen — ${mass.pngFehler}`);
  if (mass.pngLaenge < 5000) fehler.push(`${name}: PNG verdächtig klein (${mass.pngLaenge})`);
  await seite.close();
  }
}
}

await browser.close();
if (fehler.length) {
  console.error('FEHLER:\n' + fehler.map((f) => ` · ${f}`).join('\n'));
  process.exit(1);
}
console.log(`OK — Bilder in ${SHOTS}`);
