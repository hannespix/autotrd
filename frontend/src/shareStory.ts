/**
 * Die Teilen-STORY: mehrere Karten statt einer (Owner-Wunsch 20.08. —
 * „nacheinander bzw. klickbar alle coolen Grafiken, einfügbar in Social
 * Media, neugierig machen").
 *
 * Jede Karte ist ein eigenständiges 1200×1200-SVG nach den Regeln von
 * `shareCard.ts` (Kopf dort): literale Farben, Papier-Siegel auf allem, was
 * Zahlen zeigt, Beträge nur auf Wunsch. Die Portale nehmen keine SVGs an —
 * geteilt wird das PNG-Raster; das SVG ist die verlustfreie Quelle.
 *
 * Karten, deren Daten fehlen, entfallen ersatzlos: Eine leere Grafik mit
 * Markenlogo sieht aus wie ein kaputtes Werkzeug — genau das Gegenteil von
 * „neugierig machen".
 *
 * Die CTA-Karte ist die einzige ohne Nutzerzahlen — und das ist einklagbar:
 * Sie darf KEINE Ziffer enthalten (Wächter-Test). Eine Werbekarte mit einer
 * Beispiel-Rendite wäre ein erfundener Track-Record.
 */
import { stapelBaender } from '@autotrd/shared';
import { esc } from './html.js';
import { t } from './i18n.js';
import { seiteGewaehlt, type SeitenId } from './seiten.js';
import {
  FARBE,
  KARTE,
  mitVorzeichen,
  shareCard,
  siegelBreite,
  zahl,
  type ShareDaten,
  type SharePosition,
} from './shareCard.js';

export interface StoryKarte {
  id: 'ergebnis' | 'depot' | 'verlauf' | 'womit' | 'cta';
  svg: string;
}

/* Band-Farben nach BEDEUTUNG, nicht nach Reihenfolge: Gewinner grün-,
 * Verlierer rotstufig, der offene Anteil im Akzent. Eine bunte Palette wäre
 * hübscher und stumm — die Frage der Grafik ist, was aufbaut und was abträgt.
 * Die Töne sind bewusst weit gespreizt (Owner-Screenshot 20.08.: bei sechs
 * Gewinnern war „welches Symbol ist welche Fläche" nicht zu beantworten);
 * jenseits der Liste wird ZYKLISCH gefärbt, nie auf dem letzten Ton
 * zusammengeklemmt — genau das Klemmen hatte alle Flächen gleich gefärbt. */
const GRUEN_STUFEN = ['#1f9d5b', '#5cd699', '#a9ecd0', '#3f9d8a', '#7ee0c3', '#d6f5e6'] as const;
const ROT_STUFEN = ['#e04848', '#ff8a7a', '#ffc0b2', '#b8626a'] as const;

const kopfhoehe = 160;

/** Kopfzeile + Siegel — identisch auf jeder Zahlen-Karte. */
function kopfMitSiegel(titel: string, echtgeld: boolean): string {
  const siegel = echtgeld ? t('share.siegelEchtgeld') : t('share.siegelPapier');
  const b = siegelBreite(siegel);
  return (
    `<text x="90" y="140" fill="${FARBE.text2}" font-size="30" letter-spacing="3">${esc(titel.toUpperCase())}</text>`
    + `<rect data-rolle="siegelRahmen" x="${KARTE - 90 - b}" y="104" width="${b}" height="46" rx="23" fill="none" stroke="${FARBE.text3}" stroke-width="2"></rect>`
    + `<text data-rolle="siegel" x="${KARTE - 90 - b / 2}" y="136" fill="${FARBE.text3}" font-size="24" letter-spacing="2" text-anchor="middle">${esc(siegel)}</text>`
  );
}

function rahmen(inhalt: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KARTE}" height="${KARTE}" viewBox="0 0 ${KARTE} ${KARTE}"`
    + ` font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">`
    + `<rect width="${KARTE}" height="${KARTE}" fill="${FARBE.bg}"></rect>`
    + `<rect x="40" y="40" width="${KARTE - 80}" height="${KARTE - 80}" rx="36" fill="${FARBE.karte}"></rect>`
    + inhalt
    + `<line x1="90" y1="1108" x2="${KARTE - 90}" y2="1108" stroke="${FARBE.linie}" stroke-width="2"></line>`
    + `<text x="90" y="1152" fill="${FARBE.akzent}" font-size="34" font-weight="700">autotrd.net</text>`
    + `<text x="${KARTE - 90}" y="1152" fill="${FARBE.text3}" font-size="26" text-anchor="end">${esc(t('share.fuss'))}</text>`
    + '</svg>'
  );
}

/** Sonderbänder tragen im shared-Code deutsche Labels — hier wie im
 *  Depot-Chart über den KEY übersetzt (gleiche Wörterbuch-Einträge). */
export function bandName(key: string, label: string, trades: number): string {
  if (key === '__offen__') return t('dc.offenePositionen');
  if (key === '__rest__') return `${t('dc.uebrige')} (${trades})`;
  return label;
}

/**
 * EINE Farbzuweisung je Band — Fläche, Legenden-Chip und (seit dem Video)
 * jede animierte Fassung ziehen aus derselben Map. Zyklisch statt geklemmt
 * (Owner-Befund 20.08.: sechs Gewinner, alle im selben Hellgrün).
 */
export function bandFarben(gezeichnet: ReadonlyArray<{ key: string; summe: number }>): Map<string, string> {
  let gruenIdx = 0;
  let rotIdx = 0;
  const farben = new Map<string, string>();
  for (const f of gezeichnet) {
    farben.set(
      f.key,
      f.key === '__offen__'
        ? FARBE.akzent
        : f.summe >= 0
          ? GRUEN_STUFEN[gruenIdx++ % GRUEN_STUFEN.length]!
          : ROT_STUFEN[rotIdx++ % ROT_STUFEN.length]!,
    );
  }
  return farben;
}

/**
 * Karte „Mein Depot JETZT" (Owner 21.08., 21:14: „aktives Depot zum Teilen,
 * ähnlich Handelsanalyse — roast my portfolio").
 *
 * Der Unterschied zu allen anderen Karten: Diese zeigt keinen Rückblick,
 * sondern den STAND. Drei Regeln, die daraus folgen:
 *
 *  1. **Richtung steht dran.** Ein Short mit +4 % und ein Long mit +4 % sehen
 *     als Zahl gleich aus und sind gegenteilige Wetten. Pfeil UND Wort
 *     tragen sie (wie im Trade-Verlauf), der gestrichelte Rahmen markiert
 *     die Short-Seite auch ohne Farbsehen.
 *  2. **Kein Kurs ⇒ keine Zahl.** Eine Position ohne Kurs bekommt „—" in
 *     neutralem Grau, nie eine grüne Null (dieselbe Regel wie in
 *     `shareAussage.ts`).
 *  3. **Stückzahlen sind Beträge.** Sie verraten mit dem Kurs die
 *     Positionsgröße und stehen deshalb unter dem Beträge-Schalter.
 */
function depotKarte(d: ShareDaten): string {
  const pos = (d.positionen ?? []).slice();
  // Größter Gewinner zuerst — die Karte soll beim Überfliegen eine Ordnung
  // haben; ohne Kurs bewertete Zeilen ans Ende (sie behaupten nichts).
  pos.sort((a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity));
  const MAX = 7;
  const zeilen = pos.slice(0, MAX);
  const rest = pos.length - zeilen.length;

  const y0 = 300;
  const schritt = 104;
  /* Achse + Balkenlänge müssen VOR der Prozent-Spalte enden: „−100,0 %" ist
   * bei 34 px fett ~175 px breit und endet rechtsbündig bei 1110, beginnt
   * also bei ~935. Balken-über-Text sieht der Bild-Prüfstand nicht (er misst
   * Text gegen Text) — deshalb hier Reserve statt Hoffnung. */
  const achse = 760;
  /* Die Richtungs-Marke steht in einer FESTEN Spalte, nicht direkt hinter
   * dem Symbolnamen (Bild-Befund 21.08.): Aus der Zeichenzahl geschätzte
   * Textbreiten liegen bei „BTC-USD" oder „MSFT" daneben, und das Tag lief
   * mitten durch den Namen. Der Bild-Prüfstand kann das nicht fangen — er
   * misst Text gegen Text, nicht Rechteck gegen Text (derselbe Grund, aus
   * dem die WOMIT-Achse rechts der Label-Spalte sitzt). 340 liegt hinter
   * zehn fetten Zeichen à 38 px; länger wird nicht gezeigt. */
  const TAG_SPALTE = 340;
  const halb = 120;
  const maxPct = Math.max(...zeilen.map((p) => Math.abs(p.pnlPct ?? 0)), 1);

  const zeile = (p: SharePosition, i: number): string => {
    const y = y0 + i * schritt;
    const hat = p.pnlPct !== null;
    const farbe = !hat ? FARBE.text3 : p.pnlPct! > 0 ? FARBE.gruen : p.pnlPct! < 0 ? FARBE.rot : FARBE.text2;
    const w = hat ? (Math.abs(p.pnlPct!) / maxPct) * halb : 0;
    const richtung = p.short ? `▼ ${t('share.depotShort')}` : `▲ ${t('share.depotLong')}`;
    const richtungFarbe = p.short ? FARBE.rot : FARBE.gruen;
    // Tag-Breite grob aus der Zeichenzahl — SVG kann nicht messen.
    const tagBreite = richtung.length * 15 + 26;
    // Über `zahl()`, nicht `toFixed` — sonst stünde „118.40 → 131.02" mit
    // Punkt direkt neben „+10,7 %" mit Komma, in derselben Zeile derselben
    // Karte. Aufgefallen erst im gerenderten Bild (Zusammenspiel-Prüfung
    // 21.08.): Depot-Karte und Zahlenformat entstanden am selben Abend in
    // zwei getrennten Änderungen und liefen aneinander vorbei.
    const kurse = `${zahl(p.einstieg)} → ${p.aktuell === null ? '—' : zahl(p.aktuell)}`;
    const menge = d.betraege ? `${p.qty} × ` : '';
    return (
      `<text x="90" y="${y}" fill="${FARBE.text}" font-size="38" font-weight="700">${esc(p.symbol.slice(0, 10))}</text>`
      + `<rect x="${TAG_SPALTE}" y="${y - 30}" width="${tagBreite}" height="40" rx="20"`
      + ` fill="none" stroke="${richtungFarbe}" stroke-width="2"${p.short ? ' stroke-dasharray="5 4"' : ''}></rect>`
      + `<text x="${TAG_SPALTE + tagBreite / 2}" y="${y - 2}" fill="${richtungFarbe}"`
      + ` font-size="24" text-anchor="middle">${esc(richtung)}</text>`
      + `<text x="90" y="${y + 36}" fill="${FARBE.text3}" font-size="26">${esc(menge + kurse)}</text>`
      + `<rect x="${(p.pnlPct !== null && p.pnlPct >= 0 ? achse : achse - w).toFixed(1)}" y="${y - 24}"`
      + ` width="${Math.max(hat ? 3 : 0, w).toFixed(1)}" height="32" rx="16" fill="${farbe}" opacity="0.85"></rect>`
      + `<text x="${KARTE - 90}" y="${y + 2}" fill="${farbe}" font-size="34" font-weight="700" text-anchor="end">`
      + `${esc(hat ? `${mitVorzeichen(p.pnlPct!, 1)} %` : '—')}</text>`
      + (d.betraege && p.pnl !== null
        ? `<text x="${KARTE - 90}" y="${y + 36}" fill="${FARBE.text3}" font-size="24" text-anchor="end">${esc(`${mitVorzeichen(p.pnl)} ${d.waehrung}`)}</text>`
        : '')
    );
  };

  const kopfZahl = `${pos.length} ${t(pos.length === 1 ? 'share.depotEine' : 'share.depotOffene')}`;
  const quote =
    typeof d.investiertPct === 'number' && Number.isFinite(d.investiertPct)
      ? ` · ${d.investiertPct.toFixed(0)} % ${t('share.depotInvestiert')}`
      : '';

  return rahmen(
    kopfMitSiegel(t('share.storyDepot'), d.echtgeld)
    + `<text x="90" y="${kopfhoehe + 40}" fill="${FARBE.text3}" font-size="26">${esc(kopfZahl + quote)}</text>`
    + `<line x1="${achse}" y1="${y0 - 50}" x2="${achse}" y2="${y0 + zeilen.length * schritt - 60}" stroke="${FARBE.linie}" stroke-width="2"></line>`
    + zeilen.map(zeile).join('')
    + (rest > 0
      ? `<text x="90" y="${y0 + zeilen.length * schritt + 8}" fill="${FARBE.text3}" font-size="28">+${rest} ${esc(t('share.depotWeitere'))}</text>`
      : ''),
  );
}

/** Karte 2 — der zerlegte Verlauf: Wasserfall-Bänder unter der Depot-Linie. */
function verlaufKarte(d: ShareDaten): string {
  const z = d.zerlegung;
  const n = z.tage.length;
  const flaechen = stapelBaender(z);

  const x0 = 90;
  const breite = KARTE - 180;
  const y0 = 250;
  const hoehe = 470;

  // Wertebereich relativ zur Bezugslinie: alle Bandkanten, die Linie, die Null.
  let min = 0;
  let max = 0;
  for (const f of flaechen) {
    for (const [u, o] of f.kanten) {
      min = Math.min(min, u);
      max = Math.max(max, o);
    }
  }
  for (const v of z.equity) {
    min = Math.min(min, v - z.basis);
    max = Math.max(max, v - z.basis);
  }
  const spanne = max - min || 1;
  const px = (i: number): number => x0 + (n < 2 ? 0 : (i / (n - 1)) * breite);
  const py = (v: number): number => y0 + hoehe - ((v - min) / spanne) * hoehe;

  /* EINE Farbzuweisung für Fläche, Beschriftung und Legenden-Chip — vorher
   * trugen die Chips nur Vorzeichen-Grün/Rot, während die Flächen gestufte
   * Töne hatten: sechs identische grüne Chips neben sechs verschiedenen
   * Flächen (Owner-Screenshot 20.08., „kann nicht sehen, welches Symbol zu
   * welcher Linie gehört"). */
  const gezeichnet = flaechen.filter((f) => f.kanten.some(([u, o]) => o - u > 0));
  const farbeVon = bandFarben(gezeichnet);
  const baenderSvg = gezeichnet
    .map((f) => {
      const oben = f.kanten.map(([, o], i) => `${px(i).toFixed(1)},${py(o).toFixed(1)}`);
      const unten = f.kanten.map(([u], i) => `${px(i).toFixed(1)},${py(u).toFixed(1)}`).reverse();
      return `<polygon points="${oben.join(' ')} ${unten.join(' ')}" fill="${farbeVon.get(f.key)!}" opacity="0.55"></polygon>`;
    })
    .join('');

  /* Symbolname DIREKT in die Fläche, wo sie dick genug ist — die Legende
   * bleibt als Rückfallebene für schmale Bänder. Kollidierende Etiketten
   * entfallen zugunsten des zuerst gesetzten (der Bild-Prüfstand misst
   * Text-gegen-Text nach). */
  const gesetzt: Array<{ x: number; y: number }> = [];
  const etiketten = gezeichnet
    .map((f) => {
      let besterIdx = 0;
      let besteHoehe = 0;
      f.kanten.forEach(([u, o], i) => {
        const h = py(u) - py(o);
        if (h > besteHoehe) {
          besteHoehe = h;
          besterIdx = i;
        }
      });
      if (besteHoehe < 40) return '';
      const [u, o] = f.kanten[besterIdx]!;
      const name = bandName(f.key, f.label, f.trades).slice(0, 18);
      // Halbe geschätzte Textbreite als Rand-Klammer — ein mittig verankertes
      // Etikett ragt sonst bei langen Namen aus dem Rahmen (Bild-Prüfstand).
      const halbBreit = name.length * 8 + 8;
      const ex = Math.min(Math.max(px(besterIdx), x0 + halbBreit), x0 + breite - halbBreit);
      const ey = (py(u) + py(o)) / 2 + 9;
      if (gesetzt.some((g) => Math.abs(g.x - ex) < 150 && Math.abs(g.y - ey) < 34)) return '';
      gesetzt.push({ x: ex, y: ey });
      /* Heller Text mit Kontur-Ring (paint-order) statt dunklem Text: Die
       * Bandtöne reichen von hell bis dunkel — EIN Element, damit der
       * Bild-Prüfstand keine Doppel-Texte als Kollision zählt. */
      return `<text x="${ex.toFixed(1)}" y="${ey.toFixed(1)}" fill="${FARBE.text}" stroke="${FARBE.karte}" stroke-width="5" paint-order="stroke" stroke-linejoin="round" font-size="26" font-weight="700" text-anchor="middle">${esc(name)}</text>`;
    })
    .join('');

  const linie = z.equity.map((v, i) => `${px(i).toFixed(1)},${py(v - z.basis).toFixed(1)}`).join(' ');
  const nullY = py(0);

  // Legende: ALLE gezeichneten Bänder (bis zu 10 in zwei Spalten) — eine
  // Fläche ohne Legenden-Eintrag wäre wieder ein Ratespiel.
  const pctVon = (summe: number): string =>
    z.basis > 0 ? `${mitVorzeichen((summe / z.basis) * 100, 1)} %` : '';
  const legende = gezeichnet
    .slice(0, 10)
    .map((f, i) => {
      const farbe = farbeVon.get(f.key)!;
      const lx = 90 + (i % 2) * 520;
      const ly = 820 + Math.floor(i / 2) * 56;
      const name = bandName(f.key, f.label, f.trades).slice(0, 22);
      return (
        `<rect x="${lx}" y="${ly - 20}" width="22" height="22" rx="5" fill="${farbe}" opacity="0.9"></rect>`
        + `<text x="${lx + 36}" y="${ly}" fill="${FARBE.text}" font-size="28">${esc(name)}</text>`
        + `<text x="${lx + 480}" y="${ly}" fill="${f.summe >= 0 ? FARBE.gruen : FARBE.rot}" font-size="28" font-weight="600" text-anchor="end">${esc(pctVon(f.summe))}</text>`
      );
    })
    .join('');

  return rahmen(
    kopfMitSiegel(t('share.storyVerlauf'), d.echtgeld)
    + `<text x="90" y="${kopfhoehe + 40}" fill="${FARBE.text3}" font-size="26">${esc(z.tage[0] ?? '')} → ${esc(z.tage[n - 1] ?? '')} · ${esc(t('share.storyBasis'))}</text>`
    + baenderSvg
    + `<line x1="${x0}" y1="${nullY.toFixed(1)}" x2="${x0 + breite}" y2="${nullY.toFixed(1)}" stroke="${FARBE.text3}" stroke-width="2" stroke-dasharray="6 6"></line>`
    + `<polyline points="${linie}" fill="none" stroke="${FARBE.text}" stroke-width="5" stroke-linejoin="round"></polyline>`
    + etiketten
    + legende,
  );
}

/** Karte 3 — Beitrag je Symbol als Balken um die Mittelachse. */
function womitKarte(d: ShareDaten): string {
  const z = d.zerlegung;
  const reihen = [...z.baender]
    .filter((b) => b.key !== '__rest__')
    .sort((a, b) => b.summe - a.summe)
    .slice(0, 7);
  const maxBetrag = Math.max(...reihen.map((r) => Math.abs(r.summe)), 1);

  /* Die Achse sitzt RECHTS der Label-Spalte (Symbole bis 12 Zeichen enden
   * bei ~320 px) — ein negativer Maximal-Balken darf nie unter den Text
   * laufen. Der Bild-Prüfstand sieht nur Text-gegen-Text-Kollisionen,
   * Balken-über-Text muss die Geometrie selbst ausschließen. */
  const mitte = 640;
  const halb = 280;
  const zeilen = reihen
    .map((r, i) => {
      const y = 320 + i * 100;
      const w = (Math.abs(r.summe) / maxBetrag) * halb;
      const farbe = r.summe >= 0 ? FARBE.gruen : FARBE.rot;
      const wert =
        z.basis > 0
          ? `${mitVorzeichen((r.summe / z.basis) * 100, 1)} %`
          : d.betraege
            ? `${mitVorzeichen(r.summe)} ${d.waehrung}`
            : '';
      return (
        `<text x="90" y="${y + 8}" fill="${FARBE.text}" font-size="32" font-weight="600">${esc(r.label.slice(0, 12))}</text>`
        + `<text x="90" y="${y + 44}" fill="${FARBE.text3}" font-size="22">${r.trades} ${esc(t(r.trades === 1 ? 'share.einTrade' : 'share.trades'))}</text>`
        + `<rect x="${(r.summe >= 0 ? mitte : mitte - w).toFixed(1)}" y="${y - 16}" width="${Math.max(3, w).toFixed(1)}" height="34" rx="17" fill="${farbe}" opacity="0.85"></rect>`
        + `<text x="${KARTE - 90}" y="${y + 8}" fill="${farbe}" font-size="30" font-weight="600" text-anchor="end">${esc(wert)}</text>`
      );
    })
    .join('');

  return rahmen(
    kopfMitSiegel(t('share.storyWomit'), d.echtgeld)
    + `<text x="90" y="${kopfhoehe + 40}" fill="${FARBE.text3}" font-size="26">${esc(z.tage[0] ?? d.vonTag ?? '')} → ${esc(z.tage[z.tage.length - 1] ?? d.bisTag ?? '')} · ${d.trades} ${esc(t(d.trades === 1 ? 'share.einTrade' : 'share.trades'))}</text>`
    + `<line x1="${mitte}" y1="270" x2="${mitte}" y2="${320 + reihen.length * 100 - 40}" stroke="${FARBE.linie}" stroke-width="2"></line>`
    + zeilen,
  );
}

/** Karte 4 — die Einladung. Bewusst OHNE jede Ziffer (Kopf dieser Datei). */
function ctaKarte(): string {
  const merkmale = [t('share.ctaF1'), t('share.ctaF2'), t('share.ctaF3'), t('share.ctaF4')];
  const zeilen = merkmale
    .map((m, i) => {
      const y = 560 + i * 96;
      return (
        `<circle cx="112" cy="${y - 10}" r="22" fill="none" stroke="${FARBE.gruen}" stroke-width="3"></circle>`
        + `<path d="M ${101} ${y - 10} l 8 9 l 15 -18" fill="none" stroke="${FARBE.gruen}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>`
        + `<text x="160" y="${y}" fill="${FARBE.text2}" font-size="31">${esc(m)}</text>`
      );
    })
    .join('');

  // Kein „MEIN DEPOT"-Kopf: Diese Karte zeigt das Werkzeug, nicht ein Depot.
  return rahmen(
    `<text x="90" y="330" font-size="128" font-weight="800" fill="${FARBE.text}">AUTO<tspan fill="${FARBE.gruen}">TRD</tspan></text>`
    + `<text x="90" y="410" fill="${FARBE.text2}" font-size="36">${esc(t('share.ctaClaim1'))}</text>`
    + `<text x="90" y="462" fill="${FARBE.text2}" font-size="36">${esc(t('share.ctaClaim2'))}</text>`
    + zeilen
    + `<text x="90" y="1024" fill="${FARBE.akzent}" font-size="40" font-weight="700">${esc(t('share.ctaLos'))}</text>`,
  );
}

/**
 * Die Story in Lese-Reihenfolge: Ergebnis → Verlauf → Womit → Einladung.
 * Verlauf und Womit erscheinen nur, wenn ihre Daten sie tragen.
 */
export function shareStory(d: ShareDaten, auswahl?: readonly SeitenId[]): StoryKarte[] {
  /* ZWEI Bedingungen je Karte, und sie bedeuten Verschiedenes:
   *
   *   `seiteGewaehlt` — will der Nutzer sie sehen?
   *   die Datenprüfung — hat sie überhaupt etwas zu zeigen?
   *
   * Beide müssen erfüllt sein, und keine ersetzt die andere. Eine
   * abgewählte Karte fehlt, weil jemand das so wollte; eine Karte ohne
   * Daten fehlt, weil sie sonst leer wäre (Kopf dieser Datei: eine leere
   * Grafik ist ein kaputtes Werkzeug). */
  const karten: StoryKarte[] = [];
  const dran = (id: StoryKarte['id']): boolean => seiteGewaehlt(id, auswahl);

  if (dran('ergebnis')) karten.push({ id: 'ergebnis', svg: shareCard(d) });
  // Das aktive Depot direkt hinter dem Ergebnis: Es ist die Karte, nach der
  // in „roast my portfolio"-Fäden gefragt wird — was hältst du GERADE?
  if (dran('depot') && (d.positionen?.length ?? 0) > 0) {
    karten.push({ id: 'depot', svg: depotKarte(d) });
  }
  if (dran('verlauf') && d.zerlegung.tage.length >= 2) {
    karten.push({ id: 'verlauf', svg: verlaufKarte(d) });
  }
  if (dran('womit') && d.zerlegung.baender.some((b) => b.key !== '__rest__' && b.summe !== 0)) {
    karten.push({ id: 'womit', svg: womitKarte(d) });
  }
  if (dran('cta')) karten.push({ id: 'cta', svg: ctaKarte() });
  return karten;
}

/** Dateiname je Karte — Karten-Art und Endtag, damit ein Karussell-Ordner sortiert. */
export function storyDateiname(id: StoryKarte['id'], d: ShareDaten): string {
  const bis = d.zerlegung.tage[d.zerlegung.tage.length - 1] ?? d.bisTag ?? 'aktuell';
  return `autotrd-${id}-${bis}.png`;
}

