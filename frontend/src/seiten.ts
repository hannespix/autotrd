/**
 * Seiten-Verzeichnis der Teilen-Ausgabe (Owner-Auftrag 22.08.).
 *
 * Der Owner wollte „per checkbox auswählbare pages was als Bild und Video
 * exportiert wird … und angezeigt wird". Das ging vorher nicht, weil es
 * die Seiten zweimal gab, mit verschiedenen Namen:
 *
 *   Bild-Karten (shareStory)   ergebnis · depot · verlauf · womit · cta
 *   Video-Szenen (regiePlan)   kurve · ergebnis · symbole · zeitmuster · cta
 *
 * `verlauf` und `kurve` sind dieselbe Sache, `womit` und `symbole` ebenso —
 * nur hiessen sie anders. Eine Auswahl über zwei Vokabulare wäre entweder
 * doppelt (zwei Listen, die auseinanderlaufen) oder geraten (eine Liste,
 * die per Namensähnlichkeit zuordnet). Deshalb steht die Wahrheit hier
 * EINMAL, und beide Ausgabewege lesen sie.
 *
 * Das Verzeichnis kennt keine Daten — ob eine Seite ÜBERHAUPT etwas zu
 * zeigen hat, entscheidet weiterhin der jeweilige Bauer (eine Depot-Seite
 * ohne offene Position entsteht gar nicht erst). Hier steht nur, was der
 * Nutzer sehen WILL.
 */

/** Kanonische Seiten-Kennung — gilt für Anzeige, Bild und Video. */
import type { TextSchluessel } from './i18n.js';

export type SeitenId =
  | 'ergebnis'
  | 'depot'
  | 'kapital'
  | 'verlauf'
  | 'womit'
  | 'zeitmuster'
  | 'cta';

export interface SeitenEintrag {
  id: SeitenId;
  /** i18n-Schlüssel des Namens in der Auswahl. */
  label: TextSchluessel;
  /** i18n-Schlüssel der Erklärung (Titel-Tooltip). */
  hilfe: TextSchluessel;
  /** Erscheint als Bild-Karte. */
  bild: boolean;
  /** Erscheint als Video-Szene — und unter welcher Szenen-Kennung. */
  video: string | null;
}

/**
 * Reihenfolge = Reihenfolge der Ausgabe. Wer hier etwas verschiebt,
 * verschiebt es in Anzeige, Bild UND Video zugleich — das ist der Zweck.
 */
export const SEITEN: readonly SeitenEintrag[] = [
  { id: 'ergebnis', label: 'seite.ergebnis', hilfe: 'seite.ergebnisHilfe', bild: true, video: 'ergebnis' },
  { id: 'depot', label: 'seite.depot', hilfe: 'seite.depotHilfe', bild: true, video: null },
  { id: 'kapital', label: 'seite.kapital', hilfe: 'seite.kapitalHilfe', bild: true, video: null },
  { id: 'verlauf', label: 'seite.verlauf', hilfe: 'seite.verlaufHilfe', bild: true, video: 'kurve' },
  { id: 'womit', label: 'seite.womit', hilfe: 'seite.womitHilfe', bild: true, video: 'symbole' },
  { id: 'zeitmuster', label: 'seite.zeitmuster', hilfe: 'seite.zeitmusterHilfe', bild: false, video: 'zeitmuster' },
  { id: 'cta', label: 'seite.cta', hilfe: 'seite.ctaHilfe', bild: true, video: 'cta' },
];

/** Alle Seiten an — der Zustand, den ein neues Konto vorfindet. */
export const ALLE_SEITEN: readonly SeitenId[] = SEITEN.map((s) => s.id);

const SCHLUESSEL = 'autotrd.seitenAuswahl';

/**
 * Auswahl lesen. Unbekannte Kennungen fliegen raus, damit eine alte
 * Speicherung nach einer Umbenennung nicht stumm eine Seite verschluckt.
 *
 * Eine LEERE gespeicherte Auswahl bleibt leer — sie ist eine Entscheidung
 * („zeig mir gerade nichts"), kein Defekt. Nur wenn gar nichts gespeichert
 * ist, gelten alle Seiten: Wer die Auswahl nie angefasst hat, soll die
 * vollständige Ausgabe bekommen und nicht eine stumme.
 */
export function leseSeitenAuswahl(): SeitenId[] {
  let roh: string | null;
  try {
    roh = localStorage.getItem(SCHLUESSEL);
  } catch {
    return [...ALLE_SEITEN];
  }
  if (roh === null) return [...ALLE_SEITEN];
  let liste: unknown;
  try {
    liste = JSON.parse(roh);
  } catch {
    return [...ALLE_SEITEN];
  }
  if (!Array.isArray(liste)) return [...ALLE_SEITEN];
  const gueltig = new Set<string>(ALLE_SEITEN);
  return ALLE_SEITEN.filter((id) => liste.some((x) => x === id && gueltig.has(id)));
}

/** Auswahl schreiben — Reihenfolge normalisiert, damit sie stabil bleibt. */
export function schreibeSeitenAuswahl(auswahl: readonly SeitenId[]): void {
  const geordnet = ALLE_SEITEN.filter((id) => auswahl.includes(id));
  try {
    localStorage.setItem(SCHLUESSEL, JSON.stringify(geordnet));
  } catch {
    /* Privates Fenster o. Ä. — die Auswahl gilt dann nur für diese Sitzung.
     * Kein Grund, die Ausgabe zu verweigern. */
  }
}

/** Ist die Seite gewählt? `undefined` als Auswahl heisst „alle". */
export function seiteGewaehlt(id: SeitenId, auswahl?: readonly SeitenId[]): boolean {
  return auswahl === undefined || auswahl.includes(id);
}

/** Video-Szenen-Kennung → kanonische Seite. `null`, wenn unbekannt. */
export function seiteZuSzene(szene: string): SeitenId | null {
  return SEITEN.find((s) => s.video === szene)?.id ?? null;
}
