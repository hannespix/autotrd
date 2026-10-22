/**
 * Layout-Prüfstand für die Karte „Kurzfrist-Umkehr" (Task 34).
 *
 * Baut die Karte aus DEMSELBEN Modul wie die App (`umkehrKarte.ts`:
 * Gerüst + Befüllen) und derselben `theme.css`, mit der vollsten
 * realistischen Belegung: 10 Käufe + 3 Verkäufe im Plan, 8 Signale,
 * Krypto wartet auf die Kerze, alle vier „Nicht gekauft"-Gründe, Hinweis
 * „anderer Modus". Deutsch UND Englisch, Desktop (1500) UND Telefon (390),
 * dazu die schmale Seitenspalte (280).
 *
 *   node frontend/e2e/umkehr-shot.mjs
 *
 * Rot bei: Zeile breiter als die Karte, Zellen, die einander überlappen
 * (Text gegen Text UND Zelle gegen Zelle), waagerechtem Seiten-Scroll,
 * Symbol ohne `data-sym`.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHOTS = process.env.SMOKE_SHOTS ?? '/tmp/autotrd-umkehr';
const CHROME = process.env.SMOKE_CHROME;
mkdirSync(SHOTS, { recursive: true });

const BUNDLE = `${SHOTS}/karte.mjs`;
execFileSync(
  'npx',
  ['esbuild', 'frontend/e2e/umkehr-entry.ts', '--bundle', '--format=esm', `--outfile=${BUNDLE}`, '--log-level=warning'],
  { stdio: 'inherit' },
);
const { umkehrGeruest, umkehrRendern } = await import(BUNDLE);

const STATUS = {
  abend: {
    at: '2026-10-21T20:45:00Z',
    tag: '2026-10-21',
    signaleN: 9,
    signale: [
      ['DBA', 2.72], ['XLE', 3.4], ['^NDX', 4.1], ['SMH', 5.9], ['GOOGL', 6.2], ['TLT', 7.7], ['XLF', 8.8], ['EWJ', 9.6], ['IWM', 9.9],
    ].map(([symbol, rsi]) => ({ symbol, rsi })),
  },
  morgen: { at: '2026-10-22T13:35:00Z', konten: 7, kaeufe: 12, verkaeufe: 3, ohneKauf: { gehalten: 7, bargeldOderPlatz: 4, gesperrt: 2, abgelehnt: 1 } },
  krypto: { at: '2026-10-22T04:10:20Z', tag: '2026-10-20', soll: '2026-10-21', veraltet: true, kaeufe: 2, signale: [{ symbol: 'AVAX-USD', rsi: 1.2 }] },
};
const PLAN = {
  tag: '2026-10-21',
  ausgefuehrtAm: null,
  kaufen: STATUS.abend.signale.slice(0, 7).concat([{ symbol: 'BTC-USD', rsi: 1.1 }, { symbol: 'ETH-USD', rsi: 3.3 }, { symbol: 'BRK-B', rsi: 8.0 }]),
  verkaufen: [
    { symbol: 'META', grund: 'umkehr_erholt' },
    { symbol: 'QQQ', grund: 'umkehr_frist' },
    { symbol: 'SOL-USD', grund: 'umkehr_erholt' },
  ],
};

const css = readFileSync('frontend/src/theme.css', 'utf8');
const symFn = (s) => `<span class="sym-link" data-sym="${s}" role="link" tabindex="0">${s}</span>`;

function seiteHtml(sprache, breiteKarte) {
  globalThis.localStorage = { getItem: () => sprache, setItem: () => undefined };
  return `<!doctype html><html lang="${sprache}" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><div class="wrap" style="padding:12px;max-width:${breiteKarte}px">${umkehrGeruest('<button class="ibtn">i</button>')}</div>
</body></html>`;
}

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const fehler = [];

for (const sprache of ['de', 'en']) {
  for (const [name, breite, karte] of [
    ['desktop', 1500, 480],
    ['seitenspalte', 1500, 304],
    ['phone', 390, 390],
  ]) {
    const datei = `${SHOTS}/umkehr-${sprache}-${name}.html`;
    writeFileSync(datei, seiteHtml(sprache, karte));
    const seite = await browser.newPage({ viewport: { width: breite, height: 900 }, reducedMotion: 'reduce' });
    seite.on('pageerror', (e) => fehler.push(`${sprache}/${name}: pageerror ${e.message}`));
    await seite.goto(pathToFileURL(datei).href);
    // Befüllen mit dem ECHTEN umkehrRendern — im Node-Prozess gerechnet,
    // als fertiges innerHTML/textContent je id übertragen.
    globalThis.localStorage = { getItem: () => sprache, setItem: () => undefined };
    const ziel = {};
    const el = (id) => (ziel[id] ??= { textContent: '', innerHTML: '', hidden: false });
    umkehrRendern(el, STATUS, PLAN, 'confluence', symFn);
    await seite.evaluate((z) => {
      for (const [id, w] of Object.entries(z)) {
        const e = document.getElementById(id);
        if (w.innerHTML) e.innerHTML = w.innerHTML;
        else e.textContent = w.textContent;
        e.hidden = w.hidden;
      }
    }, ziel);

    const mass = await seite.evaluate(() => {
      const karte = document.querySelector('[data-panel="umkehr"]');
      const zeilen = [...document.querySelectorAll('.uk-row')];
      const ueberlauf = zeilen.filter((z) => z.scrollWidth - z.clientWidth > 0.5).length;
      const kollisionen = [];
      for (const z of zeilen) {
        const r = [...z.children].map((e) => e.getBoundingClientRect());
        for (let i = 1; i < r.length; i++) {
          // Zelle gegen Zelle: nebeneinander dürfen sie sich nicht schneiden.
          if (r[i].left < r[i - 1].right - 0.5 && r[i].top < r[i - 1].bottom - 0.5) kollisionen.push(z.textContent.slice(0, 40));
        }
        const zr = z.getBoundingClientRect();
        for (const c of r) if (c.right > zr.right + 0.5 || c.left < zr.left - 0.5) kollisionen.push(`raus: ${z.textContent.slice(0, 30)}`);
      }
      // Spaltenflucht (Bildbefund 22.10.): Die 2. Zelle beginnt in ALLEN
      // Zeilen einer Tabelle an derselben x-Position — sonst springt
      // „Kauf" mit der Länge des Symbols davor.
      const flucht = [];
      for (const tbl of karte.querySelectorAll('.uk-tbl')) {
        const xs = [...tbl.querySelectorAll(':scope > .uk-row')].map((z) => Math.round(z.children[1].getBoundingClientRect().left));
        if (new Set(xs).size > 1) flucht.push(`${tbl.id}: ${[...new Set(xs)].join('/')}`);
      }
      const symbole = [...karte.querySelectorAll('.uk-row > span:first-child')].filter((s) => !s.closest('.uk-lauf'));
      const ohneDataSym = symbole.filter((s) => !s.querySelector('[data-sym]')).length;
      return {
        karteBreite: Math.round(karte.getBoundingClientRect().width),
        seiteScroll: document.documentElement.scrollWidth,
        fenster: window.innerWidth,
        zeilen: zeilen.length,
        ueberlauf,
        kollisionen,
        ohneDataSym,
        flucht,
      };
    });
    await seite.screenshot({ path: `${SHOTS}/umkehr-${sprache}-${name}.png`, fullPage: true });
    console.log(sprache, name, JSON.stringify(mass));
    const tag = `${sprache}/${name}`;
    if (mass.zeilen !== 13 + 8 + 3) fehler.push(`${tag}: ${mass.zeilen} Zeilen statt 24`);
    if (mass.ueberlauf) fehler.push(`${tag}: ${mass.ueberlauf} Zeilen laufen über`);
    if (mass.kollisionen.length) fehler.push(`${tag}: Kollision ${mass.kollisionen.join(' | ')}`);
    if (mass.flucht.length) fehler.push(`${tag}: Spalten fluchten nicht (${mass.flucht.join(' | ')})`);
    if (mass.ohneDataSym) fehler.push(`${tag}: ${mass.ohneDataSym} Symbole ohne data-sym`);
    if (mass.seiteScroll > mass.fenster + 1) fehler.push(`${tag}: Seite scrollt waagerecht`);
    await seite.close();
  }
}
await browser.close();
if (fehler.length) {
  console.error('FEHLER:\n' + fehler.map((f) => ` · ${f}`).join('\n'));
  process.exit(1);
}
console.log(`OK — Bilder in ${SHOTS}`);
