/**
 * Firebase-Initialisierung. Die Web-Config ist öffentlich (kein Secret),
 * kommt aber trotzdem aus Env-Variablen (frontend/.env.local, siehe
 * .env.example im Repo-Root), damit kein Projekt-Bezug im Code hängt.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

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
  }
  return app;
}

let emulatorConnected = false;

export function auth(): Auth {
  const a = getAuth(getApp());
  // Lokale Entwicklung gegen die Emulator-Suite (firebase emulators:start):
  // VITE_FIREBASE_USE_EMULATORS=1 in frontend/.env.local setzen.
  if (!emulatorConnected && import.meta.env.VITE_FIREBASE_USE_EMULATORS === '1') {
    connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
    emulatorConnected = true;
  }
  return a;
}
