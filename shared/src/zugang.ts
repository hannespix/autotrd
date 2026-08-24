/**
 * Zugangsstufe eines Kontos — EINE Wahrheit für Server UND Frontend.
 *
 * Diese Datei ist am 24.08. aus `functions/src/core/access.ts` herausgelöst
 * worden, weil das Frontend die Normalisierung nachgebaut hatte:
 *
 *     rawAccess === 'pending' || rawAccess === 'blocked' ? rawAccess : 'approved'
 *
 * Zwei Kopien derselben Liste sind so lange harmlos, wie die Liste sich nicht
 * ändert. Beim Hinzufügen von `archiviert` wäre die Frontend-Kopie still
 * falsch geworden — und zwar in die gefährliche Richtung: Ein Zustand, der
 * dort nicht steht, wird zu `approved`. Der Kommentar an `mayTrade` sagt es
 * seit jeher: „EINE Wahrheit für Scan, Callables und UI — nie einzeln
 * nachbauen." Genau das war passiert.
 *
 * Zwei Eigenschaften, die beim Ändern zu beachten sind:
 *
 * 1. Die Stufe wohnt auf OBERSTER Ebene des User-Dokuments, nicht unter
 *    `settings`. Die Firestore-Regeln erlauben dem Client Updates
 *    ausschließlich auf `settings` — läge die Stufe dort, könnte sich jeder
 *    mit einem Einzeiler selbst freischalten.
 *
 * 2. FEHLENDES Feld gilt als freigeschaltet. Das ist Absicht: Bestandskonten
 *    (der Owner) haben das Feld nicht und dürfen nicht ausgesperrt werden.
 *    Neu angelegte Profile bekommen ausdrücklich `pending`.
 */

export type AccessLevel = 'pending' | 'approved' | 'blocked' | 'archiviert';

/**
 * Stufen, die AUSDRÜCKLICH nicht freigeschaltet sind.
 *
 * Der gefährlichste Ort der Datei: `accessLevelOf` macht alles, was NICHT
 * hier steht, zu `approved`. Für unbekannte Werte und Bestandskonten ist das
 * richtig (s. o., Punkt 2) — für einen VERGESSENEN neuen Zustand wäre es die
 * Umkehrung der Absicht. Wer eine Stufe hinzufügt und hier nicht einträgt,
 * schaltet sie frei, statt sie zu sperren.
 *
 * Der Typ oben zwingt zu nichts: TypeScript prüft keine Zeichenketten-Menge
 * gegen eine Union. Ein Test tut es.
 */
export const NICHT_FREI: ReadonlySet<string> = new Set<AccessLevel>([
  'pending',
  'blocked',
  'archiviert',
]);

/** Stufe aus einem User-Dokument lesen; fehlend = Bestandskonto = frei. */
export function accessLevelOf(data: Record<string, unknown> | undefined): AccessLevel {
  const raw = (data?.accessLevel ?? 'approved') as string;
  return NICHT_FREI.has(raw) ? (raw as AccessLevel) : 'approved';
}

/**
 * Darf dieses Konto handeln (Engine starten, Orders auslösen)?
 * EINE Wahrheit für Scan, Callables und UI — nie einzeln nachbauen.
 */
export function mayTrade(data: Record<string, unknown> | undefined): boolean {
  return accessLevelOf(data) === 'approved';
}

/**
 * Ist die Stufe eine ABLAGE? Archivierte Konten sind gesperrt wie `blocked`,
 * werden aber zusätzlich aus der Standard-Ansicht des Betreibers genommen.
 * Nichts wird dabei vernichtet — die Stufe ist jederzeit umkehrbar.
 */
export function istAbgelegt(level: AccessLevel): boolean {
  return level === 'archiviert';
}
