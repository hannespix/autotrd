/**
 * Firebase-Initialisierung. Die Web-Config ist öffentlich (kein Secret),
 * kommt aber trotzdem aus Env-Variablen (frontend/.env.local, siehe
 * .env.example im Repo-Root), damit kein Projekt-Bezug im Code hängt.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

// App Check (M7): nur aktiv, wenn der Site-Key gesetzt ist — sonst No-Op,
// damit lokale Entwicklung und Deploys ohne Console-Setup nicht brechen.
// Serverseitig erzwungen wird das Token erst mit APPCHECK_ENFORCE=1
// (functions/.env, SETUP.md §I).
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY as string | undefined;
let appCheckInitialized = false;

function initAppCheckOnce(a: FirebaseApp): void {
  if (appCheckInitialized || !appCheckSiteKey) return;
  if (import.meta.env.VITE_FIREBASE_USE_EMULATORS === '1') {
    // Debug-Provider für Emulator/localhost (Token erscheint in der Konsole
    // und wird in der Firebase-Konsole freigeschaltet)
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      true;
  }
  initializeAppCheck(a, {
    provider: new ReCaptchaV3Provider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
  appCheckInitialized = true;
}

/** true, sobald die Pflichtwerte der Web-Config gesetzt sind. */
export function hasFirebaseConfig(): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

let app: FirebaseApp | null = null;

function getApp(): FirebaseApp {
  if (!app) {
    app = initializeApp({
      apiKey: config.apiKey!,
      authDomain: config.authDomain!,
      projectId: config.projectId!,
      appId: config.appId!,
    });
    initAppCheckOnce(app);
  }
  return app;
}

const useEmulators = import.meta.env.VITE_FIREBASE_USE_EMULATORS === '1';
let authEmulatorConnected = false;
let dbEmulatorConnected = false;

export function auth(): Auth {
  const a = getAuth(getApp());
  // Lokale Entwicklung gegen die Emulator-Suite (firebase emulators:start):
  // VITE_FIREBASE_USE_EMULATORS=1 in frontend/.env.local setzen.
  if (!authEmulatorConnected && useEmulators) {
    connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
    authEmulatorConnected = true;
  }
  return a;
}

export function db(): Firestore {
  const d = getFirestore(getApp());
  if (!dbEmulatorConnected && useEmulators) {
    connectFirestoreEmulator(d, '127.0.0.1', 8081);
    dbEmulatorConnected = true;
  }
  return d;
}
