/**
 * EZB-Referenzkurse holen und zwischenspeichern (M12b).
 *
 * Quelle ist die Frankfurter-API, ein kostenloser Spiegel der offiziellen
 * EZB-Tagesreferenzkurse — kein Schlüssel, kein Konto, kein Limit, das ein
 * Handelskonto je erreichen würde. Sie greift bei Wochenenden und Feiertagen
 * selbst auf den letzten veröffentlichten Tag zurück und sagt im
 * `date`-Feld ehrlich, welcher das war. Genau das braucht die Steuerrechnung:
 * nicht „irgendein Kurs", sondern ein datierter.
 *
 * ── Warum ein Cache in Firestore ─────────────────────────────────────────
 *
 * Ein Kurs je Tag ändert sich nie mehr — die EZB veröffentlicht ihn einmal
 * um 16:00 Uhr und korrigiert ihn nicht. Ein Dokument je Tag ist damit
 * dauerhaft gültig, und der Handelstag wird zum Dokumentschlüssel. Bei
 * Dutzenden Trades am Tag heißt das: ein Abruf statt Dutzender, und der
 * Trade-Pfad hängt nicht an der Erreichbarkeit eines fremden Servers.
 *
 * ── Und warum ein Fehler hier nichts blockiert ───────────────────────────
 *
 * Ohne Kurs wird trotzdem gehandelt — der Trade bekommt dann keine
 * fx-Felder, und der Steuerbericht zählt ihn als Lücke (`fxLuecken`). Das
 * ist die richtige Reihenfolge: Ein nicht erreichbarer Kursserver darf
 * keinen Handel verhindern, aber er darf auch keine erfundene Zahl in eine
 * Steuererklärung schreiben.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { leseFxAntwort, type FxKurs } from '../../../shared/src/index.js';

const API = 'https://api.frankfurter.dev/v1';
/** Prozess-Cache: derselbe Tag wird innerhalb eines Laufs nie zweimal geholt. */
const speicher = new Map<string, FxKurs | null>();

/**
 * Kurs für einen Handelstag (YYYY-MM-DD), Fremdwährung je 1 EUR.
 *
 * Reihenfolge: Prozess-Cache → Firestore → API. Jede Stufe füllt die
 * darüberliegende. `null` heißt „nicht belegbar" — nie ein Ersatzwert.
 */
export async function fxKursFuer(tag: string, waehrung = 'USD'): Promise<FxKurs | null> {
  const key = `${tag}_${waehrung}`;
  const gemerkt = speicher.get(key);
  if (gemerkt !== undefined) return gemerkt;

  const db = getFirestore();
  const ref = db.doc(`meta/fx/tage/${key}`);
  try {
    const doc = await ref.get();
    const rate = doc.get('rate') as number | undefined;
    const date = doc.get('date') as string | undefined;
    if (typeof rate === 'number' && rate > 0 && typeof date === 'string') {
      const kurs: FxKurs = { date, rate, source: (doc.get('source') as string) ?? 'ecb' };
      speicher.set(key, kurs);
      return kurs;
    }
  } catch (err) {
    logger.warn(`fx: Cache ${key} nicht lesbar`, err);
  }

  let kurs: FxKurs | null = null;
  try {
    const res = await fetch(`${API}/${tag}?base=EUR&symbols=${waehrung}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) kurs = leseFxAntwort(await res.json(), waehrung);
    else logger.warn(`fx: HTTP ${res.status} für ${tag}`);
  } catch (err) {
    logger.warn(`fx: Abruf ${tag} fehlgeschlagen`, err);
  }

  if (kurs) {
    // Unter dem ANGEFRAGTEN Tag ablegen, aber mit dem gelieferten Datum im
    // Feld: Ein Sonntags-Trade findet so beim nächsten Mal sofort seinen
    // Kurs, und im Dokument steht trotzdem, von welchem Tag er stammt.
    await ref
      .set({ ...kurs, angefragt: tag, waehrung, holtAm: new Date().toISOString() })
      .catch((err: unknown) => logger.warn(`fx: Cache ${key} nicht schreibbar`, err));
  }
  speicher.set(key, kurs);
  return kurs;
}

/**
 * Kurs-Felder für ein Trade-Dokument — leer, wenn kein Kurs vorliegt.
 *
 * Bewusst als Feld-Fragment und nicht als Objekt: So lässt es sich per
 * Spread in den Trade schreiben, ohne dass bei fehlendem Kurs `undefined`
 * in Firestore landet (was der Client-SDK-Guard `exactOptionalPropertyTypes`
 * sonst durchgehen ließe und Firestore als Fehler quittiert).
 */
export async function fxFelder(
  executedAtIso: string,
  waehrung = 'USD',
): Promise<{ fxRate?: number; fxDate?: string; fxSource?: string }> {
  if (waehrung.toUpperCase() === 'EUR') return {};
  const kurs = await fxKursFuer(executedAtIso.slice(0, 10), waehrung);
  if (!kurs) return {};
  return { fxRate: kurs.rate, fxDate: kurs.date, fxSource: kurs.source };
}

/** Nur für Tests: den Prozess-Cache leeren. */
export function fxCacheLeeren(): void {
  speicher.clear();
}
