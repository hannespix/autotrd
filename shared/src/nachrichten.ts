/**
 * Nachrichten zwischen Kunde und Admin (Owner-Auftrag 22.08.).
 *
 * "Man soll eine Möglichkeit haben, dem Admin zur Anmeldung auch eine
 *  Nachricht zukommen zu lassen, und zudem soll der Admin eine Möglichkeit
 *  haben eine Antwort zu schreiben (quasi eine Unterhaltung). Diese soll
 *  der Admin später für jeden Account auch abrufen können."
 *
 * -- Ein Faden je Konto, keine Postfächer -------------------------------
 *
 * Die Unterhaltung hängt am KONTO, nicht an einem der beiden Beteiligten.
 * Das ist der Unterschied zwischen "der Admin kann den Verlauf je Account
 * abrufen" und "irgendwo liegen Nachrichten herum": Wer das Konto ansieht,
 * sieht auch, was darüber gesprochen wurde -- ohne suchen zu müssen.
 *
 * -- Wer darf was -------------------------------------------------------
 *
 * Der Konto-Inhaber schreibt und liest SEINEN Faden, sonst keinen. Der
 * Admin darf jeden lesen und beantworten. Beides serverseitig; die
 * Oberfläche zeigt nur an.
 *
 * Ausdrücklich auch für WARTENDE Konten: Die erste Nachricht ist die zur
 * Anmeldung. Ein Faden, den man erst nach der Freischaltung benutzen darf,
 * verfehlt genau den Zweck.
 */

/** Wer geschrieben hat. Keine freie Zeichenkette -- daran hängt die Anzeige. */
export type NachrichtVon = 'kunde' | 'admin';

export interface Nachricht {
  von: NachrichtVon;
  text: string;
  at: string;
}

/**
 * Obergrenze je Nachricht.
 *
 * Grosszügig genug für eine Vorstellung samt Begründung, klein genug, dass
 * niemand ein Dokument mit einem Roman sprengt (Firestore deckelt bei 1 MB).
 */
export const NACHRICHT_MAX = 2000;

/**
 * Steuerzeichen ausser Zeilenumbruch und Tabulator.
 *
 * Als Code-Punkt-Pruefung statt als Regex-Literal: Ein Literal mit
 * Steuerzeichen-Klassen ist schwer zu lesen und loest `no-control-regex`
 * aus. Die Frage "ist das ein druckbares Zeichen" beantwortet man ohnehin
 * klarer mit Zahlen.
 */
function istSteuerzeichen(zeichen: string): boolean {
  const c = zeichen.codePointAt(0) ?? 0;
  if (c === 9 || c === 10 || c === 13) return false; // Tab, LF, CR bleiben
  return c < 32 || c === 127;
}

/**
 * Text säubern und prüfen -- `null`, wenn daraus keine Nachricht wird.
 *
 * Steuerzeichen fliegen raus (sie machen die Anzeige kaputt, ohne etwas zu
 * sagen), Zeilenumbrüche bleiben: Wer sich vorstellt, gliedert das.
 */
export function pruefeNachricht(roh: unknown): string | null {
  if (typeof roh !== 'string') return null;
  const sauber = [...roh].filter((z) => !istSteuerzeichen(z)).join('').trim();
  if (sauber.length === 0) return null;
  return sauber.slice(0, NACHRICHT_MAX);
}

/** Rohdaten zu einer Nachricht -- `null`, wenn ein Feld fehlt. */
export function leseNachricht(roh: unknown): Nachricht | null {
  if (typeof roh !== 'object' || roh === null) return null;
  const n = roh as { von?: unknown; text?: unknown; at?: unknown };
  if (n.von !== 'kunde' && n.von !== 'admin') return null;
  if (typeof n.text !== 'string' || n.text.length === 0) return null;
  if (typeof n.at !== 'string' || n.at.length === 0) return null;
  return { von: n.von, text: n.text, at: n.at };
}
