/**
 * Teilbare Ergebnis-Grafik („roast my Depot", Owner-Wunsch 10.08.).
 *
 * ── Warum das eigene Regeln braucht ───────────────────────────────────────
 *
 * Diese Grafik verlässt die App. Sie landet auf Reddit, Discord oder X, wo
 * niemand nachfragen kann, was die Zahlen bedeuten. Zwei Dinge sind deshalb
 * keine Geschmacksfragen, sondern eingebaut:
 *
 *  1. **Das Papier-Siegel ist nicht abschaltbar.** Solange das Konto auf
 *     Papier handelt, steht „PAPIERKONTO" auf dem Bild. Eine Grafik, die wie
 *     ein echter Track-Record aussieht, ist ein Falschzeugnis — auch dann,
 *     wenn der Absender es nicht so meint. Schaltet das Konto auf Echtgeld,
 *     ändert sich das Wort, nicht die Regel.
 *  2. **Beträge sind standardmäßig AUS.** Prozente sagen alles, was eine
 *     Leistung beschreibt; die Kontogröße gehört niemandem außer dem
 *     Besitzer. Wer sie zeigen will, schaltet sie an — nicht umgekehrt.
 *
 * ── Warum literale Farben statt CSS-Variablen ─────────────────────────────
 *
 * Das SVG wird serialisiert, in ein `Image` geladen und auf eine Canvas
 * gezeichnet. In diesem Moment gibt es kein Dokument mehr, aus dem `var(--gn)`
 * aufgelöst werden könnte — alle Farben wären schwarz. Deshalb steht hier
 * eine eigene, geschlossene Palette. Sie ist an die App angelehnt, aber
 * bewusst unabhängig: Das Bild muss auch dann stimmen, wenn jemand das Theme
 * umbaut.
 */
import { type DepotZerlegung, stapelBaender } from '@autotrd/shared';
import { esc } from './html.js';
import { kartenAussage } from './shareAussage.js';

/** Kantenlänge der quadratischen Karte — passt ohne Zuschnitt überall hin. */
export const KARTE = 1200;

const FARBE = {
  bg: '#0b1016',
  karte: '#121a24',
  linie: '#233042',
  text: '#e8eef6',
  text2: '#9fb0c4',
  text3: '#63758a',
  gruen: '#34c77b',
  rot: '#ff5f5f',
  akzent: '#25d0ee',
} as const;

export interface ShareDaten {
  /** Zerlegung des Fensters — liefert Kurve, Zeitraum und Bänder. */
  zerlegung: DepotZerlegung;
  /** Gesamtergebnis über das Fenster in Prozent der Bezugsgröße. */
  renditePct: number;
  /** Absolutes Ergebnis; wird nur gezeigt, wenn `betraege` an ist. */
  ergebnis: number;
  waehrung: string;
  trefferquotePct: number | null;
  profitFaktor: number | null;
  trades: number;
  maxDrawdownPct: number | null;
  /** Bestes und schlechtestes Symbol im Fenster. */
  bestes: { label: string; pct: number } | null;
  schlechtestes: { label: string; pct: number } | null;
  /** `false` ⇒ Papierkonto. Das Siegel richtet sich danach. */
  echtgeld: boolean;
  /** Beträge einblenden — Standard aus. */
  betraege: boolean;
  /**
   * Summe der realisierten Ergebnisse im Fenster (Owner-Befund 12.08.).
   *
   * Ohne Kurve gibt es keine Bezugsgröße für eine Rendite — dann tritt diese
   * Zahl an ihre Stelle. Sie ist gemessen und stammt aus denselben Trades
   * wie die Kennzahlen darunter; eine Prozentzahl wäre hier erfunden.
   */
  tradeBilanz: number;
  /** Erster/letzter Handelstag im Fenster (ISO) — für „über N Tage". */
  vonTag?: string | undefined;
  bisTag?: string | undefined;
}

/** Deutsches Komma UND typografisches Minus — ein ASCII-Bindestrich neben
 *  einem echten Minus in derselben Grafik sieht nach Versehen aus. */
const zahl = (v: number, n = 2): string => v.toFixed(n).replace('.', ',').replace('-', '−');
const mitVorzeichen = (v: number, n = 2): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${zahl(Math.abs(v), n)}`;

/**
 * Schriftgröße der Hauptzeile, damit sie in den Rahmen passt.
 *
 * Die nutzbare Breite ist 1020 px (90 … 1110). Der erste Ansatz rechnete mit
 * 0,62 em je Zeichen und ragte weiter über den Rand — bei `font-weight: 800`
 * sind Ziffern deutlich breiter als in einer normalen Schnitt-Schätzung.
 * Jetzt 0,8 em: bewusst großzügig, denn zu klein ist hier folgenlos und zu
 * groß ein Überlauf auf einem Bild, das die App verlässt. Der Bild-Prüfstand
 * misst das Ergebnis nach — er hat beide Fassungen bewertet.
 */
function hauptGroesse(text: string): number {
  const max = 140;
  const passt = Math.floor(1020 / (Math.max(1, text.length) * 0.8));
  return Math.max(64, Math.min(max, passt));
}

/** Die Kurve als Pfad, auf ein Rechteck skaliert. */
function kurvenPfad(
  werte: number[],
  x: number,
  y: number,
  b: number,
  h: number,
): { linie: string; flaeche: string } {
  if (werte.length < 2) return { linie: '', flaeche: '' };
  const min = Math.min(...werte);
  const max = Math.max(...werte);
  const spanne = max - min || 1;
  const punkte = werte.map((v, i) => {
    const px = x + (i / (werte.length - 1)) * b;
    const py = y + h - ((v - min) / spanne) * h;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });
  return {
    linie: punkte.join(' '),
    flaeche: `${x},${y + h} ${punkte.join(' ')} ${x + b},${y + h}`,
  };
}

/** Ein Kennzahl-Block. */
function kpi(x: number, y: number, label: string, wert: string, farbe: string = FARBE.text): string {
  return (
    `<text x="${x}" y="${y}" fill="${FARBE.text3}" font-size="26" letter-spacing="1.5">${esc(label.toUpperCase())}</text>`
    + `<text x="${x}" y="${y + 52}" fill="${farbe}" font-size="46" font-weight="700">${esc(wert)}</text>`
  );
}

/**
 * Baut die Karte als eigenständiges SVG (keine externen Verweise, keine
 * CSS-Variablen) — bereit zum Rastern auf eine Canvas.
 */
export function shareCard(d: ShareDaten): string {
  const z = d.zerlegung;
  /* Was diese Karte behaupten DARF (Owner-Befund 12.08.).
   *
   * Vorher stand hier `positiv = d.renditePct >= 0` — und damit erschien
   * eine Rendite von 0,00 % in Gewinn-Grün, obwohl sie nur bedeutete, dass
   * mangels Kurve gar nichts gerechnet wurde. Daneben standen neun Trades
   * mit Profit-Faktor 0,12. Die Regel steckt jetzt in `kartenAussage`:
   * ohne Zeitraum keine Prozentzahl, und eine Null ist neutral. */
  const aussage = kartenAussage({
    kurventage: z.tage.length,
    renditePct: d.renditePct,
    ergebnis: d.ergebnis,
    trades: d.trades,
    tradeBilanz: d.tradeBilanz,
    /* Der Zeitraum muss zu der Zahl gehören, die darüber steht.
     *
     * Mit Kurve ist das ihr Zeitraum — er ist die Grundlage der Rendite.
     * Ohne Kurve treten die Handelstage an seine Stelle, denn dann zeigt die
     * Karte die Trade-Bilanz. Beides zu mischen wäre derselbe Fehler, der
     * den Anlassfall erzeugt hat: eine Zahl aus der einen Quelle, ihr
     * Zeitraum aus der anderen. */
    vonTag: z.tage.length >= 2 ? z.tage[0] : d.vonTag,
    bisTag: z.tage.length >= 2 ? z.tage[z.tage.length - 1] : d.bisTag,
    betraege: d.betraege,
    waehrung: d.waehrung,
  });
  const haupt =
    aussage.ton === 'gruen' ? FARBE.gruen : aussage.ton === 'rot' ? FARBE.rot : FARBE.text2;
  const { linie, flaeche } = kurvenPfad(z.equity, 90, 430, KARTE - 180, 260);
  const siegel = d.echtgeld ? 'ECHTGELD' : 'PAPIERKONTO';

  // Die drei stärksten Bänder als Streifen unter der Kurve — sie beantworten
  // die Frage, um die es beim Teilen geht: womit eigentlich?
  const flaechen = stapelBaender(z)
    .filter((f) => f.key !== '__offen__' && f.summe !== 0)
    .slice(0, 3);
  const gesamtBetrag = flaechen.reduce((s, f) => s + Math.abs(f.summe), 0) || 1;
  let sx = 90;
  const streifen = flaechen
    .map((f) => {
      const w = (Math.abs(f.summe) / gesamtBetrag) * (KARTE - 180);
      const teil =
        `<rect x="${sx.toFixed(1)}" y="740" width="${Math.max(2, w - 6).toFixed(1)}" height="14" rx="7"`
        + ` fill="${f.summe >= 0 ? FARBE.gruen : FARBE.rot}" opacity="0.85"></rect>`
        + `<text x="${sx.toFixed(1)}" y="796" fill="${FARBE.text2}" font-size="26">${esc(f.label)}</text>`;
      sx += w;
      return teil;
    })
    .join('');

  /*
   * Vier gleich breite Spalten innerhalb des Rahmens (90 … 1110).
   *
   * Der erste Entwurf setzte sie auf 90/370/650/930 — und „MAX-DRAWDOWN"
   * ragte damit rechts über die Karte hinaus. Aufgefallen ist das dem
   * Bild-Prüfstand, nicht dem Auge und keinem Unit-Test: Im SVG-Quelltext
   * sieht eine x-Koordinate von 930 unauffällig aus, erst die gerenderte
   * Textbreite verrät den Überlauf.
   */
  const spalte = (KARTE - 180) / 4;
  const kpis = [
    kpi(90, 880, 'Trades', String(d.trades)),
    kpi(90 + spalte, 880, 'Trefferquote', d.trefferquotePct === null ? '—' : `${zahl(d.trefferquotePct, 1)} %`),
    kpi(90 + 2 * spalte, 880, 'Profit-Faktor', d.profitFaktor === null ? '—' : zahl(d.profitFaktor)),
    kpi(
      90 + 3 * spalte,
      880,
      'Max-Drawdown',
      d.maxDrawdownPct === null ? '—' : `${zahl(d.maxDrawdownPct, 1)} %`,
      d.maxDrawdownPct !== null && d.maxDrawdownPct < -10 ? FARBE.rot : FARBE.text,
    ),
  ].join('');

  const bestZeile = [d.bestes, d.schlechtestes]
    .map((e, i) =>
      e === null
        ? ''
        : `<text x="${90 + i * 560}" y="1030" fill="${FARBE.text3}" font-size="26">`
          + `${i === 0 ? 'Bestes' : 'Schwächstes'}</text>`
          + `<text x="${90 + i * 560}" y="1072" fill="${e.pct >= 0 ? FARBE.gruen : FARBE.rot}" font-size="34" font-weight="600">`
          + `${esc(e.label)} ${esc(mitVorzeichen(e.pct, 1))} %</text>`,
    )
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KARTE}" height="${KARTE}" viewBox="0 0 ${KARTE} ${KARTE}"`
    + ` font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">`
    + `<rect width="${KARTE}" height="${KARTE}" fill="${FARBE.bg}"></rect>`
    + `<rect x="40" y="40" width="${KARTE - 80}" height="${KARTE - 80}" rx="36" fill="${FARBE.karte}"></rect>`
    // Kopf
    + `<text x="90" y="140" fill="${FARBE.text2}" font-size="30" letter-spacing="3">MEIN DEPOT</text>`
    + `<rect x="${KARTE - 90 - 232}" y="104" width="232" height="46" rx="23" fill="none" stroke="${FARBE.text3}" stroke-width="2"></rect>`
    + `<text x="${KARTE - 90 - 116}" y="136" fill="${FARBE.text3}" font-size="24" letter-spacing="2" text-anchor="middle">${esc(siegel)}</text>`
    // Hauptzahl
    /* Schriftgröße nach Textlänge (Bild-Prüfstand 12.08.).
     *
     * „+6,40 %" sind sieben Zeichen, „−1719,54 USD" sind zwölf — bei
     * font-size 140 ragt die zweite Fassung rechts aus dem Rahmen. Im
     * SVG-Quelltext sieht man davon nichts; gefunden hat es der
     * Bild-Prüfstand, der die gerenderten Textkästen misst. Seit die Karte
     * auch Beträge in die Kopfzeile setzen kann, ist die Länge nicht mehr
     * konstant und die Größe muss mitgehen. */
    /* `data-rolle="haupt"` ist der Griff, an dem Tests die große Zeile
     * fassen. Vorher suchten sie `font-size="140"` — seit die Größe von der
     * Textlänge abhängt, fand dieser Griff die Zeile bei langen Beträgen
     * nicht mehr und ein Test schlug fehl, obwohl die Karte stimmte. Ein
     * Prüfstand, der sein Prüfobjekt nur zufällig trifft, ist keiner. */
    + `<text data-rolle="haupt" x="90" y="290" fill="${haupt}" font-size="${hauptGroesse(aussage.haupt)}" font-weight="800">${esc(aussage.haupt)}</text>`
    /*
     * Zeitraum und Betrag stehen in EINER Zeile unter der großen Zahl.
     *
     * Der erste Entwurf setzte den Zeitraum rechts auf dieselbe Höhe wie die
     * Prozentzahl und den Betrag knapp darunter. Beides überlappte: Ein Text
     * mit Schriftgröße 140 belegt rund 120 px Höhe und über 700 px Breite,
     * davon sieht man im SVG-Quelltext nichts. Der Bild-Prüfstand vergleicht
     * seitdem alle Textkästen paarweise — er hat beide Kollisionen gefunden.
     */
    + `<text x="90" y="356" fill="${FARBE.text2}" font-size="30">${esc(aussage.unter)}</text>`
    // Kurve
    + (linie
      ? `<polygon points="${flaeche}" fill="${haupt}" opacity="0.14"></polygon>`
        + `<polyline points="${linie}" fill="none" stroke="${haupt}" stroke-width="5" stroke-linejoin="round"></polyline>`
      : `<text x="90" y="560" fill="${FARBE.text3}" font-size="30">Noch zu wenige Tage für eine Kurve</text>`)
    // Beitrags-Streifen
    /* „WOMIT" nur, wenn darunter auch etwas steht. Eine Überschrift über
     * einer leeren Fläche sieht aus, als sei die Grafik kaputt — und im
     * Anlassfall war sie das auch. */
    + (streifen
      ? `<text x="90" y="716" fill="${FARBE.text3}" font-size="26" letter-spacing="1.5">WOMIT</text>`
      : '')
    + streifen
    + kpis
    + bestZeile
    // Fuß
    + `<line x1="90" y1="1108" x2="${KARTE - 90}" y2="1108" stroke="${FARBE.linie}" stroke-width="2"></line>`
    + `<text x="90" y="1152" fill="${FARBE.akzent}" font-size="34" font-weight="700">autotrd.net</text>`
    + `<text x="${KARTE - 90}" y="1152" fill="${FARBE.text3}" font-size="26" text-anchor="end">`
    + `Automatisierter Handel, offen nachgerechnet</text>`
    + '</svg>'
  );
}

/**
 * Der Begleittext beim Teilen.
 *
 * Er trägt denselben Vorbehalt wie das Bild: Wer den Text ohne Grafik
 * weiterreicht, soll trotzdem wissen, worum es sich handelt.
 */
export function shareText(d: ShareDaten): string {
  const art = d.echtgeld ? '' : ' (Papierkonto)';
  const zeit =
    d.zerlegung.tage.length >= 2
      ? ` ${d.zerlegung.tage[0]} bis ${d.zerlegung.tage[d.zerlegung.tage.length - 1]}`
      : '';
  const quote = d.trefferquotePct === null ? '' : `, Trefferquote ${zahl(d.trefferquotePct, 1)} %`;
  return (
    `Mein Depot${art}:${zeit} ${mitVorzeichen(d.renditePct, 2)} % über ${d.trades} Trades${quote}.`
    + ' Gebaut und nachgerechnet mit autotrd.net'
  );
}

/** Dateiname des Exports — Datum drin, damit mehrere Bilder unterscheidbar sind. */
export function shareDateiname(d: ShareDaten): string {
  const bis = d.zerlegung.tage[d.zerlegung.tage.length - 1] ?? 'aktuell';
  return `autotrd-depot-${bis}.png`;
}
