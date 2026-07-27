/**
 * tuneGrid.ts — welche Varianten der Auto-Tuner überhaupt ausprobiert (MT2).
 *
 * Der Kern der Selbstverbesserung ist nicht die Statistik (die steht in
 * autotune.ts), sondern die Frage davor: **Was variieren wir?** Ein Gitter
 * über alles wäre sinnlos — bei fünf Achsen mit je drei Stufen wären es 243
 * Varianten, von denen jede Monate bräuchte, um genug Trades für einen
 * belastbaren Vergleich zu sammeln (autotune verlangt 30 je Seite).
 *
 * Deshalb wird bewusst **eine Achse zur Zeit** variiert, ausgehend von der
 * amtierenden Einstellung. Das hat drei Vorteile:
 *
 *  1. Die Zahl der Varianten bleibt klein, also sammelt jede schnell Evidenz.
 *  2. Der Vergleich ist sauber: Ändert sich genau ein Wert, weiß man auch,
 *     WORAN eine Verbesserung lag — Voraussetzung für ein verständliches
 *     Journal (MT5).
 *  3. Kein Überanpassen an Wechselwirkungen, die auf 30 Trades ohnehin nicht
 *     nachweisbar wären.
 *
 * Die Achsen sind genau die Stellschrauben, an denen die Auswertung vom
 * 27.07. hing: Haltedauer, Ausstiegs-Konfluenz, Kauf-Pause, Zeitrahmen.
 * Positionsgröße und Stop/Take bleiben AUSSEN VOR — die gehören zur
 * Risikosteuerung, und die soll kein Automat verstellen.
 */

import type { Strategy } from './strategy.js';

export interface TuneAxis {
  /** Schlüssel für Doc-IDs und Journal — stabil, nie umbenennen. */
  key: string;
  /** Klartext fürs Journal und die Oberfläche. */
  label: string;
  /** Kandidatenwerte; die amtierende Einstellung fällt automatisch raus. */
  values: Array<number | string>;
  apply: (s: Strategy, v: number | string) => void;
  read: (s: Strategy) => number | string | undefined;
}

/**
 * Die Achsen. Reihenfolge = Priorität: Bei begrenzter Flottengröße kommen
 * die vorderen zuerst dran, und vorn steht, was am 27.07. nachweislich das
 * Ergebnis bestimmt hat — praktisch ALLE Trades starben am Signal-Ausstieg,
 * nie an Stop oder Take.
 */
export const TUNE_AXES: TuneAxis[] = [
  {
    key: 'minHoldMin',
    label: 'Mindest-Haltedauer',
    values: [0, 30, 60, 120, 240],
    apply: (s, v) => {
      s.engine.minHoldMin = v as number;
    },
    read: (s) => s.engine.minHoldMin,
  },
  {
    key: 'exitConfluence',
    label: 'Ausstiegs-Konfluenz',
    values: [1, 2, 3],
    apply: (s, v) => {
      s.signals.exitConfluence = v as number;
    },
    read: (s) => s.signals.exitConfluence,
  },
  {
    key: 'timeframe',
    label: 'Signal-Zeitrahmen',
    values: ['intraday', 'daily'],
    apply: (s, v) => {
      // NonNullable, weil `timeframe` optional ist: Bei
      // exactOptionalPropertyTypes wäre `undefined` sonst zuweisbar — die
      // Achse liefert aber immer einen der beiden echten Werte.
      s.signals.timeframe = v as NonNullable<Strategy['signals']['timeframe']>;
    },
    read: (s) => s.signals.timeframe,
  },
  {
    key: 'cooldownMin',
    label: 'Kauf-Pause',
    values: [15, 60, 240],
    apply: (s, v) => {
      s.engine.cooldownMin = v as number;
    },
    read: (s) => s.engine.cooldownMin,
  },
  {
    key: 'minConfluence',
    label: 'Einstiegs-Konfluenz',
    values: [2, 3],
    apply: (s, v) => {
      s.signals.minConfluence = v as number;
    },
    read: (s) => s.signals.minConfluence,
  },
];

export interface Variant {
  /**
   * Stabile Kennung aus Achse und Wert (z. B. `minHoldMin=120`). Stabil ist
   * wesentlich: Die Variante muss über Wochen dasselbe Schattenkonto
   * weiterführen, sonst beginnt die Evidenz bei jedem Scan von vorn.
   */
  id: string;
  axis: string;
  label: string;
  value: number | string;
  strategy: Strategy;
}

/** Tiefe Kopie ohne strukturiertes Klonen — hier reicht JSON (reine Daten). */
function klon(s: Strategy): Strategy {
  return JSON.parse(JSON.stringify(s)) as Strategy;
}

/**
 * Varianten der amtierenden Einstellung erzeugen — je Achse ein Wert.
 *
 * `max` begrenzt die Flotte. Jede Variante braucht eigene Trades, um
 * bewertbar zu werden; zu viele auf einmal heißt, dass keine je die
 * Evidenzschwelle erreicht. Lieber wenige Varianten schnell entschieden als
 * viele ewig im Ungewissen.
 */
export function buildVariants(base: Strategy, max = 6, axes: TuneAxis[] = TUNE_AXES): Variant[] {
  const out: Variant[] = [];
  // Runde für Runde EINEN Wert je Achse nehmen, statt eine Achse
  // auszuschöpfen: Sonst bekäme die erste Achse die ganze Flotte und die
  // übrigen Stellschrauben würden nie geprüft.
  const zeiger = new Map<string, number>();
  let fortschritt = true;
  while (out.length < max && fortschritt) {
    fortschritt = false;
    for (const axis of axes) {
      if (out.length >= max) break;
      const ist = axis.read(base);
      const kandidaten = axis.values.filter((v) => v !== ist);
      const i = zeiger.get(axis.key) ?? 0;
      if (i >= kandidaten.length) continue;
      zeiger.set(axis.key, i + 1);
      fortschritt = true;
      const value = kandidaten[i]!;
      const strategy = klon(base);
      axis.apply(strategy, value);
      // Varianten handeln NIE echt — die Schatten-Flotte fasst kein Wallet an.
      strategy.engine.running = false;
      out.push({ id: `${axis.key}=${value}`, axis: axis.key, label: axis.label, value, strategy });
    }
  }
  return out;
}

/** Lesbare Beschreibung fürs Journal: „Mindest-Haltedauer 60 → 120". */
export function describeVariant(base: Strategy, v: Variant): string {
  const axis = TUNE_AXES.find((a) => a.key === v.axis);
  const ist = axis?.read(base);
  return `${v.label} ${ist ?? '—'} → ${v.value}`;
}
