/**
 * ensureProfile — legt users/{uid} beim ersten Login an (idempotent).
 * Die Rules verbieten Client-`create` bewusst (ARCHITECTURE §5); dieses
 * Callable ist der einzige Weg, ein Profil zu erzeugen.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  DEFAULT_STRATEGY,
  RISIKO_VERSION,
  applyVariantId,
  buildPriors,
  istAktuelleRisikoVersion,
  recommendedStart,
  type GlobalAxisStats,
  type Strategy,
} from '../../../shared/src/index.js';
import { clampStrategyRisk } from '../core/rulesTrading.js';
import { consumeQuota } from '../core/broker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const DAILY_LIMIT = 60; // idempotent + 1 Call je Login — 60/Tag ist großzügig

export const ensureProfile = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');

  if (!(await consumeQuota(uid, 'ensureProfile', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', 'srv.tageslimitErreicht');
  }

  const ref = getFirestore().doc(`users/${uid}`);
  const snap = await ref.get();
  // Bestandskonto — nicht fragen, nicht aussperren (Owner 22.08.: „nur
  // neue Kunden"). Der Check steht bewusst VOR der Risiko-Prüfung.
  if (snap.exists) return { created: false };

  /* Ab hier entsteht ein NEUES Konto — und dafür ist die Zustimmung zum
   * Risikohinweis Bedingung, nicht Beiwerk.
   *
   * Serverseitig, weil ein Häkchen im Formular keine Zustimmung ist,
   * sondern eine Anzeige: Wer den Client umgeht, hätte sonst genau das
   * Konto, das zum Problem wird. Ohne gültige Fassung entsteht deshalb
   * gar kein Profil — kein Wallet, keine Strategie, keine Zugangsstufe.
   *
   * Der Fehler ist eine ANSAGE, kein stilles Scheitern: Die Oberfläche
   * fängt ihn ab und legt die Bestätigung vor. */
  const { risiko } = (request.data ?? {}) as { risiko?: unknown };
  if (!istAktuelleRisikoVersion(risiko)) {
    throw new HttpsError('failed-precondition', 'srv.risikoBestaetigungFehlt');
  }

  const now = new Date().toISOString();
  const strategy = await startStrategie();
  await ref.set({
    // Zugangsstufe (Owner-Auftrag 26.07.): NEUE Konten starten auf 'pending'
    // und dürfen ansehen, aber nicht handeln. Das Feld liegt bewusst außerhalb
    // von `settings` — dort erlauben die Rules Client-Updates, hier nicht.
    // Bestandskonten ohne das Feld gelten weiter als freigeschaltet
    // (core/access.ts), damit diese Änderung niemanden aussperrt.
    accessLevel: 'pending',
    requestedAt: now,
    /* Was, wann, zu welcher Fassung — ein blosses `true` bewiese nicht,
     * WOZU jemand zugestimmt hat. Das Feld liegt ausserhalb von
     * `settings`: Dort erlauben die Regeln Client-Updates, hier nicht. */
    risiko: { version: RISIKO_VERSION, at: now },
    profile: {
      createdAt: now,
      plan: 'free',
    },
    settings: {
      strategy,
    },
    // Paper-Wallet: Startkapital aus dem Default — NUR Functions schreiben hier
    wallet: {
      paperBalance: strategy.broker.initialCapital,
      currency: 'USD',
      updatedAt: now,
      // Kapitalbasis der Gesamt-P&L (Equity − baseCapital); siehe Wallet-Typ
      baseCapital: strategy.broker.initialCapital,
    },
  });
  return { created: true };
});

/**
 * Die Startstrategie eines NEUEN Kontos (Owner-Wunsch 28.07.: „das Tool soll
 * sich als Gesamtes verbessern, nicht nur pro User").
 *
 * Bisher startete jedes Konto bei den Fabrik-Defaults und musste die
 * Erfahrung des Systems von null neu erarbeiten — bei einem Tuner, der
 * Signifikanz verlangt, sind das Wochen. Jetzt beginnt es dort, wo das
 * Kollektiv nachweislich steht.
 *
 * Drei Sicherungen, die das harmlos machen:
 *
 *  1. **Nur der Startpunkt.** Der lokale Tuner korrigiert danach wie bisher;
 *     nichts hier ersetzt eine lokale Signifikanzprüfung.
 *  2. **Höchstens eine Änderung je Achse** (`recommendedStart`) — sonst
 *     stapelten sich Effekte, die einzeln geprüft wurden und gemeinsam nie.
 *  3. **Die Risiko-Hülle läuft zuletzt.** Was ein Mensch über die Oberfläche
 *     nicht einstellen dürfte, kommt auch hier nicht durch.
 *
 * Fällt irgendetwas davon aus, gibt es die Defaults — ein Profil darf an
 * einer Empfehlung niemals scheitern.
 */
async function startStrategie(): Promise<Strategy> {
  const basis = structuredClone(DEFAULT_STRATEGY) as Strategy;
  try {
    const axes = (await getFirestore().doc('meta/tuneGlobal').get()).get('axes') as
      | GlobalAxisStats
      | undefined;
    if (!axes) return basis;
    for (const id of recommendedStart(buildPriors(axes))) applyVariantId(basis, id);
    return clampStrategyRisk(basis);
  } catch {
    return basis;
  }
}
