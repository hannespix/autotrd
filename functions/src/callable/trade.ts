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
  pruefeBreaker,
  tradableSymbols,
  type Quote,
  type Strategy,
} from '../../../shared/src/index.js';
import { consumeQuota, executeTrade, resolveBrokerMode } from '../core/broker.js';
import { breakerHeuteAusgeloest, handelstagET } from '../scheduled/scanMarket.js';
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

  /* Tages-Notbremse gilt auch für den Klick (M12).
   *
   * Eine Bremse, die man mit einem Handel umgehen kann, ist keine — und der
   * manuelle Pfad ist der, den man in einer Verlustserie am ehesten benutzt.
   * Nur EINSTIEGE: Ein Verkauf muss immer möglich bleiben, sonst sperrte die
   * Bremse genau den Ausweg, für den sie ausgelöst hat. Ein Leerverkauf ist
   * allerdings ein Einstieg und fällt darunter.
   */
  const istEinstieg =
    side === 'buy'
    || (side === 'sell'
      && strategy.signals.allowShort === true
      && !(await db.doc(`users/${uid}/positions/${symbol}`).get()).exists);
  if (istEinstieg) {
    const breaker = pruefeBreaker(
      {
        vortagEquity: (userSnap.get('risk.vortagEquity') as number | undefined) ?? 0,
        // Kein frischer Marktwert an dieser Stelle: Der Scan rechnet ihn alle
        // fünf Minuten und schreibt das Ergebnis mit. Was hier zählt, ist der
        // ZUSTAND der Bremse — die Grenzprüfung selbst hat der Scan gemacht.
        jetztEquity: (userSnap.get('risk.vortagEquity') as number | undefined) ?? 0,
        // Alter der Bezugsgröße (Audit-Befund 11.08.) — dieselbe Angabe wie
        // im Scan, damit der Klartext hier nicht etwas anderes behauptet.
        vortagEquityAm: (userSnap.get('risk.vortagEquityAm') as string | undefined) ?? undefined,
        heute: handelstagET(new Date()),
        // Handelstag in New York, nicht UTC (Audit-Befund 11.08.): Sonst
        // gäbe die Bremse das Konto ab 20:00 ET wieder frei, obwohl niemand
        // sie entriegelt hat. Dieselbe Funktion wie im Scan — zwei
        // Ableitungen wären zwei Gelegenheiten, sie verschieden zu machen.
        bereitsAusgeloest: breakerHeuteAusgeloest(
          userSnap.get('risk.breakerAusgeloestAm'),
          new Date(),
        ),
      },
      { dailyLossLimitPct: strategy.engine.dailyLossLimitPct ?? 0 },
    );
    if (!breaker.einstiegErlaubt) {
      throw new HttpsError('failed-precondition', breaker.grund);
    }
  }

  const quote = (await db.doc(`market/${symbol}`).get()).get('quote') as Quote | undefined;
  if (!quote || !(quote.price > 0)) {
    throw new HttpsError(
      'failed-precondition',
      'Kein zentraler Kurs — Symbol zuerst in die Watchlist aufnehmen (nächster Scan liefert Daten)',
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
    strategy,
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
