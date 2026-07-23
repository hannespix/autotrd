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

/** Gemeinsame Optionen aller Callables (heute nur App Check). */
export const CALLABLE_OPTS = { enforceAppCheck: APPCHECK_ENFORCE } as const;
