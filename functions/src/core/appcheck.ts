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
export const CALLABLE_OPTS = {
  enforceAppCheck: APPCHECK_ENFORCE,
  invoker: 'public',
} as const;

/** Emulator-only-HTTP-Trigger: in Produktion gar nicht erst aufrufbar. */
export const EMULATOR_TRIGGER_OPTS = { invoker: 'private' } as const;
