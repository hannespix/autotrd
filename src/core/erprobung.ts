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
 * 1. **Nur Papier.** Entschieden wird am aufgelösten Modus des Kontos:
 *    `resolveMode` im eigenen Prozess, `verbindung.mode` auf der Plattform.
 *
 *    **`verbindung.mode` ist NICHT `resolveBrokerMode`, und das ist Absicht**
 *    (Prüfbefund M3, 14.09.2026): Es stammt aus `users/{uid}/private/broker.mode`,
 *    das `connectBroker` aus dem SCHLÜSSEL-PRÄFIX ableitet (PK… ⇒ paper,
 *    AK… ⇒ live). `resolveBrokerMode` (functions/src/core/liveGate.ts) liefert
 *    dagegen für ein Live-Konto OHNE Reife ausdrücklich `'paper'` — wer hier
 *    darauf umstellt, schaltet die Erprobung auf einem Konto mit
 *    Echtgeld-Schlüssel frei. Nicht umstellen.
 * 2. **Nur, wenn sonst nichts handelt.** Führt irgendein Symbol ein
 *    Alpha-Champion, oder hat die Basis Einstiegsrecht, bleibt die Erprobung
 *    GANZ aus (Prüfbefund K1). Grund: Plätze (`risk.maxPositions`), Equity,
 *    Brutto-Budget, PDT-Kontingent und die KONTO-Notbremse sind geteilt und
 *    stufenblind. Schlimmer noch, die Rangordnung ist es auch —
 *    `korbRaenge` (core/logic.ts) vergibt Ränge nur an Symbole mit
 *    `crossScore`, ranglose sortieren mit `POSITIVE_INFINITY` ans Ende: Ein
 *    durchgefallener Querschnitts-Kandidat würde VOR einem Champion bedient.
 *    Und löst die Konto-Notbremse wegen Erprobungs-Verlusten aus, werden
 *    AUCH Champion-Positionen glattgestellt — deren Zwangs-Exits tragen
 *    `stufe: 'champion'` und zählen in die Live-Reife. Über diesen Umweg
 *    hätte ein durchgefallener Kandidat die Echtgeld-Freigabe beeinflusst.
 *    Die Ausschließlichkeit schneidet alle diese Wege auf einmal ab — und sie
 *    kostet nichts, denn die Stufe existiert genau für den Zustand, in dem
 *    NICHTS besteht.
 * 3. **Keine Adoption.** Bei `engine.onOrphan: 'adopt'` bleibt die Erprobung
 *    aus (Prüfbefund K2): Adoption legt Fremdbestand als `strategy: 'adopted'`
 *    OHNE Stufe an (engine/reconcile.ts). Eine adoptierte Erprobungs-Position
 *    wäre danach von einem Champion-Trade nicht mehr zu unterscheiden und
 *    zählte für die Live-Reife. Die Stufe hängt an der Herkunft; wer die
 *    Herkunft löscht, bekommt die Stufe nicht.
 * 4. **Schalter aus per Vorgabe** (`strategy.erprobung`, Default false).
 * 5. **Das Journal weiß Bescheid.** Jede Wahl trägt `source: 'erprobung'`,
 *    jeder Trade daraus ebenso — und `readiness` (src/readiness.ts) wie
 *    `snapshotEquity.ts` (Plattform) zählen diese Trades NICHT für die
 *    Live-Reife.
 *
 * Keine dieser Sperren ist Vorsicht. Ohne sie wäre „auf Papier mal laufen
 * lassen" ein stiller Pfad, auf dem ein durchgefallener Kandidat
 * Reife-Statistik erzeugt und irgendwann echtes Geld bewegt.
 *
 * ── Was beim Abschalten passiert ─────────────────────────────────────────
 *
 * Fällt die Wahl weg (Schalter aus, Modus gewechselt, Eintrag geräumt),
 * liquidiert die Engine die offene Position als `unmanaged`
 * (engine/engine.ts, `ohneFuehrung`) — sie bleibt NICHT ohne Exit stehen
 * (§0.4). Das ist gröber als bei der Basis-Stufe, die ihren Bestand mit
 * `entriesAllowed: false` zu Ende führt. Für eine Papier-Stufe ist die
 * Zwangsräumung vertretbar, und sie ist hier ausdrücklich genannt statt
 * stillschweigend in Kauf genommen.
 */
import type { Params, TimeframeMin } from './types.ts';
import type { ChampionFile, ErprobungEntry } from '../optimize/promote.ts';

/** Quelle und Stufe der Erprobung — ein Name, damit ihn niemand zweimal tippt. */
export const ERPROBUNG_QUELLE = 'erprobung';

export interface ErprobungChoice {
  symbol: string;
  strategyId: string;
  params: Params;
  /** Gefallene Gates aus dem Champion-Block — Fakten, nicht Prosa (für `erprobungSammelNotiz`). */
  failed: readonly string[];
  /** Text fürs Journal, wenn EIN Symbol gemeint ist: welcher Kandidat, welche Gates gefallen sind. */
  note: string;
}

export interface ErprobungArgs {
  champion: ChampionFile | null;
  timeframe: TimeframeMin;
  /** Schalter `strategy.erprobung` (Plattform: global ∧ Nutzer). */
  enabled: boolean;
  /**
   * Der aufgelöste Broker-Modus des KONTOS — nicht der Wunsch aus einer
   * Config, und auf der Plattform NICHT `resolveBrokerMode` (siehe Modulkopf).
   * Alles außer `'paper'` sperrt; `undefined` ebenso, denn ein Aufrufer, der
   * den Modus nicht kennt, darf die Erprobung erst recht nicht freigeben.
   */
  mode: string | undefined;
  /** Führt IRGENDEIN Symbol ein Alpha-Champion? Dann bleibt die Erprobung ganz aus (K1). */
  alphaAktiv: boolean;
  /** Hat die Basis-Stufe Einstiegsrecht? Dann bleibt die Erprobung ganz aus (K1). */
  basisAktiv: boolean;
  /** `engine.onOrphan === 'adopt'`? Dann bleibt die Erprobung ganz aus (K2). */
  adoptiert: boolean;
}

/** Warum die Erprobung nicht greift — oder null, wenn sie greift. */
export function erprobungSperre(a: ErprobungArgs): string | null {
  // Reihenfolge mit Absicht: erst der Modus, dann die beiden Sperren, die die
  // Echtgeld-Kette schützen, dann der Schalter. Eine Sperre, die hinter einer
  // anderen verschwindet, steht in keinem Journal — und genau die, an der
  // alles hängt, darf nie die zweite Zeile sein.
  if (a.mode !== 'paper') return `Papier-Erprobung: Modus ${a.mode ?? 'unbekannt'} — die Erprobung gilt ausschließlich für Papier-Konten`;
  if (a.alphaAktiv) return 'Papier-Erprobung: ein Alpha-Champion handelt — die Erprobung bleibt aus, solange etwas Bestandenes läuft (geteilte Plätze, geteilte Notbremse)';
  if (a.basisAktiv) return 'Papier-Erprobung: die Basis-Stufe hat Einstiegsrecht — die Erprobung bleibt aus (geteilte Plätze, geteilte Notbremse)';
  if (a.adoptiert) return 'Papier-Erprobung: engine.onOrphan=adopt — Adoption löscht die Herkunft einer Position, und ohne Herkunft zählte sie für die Live-Reife';
  if (!a.enabled) return 'Papier-Erprobung: Schalter aus (strategy.erprobung)';
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
  const note =
    `Papier-Erprobung ${a.symbol}: ${entry.strategy} — DURCHGEFALLEN (${gateListe(entry.failed)}), wird nur auf Papier gehandelt, ` +
    `zählt nicht für die Live-Reife (readiness)`;
  return { symbol: a.symbol, strategyId: entry.strategy, params: entry.params, failed: entry.failed, note };
}

const gateListe = (failed: readonly string[]): string => (failed.length ? failed.join(', ') : 'keine Gate-Namen im Block');

/**
 * EINE Notiz für ALLE Symbole der Erprobung — statt einer je Symbol.
 *
 * Der Grund ist betrieblich und wurde am 15.09.2026 im laufenden Betrieb
 * sichtbar: Der Plattform-Takt baut seine Strategie-Zuordnung JEDE MINUTE neu
 * auf und schreibt jede Notiz als WARNUNG. Bei 30 Symbolen und zwei Konten
 * waren das rund 86 000 Warnzeilen am Tag — sie verdrängten in Cloud Logging
 * alles andere, und die Diagnose (`scripts-ci/fetch-scan-logs.mjs` holt die 50
 * jüngsten Einträge) sah nur noch diese eine Meldung. Eine Warnung, die immer
 * da ist, warnt nicht mehr; sie versteckt die, auf die es ankommt.
 *
 * Der Inhalt bleibt vollständig: Kandidat, gefallene Gates und die Symbole
 * stehen weiter drin, nur eben einmal. Gruppiert wird nach Strategie und
 * Gate-Liste — verschiedene Kandidaten bekommen verschiedene Zeilen.
 */
export function erprobungSammelNotiz(wahlen: readonly ErprobungChoice[]): string[] {
  const gruppen = new Map<string, { strategyId: string; gates: string; symbole: string[] }>();
  for (const w of wahlen) {
    const gates = gateListe(w.failed);
    const key = `${w.strategyId}|${gates}`;
    const g = gruppen.get(key) ?? { strategyId: w.strategyId, gates, symbole: [] };
    g.symbole.push(w.symbol);
    gruppen.set(key, g);
  }
  return [...gruppen.values()].map(
    (g) =>
      `Papier-Erprobung: ${g.symbole.length} Symbol(e) — ${g.strategyId}, DURCHGEFALLEN (${g.gates}), ` +
      `nur auf Papier, zählt nicht für die Live-Reife (readiness): ${g.symbole.join(', ')}`,
  );
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
