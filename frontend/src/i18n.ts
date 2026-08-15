/**
 * Sprachumschalter (Task #139, Phase 0) — Deutsch bleibt die Quelle der
 * Wahrheit, Englisch ist eine Übersetzungsschicht darüber.
 *
 * ── Die eine Regel, die alles trägt ───────────────────────────────────────
 *
 * Fehlt eine englische Übersetzung, erscheint der DEUTSCHE Text — niemals
 * ein leerer String, niemals ein Fehler, niemals ein Schlüssel-Name im UI.
 * Damit ist „kaputtmachen" strukturell ausgeschlossen: Der schlimmste
 * denkbare Zustand ist ein deutscher Text im Englisch-Modus, und genau das
 * ist während der schrittweisen Übersetzung (Phase 1, modulweise) der
 * gewollte Zwischenstand.
 *
 * ── Konventionen ──────────────────────────────────────────────────────────
 *
 *  - `DE` ist vollständig und der einzige Ort, an dem neue Texte entstehen.
 *    `EN` darf lücken (Fallback), aber nie Schlüssel erfinden — der Test
 *    `i18n.test.ts` weist Karteileichen ab.
 *  - Schlüssel sind `bereich.name` (z. B. `login.anmelden`), damit die
 *    Phase-1-Tranchen sauber geschnitten werden können.
 *  - Die Wahl liegt in localStorage `autotrd-lang` ('de' Standard | 'en'),
 *    gleiche Mechanik wie das Theme (`autotrd-theme`, s. dashboard.ts).
 *    Serverseitig erzeugte Texte (Journal, KI-Bericht, Regler-Gründe)
 *    bleiben in Phase 0/1 unangetastet — die kommen als Codes in Phase 2.
 */

export type Sprache = 'de' | 'en';

/** Deutsches Wörterbuch — vollständig, Quelle der Wahrheit. */
export const DE = {
  'login.sub': 'Automatisiertes Trading · Paper & Broker-Anbindung · keine Anlageberatung',
  'login.email': 'E-Mail',
  'login.passwort': 'Passwort',
  'login.anmelden': 'Anmelden',
  'login.registrieren': 'Registrieren',
  'login.passwortVergessen': 'Passwort vergessen?',
  'login.oder': 'oder',
  'login.mitGoogle': 'Mit Google anmelden',
  'login.emailFehlt': 'Bitte oben die E-Mail-Adresse eintragen.',
  'login.resetUnterwegs': 'Passwort-Reset-Mail ist unterwegs (Spam-Ordner prüfen).',
  'auth.falscheDaten': 'E-Mail oder Passwort ist falsch.',
  'auth.ungueltigeEmail': 'Das ist keine gültige E-Mail-Adresse.',
  'auth.emailVergeben': 'Für diese E-Mail existiert bereits ein Konto.',
  'auth.schwachesPasswort': 'Das Passwort ist zu schwach (mindestens 6 Zeichen).',
  'auth.zuVieleVersuche': 'Zu viele Versuche — bitte kurz warten.',
  'auth.googleAbgebrochen': 'Google-Anmeldung abgebrochen.',
  'auth.fehlgeschlagen': 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.',
} as const;

export type TextSchluessel = keyof typeof DE;

/**
 * Englisches Wörterbuch — darf Lücken haben (dann greift der Fallback),
 * aber KEINE Schlüssel außerhalb von `DE` (Karteileichen-Test).
 */
export const EN: Partial<Record<TextSchluessel, string>> = {
  'login.sub': 'Automated trading · paper & broker connection · not investment advice',
  'login.email': 'Email',
  'login.passwort': 'Password',
  'login.anmelden': 'Sign in',
  'login.registrieren': 'Sign up',
  'login.passwortVergessen': 'Forgot password?',
  'login.oder': 'or',
  'login.mitGoogle': 'Sign in with Google',
  'login.emailFehlt': 'Please enter your email address above.',
  'login.resetUnterwegs': 'Password reset email is on its way (check your spam folder).',
  'auth.falscheDaten': 'Email or password is incorrect.',
  'auth.ungueltigeEmail': 'That is not a valid email address.',
  'auth.emailVergeben': 'An account already exists for this email.',
  'auth.schwachesPasswort': 'The password is too weak (at least 6 characters).',
  'auth.zuVieleVersuche': 'Too many attempts — please wait a moment.',
  'auth.googleAbgebrochen': 'Google sign-in was cancelled.',
  'auth.fehlgeschlagen': 'Sign-in failed. Please try again.',
};

/**
 * Pure Übersetzungs-Regel — als eigene Funktion, damit der Test die
 * Fallback-Semantik mit beliebigen Wörterbüchern prüfen kann, ohne
 * localStorage zu stubben.
 */
export function uebersetze(
  schluessel: TextSchluessel,
  sprache: Sprache,
  en: Partial<Record<TextSchluessel, string>> = EN,
): string {
  if (sprache === 'en') {
    const u = en[schluessel];
    if (typeof u === 'string' && u.length > 0) return u;
  }
  return DE[schluessel];
}

/** Gewählte Sprache — alles außer ausdrücklichem 'en' ist Deutsch. */
export function sprachWahl(): Sprache {
  try {
    return localStorage.getItem('autotrd-lang') === 'en' ? 'en' : 'de';
  } catch {
    return 'de';
  }
}

/** Wahl speichern — das Anwenden (Neu-Rendern) entscheidet der Aufrufer. */
export function setzeSprache(sprache: Sprache): void {
  localStorage.setItem('autotrd-lang', sprache);
}

/** Der Übersetzer fürs UI: deutscher Text oder seine englische Fassung. */
export function t(schluessel: TextSchluessel): string {
  return uebersetze(schluessel, sprachWahl());
}
