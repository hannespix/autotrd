/**
 * Die Papier-Erprobung: Wer handelt ein Symbol, das die Gates NICHT bestanden hat?
 *
 * ── Owner-Entscheidung 14.09.2026 ────────────────────────────────────────
 *
 * Bis heute galt: Wer die zehn Alpha-Gates nicht nimmt, handelt nicht — und
 * „wir sollten nicht handeln" ist ein zulässiges Ergebnis (§0.9). Daran
 * ändert sich für ECHTGELD kein Buchstabe. Was sich ändert: Auf einem
 * PAPIER-Konto darf die Engine den besten gemessenen Kandidaten trotzdem
 * handeln, damit überhaupt ein Journal entsteht.
 *
 * Der Grund ist eine Sackgasse im Entwurf, die am 14.09.2026 offen zutage
 * lag: Die Gates entscheiden über den Champion, der Champion über die
 * Paper-Trades, die Paper-Trades über `readiness`, und `readiness` über
 * Echtgeld. Besteht nie etwas, passiert nie etwas — auf ewig, und ohne dass
 * je eine Zeile Betriebserfahrung entsteht.
 *
 * ── Was das NICHT ist ────────────────────────────────────────────────────
 *
 * Es ist **keine dritte Latte**. Eine Latte entscheidet, ob etwas gut genug
 * ist; hier wird nichts entschieden und nichts befördert. Der Kandidat
 * bleibt durchgefallen, steht weiter in `noTrade`, und kein Gate wird
 * gelockert, umdefiniert oder umgangen. Die Erprobung ist eine
 * ERHEBUNGSART: Sie erzeugt Daten über einen Kandidaten, von dem wir
 * wissen, dass er nicht besteht.
 *
 * ── Die drei Sicherungen ─────────────────────────────────────────────────
 *
 * 1. **Nur Papier.** Entschieden wird am AUFGELÖSTEN Modus (`resolveMode`
 *    bzw. `resolveBrokerMode` auf der Plattform), nicht an dem, was eine
 *    Config behauptet. Ein Live-Konto sieht die Erprobung nie — auch nicht,
 *    wenn jeder Schalter an ist. Das ist die Sicherung, an der alles hängt.
 * 2. **Schalter aus per Vorgabe** (`strategy.erprobung`, Default false).
 *    Wer nichts tut, ändert nichts.
 * 3. **Das Journal weiß Bescheid.** Jede Wahl trägt `source: 'erprobung'`,
 *    jeder Trade daraus ebenso — und `readiness` (src/readiness.ts) zählt
 *    diese Trades NICHT für die Live-Reife. Sonst hätte die Erprobung einen
 *    Weg zu Echtgeld gebahnt, und genau den darf sie nicht haben.
 *
 * Sicherung 1 und 3 sind nicht Vorsicht, sondern die Bedingung, unter der
 * die Entscheidung überhaupt tragbar ist: Ohne sie wäre „auf Papier mal
 * laufen lassen" ein stiller Pfad, auf dem ein durchgefallener Kandidat
 * Reife-Statistik erzeugt und irgendwann echtes Geld bewegt.
 */
import type { Params, TimeframeMin } from './types.ts';
import type { ChampionFile, ErprobungEntry } from '../optimize/promote.ts';

/** Quelle und Stufe der Erprobung — ein Name, damit ihn niemand zweimal tippt. */
export const ERPROBUNG_QUELLE = 'erprobung';

export interface ErprobungChoice {
  strategyId: string;
  params: Params;
  /** Text fürs Journal: welcher Kandidat, welche Gates gefallen sind. */
  note: string;
}

export interface ErprobungArgs {
  champion: ChampionFile | null;
  timeframe: TimeframeMin;
  /** Schalter `strategy.erprobung` (Plattform: global ∧ Nutzer). */
  enabled: boolean;
  /**
   * Der AUFGELÖSTE Broker-Modus — nicht der Wunsch aus einer Config.
   * Alles außer `'paper'` sperrt die Erprobung; `undefined` ebenso, denn ein
   * Aufrufer, der den Modus nicht kennt, darf sie erst recht nicht freigeben.
   */
  mode: string | undefined;
}

/** Warum die Erprobung nicht greift — oder null, wenn sie greift. */
export function erprobungSperre(a: ErprobungArgs): string | null {
  // Reihenfolge mit Absicht: Der Modus zuerst, damit die Sperre, an der alles
  // hängt, nie hinter einer anderen Bedingung verschwindet.
  if (a.mode !== 'paper') return `Papier-Erprobung: Modus ${a.mode ?? 'unbekannt'} — die Erprobung gilt ausschließlich für Papier-Konten`;
  if (!a.enabled) return 'Papier-Erprobung: Schalter aus (strategy.erprobung)';
  const block = a.champion?.erprobung;
  if (!block || Object.keys(block).length === 0) return null;
  return null;
}

/**
 * Die Erprobungs-Wahl für EIN Symbol — nur, wenn weder Alpha-Champion noch
 * Basis es führen, die Sperre offen ist und der Block einen Eintrag mit
 * passendem Zeitrahmen trägt.
 */
export function erprobungChoiceFor(a: ErprobungArgs & { symbol: string; alphaLeads: boolean; basisLeads: boolean }): ErprobungChoice | null {
  if (a.alphaLeads || a.basisLeads) return null;
  if (erprobungSperre(a) !== null) return null;
  const entry: ErprobungEntry | undefined = a.champion?.erprobung?.[a.symbol];
  if (!entry) return null;
  if (entry.timeframe !== a.timeframe) return null;
  const gefallen = entry.failed.length ? entry.failed.join(', ') : 'keine Gate-Namen im Block';
  const note =
    `Papier-Erprobung ${a.symbol}: ${entry.strategy} — DURCHGEFALLEN (${gefallen}), wird nur auf Papier gehandelt, ` +
    `zählt nicht für die Live-Reife (readiness)`;
  return { strategyId: entry.strategy, params: entry.params, note };
}

/**
 * Trägt dieser Trade die Erprobung? Eine Stelle, damit `readiness` und jeder
 * Bericht dieselbe Frage gleich beantworten.
 *
 * Gelesen wird `Trade.stufe` — die Engine schreibt dorthin die Quelle der
 * Wahl (`app.ts`: `stufe: choice.source`, `book.ts` reicht sie in den Trade).
 * Ein eigenes Feld gäbe es zweimal, und zwei Felder für dieselbe Frage sind
 * genau die Bauart, die am 13.09. 3 877 $ Unterschied erzeugt hat.
 *
 * Fehlt `stufe` (Trades von vor dieser Stufe, ältere Journale), ist die
 * Antwort NEIN: Sie stammen aus dem Champion-Betrieb und zählen weiter.
 * Die Richtung ist mit Absicht so herum — ein unbekannter Trade darf die
 * Reife-Statistik nicht heimlich aufblähen, aber er darf sie auch nicht
 * rückwirkend entwerten.
 */
export function istErprobung(t: { stufe?: string | undefined }): boolean {
  return t.stufe === ERPROBUNG_QUELLE;
}
