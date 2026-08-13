/**
 * saveStrategy — validiert das FLACHE Strategie-Schema serverseitig
 * (shared/validateStrategy, lehnt das kaputte Alt-Schema hart ab) und
 * schreibt es nach users/{uid}.settings.strategy.
 *
 * Härtung (M7): Tages-Quota gegen Schreib-Spam; die Engine (Auto-Trading)
 * lässt sich erst mit BESTÄTIGTER E-Mail einschalten — Google-Logins gelten
 * als bestätigt (email_verified im Token).
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  allSymbols,
  CLASS_LABELS,
  klemmeGewicht,
  MAX_WATCHLIST,
  validateStrategy,
  type Strategy,
} from '../../../shared/src/index.js';
import { consumeQuota } from '../core/broker.js';
import { ladeUniversumSymbole } from '../core/universumLeser.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const DAILY_SAVE_LIMIT = 300;

export const saveStrategy = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  if (!(await consumeQuota(uid, 'saveStrategy', DAILY_SAVE_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Tageslimit von ${DAILY_SAVE_LIMIT} Speicherungen erreicht`);
  }

  const strategy = (request.data as { strategy?: unknown })?.strategy;
  const problems = validateStrategy(strategy);
  if (problems.length > 0) {
    throw new HttpsError('invalid-argument', problems.join(' · '));
  }
  const s = strategy as Strategy;

  if (s.watchlist.length > MAX_WATCHLIST) {
    throw new HttpsError('invalid-argument', `Watchlist ist auf ${MAX_WATCHLIST} Symbole begrenzt`);
  }
  // Katalog-Symbole (yfinance-Konventionen, z. B. '^NDX' statt 'NDX') —
  // seit Stufe 3 (Task 121) erweitert um das Alpaca-Universum: Was der
  // Broker laut täglichem Sync wirklich handelt, darf auf die Watchlist,
  // auch ohne Katalog-Eintrag. Der Universums-Blick kostet nur dann eine
  // Lesung, wenn tatsächlich ein Nicht-Katalog-Symbol dabei ist.
  const catalog = new Set(allSymbols());
  let unknown = s.watchlist.filter((sym) => !catalog.has(sym));
  if (unknown.length > 0) {
    const universum = await ladeUniversumSymbole();
    unknown = unknown.filter((sym) => !universum.has(sym));
  }
  if (unknown.length > 0) {
    throw new HttpsError(
      'invalid-argument',
      `Unbekannte Symbole (weder Katalog noch Alpaca-Universum): ${unknown.join(', ')}`,
    );
  }
  // Broker-Guards: Client kann hierüber NIE live schalten (M8/M14-Thema)
  if (s.broker.mode !== 'paper') {
    throw new HttpsError('invalid-argument', 'broker.mode ist bis M14 fest auf paper');
  }
  // Engine-Start nur mit bestätigter E-Mail (M7 — Missbrauchsbremse:
  // Auto-Trading erzeugt laufende Serverlast pro User)
  if (s.engine.running === true && request.auth?.token.email_verified !== true) {
    throw new HttpsError(
      'failed-precondition',
      'Bitte zuerst die E-Mail-Adresse bestätigen — dann lässt sich die Engine starten.',
    );
  }

  // Klassen-Regler normalisieren (MG2): nur bekannte Anlageklassen, Werte in
  // der Hülle 0…1,5. Die Ausführung klemmt beim LESEN ohnehin — aber ein
  // Dokument, in dem „× 99" steht, lädt beim nächsten Öffnen der
  // Einstellungen genau die Zahl, die nie gewirkt hat. Falsche Werte gar
  // nicht erst ablegen ist ehrlicher als sie still zu ignorieren.
  if (s.engine.classWeights && typeof s.engine.classWeights === 'object') {
    const sauber: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.engine.classWeights)) {
      if (k in CLASS_LABELS) sauber[k] = klemmeGewicht(typeof v === 'number' ? v : undefined);
    }
    s.engine.classWeights = sauber;
  }

  const ref = getFirestore().doc(`users/${uid}`);
  if (!(await ref.get()).exists) {
    throw new HttpsError('failed-precondition', 'Profil fehlt — ensureProfile zuerst aufrufen');
  }
  await ref.set({ settings: { strategy: s } }, { merge: true });
  return { ok: true };
});
