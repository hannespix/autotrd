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

/**
 * Wie lange ein FEHLSCHLAG im Prozess-Cache steht (Millisekunden).
 *
 * ── Audit-Befund 11.08. ───────────────────────────────────────────────────
 *
 * Der Cache merkte sich `null` genauso lange wie einen Kurs — also für die
 * gesamte Lebensdauer der Function-Instanz, und die läuft Minuten bis
 * Stunden. Ein einziger Aussetzer der Kurs-API (Timeout, 5xx, kurze
 * Netzstörung) reichte damit, dass ALLE Trades dieses Tages dauerhaft ohne
 * `fxRate` gebucht wurden — auf derselben Instanz, obwohl die API eine
 * Sekunde später wieder lieferte.
 *
 * Der Schaden fällt erst beim Steuer-Export auf, Monate später: Ein Trade
 * ohne Umrechnungskurs lässt sich nicht in Euro ausweisen, und der Kurs
 * eines vergangenen Tages ist dann nur noch mit Handarbeit zu beschaffen.
 *
 * Ganz ohne Negativ-Cache ginge es allerdings auch nicht: Ein Tag, den die
 * API grundsätzlich nicht kennt, liefe sonst bei JEDEM Trade in acht
 * Sekunden Timeout — im 5-Minuten-Scan wäre das der sichere Weg ins
 * Funktions-Timeout. Eine Minute ist der Kompromiss: kurz genug, dass sich
 * eine Störung von selbst heilt, lang genug, dass ein Scan-Durchlauf nicht
 * dutzendfach in dieselbe Wand läuft.
 */
export const FX_NEGATIV_MS = 60_000;

interface FxEintrag {
  kurs: FxKurs | null;
  /** Zeitpunkt, ab dem der Eintrag neu geholt werden muss. */
  bis: number;
}

/**
 * Wie lange dieser Eintrag gilt.
 *
 * Ein Kurs gilt unbegrenzt — der EZB-Referenzkurs eines Tages ändert sich
 * nicht mehr. Ein Fehlschlag gilt kurz (siehe oben).
 */
export function fxCacheDauerMs(kurs: FxKurs | null): number {
  return kurs ? Number.POSITIVE_INFINITY : FX_NEGATIV_MS;
}

/**
 * Was der Cache liefert: den Eintrag, oder `undefined` für „muss geholt
 * werden". `undefined` steht damit sowohl für „nie gesehen" als auch für
 * „abgelaufen" — für den Aufrufer ist das dasselbe.
 */
export function fxCacheTreffer(
  eintrag: FxEintrag | undefined,
  jetzt: number,
): FxKurs | null | undefined {
  if (!eintrag) return undefined;
  if (jetzt >= eintrag.bis) return undefined;
  return eintrag.kurs;
}

/** Prozess-Cache: derselbe Tag wird innerhalb eines Laufs nie zweimal geholt. */
const speicher = new Map<string, FxEintrag>();

/**
 * Kurs für einen Handelstag (YYYY-MM-DD), Fremdwährung je 1 EUR.
 *
 * Reihenfolge: Prozess-Cache → Firestore → API. Jede Stufe füllt die
 * darüberliegende. `null` heißt „nicht belegbar" — nie ein Ersatzwert.
 */
export async function fxKursFuer(tag: string, waehrung = 'USD'): Promise<FxKurs | null> {
  const key = `${tag}_${waehrung}`;
  const gemerkt = fxCacheTreffer(speicher.get(key), Date.now());
  if (gemerkt !== undefined) return gemerkt;

  const db = getFirestore();
  const ref = db.doc(`meta/fx/tage/${key}`);
  try {
    const doc = await ref.get();
    const rate = doc.get('rate') as number | undefined;
    const date = doc.get('date') as string | undefined;
    if (typeof rate === 'number' && rate > 0 && typeof date === 'string') {
      const kurs: FxKurs = { date, rate, source: (doc.get('source') as string) ?? 'ecb' };
      speicher.set(key, { kurs, bis: Number.POSITIVE_INFINITY });
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
  // Ein Fehlschlag steht hier nur kurz — siehe FX_NEGATIV_MS. Vorher blieb
  // er, bis die Instanz starb.
  speicher.set(key, { kurs, bis: Date.now() + fxCacheDauerMs(kurs) });
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
