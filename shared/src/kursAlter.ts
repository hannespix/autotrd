/**
 * Kurs-Zeitdeckel (Audit 13.08., B-2): Wie alt darf ein gespeicherter Kurs
 * sein, bevor niemand mehr auf ihm handeln darf?
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * `market/{sym}.quote.updatedAt` wird bei jedem Scan geschrieben — und wurde
 * von KEINEM Leser je geprüft. Fällt ein Symbol aus der Beobachtung (aus dem
 * Katalog genommen, Yahoo kennt es nicht mehr, Schreiber tot), friert die
 * Quote ein und sieht für alle Leser aus wie ein Kurs: Die Handeingabe
 * führte zum Wochen-alten Kurs aus.
 *
 * ── Warum der Deckel marktzeiten-bewusst sein muss ────────────────────────
 *
 * `updatedAt` ist die SCHREIBZEIT des Scans, und der Scan versorgt nur
 * OFFENE Marktklassen („ein geschlossener Markt kann keinen neuen Kurs
 * haben"). Ein flacher 30-Minuten-Deckel würde deshalb jeden Aktien-Trade
 * am Abend und am Wochenende blocken — der Freitags-Schlusskurs ist dort
 * nicht veraltet, er ist der letzte Kurs, den es gibt.
 *
 * Deshalb zwei Stufen:
 *  1. Markt OFFEN → der Kurs muss frisch sein (Scan-Takt 5 min, Deckel 30):
 *     Ein Kurs, der sich bei offenem Markt eine halbe Stunde nicht bewegt
 *     hat, wird nicht beobachtet — nicht „ist stabil".
 *  2. Markt ZU → der letzte Schlusskurs gilt, aber mit absoluter Reißleine:
 *     Die längste reguläre Schließung ist ein langes Wochenende (~4 Tage).
 *     Älter heißt „seit Wochen unbeobachtet" — genau der Audit-Fall.
 */

import { marketOpenForClass } from './marketHours.js';

/** Deckel bei OFFENEM Markt, Minuten. Scan-Takt ist 5 min; 30 lässt Luft
 *  für Rotations- und Ausfall-Lücken, ohne die Fiktion durchzulassen. */
export const KURS_DECKEL_OFFEN_MIN = 30;

/** Absolute Reißleine, Tage — gilt auch bei geschlossenem Markt. */
export const KURS_DECKEL_MAX_TAGE = 5;

export interface KursAlterBefund {
  zuAlt: boolean;
  /** Alter in Minuten (gerundet); `null` = kein lesbarer Zeitstempel. */
  alterMin: number | null;
  /** Klartext, wenn `zuAlt` — für Logs. Für NUTZER-Meldungen gilt `code`. */
  grund?: string;
  /**
   * Maschinen-Code, wenn `zuAlt` (#145-Grenzfall, 20.08.): Die Grenze
   * (trade-Callable) übersetzt Codes in `srv.*`-Schlüssel, damit die
   * Meldung in der Sprache des Nutzers erscheint — deutscher Klartext im
   * Fehler wäre für EN-Nutzer unlesbar. `grund` bleibt für Server-Logs.
   */
  code?: 'ohne_zeitstempel' | 'tage_alt' | 'min_alt';
}

/**
 * Ist dieser Kurs zu alt, um darauf zu handeln?
 *
 * `marktOffen` erlaubt dem Aufrufer, die Kalenderrechnung zu übersteuern
 * (z. B. mit der Alpaca-Börsenuhr); fehlt es, entscheidet der Kalender.
 * Ein FEHLENDER oder unlesbarer Zeitstempel zählt als zu alt — ein Kurs
 * ohne Herkunftszeit ist kein Kurs, sondern eine Zahl.
 */
export function kursZuAlt(
  updatedAt: unknown,
  assetClass: string,
  jetzt: Date,
  marktOffen?: boolean,
): KursAlterBefund {
  const t = typeof updatedAt === 'string' ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(t)) {
    return {
      zuAlt: true,
      alterMin: null,
      grund: 'Kurs ohne lesbaren Zeitstempel',
      code: 'ohne_zeitstempel',
    };
  }
  const alterMin = Math.round((jetzt.getTime() - t) / 60_000);
  if (alterMin > KURS_DECKEL_MAX_TAGE * 24 * 60) {
    return {
      zuAlt: true,
      alterMin,
      grund: `Kurs ist ${Math.round(alterMin / 1440)} Tage alt — das Symbol wird nicht mehr beobachtet`,
      code: 'tage_alt',
    };
  }
  const offen = marktOffen ?? marketOpenForClass(assetClass, jetzt);
  if (offen && alterMin > KURS_DECKEL_OFFEN_MIN) {
    return {
      zuAlt: true,
      alterMin,
      grund: `Kurs ist ${alterMin} min alt, der Markt ist offen — keine frische Beobachtung`,
      code: 'min_alt',
    };
  }
  return { zuAlt: false, alterMin };
}
