/**
 * Zugangsstufen (Owner-Auftrag 26.07.) — Firebase-Seite.
 *
 * Der wichtigste Fall steht ganz oben: Ein BESTEHENDES Konto ohne das neue
 * Feld muss weiter handeln dürfen. Wäre das umgekehrt, hätte die Einführung
 * der Zugangsstufen den laufenden Betrieb des Owners still abgeschaltet —
 * die Engine hätte einfach aufgehört zu handeln, ohne Fehlermeldung.
 */

import { describe, expect, it } from 'vitest';
import { accessDeniedReason, accessLevelOf, mayTrade } from '../src/core/access.js';

describe('accessLevelOf', () => {
  it('Bestandskonto ohne Feld gilt als freigeschaltet', () => {
    expect(accessLevelOf({ wallet: { paperBalance: 25000 } })).toBe('approved');
    expect(accessLevelOf({})).toBe('approved');
    expect(accessLevelOf(undefined)).toBe('approved');
  });

  it('liest die gesetzten Stufen', () => {
    expect(accessLevelOf({ accessLevel: 'pending' })).toBe('pending');
    expect(accessLevelOf({ accessLevel: 'blocked' })).toBe('blocked');
    expect(accessLevelOf({ accessLevel: 'approved' })).toBe('approved');
    expect(accessLevelOf({ accessLevel: 'archiviert' })).toBe('archiviert');
  });

  it('archiviert ist NICHT freigeschaltet — die Falle der Normalisierung', () => {
    /* Der gefährlichste Satz dieser Datei ist „unbekannte Werte gelten als
     * freigeschaltet". Für Tippfehler richtig — für einen VERGESSENEN neuen
     * Zustand die Umkehrung der Absicht: Wer eine Stufe hinzufügt und sie
     * nicht in NICHT_FREI einträgt, schaltet sie frei statt sie zu sperren.
     * Der Typ zwingt zu nichts; dieser Test tut es. */
    expect(mayTrade({ accessLevel: 'archiviert' })).toBe(false);
  });

  it('unbekannte Werte gelten als freigeschaltet, nicht als gesperrt', () => {
    // Bewusst so herum: Ein Tippfehler im Datenbestand darf niemanden
    // aussperren. Gesperrt wird nur, was ausdrücklich gesperrt ist.
    expect(accessLevelOf({ accessLevel: 'quatsch' })).toBe('approved');
    expect(accessLevelOf({ accessLevel: 42 })).toBe('approved');
  });
});

describe('mayTrade', () => {
  it('nur freigeschaltete Konten handeln', () => {
    expect(mayTrade({ accessLevel: 'approved' })).toBe(true);
    expect(mayTrade({ accessLevel: 'pending' })).toBe(false);
    expect(mayTrade({ accessLevel: 'blocked' })).toBe(false);
  });

  it('Bestandskonto handelt weiter', () => {
    expect(mayTrade({ profile: { plan: 'free' } })).toBe(true);
  });
});

describe('accessDeniedReason', () => {
  it('unterscheidet Wartestand und Sperre — als srv.*-Codes', () => {
    // Seit Task #145 liefert der Helfer Codes; die Wortlaute („geprüft",
    // „ansehen", „gesperrt") wohnen im Frontend-Wörterbuch, und
    // serverCodes.test.ts erzwingt dort DE- UND EN-Zeile je Code.
    expect(accessDeniedReason('pending')).toBe('srv.zugangWirdGeprueft');
    expect(accessDeniedReason('blocked')).toBe('srv.kontoGesperrtBetreiber');
    expect(accessDeniedReason('approved')).not.toBe(accessDeniedReason('blocked'));
  });

  it('ein archiviertes Konto bekommt KEINE Hoffnungs-Meldung', () => {
    // Der frühere Ternär hätte jede neue Stufe zu „wird gerade geprüft"
    // gemacht — eine Meldung, die Hoffnung macht, wo keine ist.
    expect(accessDeniedReason('archiviert')).toBe('srv.kontoArchiviert');
    expect(accessDeniedReason('archiviert')).not.toBe(accessDeniedReason('pending'));
  });
});
