/**
 * saveStrategy — Einstellungen des Auto-Traders je Nutzer.
 *
 * Payload: `{ auto?: AutoSettings; engineRunning?: boolean }` — mindestens
 * eines von beiden.
 *
 *   auto           ⇒ `validateAutoSettings` (shared) gegen das Plattform-
 *                    Universum (`meta/engineConfig.universe.symbols`,
 *                    Fallback: die eingebauten Symbole des Takts) ⇒
 *                    `users/{uid}.settings.auto`. Die Map wird als GANZES
 *                    ersetzt: Ein Merge ließe eine abgewählte Symbol-Liste
 *                    stehen. Geschwister unter `settings` bleiben unberührt.
 *   engineRunning  ⇒ `settings.strategy.engine.running` per Punktpfad — die
 *                    übrigen Alt-Felder bleiben stehen. Über genau dieses
 *                    Feld findet der Engine-Takt seine Nutzer.
 *
 * Alt-Payload `{ strategy }` (Übergang, altes Frontend): Es wird NUR
 * `engine.running` übernommen; alles andere wird ignoriert, mit Log-Hinweis.
 * Die Handelsparameter des alten Schemas haben im Auto-Trader keine Wirkung
 * mehr — Strategie und Parameter kommen für alle aus dem Champion.
 *
 * Härtung (M7, weiterhin gültig): Tages-Quota gegen Schreib-Spam; die Engine
 * lässt sich nur mit BESTÄTIGTER E-Mail einschalten (Google-Logins gelten als
 * bestätigt: `email_verified` im Token) …
 *
 * … und erst ab FREISCHALTUNG (Befund 23.08.): Eine laufende Engine ist
 * Serverlast und Broker-Aufrufe je Nutzer. Der Takt filtert Nicht-
 * Freigeschaltete selbst (`mayTrade`) — das hier ist die zweite Hälfte: Was
 * gar nicht erst eingeschaltet werden kann, muss auch nirgends ausgefiltert
 * werden. Zwei Riegel für dieselbe Tür, weil ein einzelner beim nächsten
 * Umbau übersehen wird. Fehlendes `accessLevel` gilt als freigeschaltet
 * (Bestandskonten, siehe shared/zugang.ts). AUSSCHALTEN ist immer erlaubt.
 *
 * Der Broker-Modus (paper/live) wird hier nie gesetzt — das bleibt
 * `setLiveMode` mit seiner Guard-Kette.
 *
 * Die Logik ist von der Callable-Hülle getrennt (`speichereEinstellungen`),
 * damit sie mit dem In-Memory-Firestore der Takt-Tests geprüft werden kann.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { normalizeUserSymbol } from '../../../src/alpaca/symbols.ts';
import {
  engineRunningAus,
  validateAutoSettings,
  validateStrategy,
  type AutoSettings,
} from '../../../shared/src/index.js';
import { mayTrade } from '../core/access.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/quota.js';
import { DEFAULT_UNIVERSE, globalConfigRaw } from '../engine/config.js';
import { isRecord, type FirestoreLike } from '../engine/firestoreLike.js';

const DAILY_SAVE_LIMIT = 300;

/** Globale Engine-Config — derselbe Pfad wie `CONFIG_PATH` in engine/tick.ts (der Test pinnt das). */
export const ENGINE_CONFIG_PATH = 'meta/engineConfig';

export interface SpeicherLog {
  info(...args: unknown[]): void;
}

export interface SpeicherDeps {
  db: FirestoreLike;
  /** E-Mail des Aufrufers bestätigt (`email_verified` im Token)? */
  emailBestaetigt: boolean;
  log: SpeicherLog;
}

export interface SpeicherErgebnis {
  ok: true;
  /** Gespeicherte, normalisierte Einstellungen — der Client übernimmt sie 1:1 ins Formular. */
  auto?: AutoSettings;
  engineRunning?: boolean;
}

export interface PlattformUniversum {
  assetClass: 'us_equity' | 'crypto';
  /** Kanonische Schreibweise (`normalizeUserSymbol`), wie sie der Takt selbst herstellt. */
  symbols: string[];
}

/**
 * Plattform-Universum aus `meta/engineConfig` — über dieselbe Ableitung
 * (`globalConfigRaw`) wie der Takt, damit hier nichts als bekannt gilt, was
 * dort nicht gehandelt würde. Fehlt das Doc oder die Liste: eingebaute
 * Symbole.
 */
export async function ladePlattformUniversum(db: FirestoreLike): Promise<PlattformUniversum> {
  const snap = await db.doc(ENGINE_CONFIG_PATH).get();
  const global = globalConfigRaw(snap.exists ? snap.data() : undefined);
  const u = isRecord(global.universe) ? global.universe : {};
  const assetClass = u.assetClass === 'crypto' ? 'crypto' : 'us_equity';
  const roh = Array.isArray(u.symbols) ? u.symbols.filter((x): x is string => typeof x === 'string') : [];
  const symbols = (roh.length > 0 ? roh : [...DEFAULT_UNIVERSE]).map((x) => normalizeUserSymbol(x, assetClass));
  return { assetClass, symbols };
}

/** Validierungs-Ablehnung: `val.*`-Codes, mit ' · ' gejoint — `serverText` löst jeden einzeln auf. */
function ungueltig(codes: readonly string[]): HttpsError {
  return new HttpsError('invalid-argument', codes.join(' · '));
}

/**
 * Nutzer-Symbole VOR der Prüfung in die Broker-Schreibweise bringen
 * (brk-b → BRK.B, btcusd → BTC/USD) — dieselbe Übersetzung, die der Takt
 * beim Lesen anwendet. Nicht-Strings bleiben stehen, damit die Validierung
 * sie als das meldet, was sie sind.
 */
function mitBrokerSchreibweise(auto: unknown, assetClass: PlattformUniversum['assetClass']): unknown {
  if (!isRecord(auto) || !Array.isArray(auto.symbols)) return auto;
  return {
    ...auto,
    symbols: auto.symbols.map((x) => (typeof x === 'string' ? normalizeUserSymbol(x, assetClass) : x)),
  };
}

export async function speichereEinstellungen(deps: SpeicherDeps, uid: string, data: unknown): Promise<SpeicherErgebnis> {
  const p = isRecord(data) ? data : {};

  // Erst das Payload, dann Firestore: Für Müll wird nichts gelesen.
  if (p.auto === undefined && p.engineRunning === undefined && p.strategy === undefined) {
    throw ungueltig(['val.pflichtFehlt|auto']);
  }

  // Engine-Schalter: das neue Feld hat Vorrang; sonst der Alt-Payload,
  // aus dem nur `engine.running` gelesen wird.
  let running: boolean | undefined;
  if (p.engineRunning !== undefined) {
    if (typeof p.engineRunning !== 'boolean') throw ungueltig(['val.boolean|engineRunning']);
    running = p.engineRunning;
  } else if (p.strategy !== undefined) {
    const probleme = validateStrategy(p.strategy);
    if (probleme.length > 0) throw ungueltig(probleme);
    running = engineRunningAus(p.strategy);
    deps.log.info('saveStrategy: Alt-Payload {strategy} — nur engine.running übernommen, alle anderen Felder ignoriert', {
      uid,
      running,
    });
  }

  const ref = deps.db.doc(`users/${uid}`);
  const vorher = await ref.get();
  if (!vorher.exists) {
    throw new HttpsError('failed-precondition', 'srv.profilFehltEnsure');
  }

  if (running === true) {
    if (!deps.emailBestaetigt) {
      throw new HttpsError('failed-precondition', 'srv.emailZuerstBestaetigen');
    }
    if (!mayTrade(vorher.data())) {
      throw new HttpsError('failed-precondition', 'srv.freischaltungAbwarten');
    }
  }

  let auto: AutoSettings | undefined;
  if (p.auto !== undefined) {
    const universum = await ladePlattformUniversum(deps.db);
    const pruefung = validateAutoSettings(mitBrokerSchreibweise(p.auto, universum.assetClass), universum.symbols);
    if (!pruefung.ok || pruefung.wert === null) throw ungueltig(pruefung.fehler);
    auto = pruefung.wert;
  }

  // EIN Update mit Punktpfaden: `settings.auto` wird als Map ersetzt,
  // `settings.strategy.engine.running` einzeln gesetzt — alles andere unter
  // `settings` (ui, hotkeys, die Alt-Strategie) bleibt, wie es war.
  const update: Record<string, unknown> = {};
  if (auto !== undefined) update['settings.auto'] = auto;
  if (running !== undefined) update['settings.strategy.engine.running'] = running;
  await ref.update(update);

  const out: SpeicherErgebnis = { ok: true };
  if (auto !== undefined) out.auto = auto;
  if (running !== undefined) out.engineRunning = running;
  return out;
}

export const saveStrategy = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');

  if (!(await consumeQuota(uid, 'saveStrategy', DAILY_SAVE_LIMIT))) {
    throw new HttpsError('resource-exhausted', `srv.tageslimitSpeicherungen|${DAILY_SAVE_LIMIT}`);
  }

  return speichereEinstellungen(
    {
      db: getFirestore(),
      emailBestaetigt: request.auth?.token.email_verified === true,
      log: logger,
    },
    uid,
    request.data,
  );
});
