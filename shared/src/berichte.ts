/**
 * Ort der Optimierer-Berichte in Firestore — EINE Quelle für Skript, Rules
 * und Frontend.
 *
 * Firestore-Pfade wechseln sich ab: Collection / Dokument / Collection / …
 * `meta` ist eine Collection, also ist `meta/optimizeReports` bereits ein
 * DOKUMENT und keine Collection. Genau daran ist die erste Veröffentlichung
 * gescheitert (`meta/optimizeReports/2026-09-07` hat drei Segmente); das
 * Frontend hätte mit `collection(db, 'meta', 'optimizeReports')` denselben
 * Fehler von der anderen Seite gemacht. Die Berichte liegen deshalb in einer
 * Unter-Collection des (leeren) Dokuments `meta/optimizeReports`.
 *
 * Wer den Pfad ändert, ändert ihn hier — und in `firestore.rules`, wo er
 * naturgemäß ausgeschrieben stehen muss.
 */

/** Segmente der Berichts-Collection (ungerade Zahl ⇒ Collection). */
export const BERICHTE_SEGMENTE = ['meta', 'optimizeReports', 'berichte'] as const;

/** `meta/optimizeReports/berichte` — Collection, für `collection()`/`db.collection()`. */
export const BERICHTE_COLLECTION = BERICHTE_SEGMENTE.join('/');

/** Pfad EINES Berichts (gerade Zahl an Segmenten ⇒ Dokument). */
export function berichtPfad(datum: string): string {
  return `${BERICHTE_COLLECTION}/${datum}`;
}
