/**
 * Tests der verschlüsselten Schlüsselablage (05.08.).
 *
 * Der Schwerpunkt liegt auf den Fällen, in denen ein Fehler ECHTES GELD
 * kostet oder ein Geheimnis preisgibt:
 *
 *   - Ein Fehlschlag beim Verschlüsseln darf NIEMALS still auf Klartext
 *     zurückfallen. Ein Aufrufer, der glaubt zu verschlüsseln, aber
 *     Klartext speichert, ist schlimmer als einer, der weiß, dass er es
 *     nicht kann.
 *   - Manipuliertes Chiffrat muss erkannt werden, statt Müll zu liefern,
 *     den dann jemand als Zugangsdaten an einen Broker schickt.
 *   - Der Klartext-Altbestand muss weiter lesbar bleiben, sonst verlieren
 *     alle bestehenden Papierkonten beim Deploy ihre Verbindung.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VAULT_ENV,
  entschluessle,
  gleich,
  hauptschluessel,
  istVerschluesselt,
  vaultBereit,
  verschluessle,
} from '../src/core/keyVault.js';

/** 32 Byte, base64 — die einzige akzeptierte Form. */
const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const GEHEIM = 'ein-alpaca-secret-mit-genug-laenge-0123456789';

beforeEach(() => {
  process.env[VAULT_ENV] = KEY_A;
});
afterEach(() => {
  delete process.env[VAULT_ENV];
});

describe('Hauptschlüssel', () => {
  it('akzeptiert genau 32 Byte', () => {
    expect(hauptschluessel()?.length).toBe(32);
    expect(vaultBereit()).toBe(true);
  });

  it('lehnt einen zu kurzen Schlüssel ab, statt ihn aufzufüllen', () => {
    // Ein auf 32 Byte gepolstertes Passwort sieht aus wie Verschlüsselung
    // und ist keine — die Schlüsselstärke bliebe die des Passworts.
    process.env[VAULT_ENV] = Buffer.from('zu-kurz').toString('base64');
    expect(hauptschluessel()).toBeNull();
    expect(vaultBereit()).toBe(false);
  });

  it('ist ohne gesetzte Variable schlicht nicht bereit', () => {
    delete process.env[VAULT_ENV];
    expect(hauptschluessel()).toBeNull();
    expect(vaultBereit()).toBe(false);
  });
});

describe('verschlüsseln und entschlüsseln', () => {
  it('liefert den Klartext zurück', () => {
    const c = verschluessle(GEHEIM);
    expect(c).not.toContain(GEHEIM);
    expect(entschluessle(c)).toBe(GEHEIM);
  });

  it('erzeugt bei gleichem Klartext ZWEI verschiedene Chiffrate', () => {
    // Sonst wäre am Datenbestand ablesbar, welche Konten dasselbe
    // Geheimnis benutzen — und ein wiederverwendeter IV bricht GCM ganz.
    const a = verschluessle(GEHEIM);
    const b = verschluessle(GEHEIM);
    expect(a).not.toBe(b);
    expect(entschluessle(a)).toBe(entschluessle(b));
  });

  it('wirft statt still auf Klartext zurückzufallen', () => {
    delete process.env[VAULT_ENV];
    expect(() => verschluessle(GEHEIM)).toThrow();
  });

  it('erkennt manipuliertes Chiffrat', () => {
    const c = verschluessle(GEHEIM);
    const teile = c.split(':');
    // Ein Bit im Chiffrat kippen — GCM muss das am Auth-Tag bemerken.
    const roh = Buffer.from(teile[3]!, 'base64');
    roh[0] ^= 0xff;
    teile[3] = roh.toString('base64');
    expect(entschluessle(teile.join(':'))).toBeNull();
  });

  it('erkennt ein manipuliertes Auth-Tag', () => {
    const c = verschluessle(GEHEIM);
    const teile = c.split(':');
    const tag = Buffer.from(teile[2]!, 'base64');
    tag[0] ^= 0xff;
    teile[2] = tag.toString('base64');
    expect(entschluessle(teile.join(':'))).toBeNull();
  });

  it('gibt mit dem FALSCHEN Hauptschlüssel null zurück, nicht Müll', () => {
    const c = verschluessle(GEHEIM);
    process.env[VAULT_ENV] = KEY_B;
    expect(entschluessle(c)).toBeNull();
  });

  it('gibt ohne Hauptschlüssel null zurück', () => {
    const c = verschluessle(GEHEIM);
    delete process.env[VAULT_ENV];
    expect(entschluessle(c)).toBeNull();
  });

  it('lehnt ein verstümmeltes Format ab', () => {
    expect(entschluessle('v1:kaputt')).toBeNull();
    expect(entschluessle('v1:a:b:c:d')).toBeNull();
  });
});

describe('Klartext-Altbestand', () => {
  it('bleibt lesbar — sonst verlieren alle Papierkonten ihre Verbindung', () => {
    expect(entschluessle(GEHEIM)).toBe(GEHEIM);
    expect(istVerschluesselt(GEHEIM)).toBe(false);
  });

  it('bleibt auch ohne Hauptschlüssel lesbar', () => {
    delete process.env[VAULT_ENV];
    expect(entschluessle(GEHEIM)).toBe(GEHEIM);
  });

  it('wird als unverschlüsselt erkannt, Chiffrat als verschlüsselt', () => {
    expect(istVerschluesselt(verschluessle(GEHEIM))).toBe(true);
  });
});

describe('gleich', () => {
  it('vergleicht korrekt', () => {
    expect(gleich('abc', 'abc')).toBe(true);
    expect(gleich('abc', 'abd')).toBe(false);
    expect(gleich('abc', 'abcd')).toBe(false);
    expect(gleich('', '')).toBe(true);
  });
});
