/**
 * adoptBroker — das Buch an das reale Broker-Depot angleichen (05.08.).
 *
 * ── Der Vorfall, der das nötig machte ─────────────────────────────────────
 *
 * Am 05.08. um 15:30 kaufte die Engine über das Order-Routing real bei
 * Alpaca ein (16 Fills, ~119.500 $). Kurz darauf wurde das Buch per
 * „Neu anfangen" geleert — der Reset löscht Positionen, Trades und
 * Kennzahlen des BUCHES, aber kein Reset der Welt löscht ein Depot beim
 * Broker. Ergebnis: Alpaca hält acht Positionen, das Buch keine einzige;
 * der Abgleich meldet dauerhaft Fremdbestand, die Historie fehlt im
 * Steuerbericht.
 *
 * Owner-Frage dazu: „kann man das nicht im Nachhinein synchronisieren!?!"
 * — Ja. Genau das tut dieses Callable.
 *
 * ── Was übernommen wird ───────────────────────────────────────────────────
 *
 *   Positionen  aus `/v2/positions` — Menge, Seite, Einstand. Stops und
 *               Ziele werden aus der AKTUELLEN Strategie neu abgeleitet,
 *               damit riskPulse die übernommenen Positionen sofort schützt.
 *   Barbestand  aus `/v2/account` (`cash`, nicht `equity` — der Rest des
 *               Vermögens steckt in den Positionen, die gerade übernommen
 *               werden; equity zusätzlich zu setzen zählte ihn doppelt).
 *   Historie    aus `/v2/orders?status=closed` — aber NUR Orders mit
 *               unserer eigenen `client_order_id`. Was ein Mensch direkt
 *               in der Alpaca-Oberfläche gehandelt hat, gehört ihm, nicht
 *               unserem Buch; es erscheint als Bestand, nicht als Trade.
 *
 * ── Was NICHT passiert ────────────────────────────────────────────────────
 *
 * Keine einzige Order. Die Übernahme liest den Broker und schreibt das
 * Buch — sie kauft nichts, verkauft nichts, storniert nichts. Sie ist die
 * Umsetzung der Architekturentscheidung von M13 für den Konfliktfall:
 * Alpaca ist die Wahrheit über den BESTAND, also folgt ihr das Buch.
 *
 * Buch-Positionen, die der Broker nicht kennt, werden dabei GELÖSCHT —
 * das ist die harte Konsequenz derselben Entscheidung. Wer sie behalten
 * will, übernimmt nicht.
 */

import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import {
  DEFAULT_STRATEGY,
  classify,
  currencyForSymbol,
  feePartsForClass,
  resolveRisk,
  type Position,
  type Strategy,
} from '../../../shared/src/index.js';
import {
  alpacaKonto,
  alpacaOrdersGeschlossen,
  alpacaPositionen,
  type AlpacaGeschlosseneOrder,
} from '../core/alpacaBroker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';
import { fxFelder } from '../core/fx.js';
import { brokerVerbindungLesend } from '../core/orderRouting.js';

/** Übernahmen je Tag — großzügig, aber kein Dauerlauf. */
const DAILY_ADOPT_LIMIT = 10;

/** Wie weit die Order-Historie zurückgeholt wird. Länger als jede
 *  realistische Lücke zwischen Vorfall und Übernahme; ein Zuviel ist
 *  harmlos, weil bereits gebuchte brokerOrderIds übersprungen werden. */
const HISTORIE_TAGE = 14;

export interface AdoptErgebnis {
  ok: true;
  /** Übernommene Broker-Positionen. */
  positionen: number;
  /** Gelöschte Buch-Positionen ohne Gegenstück beim Broker. */
  geloescht: number;
  /** Nachgebuchte Trades aus der Order-Historie. */
  trades: number;
  /** Neuer Barbestand (vom Broker). */
  cash: number;
  meldung: string;
}

export const adoptBroker = onCall(CALLABLE_OPTS, async (request): Promise<AdoptErgebnis> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'adoptBroker', DAILY_ADOPT_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Höchstens ${DAILY_ADOPT_LIMIT} Übernahmen am Tag`);
  }

  const verbindung = await brokerVerbindungLesend(uid);
  if (!verbindung) {
    throw new HttpsError(
      'failed-precondition',
      'Kein Broker verbunden — es gibt kein Depot, das sich übernehmen ließe.',
    );
  }

  const [konto, brokerPositionen] = await Promise.all([
    alpacaKonto(verbindung.mode, verbindung.schluessel),
    alpacaPositionen(verbindung.mode, verbindung.schluessel),
  ]);

  /* Historie ist WÜNSCHENSWERT, aber nicht Bedingung: Wenn der Order-Abruf
   * scheitert, sollen Bestand und Cash trotzdem stimmen. Ein Depot ohne
   * Historie ist unvollständig; ein Buch, das dem Depot widerspricht, ist
   * falsch. */
  let eigeneOrders: AlpacaGeschlosseneOrder[] = [];
  try {
    const seit = new Date(Date.now() - HISTORIE_TAGE * 86_400_000).toISOString();
    const alle = await alpacaOrdersGeschlossen(verbindung.mode, verbindung.schluessel, seit);
    // Nur UNSERE Orders: Die Kennung beginnt mit der (bereinigten) uid —
    // exakt so baut `clientOrderId()` sie. Fremde Orders (Mensch in der
    // Alpaca-Oberfläche) gehören nicht in unser Handelsjournal.
    const uidSauber = uid.replace(/[^A-Za-z0-9-]/g, '_');
    eigeneOrders = alle.filter((o) => o.clientOrderId.startsWith(`${uidSauber}-`));
  } catch (err) {
    logger.warn(`adoptBroker ${uid}: Order-Historie nicht abrufbar`, err);
  }

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const [userSnap, posSnap, tradesSnap] = await Promise.all([
    userRef.get(),
    userRef.collection('positions').get(),
    // Bereits gebuchte Broker-Orders erkennen — die Übernahme muss
    // IDEMPOTENT sein: zweimal gedrückt darf nichts doppelt buchen.
    userRef.collection('trades').select('brokerOrderId').get(),
  ]);
  if (!userSnap.exists) throw new HttpsError('failed-precondition', 'Profil fehlt');
  const strategy = (userSnap.get('settings.strategy') as Strategy | undefined) ?? DEFAULT_STRATEGY;

  const bekannt = new Set<string>();
  for (const d of tradesSnap.docs) {
    const b = d.get('brokerOrderId');
    if (typeof b === 'string' && b.length > 0) bekannt.add(b);
  }

  /** Frühester eigener Kauf je Symbol — bestmögliches `openedAt`. */
  const fruehester = new Map<string, string>();
  for (const o of eigeneOrders) {
    if (o.side !== 'buy') continue;
    const bisher = fruehester.get(o.symbol);
    if (!bisher || o.filledAt < bisher) fruehester.set(o.symbol, o.filledAt);
  }

  const now = new Date().toISOString();
  const batch = db.batch();

  // 1) Buch-Positionen ohne Gegenstück beim Broker löschen (Bestand folgt
  //    dem Broker — siehe Modulkopf).
  const brokerSymbole = new Set(brokerPositionen.map((p) => p.symbol));
  let geloescht = 0;
  for (const d of posSnap.docs) {
    if (!brokerSymbole.has(d.id)) {
      batch.delete(d.ref);
      geloescht += 1;
    }
  }

  // 2) Broker-Positionen ins Buch — mit frischen Stops aus der aktuellen
  //    Strategie, damit riskPulse sie ab dem nächsten Lauf schützt.
  for (const p of brokerPositionen) {
    if (!(p.qty > 0) || !(p.einstand > 0)) continue; // kein Raten bei kaputten Daten
    const cls = classify(p.symbol);
    const risk = resolveRisk(strategy.engine, cls);
    const short = p.seite === 'short';
    const avg = p.einstand;
    const position: Position = {
      symbol: p.symbol,
      qty: p.qty,
      avgEntry: avg,
      // Level gespiegelt beim Short — dieselbe Regel wie beim Öffnen.
      stopLoss: risk.stopLossPct > 0 ? avg * (1 + (short ? 1 : -1) * (risk.stopLossPct / 100)) : null,
      takeProfit:
        risk.takeProfitPct > 0 ? avg * (1 - (short ? 1 : -1) * (risk.takeProfitPct / 100)) : null,
      openedAt: fruehester.get(p.symbol) ?? now,
      ...(short ? { side: 'short' as const, lowWater: avg } : { highWater: avg }),
      broker: true,
    };
    batch.set(userRef.collection('positions').doc(p.symbol), position);
  }

  // 3) Historie nachbuchen — chronologisch, mit dem ECHTEN Fill-Kurs und
  //    der Kommission der Klasse (Slippage steckt im Kurs, siehe
  //    effectivePriceFromFill). `at` trägt den Fill-Zeitpunkt, nicht den
  //    Import-Zeitpunkt, damit die Trade-Liste und FIFO richtig sortieren.
  let importiert = 0;
  for (const o of eigeneOrders) {
    if (bekannt.has(o.id)) continue;
    const cls = classify(o.symbol);
    const teile = feePartsForClass(cls);
    const waehrung = currencyForSymbol(o.symbol);
    // EZB-Kurs zum FILL-Tag — je Tag gecacht, der Import bleibt billig.
    const fx = await fxFelder(o.filledAt, waehrung);
    batch.set(userRef.collection('trades').doc(), {
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      price: o.kurs,
      rawPrice: o.kurs,
      executedAt: o.filledAt,
      at: Timestamp.fromDate(new Date(o.filledAt)),
      source: 'engine',
      paper: verbindung.mode !== 'live',
      /** Kennzeichen der Übernahme — nachgebucht, nicht live gebucht. */
      sync: true,
      assetClass: cls,
      currency: waehrung,
      commissionRate: teile.commission,
      slippageRate: 0,
      feeRate: teile.commission,
      preisQuelle: 'broker',
      brokerOrderId: o.id,
      clientOrderId: o.clientOrderId,
      fee: Math.round(o.qty * o.kurs * teile.commission * 100) / 100,
      ...fx,
    });
    importiert += 1;
  }

  // 4) Barbestand vom Broker. Negativ ist möglich (Margin) und bleibt
  //    negativ — das Buch soll die Wahrheit zeigen, nicht die schönere Zahl.
  batch.update(userRef, {
    'wallet.paperBalance': Math.round(konto.cash * 100) / 100,
    'wallet.updatedAt': now,
  });

  // 5) Abgleich-Vermerk direkt mitschreiben: Nach der Übernahme IST der
  //    Stand sauber; die Karte soll das sofort sagen und nicht erst beim
  //    nächsten Scan.
  batch.set(
    userRef,
    {
      risk: {
        abgleich: {
          at: now,
          status: 'sauber',
          anzahl: 0,
          fehlbestand: 0,
          fremdbestand: 0,
          verglichen: brokerPositionen.length,
          brokerPositionen: brokerPositionen.length,
        },
      },
    },
    { merge: true },
  );

  await batch.commit();
  logger.info(
    `adoptBroker ${uid}: ${brokerPositionen.length} Position(en) übernommen, ` +
      `${importiert} Trade(s) nachgebucht, ${geloescht} Buch-Position(en) entfernt`,
  );
  return {
    ok: true,
    positionen: brokerPositionen.length,
    geloescht,
    trades: importiert,
    cash: Math.round(konto.cash * 100) / 100,
    meldung:
      `${brokerPositionen.length} Position(en) und ${importiert} Trade(s) vom Broker übernommen; ` +
      `Barbestand jetzt ${konto.cash.toFixed(2)} $. Es wurde nichts gekauft oder verkauft. ` +
      'Stops und Ziele wurden aus deiner aktuellen Strategie neu gesetzt.',
  };
});
