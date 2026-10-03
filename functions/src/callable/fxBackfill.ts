/**
 * fxNachtragen — fehlende Wechselkurse historischer Trades einfrieren
 * (Owner-Frage 06.08.: „muss der jeweilige Umrechnungskurs zum
 * Handelszeitpunkt noch zusätzlich gespeichert werden?").
 *
 * Die Antwort ist seit M12b: Er WIRD gespeichert — jeder gebuchte Trade
 * friert den EZB-Referenzkurs seines Tages ein (`fxFelder` in
 * executePaperTrade). Was fehlte, war der Rückweg für den ALTBESTAND aus
 * der Zeit davor: Diese Trades zählten dauerhaft als `fxLuecken`, und die
 * Euro-Summen der betroffenen Töpfe blieben für immer unbelegbar.
 *
 * ── Warum das Nachtragen zulässig ist, das Neuholen aber nicht ────────────
 *
 * Die Regel „eingefrorene Kurse nie neu holen" schützt vor BEWEGLICHEN
 * Zahlen: Derselbe Trade darf im März nicht anders aussehen als im Januar.
 * Der EZB-Referenzkurs eines VERGANGENEN Tages ist aber unveränderlich —
 * ihn nachträglich für einen Trade einzufrieren, der noch keinen hat,
 * erzeugt exakt die Zahl, die beim Buchen entstanden wäre. Deshalb gilt:
 *
 *   - Gesetzt wird NUR, wo nichts steht (idempotent; nie überschreiben).
 *   - Der Kurs ist der des HANDELSTAGES (`executedAt`), nie der heutige.
 *   - `fxNachgetragenAm` stempelt den Vorgang — im Dokument bleibt
 *     sichtbar, dass der Kurs später ergänzt wurde.
 *
 * Kein Kurs auffindbar (Datenlücke der Quelle) → das Feld bleibt leer und
 * der Bericht zählt den Vorgang weiter als Lücke. Erfunden wird nichts.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { brauchtUmrechnung, currencyForSymbol } from '../../../shared/src/index.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';
import { fxKursFuer } from '../core/fx.js';

/** Wie beim Steuerbericht: die volle Historie, mit Reißleine. */
const MAX_TRADES = 20_000;
/** Der Lauf liest die volle Historie — dieselbe Größenordnung wie taxReport. */
const DAILY_LIMIT = 5;

export interface FxNachtragErgebnis {
  ok: true;
  /** Durchgesehene Trades (beide Sammlungen). */
  geprueft: number;
  /** Kurse eingefroren. */
  nachgetragen: number;
  /** Fremdwährungs-Trades, für deren Tag kein Kurs auffindbar war. */
  ohneKurs: number;
}

export const fxNachtragen = onCall(CALLABLE_OPTS, async (request): Promise<FxNachtragErgebnis> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');
  if (!(await consumeQuota(uid, 'fxNachtragen', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', `srv.hoechstensNachtragLaeufe|${DAILY_LIMIT}`);
  }

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  let geprueft = 0;
  let nachgetragen = 0;
  let ohneKurs = 0;
  let batch = db.batch();
  let imBatch = 0;

  for (const sammlung of ['trades', 'tradesArchive']) {
    if (geprueft >= MAX_TRADES) break;
    const snap = await userRef.collection(sammlung).limit(MAX_TRADES - geprueft).get();
    for (const d of snap.docs) {
      geprueft += 1;
      const fxRate = d.get('fxRate') as number | undefined;
      if (typeof fxRate === 'number' && fxRate > 0) continue; // eingefroren bleibt eingefroren
      const symbol = d.get('symbol') as string | undefined;
      if (!symbol) continue;
      const waehrung = (d.get('currency') as string | undefined) ?? currencyForSymbol(symbol);
      if (!brauchtUmrechnung(waehrung)) continue;
      const executedAt = (d.get('executedAt') ?? d.get('at')) as string | undefined;
      if (typeof executedAt !== 'string' || executedAt.length < 10) continue;

      // Kurs des HANDELSTAGES — fxKursFuer cached je Tag, ein Jahr Historie
      // kostet also ~250 Abrufe beim ersten Lauf und danach nichts mehr.
      const kurs = await fxKursFuer(executedAt.slice(0, 10), waehrung.toUpperCase());
      if (!kurs) {
        ohneKurs += 1;
        continue;
      }
      batch.update(d.ref, {
        fxRate: kurs.rate,
        fxDate: kurs.date,
        fxSource: kurs.source,
        fxNachgetragenAm: new Date().toISOString(),
      });
      nachgetragen += 1;
      imBatch += 1;
      if (imBatch >= 400) {
        await batch.commit();
        batch = db.batch();
        imBatch = 0;
      }
    }
  }
  if (imBatch > 0) await batch.commit();

  logger.info(
    `fxNachtragen ${uid}: ${geprueft} geprüft, ${nachgetragen} nachgetragen, ${ohneKurs} ohne Kurs`,
  );
  return { ok: true, geprueft, nachgetragen, ohneKurs };
});
