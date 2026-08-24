/**
 * Zugangsstufe eines Kontos — Server-Seite.
 *
 * Die Wahrheit selbst wohnt seit dem 24.08. in `shared/src/zugang.ts`, damit
 * Server und Frontend dieselbe Liste lesen: Das Frontend hatte die
 * Normalisierung nachgebaut, und beim Hinzufügen einer Stufe wäre die Kopie
 * still falsch geworden — in die gefährliche Richtung, weil ein dort
 * fehlender Zustand zu `approved` wird.
 *
 * Hier bleibt nur, was serverseitig ist: der Ablehnungsgrund als srv.*-Code.
 * Der Klartext (DE+EN) wohnt im Frontend-Wörterbuch, `serverText` löst ihn in
 * der Sprachwahl des Nutzers auf — `serverCodes.test.ts` pinnt, dass beide
 * Zeilen existieren.
 */

import { accessLevelOf, mayTrade, type AccessLevel } from '../../../shared/src/index.js';

export { accessLevelOf, mayTrade };
export type { AccessLevel };

/** Warum ein Konto abgewiesen wurde — als srv.*-Code fürs Frontend. */
export function accessDeniedReason(level: AccessLevel): string {
  /* Vollständig statt ternär (23.08.): Ein Ternär hätte jede künftige Stufe
   * stillschweigend zu „wird gerade geprüft" gemacht — eine Meldung, die
   * Hoffnung macht, wo keine ist. Der `switch` mit `never`-Abschluss zwingt
   * den Compiler, hier eine Antwort zu verlangen. */
  switch (level) {
    case 'blocked':
      return 'srv.kontoGesperrtBetreiber';
    case 'archiviert':
      return 'srv.kontoArchiviert';
    case 'pending':
      return 'srv.zugangWirdGeprueft';
    case 'approved':
      // Kein Ablehnungsgrund — der Aufrufer sollte hier gar nicht landen.
      return 'srv.zugangWirdGeprueft';
    default: {
      const _erschoepft: never = level;
      return _erschoepft;
    }
  }
}
