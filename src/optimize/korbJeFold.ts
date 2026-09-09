/**
 * Korb-Zugehörigkeit je Fold — Punkt-in-Zeit statt Endkorb rückwärts.
 *
 * ── Warum ────────────────────────────────────────────────────────────────
 *
 * Bis zum 09.09.2026 galt in jedem Walk-Forward der Korb, der am ENDE des
 * Fensters gewählt worden war — rückwärts über alle Folds. Wer bis heute
 * groß geblieben ist, war damit von Anfang an dabei; wer unterwegs
 * verschwand, kam nie vor. Drei Stichtags-Läufe zeigten, was das anrichtet:
 * dieselbe Strategie über dieselben Jahre bei 0,71 / −0,18 / 0,04, je
 * nachdem, welcher Endkorb rückwärts galt. Das Urteil hing am Korb.
 *
 * ── Was hier passiert ────────────────────────────────────────────────────
 *
 * Für jede Auswahlzeit (die OOS-Beginne aller Folds, das Ende des letzten
 * Folds, der Holdout-Beginn) wird der Korb mit `waehleUniverse` gewählt —
 * derselben Funktion wie nachts, mit Daten bis zu diesem Zeitpunkt (sie
 * schneidet selbst bei `jetzt`, #463) und mit Hysterese gegenüber dem
 * VORIGEN Stand, wie Nacht für Nacht. Der erste Stand kennt keinen
 * Bestand — schon gar nicht den Korb der Config: Der stammt aus der
 * Zukunft dieses Zeitpunkts.
 *
 * `at(t)` liefert den jüngsten Stand, der nicht nach `t` liegt. Einen
 * späteren gibt es nie; gibt es keinen, fragt der Aufrufer nach einem
 * Fenster, das nicht vorbereitet wurde — dann laut scheitern.
 *
 * ── Was das nicht ist ────────────────────────────────────────────────────
 *
 * Innerhalb eines Folds ist der Korb eingefroren (`oosDays`); nachts würde
 * er täglich nachgeführt. Das ist konservativ: Ein Symbol, das im Fold
 * illiquide wird, bleibt; eines, das liquide wird, kommt erst zum nächsten
 * Fold. Und die Auswahl nach Dollarumsatz bleibt — der Umsatz enthält den
 * Kurs, also vergangene Rendite, aber punkt-in-zeit gewählt ist „groß per
 * t" eine kaufbare Korbdefinition und genau die des Betriebs. Der Fehler war
 * die Rückwärts-Anwendung, nicht das Kriterium.
 */
import type { Bar, BarSeriesLike, Ms } from '../core/types.ts';
import { waehleUniverse, type UniverseRegeln } from '../universe/select.ts';
import type { Membership } from './walkForward.ts';

export interface KorbStand {
  at: Ms;
  symbols: string[];
  zugang: string[];
  abgang: string[];
}

export interface KorbJeFold {
  at: Membership;
  staende: readonly KorbStand[];
  kandidaten: number;
}

export function korbJeFold(a: {
  kandidaten: ReadonlyMap<string, BarSeriesLike>;
  zeiten: readonly Ms[];
  regeln: UniverseRegeln;
  pflicht: readonly string[];
}): KorbJeFold {
  const zeiten = [...new Set(a.zeiten)].sort((x, y) => x - y);
  if (zeiten.length === 0) throw new Error('Korb je Fold: keine Auswahlzeiten');

  // Bars einmal als Arrays — waehleUniverse schneidet selbst bei `jetzt`.
  const bars = new Map<string, Bar[]>();
  for (const [sym, s] of a.kandidaten) {
    const arr: Bar[] = [];
    for (let i = 0; i < s.length; i++) arr.push(s.at(i));
    bars.set(sym, arr);
  }

  // Die Turnover-Notbremse (`maxAbgang`) schützt den NÄCHTLICHEN Betrieb vor
  // Datenpannen: Zwischen zwei Nächten wechselt ein Korb nicht fünf Plätze.
  // Hier liegen `oosDays` zwischen zwei Ständen; ein Umbau ist dann Markt,
  // keine Panne. Alle anderen Regeln gelten unverändert.
  const regeln: UniverseRegeln = { ...a.regeln, maxAbgang: a.regeln.max };

  const staende: KorbStand[] = [];
  let bestand: string[] = [];
  for (const at of zeiten) {
    const auswahl = waehleUniverse({ kandidaten: bars, pflicht: a.pflicht, bestand, bestandIstAuswahl: staende.length > 0, regeln, jetzt: at });
    staende.push({ at, symbols: auswahl.symbols, zugang: auswahl.zugang, abgang: auswahl.abgang });
    bestand = auswahl.symbols;
  }

  const at: Membership = (t) => {
    let stand: KorbStand | null = null;
    for (const s of staende) {
      if (s.at <= t) stand = s;
      else break;
    }
    if (!stand) throw new Error(`Korb je Fold: kein Stand zum ${new Date(t).toISOString().slice(0, 10)} — die Auswahlzeiten decken das Fenster nicht`);
    return new Set(stand.symbols);
  };
  return { at, staende, kandidaten: a.kandidaten.size };
}
