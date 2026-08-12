/**
 * Was darf die Teilen-Karte behaupten?
 *
 * ── Der Befund (Owner-Screenshot 12.08.) ──────────────────────────────────
 *
 * Die Karte zeigte „MEIN DEPOT 0,00 %" in GRÜN, während direkt darunter
 * stand: „noch kein Zeitraum · 0,00 USD" — und direkt daneben:
 *
 *   TRADES 9 · TREFFERQUOTE 33,3 % · PROFIT-FAKTOR 0,12 · Ø −191,06 $
 *
 * Profit-Faktor 0,12 heißt acht verlorene Dollar je gewonnenem. Wer diese
 * Grafik teilt, teilt eine Aussage, die das Gegenteil der eigenen Zahlen
 * behauptet — und sie trägt „autotrd.net · Automatisierter Handel, offen
 * nachgerechnet" im Fuß.
 *
 * ── Warum es passieren konnte ─────────────────────────────────────────────
 *
 * Zwei Datenquellen, eine leer: Die Prozentzahl kam aus der Equity-Kurve
 * (keine Snapshots ⇒ 0), die Kennzahlen aus den Trades (neun vorhanden).
 * Dieselbe Fehlerfamilie wie beim Chart-Prüfstand — eine Sache, zwei
 * Antworten. Dazu ein zweiter Fehler in der Farbe: `renditePct >= 0` färbt
 * die Null grün, obwohl eine Null kein Gewinn ist.
 *
 * ── Die Regel ─────────────────────────────────────────────────────────────
 *
 * Ohne Zeitraum keine Prozentzahl. Fehlt die Kurve, zeigt die Karte, was sie
 * HAT — die realisierte Trade-Bilanz mit ihrem echten Zeitraum — und nie
 * eine Null, die wie ein neutrales Ergebnis aussieht. Liegt gar nichts vor,
 * sagt sie das und wird nicht zum Teilen angeboten.
 *
 * Die Farbe folgt der AUSSAGE, nicht dem Vorzeichen einer Zahl: Wo nichts
 * behauptet wird, ist sie neutral.
 */

/** Woraus die Karte ihre Kopfzeile bildet. */
export interface AussageEingabe {
  /** Tage der Equity-Kurve — ab zwei ist eine Rendite berechenbar. */
  kurventage: number;
  /** Rendite über das Fenster in Prozent (nur mit Kurve sinnvoll). */
  renditePct: number;
  /**
   * Absolutes Ergebnis der KURVE — die Zahl, die zur Rendite gehört.
   *
   * Bewusst getrennt von `tradeBilanz`: Bei vorhandener Kurve muss unter der
   * Prozentzahl der Betrag stehen, aus dem sie gebildet wurde. Die
   * Trade-Bilanz ist eine andere Größe (nur realisiert) — beide in dieselbe
   * Zeile zu mischen wäre wieder „eine Sache, zwei Antworten".
   */
  ergebnis: number;
  /** Geschlossene Trades im Fenster. */
  trades: number;
  /** Summe der realisierten Ergebnisse im Fenster. */
  tradeBilanz: number;
  /** Erster und letzter Handelstag (ISO), wenn es Trades gibt. */
  vonTag?: string | undefined;
  bisTag?: string | undefined;
  /** Beträge einblenden — steuert, ob die Bilanz beziffert werden darf. */
  betraege: boolean;
  waehrung: string;
}

export type AussageTon = 'gruen' | 'rot' | 'neutral';

export interface Aussage {
  /** Die große Zeile. */
  haupt: string;
  ton: AussageTon;
  /** Die Zeile darunter — Zeitraum oder Erklärung. */
  unter: string;
  /**
   * Darf die Karte geteilt werden?
   *
   * Eine Grafik ohne belastbare Aussage ist kein Ergebnis, sondern ein
   * leeres Formular mit einem Markenlogo. Der Knopf verschwindet, statt ein
   * Bild zu erzeugen, das nichts sagt und trotzdem nach Track-Record
   * aussieht.
   */
  teilbar: boolean;
  /** Wenn nicht teilbar: warum nicht (für den Hinweis neben dem Knopf). */
  grund?: string;
}

const komma = (v: number, n = 2): string => v.toFixed(n).replace('.', ',').replace('-', '−');
const mitVz = (v: number, n = 2): string =>
  `${v > 0 ? '+' : v < 0 ? '−' : ''}${komma(Math.abs(v), n)}`;

/**
 * Ton einer Zahl — eine Null ist NEUTRAL, nicht grün.
 *
 * Das ist der Kern des Anlassfalls: `>= 0` machte aus „keine Aussage" ein
 * Gewinn-Grün. Null ist kein Gewinn, und in der überwiegenden Zahl der Fälle
 * heißt sie hier ohnehin „nicht gerechnet".
 */
export function tonVon(wert: number): AussageTon {
  if (!Number.isFinite(wert) || wert === 0) return 'neutral';
  return wert > 0 ? 'gruen' : 'rot';
}

/** Zeitraum in Tagen, einschließlich beider Enden. */
function tageSpanne(von: string | undefined, bis: string | undefined): number | null {
  if (!von || !bis) return null;
  const a = Date.parse(`${von}T00:00:00Z`);
  const b = Date.parse(`${bis}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function kartenAussage(e: AussageEingabe): Aussage {
  const zeitraumText =
    e.vonTag && e.bisTag && e.vonTag !== e.bisTag
      ? `${e.vonTag} → ${e.bisTag}`
      : (e.vonTag ?? e.bisTag ?? '');

  // ── Fall 1: echte Kurve ⇒ Rendite in Prozent ────────────────────────────
  if (e.kurventage >= 2 && Number.isFinite(e.renditePct)) {
    return {
      haupt: `${mitVz(e.renditePct, 2)} %`,
      ton: tonVon(e.renditePct),
      unter:
        (zeitraumText || 'Zeitraum unbekannt')
        + (e.betraege ? ` · ${mitVz(e.ergebnis)} ${e.waehrung}` : ' · Beträge ausgeblendet'),
      teilbar: true,
    };
  }

  // ── Fall 2: keine Kurve, aber Abschlüsse ⇒ Trade-Bilanz statt Prozent ───
  //
  // Prozent wäre hier eine Erfindung: Ohne Kurve gibt es keine Bezugsgröße,
  // gegen die man eine Rendite bilden könnte. Die Bilanz dagegen ist
  // gemessen — sie steht in denselben Trades, aus denen die Kennzahlen
  // daneben stammen.
  if (e.trades > 0) {
    const tage = tageSpanne(e.vonTag, e.bisTag);
    const spanne = tage === null ? '' : ` über ${tage} ${tage === 1 ? 'Tag' : 'Tage'}`;
    return {
      haupt: e.betraege
        ? `${mitVz(e.tradeBilanz)} ${e.waehrung}`
        : `${e.trades} ${e.trades === 1 ? 'Trade' : 'Trades'}`,
      ton: tonVon(e.tradeBilanz),
      unter: e.betraege
        ? `${e.trades} ${e.trades === 1 ? 'Trade' : 'Trades'}${spanne} · noch keine Tageskurve`
        : `${zeitraumText || 'Zeitraum unbekannt'}${spanne ? '' : ''} · Beträge ausgeblendet`,
      teilbar: true,
    };
  }

  // ── Fall 3: nichts ⇒ nichts behaupten ───────────────────────────────────
  return {
    haupt: '—',
    ton: 'neutral',
    unter: 'Noch keine abgeschlossenen Trades',
    teilbar: false,
    grund: 'Zum Teilen braucht die Karte mindestens einen abgeschlossenen Trade.',
  };
}
