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
  const ref = getFirestore().doc(`users/${uid}`);
  const vorher = await ref.get();
  if (!vorher.exists) {
    throw new HttpsError('failed-precondition', 'Profil fehlt — ensureProfile zuerst aufrufen');
  }

  // Katalog-Symbole (yfinance-Konventionen, z. B. '^GSPC' statt 'GSPC') —
  // seit Stufe 3 (Task 121) erweitert um das Alpaca-Universum: Was der
  // Broker laut täglichem Sync wirklich handelt, darf auf die Watchlist,
  // auch ohne Katalog-Eintrag. Der Universums-Blick kostet nur dann eine
  // Lesung, wenn tatsächlich ein Nicht-Katalog-Symbol dabei ist.
  //
  // ── Bestandsschutz (Owner-Befund 15.08.) ────────────────────────────────
  //
  // Nur NEU hinzukommende Symbole müssen bekannt sein. Der Alpaca-first-
  // Umbau (Stufe 2) hat Indizes und Futures aus dem Katalog genommen —
  // Watchlists aus der Zeit davor tragen sie aber noch. Ohne diese Zeile
  // blockierte ein '^NDX' von Juli JEDEN Speichern-Klick des Kontos
  // („Unbekannte Symbole: ^NDX, GC=F"), auch wenn die Änderung mit der
  // Watchlist nichts zu tun hatte — der Klassen-Regler ließ sich so nicht
  // mehr verstellen. Was schon gespeichert ist, war beim Eintragen gültig
  // und bleibt; einmal entfernt, kommt es nicht wieder hinein.
  const catalog = new Set(allSymbols());
  let unknown = s.watchlist.filter((sym) => !catalog.has(sym));
  if (unknown.length > 0) {
    const bestand = new Set(
      (vorher.get('settings.strategy.watchlist') as string[] | undefined) ?? [],
    );
    unknown = unknown.filter((sym) => !bestand.has(sym));
  }
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

  await ref.set({ settings: { strategy: s } }, { merge: true });
  return { ok: true };
});
