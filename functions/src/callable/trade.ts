/**
 * trade — manueller Paper-Trade (auth-geprüft, validiert, rate-limitiert).
 * Der Preis kommt IMMER aus den zentralen Scan-Daten (market/{sym}.quote),
 * nie vom Client — Clients können Ausführungspreise nicht wählen.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { allSymbols, classify, type Quote, type Strategy } from '../../../shared/src/index.js';
import { consumeQuota, executePaperTrade, resolveBrokerMode } from '../core/broker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

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
  if (typeof symbol !== 'string' || !new Set(allSymbols()).has(symbol)) {
    throw new HttpsError('invalid-argument', 'Unbekanntes Symbol');
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
  const strategy = userSnap.get('settings.strategy') as Strategy | undefined;
  if (!strategy) throw new HttpsError('failed-precondition', 'Profil fehlt — ensureProfile zuerst aufrufen');

  // M4: Paper only — der Doppel-Guard entscheidet zentral (M13/M14 erweitern das).
  if (resolveBrokerMode(strategy) !== 'paper') {
    throw new HttpsError('failed-precondition', 'Live-Trading ist nicht freigeschaltet');
  }

  const quote = (await db.doc(`market/${symbol}`).get()).get('quote') as Quote | undefined;
  if (!quote || !(quote.price > 0)) {
    throw new HttpsError(
      'failed-precondition',
      'Kein zentraler Kurs — Symbol zuerst in die Watchlist aufnehmen (nächster Scan liefert Daten)',
    );
  }

  const result = await executePaperTrade(
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
    },
    strategy,
  );
  if (!result.executed) {
    throw new HttpsError('failed-precondition', `Nicht ausgeführt: ${result.reason}`);
  }
  return { ok: true, trade: result.trade };
});
