/**
 * App-Check-Enforcement (M7) — zentral für alle Callables.
 *
 * Zweistufig scharf geschaltet, damit nichts bricht, bevor der Owner App
 * Check in der Firebase-Konsole eingerichtet hat (SETUP.md §I):
 *   1. Frontend sendet App-Check-Token, sobald VITE_FIREBASE_APPCHECK_SITE_KEY
 *      gesetzt ist (frontend/src/firebase.ts).
 *   2. Functions ERZWINGEN das Token erst mit APPCHECK_ENFORCE=1 in
 *      functions/.env (wird mit dem nächsten Deploy wirksam).
 * Default ist AUS — Clients ohne Token werden dann nicht abgewiesen.
 */

export const APPCHECK_ENFORCE = process.env.APPCHECK_ENFORCE === '1';

/**
 * Gemeinsame Optionen aller Callables. `invoker: 'public'` ist EXPLIZIT
 * gesetzt: Werden Functions in einem fehlgeschlagenen Lauf ohne
 * Public-Invoker angelegt, fasst ein späteres Update die IAM-Policy sonst
 * nie wieder an — der Browser sieht dann dauerhaft 403-Preflights ohne
 * CORS-Header. Öffentlich aufrufbar ≠ ungeschützt: Auth/App-Check/Quotas
 * prüft jede Function selbst.
 */
export const CALLABLE_OPTS: { enforceAppCheck: boolean; invoker: 'public'; secrets: string[] } = {
  enforceAppCheck: APPCHECK_ENFORCE,
  invoker: 'public',
  /**
   * Hauptschlüssel des Key-Tresors an JEDES Callable binden (Secreview 2, M2):
   * Ohne ihn speicherte `connectBroker` Papier-Schlüssel im Klartext, und
   * `brokerStatus`/`setLiveMode`/`resetWallet`/`engineCommand` konnten ein
   * `v1:`-Chiffrat nicht lesen — während der Takt (mit Secret) dieselben
   * Docs entschlüsselte. Das Secret muss VOR dem Deploy existieren
   * (`firebase functions:secrets:set BROKER_MASTER_KEY`, docs/SETUP.md).
   */
  secrets: ['BROKER_MASTER_KEY'],
};

/** Emulator-only-HTTP-Trigger: in Produktion gar nicht erst aufrufbar. */
export const EMULATOR_TRIGGER_OPTS = { invoker: 'private' } as const;
