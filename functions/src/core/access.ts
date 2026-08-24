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

/**
 * Wie `mayTrade`/`accessLevelOf`, aber für einen frisch gelesenen Snapshot
 * statt für `.data()` allein (Nahtstellen-Befund 24.08., im Zug der
 * Konto-Löschung).
 *
 * `.data()` liefert `undefined` sowohl für „Dokument existiert nicht" als
 * auch — bei einem existierenden Dokument, das das Feld nie bekam — für ein
 * BESTANDSKONTO. `accessLevelOf`/`mayTrade` können und sollen diese beiden
 * Fälle NICHT unterscheiden: Ein fehlendes Feld auf einem existierenden
 * Dokument muss weiterhin `approved` gelten (Owner/Bestandskonten,
 * `functions/test/access.test.ts`). Ein nicht (mehr) existierendes Dokument
 * ist aber niemals ein Bestandskonto — es wurde nie angelegt oder gerade
 * GELÖSCHT. Genau diese Lücke machte ein bereits endgültig gelöschtes Konto
 * mit einem noch gültigen Auth-Token (bis zu dessen Ablauf, ~1 h) über
 * `verbindeBroker`/`adoptBroker`/`brokerStatus` wieder erreichbar — und
 * konnte dabei neue, für immer unsichtbare Daten unter der gelöschten uid
 * anlegen (`private/broker`), obwohl die Löschung genau das verhindern soll.
 */
export function mayTradeSnap(snap: FirebaseFirestore.DocumentSnapshot): boolean {
  return snap.exists && mayTrade(snap.data());
}

/** Zugangsstufe eines Snapshots — `'blocked'` für ein nicht existierendes
 *  Dokument (nie `approved`: siehe `mayTradeSnap`). */
export function accessLevelOfSnap(snap: FirebaseFirestore.DocumentSnapshot): AccessLevel {
  return snap.exists ? accessLevelOf(snap.data()) : 'blocked';
}

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
