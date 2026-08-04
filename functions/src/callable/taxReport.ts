/**
 * taxReport — Jahres-Steuerbericht aus der eigenen Handelshistorie.
 *
 * Owner-Auftrag 04.08.: „fürs deutsche finanzamt alle möglichen speicherungen
 * und exportfunktionen vorbereiten."
 *
 * Die Rechnung selbst steht in `shared/src/tax.ts` und ist pur — hier passiert
 * nur das Beschaffen der Trades und das Zusammensetzen der Antwort. Diese
 * Trennung ist nicht Kosmetik: Die FIFO-Logik muss sich ohne Firestore testen
 * lassen, sonst prüft niemand die Fälle, auf die es ankommt.
 *
 * ── Warum BEIDE Sammlungen gelesen werden ─────────────────────────────────
 *
 * `resetWallet` verschiebt die Historie seit dem 04.08. nach `tradesArchive`,
 * statt sie zu löschen. Für die Kennzahlen ist der Reset ein Schnitt — für das
 * Finanzamt ist er bedeutungslos: Ein Verkauf im Januar bleibt steuerpflichtig,
 * auch wenn der Nutzer im März sein Depot zurückgesetzt hat. Wer hier nur
 * `trades` liest, produziert nach jedem Reset einen Bericht, der Anschaffungen
 * unterschlägt — und damit den vollen Verkaufserlös als Gewinn ausweist.
 *
 * ── Warum es KEIN Fenster gibt ────────────────────────────────────────────
 *
 * `snapshotEquity` liest je Konto nur die jüngsten 500 Trades (Kostenbremse).
 * Hier wäre das ein Fehler: FIFO braucht die Anschaffung, auch wenn sie Jahre
 * zurückliegt. Ein abgeschnittenes Fenster verliert Einstandskurse, und der
 * Bericht rechnet den Gewinn zu hoch. Deshalb liest dieses Callable die volle
 * Historie — und ist genau deswegen quotiert.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import {
  classify,
  currencyForSymbol,
  steuerbericht,
  veraeusserungenCsv,
  type Steuerbericht,
  type SteuerTrade,
} from '../../../shared/src/index.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';

/**
 * Höchstens zwanzig Berichte am Tag.
 *
 * Der Bericht liest die VOLLE Historie — bei 500 Trades sind das 500 Reads je
 * Aufruf. Ein versehentlicher Klick-Loop in der UI wäre sonst eine
 * Firestore-Rechnung. Zwanzig reichen für jedes echte Nutzungsmuster: Man
 * erzeugt einen Steuerbericht einmal im Jahr, nicht einmal pro Minute.
 */
const DAILY_REPORT_LIMIT = 20;

/**
 * Obergrenze gelesener Trades je Bericht.
 *
 * Kein fachliches Fenster (s. Modulkopf), sondern eine Reißleine gegen ein
 * entlaufenes Konto. Wird sie erreicht, sagt der Bericht das AUSDRÜCKLICH
 * (`historieUnvollstaendig`) — ein stillschweigend abgeschnittener
 * Steuerbericht wäre schlimmer als gar keiner.
 */
const MAX_TRADES = 20_000;

export interface TaxReportResult {
  ok: true;
  bericht: Steuerbericht;
  /** Veräußerungsliste als CSV — direkt speicherbar. */
  csv: string;
  /** Gelesene Trades (beide Sammlungen zusammen). */
  gelesen: number;
  /** Reißleine gegriffen? Dann fehlen ältere Trades und der Bericht ist unvollständig. */
  historieUnvollstaendig: boolean;
}

/** Ein Firestore-Trade-Dokument in die Eingabe der Steuerrechnung übersetzen. */
function alsSteuerTrade(d: FirebaseFirestore.QueryDocumentSnapshot): SteuerTrade | null {
  const symbol = d.get('symbol') as string | undefined;
  const side = d.get('side') as string | undefined;
  const qty = d.get('qty') as number | undefined;
  const price = d.get('price') as number | undefined;
  // `executedAt` fehlt an ganz alten Einträgen; `at` ist der frühere Name.
  const executedAt = (d.get('executedAt') ?? d.get('at')) as string | undefined;
  if (!symbol || (side !== 'buy' && side !== 'sell')) return null;
  if (typeof qty !== 'number' || !(qty > 0)) return null;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  if (typeof executedAt !== 'string' || executedAt.length < 10) return null;

  const fee = d.get('fee') as number | undefined;
  // Anlageklasse und Währung stehen seit dem 04.08. am Trade. Für Altbestand
  // werden sie aus dem Symbol abgeleitet — das ist eine Näherung (eine
  // Katalog-Änderung verschöbe sie rückwirkend), aber die einzige Alternative
  // wäre, alte Trades ganz wegzulassen.
  const assetClass = (d.get('assetClass') as string | undefined) ?? classify(symbol);
  const currency = (d.get('currency') as string | undefined) ?? currencyForSymbol(symbol);
  const paper = d.get('paper') as boolean | undefined;

  return {
    symbol,
    side,
    qty,
    price,
    executedAt,
    assetClass,
    currency,
    // Ohne ausdrückliches `paper: false` gilt ein Trade als Papierhandel.
    // Die sichere Richtung: Lieber ein Echtgeld-Trade fehlt im Bericht und
    // fällt auf, als dass Papierhandel als steuerpflichtig ausgewiesen wird.
    paper: paper !== false,
    ...(typeof fee === 'number' ? { fee } : {}),
  };
}

/** Volle Handelshistorie eines Kontos — laufende Sammlung plus Archiv. */
async function historie(uid: string): Promise<{ trades: SteuerTrade[]; abgeschnitten: boolean }> {
  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const trades: SteuerTrade[] = [];
  let abgeschnitten = false;

  for (const sammlung of ['trades', 'tradesArchive']) {
    const rest = MAX_TRADES - trades.length;
    if (rest <= 0) {
      abgeschnitten = true;
      break;
    }
    const snap = await userRef.collection(sammlung).limit(rest + 1).get();
    if (snap.size > rest) abgeschnitten = true;
    for (const d of snap.docs.slice(0, rest)) {
      const t = alsSteuerTrade(d);
      if (t) trades.push(t);
    }
  }
  return { trades, abgeschnitten };
}

export async function erzeugeSteuerbericht(
  uid: string,
  jahr: number,
  echtgeld: boolean,
): Promise<TaxReportResult> {
  const { trades, abgeschnitten } = await historie(uid);
  const bericht = steuerbericht(trades, jahr, { echtgeld, waehrung: 'USD' });
  logger.info(
    `taxReport ${uid} ${jahr}: ${trades.length} Trades gelesen, ` +
      `${bericht.veraeusserungen.length} Veräußerungen im Jahr` +
      (abgeschnitten ? ' — HISTORIE ABGESCHNITTEN' : ''),
  );
  return {
    ok: true,
    bericht,
    csv: veraeusserungenCsv(bericht),
    gelesen: trades.length,
    historieUnvollstaendig: abgeschnitten,
  };
}

export const taxReport = onCall(CALLABLE_OPTS, async (request): Promise<TaxReportResult> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  const { jahr, echtgeld } = (request.data ?? {}) as { jahr?: unknown; echtgeld?: unknown };
  const j = typeof jahr === 'number' ? Math.trunc(jahr) : new Date().getUTCFullYear();
  // Jahre außerhalb dieser Spanne sind Tippfehler, keine Anfragen. Die
  // Untergrenze ist die Einführung der Abgeltungsteuer.
  if (j < 2009 || j > new Date().getUTCFullYear() + 1) {
    throw new HttpsError('invalid-argument', `Jahr ${j} liegt außerhalb des zulässigen Bereichs`);
  }
  if (!(await consumeQuota(uid, 'taxReport', DAILY_REPORT_LIMIT))) {
    throw new HttpsError(
      'resource-exhausted',
      `Höchstens ${DAILY_REPORT_LIMIT} Steuerberichte am Tag`,
    );
  }
  return erzeugeSteuerbericht(uid, j, echtgeld === true);
});
