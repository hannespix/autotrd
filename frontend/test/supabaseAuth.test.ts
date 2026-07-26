/**
 * Übersetzung der Anmelde-Fehlermeldungen (MS2).
 *
 * Der wichtigste Fall ist `email_address_invalid`: Supabase prüft
 * E-Mail-Domains strenger als Firebase und lehnt erfundene Adressen ab —
 * beim ersten Test gegen die echte Instanz ist genau das passiert. Ohne
 * Übersetzung stünde im Anmeldeformular ein roher englischer Fehlercode,
 * und niemand käme darauf, dass die ADRESSE das Problem ist.
 */

import { describe, expect, it } from 'vitest';
import { authErrorText } from '../src/supabase.js';

describe('authErrorText', () => {
  it('erklärt die abgelehnte E-Mail-Domain', () => {
    const t = authErrorText({ code: 'email_address_invalid', message: 'Email address "x@y.z" is invalid' });
    expect(t).toMatch(/E-Mail-Adresse/);
    expect(t).toMatch(/echte, erreichbare/);
    expect(t).not.toMatch(/invalid/i); // kein englischer Rest
  });

  it('nennt bei falschen Zugangsdaten nicht, WAS falsch war', () => {
    // Absicht: „E-Mail oder Passwort" verrät nicht, ob es das Konto gibt.
    const t = authErrorText({ code: 'invalid_credentials' });
    expect(t).toMatch(/E-Mail oder Passwort/);
  });

  it('weist bei unbestätigter Adresse auf den Spam-Ordner hin', () => {
    expect(authErrorText({ code: 'email_not_confirmed' })).toMatch(/Spam/);
  });

  it('schickt bestehende Konten zur Anmeldung', () => {
    expect(authErrorText({ code: 'user_already_exists' })).toMatch(/anmelden/);
  });

  it('nennt die Mindestlänge beim Passwort', () => {
    expect(authErrorText({ code: 'weak_password' })).toMatch(/sechs Zeichen/);
  });

  it('erklärt die Sperre nach zu vielen Versuchen', () => {
    expect(authErrorText({ code: 'over_email_send_rate_limit' })).toMatch(/warten/);
  });

  it('reicht unbekannte Meldungen durch, statt sie zu verschlucken', () => {
    expect(authErrorText({ message: 'Datenbank offline' })).toBe('Datenbank offline');
    expect(authErrorText({})).toMatch(/Unbekannter Fehler/);
  });
});
