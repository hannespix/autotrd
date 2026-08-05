import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from './firebase.js';

/**
 * Anmeldung auffrischen — der zweite Faktor an der Stelle, wo er wirkt.
 *
 * Gebraucht beim Hinterlegen eines ECHTGELD-Schlüssels: Der Server verlangt
 * dafür eine Anmeldung, die höchstens fünf Minuten alt ist (`auth_time` im
 * ID-Token). Das schützt gegen den Fall, den 2FA beim Login nicht abdeckt —
 * eine übernommene, bereits offene Sitzung.
 *
 * Wirft, wenn das Passwort falsch ist oder der Nutzer den Google-Dialog
 * abbricht. Der Aufrufer zeigt die Meldung und speichert NICHTS.
 *
 * `getIdToken(true)` am Ende ist entscheidend: Ohne die Erzwingung liefe der
 * nächste Aufruf mit dem alten, gecachten Token — und dessen `auth_time`
 * wäre unverändert alt. Die Reauthentifizierung wäre wirkungslos, ohne dass
 * es jemandem auffiele.
 */
export async function frischAnmelden(passwort?: string): Promise<void> {
  const u = auth().currentUser;
  if (!u) throw new Error('Nicht angemeldet.');
  const perGoogle = u.providerData.some((p) => p.providerId === 'google.com');
  if (perGoogle) {
    await reauthenticateWithPopup(u, new GoogleAuthProvider());
  } else {
    if (!u.email) throw new Error('Zu diesem Konto ist keine E-Mail-Adresse hinterlegt.');
    if (!passwort) throw new Error('Bitte das Passwort eingeben.');
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, passwort));
  }
  await u.getIdToken(true);
}

export function watchAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth(), cb);
}

export async function loginEmail(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth(), email, password);
}

export async function registerEmail(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(auth(), email, password);
}

export async function loginGoogle(): Promise<void> {
  await signInWithPopup(auth(), new GoogleAuthProvider());
}

export async function logout(): Promise<void> {
  await signOut(auth());
}

/** Verifikations-Mail an den eingeloggten User (Engine-Start braucht das, M7). */
export async function sendVerification(): Promise<void> {
  const user = auth().currentUser;
  if (!user) throw new Error('Nicht angemeldet');
  await sendEmailVerification(user);
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth(), email);
}

/** true, wenn die E-Mail des aktuellen Users bestätigt ist (Google zählt). */
export function emailVerified(): boolean {
  return auth().currentUser?.emailVerified === true;
}

/** Token-Refresh nach Verifikation (emailVerified landet erst im neuen Token). */
export async function refreshUser(): Promise<boolean> {
  const user = auth().currentUser;
  if (!user) return false;
  await user.reload();
  await user.getIdToken(true);
  return user.emailVerified;
}

/** Firebase-Fehlercodes → verständliche deutsche Meldung. */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-Mail oder Passwort ist falsch.';
    case 'auth/invalid-email':
      return 'Das ist keine gültige E-Mail-Adresse.';
    case 'auth/email-already-in-use':
      return 'Für diese E-Mail existiert bereits ein Konto.';
    case 'auth/weak-password':
      return 'Das Passwort ist zu schwach (mindestens 6 Zeichen).';
    case 'auth/too-many-requests':
      return 'Zu viele Versuche — bitte kurz warten.';
    case 'auth/popup-closed-by-user':
      return 'Google-Anmeldung abgebrochen.';
    default:
      return 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.';
  }
}
