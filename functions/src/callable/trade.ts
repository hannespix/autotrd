/**
 * trade — manueller Paper-Trade (auth-geprüft, validiert, rate-limitiert).
 * Der Preis kommt IMMER aus den zentralen Scan-Daten (market/{sym}.quote),
 * nie vom Client — Clients können Ausführungspreise nicht wählen.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  bucketKey,
  classify,
  kursZuAlt,
  tradableSymbols,
  type Quote,
  type Strategy,
} from '../../../shared/src/index.js';
import { consumeQuota, executeTrade, resolveBrokerMode } from '../core/broker.js';
import { kontoTore } from '../core/kontoTore.js';
import { clampStrategyRisk, maxOpenPositions } from '../core/rulesTrading.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { accessDeniedReason, accessLevelOf, mayTrade } from '../core/access.js';

const DAILY_TRADE_LIMIT = 50;
const MAX_QTY = 10_000;

export const trade = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  const { symbol, side, qty } = (request.data ?? {}) as {
    symbol?: unknown;
    side?: unknown;
    qty?: unknown;
  };
  /* HANDELBARE Symbole, nicht bloß bekannte (04.08.).
   *
   * Vorher prüfte die Handeingabe gegen `allSymbols()` — den ganzen Katalog
   * inklusive der Dinge, die `isTradable` längst ausschließt: Indizes (`^GSPC`
   * ist eine Zahl, kein Instrument) und Auslandsbörsen. Letztere sind der
   * ernstere Fall, denn sie notieren gar nicht in Dollar: `BMW.DE` in Euro,
   * `7203.T` in Yen, `AZN.L` sogar in Pence. Der Kontostand ist hart in USD
   * geführt — ein solcher Kauf hätte den Saldo lautlos verfälscht. */
  if (typeof symbol !== 'string' || !new Set(tradableSymbols()).has(symbol)) {
    throw new HttpsError('invalid-argument', 'Symbol nicht handelbar');
  }
  if (side !== 'buy' && side !== 'sell') {
    throw new HttpsError('invalid-argument', "side muss 'buy' oder 'sell' sein");
  }
  let qtyNum: number | undefined;
  if (qty !== undefined && qty !== null) {
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new HttpsError('invalid-argument', `qty muss eine ganze Zahl 1–${MAX_QTY} sein`);
    }
    qtyNum = qty;
  }

  if (!(await consumeQuota(uid, 'trades', DAILY_TRADE_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Tageslimit von ${DAILY_TRADE_LIMIT} Trades erreicht`);
  }

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  // Zugangsstufe (Owner 26.07.): Ohne Freischaltung keine Order — auch nicht
  // manuell. Die Prüfung steht VOR jeder Preisermittlung, damit ein gesperrtes
  // Konto nicht einmal Marktdaten-Aufrufe auslöst.
  if (!mayTrade(userSnap.data())) {
    throw new HttpsError('permission-denied', accessDeniedReason(accessLevelOf(userSnap.data())));
  }
  const strategy = userSnap.get('settings.strategy') as Strategy | undefined;
  if (!strategy) throw new HttpsError('failed-precondition', 'Profil fehlt — ensureProfile zuerst aufrufen');

  // M4: Paper only — der Doppel-Guard entscheidet zentral (M13/M14 erweitern das).
  if (resolveBrokerMode(strategy) !== 'paper') {
    throw new HttpsError('failed-precondition', 'Live-Trading ist nicht freigeschaltet');
  }

  /* Risiko-Hülle auch für die Handeingabe (Audit 13.08., H3).
   *
   * Bis dahin ging die UNGEKLAMMERTE Strategie an den Broker: Wer sich
   * maxPositionPct 100 ins Profil schrieb, kaufte von Hand mit vollem
   * Einsatz, während der Scan längst auf 25 % geklemmt hätte. Die Hülle gilt
   * für jeden Trade dieses Users — egal, welcher Pfad ihn auslöst.
   */
  const clamped = clampStrategyRisk(strategy);

  /* Konto-Tore (M12, zentralisiert 13.08.): Reset sperrt JEDEN Handel
   * (Buchführung), Notbremse und Abgleich-Drift sperren EINSTIEGE — eine
   * Bremse, die man mit einem Klick umgehen kann, ist keine. Ein Verkauf
   * einer bestehenden Position bleibt immer möglich; ein Leerverkauf ist
   * ein Einstieg und fällt unter die Tore. */
  const tore = kontoTore(userSnap, clamped, new Date());
  if (tore.handel) {
    throw new HttpsError('failed-precondition', tore.grund ?? 'Konto ist vorübergehend gesperrt');
  }

  /* Positionsbestand EINMAL lesen: Er entscheidet, ob dieser Trade ein
   * Einstieg ist (neue Position) — und ob das Positionslimit greift. */
  const posSnap = await db.collection(`users/${uid}/positions`).get();
  const hatPosition = posSnap.docs.some((d) => d.id === symbol);
  // Sockel-Positionen (core) zählen nicht — dieselbe Besitzgrenze wie im
  // Scan: Sie gehören dem Momentum-Lauf und blockieren nicht das Limit
  // der aktiv geführten Trades.
  const offenAktiv = posSnap.docs.filter((d) => (d.data() as { core?: boolean }).core !== true).length;

  const istEinstieg =
    (side === 'buy' && !hatPosition)
    || (side === 'sell' && strategy.signals.allowShort === true && !hatPosition);
  if (istEinstieg) {
    if (tore.einstieg) {
      throw new HttpsError('failed-precondition', tore.grund ?? 'Einstiege sind gesperrt');
    }
    /* Positionslimit auch von Hand (Audit 13.08., H3): 50 Käufe am Tag mit
     * je 25 % wären sonst regelkonform gewesen, während der Scan beim
     * Limit längst aufhört. Nur NEUE Positionen — ein Verkauf und die
     * Bedienung bestehender Positionen bleiben frei. */
    const limit = maxOpenPositions(clamped);
    if (offenAktiv >= limit) {
      throw new HttpsError(
        'failed-precondition',
        `Positionslimit erreicht (${offenAktiv}/${limit} offene Positionen) — erst schließen, dann neu eröffnen.`,
      );
    }
  }

  const quote = (await db.doc(`market/${symbol}`).get()).get('quote') as Quote | undefined;
  if (!quote || !(quote.price > 0)) {
    throw new HttpsError(
      'failed-precondition',
      'Kein zentraler Kurs — Symbol zuerst in die Watchlist aufnehmen (nächster Scan liefert Daten)',
    );
  }
  /* Kurs-Zeitdeckel (Audit 13.08., B-2): `updatedAt` wurde geschrieben und
   * von keinem Leser geprüft — ein Symbol, das aus der Beobachtung fällt,
   * behielt seine eingefrorene Quote, und die Handeingabe führte zum
   * Wochen-alten Kurs aus. Gilt für BEIDE Seiten wie die Prüfung darüber:
   * Ein Verkauf zu einem erfundenen Kurs ist keine Hilfe, sondern eine
   * falsche P&L-Buchung. Das ist keine Risiko-Sperre (die lassen Exits
   * durch), sondern dieselbe Frage wie „kein zentraler Kurs" — nur in der
   * Zeit statt im Raum. */
  const kursAlter = kursZuAlt(quote.updatedAt, classify(symbol), new Date());
  if (kursAlter.zuAlt) {
    throw new HttpsError(
      'failed-precondition',
      `${kursAlter.grund ?? 'Kurs ist veraltet'} — Symbol in die Watchlist aufnehmen, der nächste Scan liefert frische Daten`,
    );
  }

  const result = await executeTrade(
    {
      uid,
      symbol,
      side,
      price: quote.price,
      // Kauf ohne qty: Positionsgröße aus maxPositionPct (wie die Engine);
      // Verkauf schließt immer die ganze Position.
      ...(side === 'buy' && qtyNum !== undefined ? { qty: qtyNum } : {}),
      source: 'manual',
      // Klassen-aufgelöste Stop/Take-Level (MA3-Fund 26.07.): Ohne die
      // Klasse schrieb der Broker jedem Kauf die GLOBALEN Prozente als
      // Level fest — Krypto-Profile griffen nie (Level haben Vorrang).
      assetClass: classify(symbol),
      // Manueller Verkauf ohne Position wird zum SHORT, wenn der User
      // Leerverkäufe erlaubt hat (Opt-in) — sonst wie bisher 'keine_position'.
      ...(side === 'sell' && strategy.signals.allowShort === true ? { openShort: true } : {}),
      // Steckbrief fürs Meta-Labeling: Hand-Trades lernen als eigene Sorte.
      // Bei Öffnungen relevant; bei Schließungen ignoriert ihn der Broker.
      bucket: bucketKey({
        assetClass: classify(symbol),
        timeframe: 'daily',
        signature: 'manuell',
        side: side === 'sell' ? 'short' : 'long',
      }),
    },
    clamped,
    /* Lauf-Kennung des Handeingabe-Trades (M13).
     *
     * Minutengenau — und das ist hier die GEWOLLTE Semantik, nicht ein
     * Kompromiss: Ein Doppelklick auf „Kaufen" soll nicht zwei Positionen
     * eröffnen. Alpaca weist die zweite Order mit derselben Kennung ab.
     * Die Kehrseite ist bekannt: Wer denselben Trade absichtlich zweimal
     * will, muss die Minutengrenze abwarten. Für eine Handeingabe ist das
     * die sichere Richtung. */
    `man-${new Date().toISOString().slice(0, 16)}Z`,
  );
  if (!result.executed) {
    throw new HttpsError('failed-precondition', `Nicht ausgeführt: ${result.reason}`);
  }
  return { ok: true, trade: result.trade };
});
