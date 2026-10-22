/**
 * Layout-Prüfstand für die Karte „Kurzfrist-Umkehr" (Task 34).
 *
 * Baut die Karte aus DEMSELBEN Modul wie die App (`umkehrKarte.ts`:
 * Gerüst + Befüllen) und derselben `theme.css` — fünfmal, je ein
 * Zustand, der live vorkommt: Plan offen (10 Käufe + 3 Verkäufe, Krypto
 * frisch), Plan abgearbeitet (mit Kaufsperre, Depot teils gefüllt),
 * Krypto wartet nach 14:10 UTC, Engine gestoppt, noch keine Daten.
 * Deutsch UND Englisch, Desktop (1500), Telefon (390) und die schmale
 * Seitenspalte (280); Uhrzeiten in Europe/Berlin wie bei den Nutzern.
 *
 *   node frontend/e2e/umkehr-shot.mjs
 *
 * Rot bei: Zeile breiter als die Karte, Zellen, die einander überlappen,
 * Spalten, die nicht fluchten, Kennzahlen auf verschiedenen Höhen,
 * waagerechtem Seiten-Scroll, Symbol ohne `data-sym` — und bei den
 * inhaltlichen Riegeln aus der Prüfung vom 22.10.: nie „ausgeführt",
 * „normal" nicht ohne Abendplan, kein Plan bei gestoppter Engine.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Uhrzeiten wie bei den Nutzern (sonst zeigt das Bild UTC, Prüfbefund 22.10.).
process.env.TZ = 'Europe/Berlin';

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

// Realistische Zustände (Prüfbefund 22.10.: die erste Fassung zeigte Krypto
// im Plan — das kommt nie vor, der Abendlauf plant nur Börsenwerte).
const SIGNALE = [
  ['DBA', 2.72], ['XLE', 3.4], ['^NDX', 4.1], ['SMH', 5.9], ['GOOGL', 6.2], ['TLT', 7.7], ['XLF', 8.8], ['EWJ', 9.6], ['IWM', 9.9],
].map(([symbol, rsi]) => ({ symbol, rsi }));
const ABEND = { at: '2026-10-21T20:45:00Z', tag: '2026-10-21', signaleN: 9, signale: SIGNALE };
const KRYPTO_FRISCH = { at: '2026-10-22T00:10:00Z', tag: '2026-10-21', veraltet: false, kaeufe: 3, verkaeufe: 1, signale: [{ symbol: 'AVAX-USD', rsi: 1.2 }, { symbol: 'SOL-USD', rsi: 4.4 }], ohneKauf: { gehalten: 2 } };
const MORGEN_VOR = { at: '2026-10-21T13:35:00Z', konten: 7, kaeufe: 4, verkaeufe: 2, ohneKauf: { gehalten: 3 } };
const MORGEN_NACH = { at: '2026-10-22T13:35:00Z', konten: 7, kaeufe: 12, verkaeufe: 3, ohneKauf: { gehalten: 7, bargeldOderPlatz: 4, gesperrt: 2, abgelehnt: 1 } };
const PLAN = {
  tag: '2026-10-21',
  erstelltAt: '2026-10-21T20:45:30Z',
  ausgefuehrtAm: null,
  kaufen: SIGNALE.slice(0, 7).concat([{ symbol: 'BRK-B', rsi: 8.0 }, { symbol: 'NVDA', rsi: 8.4 }, { symbol: 'EFA', rsi: 9.1 }]),
  verkaufen: [
    { symbol: 'META', grund: 'umkehr_erholt' },
    { symbol: 'QQQ', grund: 'umkehr_frist' },
    { symbol: 'AAPL', grund: 'umkehr_erholt' },
  ],
};
const OK = { mode: 'umkehr', running: true, echtgeld: false };
const JETZT = Date.parse('2026-10-22T15:00:00Z');

/** [Name, Status, Plan, Konto, gehalten, erwartete uk-row-Zeilen] */
const SZENEN = [
  ['offen', { abend: ABEND, morgen: MORGEN_VOR, krypto: KRYPTO_FRISCH }, PLAN, OK, [], 13 + 8 + 3],
  ['bearbeitet', { abend: ABEND, morgen: MORGEN_NACH, krypto: KRYPTO_FRISCH }, { ...PLAN, ausgefuehrtAm: '2026-10-22', einstiegGesperrt: 'tages_notbremse' }, OK, ['DBA', 'XLE', 'QQQ'], 13 + 8 + 3],
  ['kryptoSpaet', { abend: ABEND, morgen: MORGEN_NACH, krypto: { at: '2026-10-22T14:10:05Z', tag: '2026-10-20', soll: '2026-10-21', veraltet: true, kaeufe: 2 } }, null, OK, [], 8 + 3],
  ['gestoppt', { abend: ABEND, morgen: MORGEN_NACH }, PLAN, { ...OK, running: false }, [], 8 + 3],
  ['leer', null, null, OK, [], 3],
];

const css = readFileSync('frontend/src/theme.css', 'utf8');
const symFn = (s) => `<span class="sym-link" data-sym="${s}" role="link" tabindex="0">${s}</span>`;

/** Inhalt je Szene mit dem ECHTEN umkehrRendern (im Node-Prozess) berechnen. */
function inhalt(sprache, [, status, plan, konto, gehalten]) {
  globalThis.localStorage = { getItem: () => sprache, setItem: () => undefined };
  const ziel = {};
  const el = (id) => (ziel[id] ??= { textContent: '', innerHTML: '', hidden: false });
  umkehrRendern(el, status, plan, konto, new Set(gehalten), symFn, JETZT);
  return ziel;
}

function seiteHtml(sprache, breiteKarte) {
  globalThis.localStorage = { getItem: () => sprache, setItem: () => undefined };
  const karten = SZENEN.map(([name]) => `<div class="szene" data-szene="${name}" style="margin-bottom:16px">${umkehrGeruest('<button class="ibtn">i</button>')}</div>`).join('');
  return `<!doctype html><html lang="${sprache}" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><div class="wrap" style="padding:12px;max-width:${breiteKarte}px">${karten}</div></body></html>`;
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
    const seite = await browser.newPage({ viewport: { width: breite, height: 900 }, reducedMotion: 'reduce', timezoneId: 'Europe/Berlin' });
    seite.on('pageerror', (e) => fehler.push(`${sprache}/${name}: pageerror ${e.message}`));
    await seite.goto(pathToFileURL(datei).href);
    const fuellung = Object.fromEntries(SZENEN.map((sz) => [sz[0], inhalt(sprache, sz)]));
    await seite.evaluate((f) => {
      for (const [szene, z] of Object.entries(f)) {
        const karte = document.querySelector(`[data-szene="${szene}"]`);
        for (const [id, w] of Object.entries(z)) {
          const e = karte.querySelector(`#${id}`);
          if (w.innerHTML) e.innerHTML = w.innerHTML;
          else e.textContent = w.textContent;
          e.hidden = w.hidden;
        }
      }
    }, fuellung);

    const mass = await seite.evaluate(() => {
      const ergebnis = {};
      for (const szene of document.querySelectorAll('[data-szene]')) {
        const karte = szene.querySelector('[data-panel="umkehr"]');
        const zeilen = [...karte.querySelectorAll('.uk-row')];
        const kollisionen = [];
        for (const z of zeilen) {
          const r = [...z.children].map((e) => e.getBoundingClientRect());
          for (let i = 1; i < r.length; i++) {
            if (r[i].width > 0 && r[i - 1].width > 0 && r[i].left < r[i - 1].right - 0.5 && r[i].top < r[i - 1].bottom - 0.5) kollisionen.push(z.textContent.slice(0, 40));
          }
          const zr = z.getBoundingClientRect();
          for (const c of r) if (c.right > zr.right + 0.5 || c.left < zr.left - 0.5) kollisionen.push(`raus: ${z.textContent.slice(0, 30)}`);
        }
        // Spaltenflucht (Bildbefund 22.10.): Die 2. Zelle beginnt in ALLEN
        // Zeilen einer Tabelle an derselben x-Position.
        const flucht = [];
        for (const tbl of karte.querySelectorAll('.uk-tbl')) {
          const xs = [...tbl.querySelectorAll(':scope > .uk-row')].map((z) => Math.round(z.children[1].getBoundingClientRect().left));
          if (new Set(xs).size > 1) flucht.push(`${tbl.id}: ${[...new Set(xs)].join('/')}`);
        }
        const symbole = [...karte.querySelectorAll('.uk-row > span:first-child')].filter((s) => !s.closest('.uk-lauf'));
        // Kennzahlen: Werte auf EINER Linie, auch wenn Bezeichnungen umbrechen.
        const werte = [...karte.querySelectorAll('.uk-zahlen .smv')].map((e) => Math.round(e.getBoundingClientRect().bottom));
        ergebnis[szene.dataset.szene] = {
          zeilen: zeilen.length,
          ueberlauf: zeilen.filter((z) => z.scrollWidth - z.clientWidth > 0.5).length,
          kollisionen,
          flucht,
          ohneDataSym: symbole.filter((s) => !s.querySelector('[data-sym]')).length,
          werteVersatz: Math.max(...werte) - Math.min(...werte),
          text: karte.innerText,
        };
      }
      return { ergebnis, seiteScroll: document.documentElement.scrollWidth, fenster: window.innerWidth };
    });
    await seite.screenshot({ path: `${SHOTS}/umkehr-${sprache}-${name}.png`, fullPage: true });
    // Je Zustand ein Einzelbild in Originalgröße — das Gesamtbild ist zum
    // Ansehen zu klein (Prüfregel §6: das Bild ansehen, nicht nur messen).
    for (const [szene] of SZENEN) {
      await seite.locator(`[data-szene="${szene}"]`).screenshot({ path: `${SHOTS}/umkehr-${sprache}-${name}-${szene}.png` });
    }
    const tag = `${sprache}/${name}`;
    for (const [szene, , , , , erwartet] of SZENEN) {
      const m = mass.ergebnis[szene];
      const { text, ...kurz } = m;
      console.log(tag, szene, JSON.stringify(kurz));
      const t2 = `${tag}/${szene}`;
      if (m.zeilen !== erwartet) fehler.push(`${t2}: ${m.zeilen} Zeilen statt ${erwartet}`);
      if (m.ueberlauf) fehler.push(`${t2}: ${m.ueberlauf} Zeilen laufen über`);
      if (m.kollisionen.length) fehler.push(`${t2}: Kollision ${m.kollisionen.join(' | ')}`);
      if (m.flucht.length) fehler.push(`${t2}: Spalten fluchten nicht (${m.flucht.join(' | ')})`);
      if (m.ohneDataSym) fehler.push(`${t2}: ${m.ohneDataSym} Symbole ohne data-sym`);
      if (m.werteVersatz > 1) fehler.push(`${t2}: Kennzahlen stehen ${m.werteVersatz}px versetzt`);
      // Inhaltliche Riegel aus den Prüfbefunden — im gerenderten Text.
      if (/ausgeführt|executed/i.test(text)) fehler.push(`${t2}: behauptet „ausgeführt"`);
      if (szene === 'leer' && /normal/i.test(text)) fehler.push(`${t2}: „normal" ohne Abendplan`);
      if (szene === 'gestoppt' && /META|QQQ/.test(text.split(/Kaufsignale|Buy signals/i)[0])) fehler.push(`${t2}: Plan trotz gestoppter Engine`);
    }
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
