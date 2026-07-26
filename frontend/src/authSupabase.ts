/**
 * Anmeldung gegen Supabase (MS2) — spiegelt die Schnittstelle von auth.ts.
 *
 * Die App braucht vom angemeldeten Nutzer nur zwei Dinge: `uid` und `email`.
 * Deshalb reicht hier ein schlankes eigenes Objekt statt eines fremden
 * Nutzer-Typs — die Oberfläche muss dadurch an keiner Stelle wissen, welches
 * Backend gerade antwortet.
 *
 * Ein Unterschied zu Firebase, der bewusst so bleibt: Ein Profil legt hier
 * kein Callable an, sondern ein Datenbank-Trigger beim Registrieren
 * (Migration 0006). Damit gibt es keinen Moment, in dem jemand angemeldet,
 * aber ohne Zugangsstufe unterwegs wäre.
 */

import { authErrorText, sb } from './supabase.js';

export interface AppUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

/** Aktuelle Sitzung beobachten (wie onAuthStateChanged). */
export function watchAuthSb(cb: (user: AppUser | null) => void): () => void {
  // Erste Antwort sofort aus der gespeicherten Sitzung — sonst blitzt beim
  // Laden für einen Moment die Anmeldemaske auf, obwohl man angemeldet ist.
  void sb()
    .auth.getSession()
    .then(({ data }) => cb(toUser(data.session?.user)));

  const { data } = sb().auth.onAuthStateChange((_event, session) => {
    cb(toUser(session?.user));
  });
  return () => data.subscription.unsubscribe();
}

function toUser(u: { id: string; email?: string; email_confirmed_at?: string } | undefined | null): AppUser | null {
  if (!u) return null;
  return {
    uid: u.id,
    email: u.email ?? null,
    emailVerified: Boolean(u.email_confirmed_at),
  };
}

export async function loginEmailSb(email: string, password: string): Promise<void> {
  const { error } = await sb().auth.signInWithPassword({ email, password });
  if (error) throw new Error(authErrorText(error));
}

export async function registerEmailSb(email: string, password: string): Promise<void> {
  const { error } = await sb().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw new Error(authErrorText(error));
}

export async function logoutSb(): Promise<void> {
  await sb().auth.signOut();
}

export async function resetPasswordSb(email: string): Promise<void> {
  const { error } = await sb().auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/#/passwort`,
  });
  if (error) throw new Error(authErrorText(error));
}

/** Bestätigungsmail erneut senden (Supabase kennt kein „an aktuellen Nutzer"). */
export async function sendVerificationSb(email: string): Promise<void> {
  const { error } = await sb().auth.resend({ type: 'signup', email });
  if (error) throw new Error(authErrorText(error));
}

/** Sitzung neu laden — nach der Bestätigung steckt das Merkmal im neuen Token. */
export async function refreshUserSb(): Promise<boolean> {
  const { data } = await sb().auth.refreshSession();
  return Boolean(data.session?.user?.email_confirmed_at);
}

/**
 * Zugangsstufe des angemeldeten Nutzers (Owner-Auftrag 26.07.).
 * Fehlt die Zeile noch — der Trigger legt sie beim Registrieren an —, gilt
 * das Konto als in Prüfung, nicht als freigeschaltet: Im Zweifel sperren.
 */
export async function accessLevelSb(): Promise<'pending' | 'approved' | 'blocked'> {
  const { data } = await sb().auth.getUser();
  const uid = data.user?.id;
  if (!uid) return 'pending';
  const res = await sb().from('profiles').select('access_level').eq('id', uid).maybeSingle();
  const lvl = res.data?.access_level as string | undefined;
  return lvl === 'approved' || lvl === 'blocked' ? lvl : 'pending';
}
