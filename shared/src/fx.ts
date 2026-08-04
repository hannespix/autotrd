/**
 * Währungsumrechnung für die deutsche Steuerrechnung (M12b).
 *
 * ── Die Falle, um die es hier geht ────────────────────────────────────────
 *
 * Ein US-Trade wird in Dollar abgerechnet, die Steuererklärung braucht Euro.
 * Der naheliegende Weg — Ergebnis in Dollar rechnen, am Ende umrechnen — ist
 * **unzulässig**. Anschaffung und Veräußerung sind zwei getrennte Vorgänge,
 * jeder wird zum Kurs SEINES Tages umgerechnet. Der Unterschied ist kein
 * Rundungsdetail:
 *
 *   Kauf   1.000 $ bei 1,10 $/€  →  909,09 €
 *   Verkauf 1.000 $ bei 1,05 $/€ →  952,38 €
 *
 * In Dollar ein Nullsummen-Geschäft, in Euro ein Gewinn von 43,29 € — und
 * genau der ist steuerpflichtig. Wer am Ergebnis umrechnet, bekommt null
 * heraus und erklärt zu wenig.
 *
 * ── Warum der Kurs im Trade EINGEFROREN wird ──────────────────────────────
 *
 * Ein Kurs, der bei jedem Bericht neu geholt wird, macht historische
 * Ergebnisse beweglich: Derselbe Trade ergäbe im Januar eine andere Zahl als
 * im März. Für eine Steuererklärung ist das untragbar — abgegebene Zahlen
 * müssen reproduzierbar bleiben. Deshalb schreibt der Trade `fxRate`,
 * `fxDate` und `fxSource` mit und niemand rechnet sie je neu.
 *
 * ── Konvention ───────────────────────────────────────────────────────────
 *
 * Die EZB veröffentlicht Referenzkurse als „Fremdwährung je 1 EUR"
 * (1 EUR = 1,0850 USD). Diese Datei hält sich daran, weil jede eigene
 * Konvention beim Vergleich mit der veröffentlichten Tabelle zu einem
 * Kehrwert-Fehler einlädt — und ein gekippter Kurs verschiebt jedes
 * Ergebnis um Faktor 1,18 statt es leicht zu verzerren.
 */

/** Ein Referenzkurs, so wie er im Trade eingefroren wird. */
export interface FxKurs {
  /** Tag, für den der Kurs veröffentlicht wurde (YYYY-MM-DD). */
  date: string;
  /** Fremdwährungseinheiten je 1 EUR — EZB-Konvention. */
  rate: number;
  /** Herkunft, z. B. 'ecb'. Steht im Bericht, damit sie prüfbar ist. */
  source: string;
}

/**
 * Wie weit zurückgegriffen werden darf, wenn für den Handelstag kein Kurs
 * existiert.
 *
 * Die EZB veröffentlicht an Wochenenden und TARGET-Feiertagen nicht — Krypto
 * handelt aber durch. Für einen Sonntags-Trade gibt es also nie einen Kurs
 * desselben Tages; der letzte veröffentlichte ist der übliche und
 * anerkannte Ersatz. Sieben Tage decken auch die längste Feiertagslücke ab
 * (Weihnachten/Neujahr) und sind kurz genug, dass ein ausgefallener
 * Kurs-Abruf auffällt, statt still durchzulaufen.
 */
export const FX_MAX_RUECKGRIFF_TAGE = 7;

/** Fremdwährungsbetrag in Euro, auf Cent gerundet. */
export function nachEur(betrag: number, rate: number): number {
  if (!Number.isFinite(betrag) || !Number.isFinite(rate) || rate <= 0) return Number.NaN;
  return Math.round((betrag / rate) * 100) / 100;
}

/**
 * Passenden Kurstag zu einem Handelstag wählen.
 *
 * Nimmt den jüngsten verfügbaren Tag, der NICHT nach dem Handelstag liegt —
 * niemals einen späteren. Ein Kurs von morgen wäre Lookahead, derselbe
 * Fehler wie in der Prognose-Auswertung, nur in Euro.
 */
export function fxTagFuer(
  handelsTag: string,
  verfuegbar: readonly string[],
  maxTage: number = FX_MAX_RUECKGRIFF_TAGE,
): string | null {
  const ziel = Date.parse(`${handelsTag}T00:00:00Z`);
  if (!Number.isFinite(ziel)) return null;
  let beste: string | null = null;
  let besteZeit = -Infinity;
  for (const tag of verfuegbar) {
    const t = Date.parse(`${tag}T00:00:00Z`);
    if (!Number.isFinite(t) || t > ziel) continue;
    if (ziel - t > maxTage * 86_400_000) continue;
    if (t > besteZeit) {
      besteZeit = t;
      beste = tag;
    }
  }
  return beste;
}

/** Kontowährung — alles andere braucht einen Kurs. */
export const BASIS_WAEHRUNG = 'EUR';

/** Braucht dieser Betrag überhaupt eine Umrechnung? */
export function brauchtUmrechnung(waehrung: string | undefined): boolean {
  return (waehrung ?? 'USD').toUpperCase() !== BASIS_WAEHRUNG;
}

/**
 * Euro-Betrag eines Vorgangs — oder `null`, wenn er nicht belegbar ist.
 *
 * `null` statt einer Schätzung ist Absicht: Ein erfundener Kurs sieht in
 * der Ausgabe genauso aus wie ein echter, und im Zweifel merkt es niemand.
 * Eine fehlende Zahl fällt auf und wird nachgetragen.
 */
export function eurBetrag(
  betrag: number,
  waehrung: string | undefined,
  kurs: FxKurs | null | undefined,
): number | null {
  if (!Number.isFinite(betrag)) return null;
  if (!brauchtUmrechnung(waehrung)) return Math.round(betrag * 100) / 100;
  if (!kurs || !(kurs.rate > 0)) return null;
  const eur = nachEur(betrag, kurs.rate);
  return Number.isFinite(eur) ? eur : null;
}

/**
 * Rohantwort der EZB-Tagesreferenz in ein Kursobjekt übersetzen.
 *
 * Bewusst hier und nicht in der Cloud Function: Das Parsen einer fremden
 * Datenquelle ist genau die Stelle, an der ein Feldname sich ändert und
 * niemand es merkt — mit Tests fällt es beim nächsten Lauf auf.
 */
export function leseFxAntwort(roh: unknown, waehrung = 'USD'): FxKurs | null {
  if (!roh || typeof roh !== 'object') return null;
  const o = roh as Record<string, unknown>;
  const date = o['date'];
  const rates = o['rates'];
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!rates || typeof rates !== 'object') return null;
  const rate = (rates as Record<string, unknown>)[waehrung.toUpperCase()];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
  return { date, rate, source: 'ecb' };
}
