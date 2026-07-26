/**
 * Supabase-Client (MS2) — Gegenstück zu firebase.ts.
 *
 * Welches Backend die App benutzt, entscheidet EINE Umgebungsvariable:
 *   VITE_BACKEND=supabase   → diese Datei
 *   (alles andere)          → Firebase, wie bisher
 *
 * Warum ein Schalter statt eines harten Schnitts: Firebase betreibt gerade
 * das laufende System. Solange nicht jeder Pfad auf Supabase nachweislich
 * grün ist, wäre ein Austausch ohne Rückweg leichtsinnig — mit dem Schalter
 * lässt sich die neue Datenschicht vollständig testen, während autotrd.net
 * unverändert weiterläuft. Der Umschalttag ist dann eine Variablen-Änderung.
 *
 * Der `anon`-Schlüssel steht im ausgelieferten JavaScript — das ist so
 * vorgesehen: Geschützt wird über Row Level Security in der Datenbank
 * (supabase/migrations/0002_rls.sql), nicht über Geheimhaltung des
 * Schlüssels.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Läuft die App gegen Supabase? Steuert die Auswahl der Datenschicht. */
export function useSupabase(): boolean {
  return import.meta.env.VITE_BACKEND === 'supabase';
}

export function sb(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) {
      throw new Error(
        'VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY fehlen — siehe docs/SETUP.md §K',
      );
    }
    client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Die Sitzung liegt im localStorage; ohne detectSessionInUrl würde
        // der Bestätigungslink aus der E-Mail nicht zur Anmeldung führen.
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

/**
 * Fehlermeldungen von Supabase sind englisch und technisch. Die Anmeldung
 * ist der erste Kontakt mit der App — hier lohnt sich die Übersetzung
 * besonders, und zwar so, dass sie sagt, was zu TUN ist.
 *
 * Der Fall `email_address_invalid` ist dabei kein Randfall: Supabase prüft
 * Domains strenger als Firebase und lehnt erfundene Adressen ab. Ohne
 * Übersetzung stünde dort ein roher Fehlercode.
 */
export function authErrorText(err: unknown): string {
  const e = err as { message?: string; code?: string; status?: number };
  const code = e?.code ?? '';
  const msg = (e?.message ?? '').toLowerCase();

  if (code === 'email_address_invalid' || msg.includes('email address') && msg.includes('invalid')) {
    return 'Diese E-Mail-Adresse wird nicht akzeptiert. Bitte eine echte, erreichbare Adresse verwenden.';
  }
  if (code === 'invalid_credentials' || msg.includes('invalid login')) {
    return 'E-Mail oder Passwort stimmt nicht.';
  }
  if (code === 'email_not_confirmed' || msg.includes('not confirmed')) {
    return 'Bitte zuerst die Bestätigungsmail öffnen. Sieh notfalls im Spam-Ordner nach.';
  }
  if (code === 'user_already_exists' || msg.includes('already registered')) {
    return 'Für diese Adresse gibt es schon ein Konto — bitte anmelden.';
  }
  if (code === 'weak_password' || msg.includes('password should be')) {
    return 'Das Passwort ist zu kurz — mindestens sechs Zeichen.';
  }
  if (code === 'over_email_send_rate_limit' || msg.includes('rate limit')) {
    return 'Zu viele Versuche in kurzer Zeit. Bitte ein paar Minuten warten.';
  }
  return e?.message ?? 'Unbekannter Fehler bei der Anmeldung.';
}
