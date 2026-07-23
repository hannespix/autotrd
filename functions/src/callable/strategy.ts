/**
 * saveStrategy — validiert das FLACHE Strategie-Schema serverseitig
 * (shared/validateStrategy, lehnt das kaputte Alt-Schema hart ab) und
 * schreibt es nach users/{uid}.settings.strategy.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { allSymbols, validateStrategy, type Strategy } from '../../../shared/src/index.js';

const MAX_WATCHLIST = 12;

export const saveStrategy = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  const strategy = (request.data as { strategy?: unknown })?.strategy;
  const problems = validateStrategy(strategy);
  if (problems.length > 0) {
    throw new HttpsError('invalid-argument', problems.join(' · '));
  }
  const s = strategy as Strategy;

  if (s.watchlist.length > MAX_WATCHLIST) {
    throw new HttpsError('invalid-argument', `Watchlist ist auf ${MAX_WATCHLIST} Symbole begrenzt`);
  }
  // Nur Katalog-Symbole (yfinance-Konventionen, z. B. '^NDX' statt 'NDX')
  const catalog = new Set(allSymbols());
  const unknown = s.watchlist.filter((sym) => !catalog.has(sym));
  if (unknown.length > 0) {
    throw new HttpsError('invalid-argument', `Unbekannte Symbole: ${unknown.join(', ')}`);
  }
  // Broker-Guards: Client kann hierüber NIE live schalten (M8/M14-Thema)
  if (s.broker.mode !== 'paper') {
    throw new HttpsError('invalid-argument', 'broker.mode ist bis M14 fest auf paper');
  }

  const ref = getFirestore().doc(`users/${uid}`);
  if (!(await ref.get()).exists) {
    throw new HttpsError('failed-precondition', 'Profil fehlt — ensureProfile zuerst aufrufen');
  }
  await ref.set({ settings: { strategy: s } }, { merge: true });
  return { ok: true };
});
