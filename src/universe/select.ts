/**
 * Nächtliche Wahl des Handelsuniversums — nach Handelbarkeit, nie nach dem
 * ERGEBNIS DER STRATEGIE.
 *
 * Warum diese Trennung die wichtigste Zeile in dieser Datei ist: Ein Universum
 * danach zusammenzustellen, wo die Strategie funktioniert hat, ist
 * Selektionsbias in Reinform. Man wählt die Symbole aus, auf denen es zufällig
 * lief, und misst sie anschließend auf denselben Daten — das Ergebnis ist immer
 * schön und immer wertlos. Genau daran ist das Vorgängersystem gescheitert
 * (30 Trades als Beweis, Auswahl auf denselben Daten wiederholt). Der Eingang
 * dieser Funktion hat deshalb kein Feld für PnL, Trades oder Champion; sie
 * bekommt Bars und Regeln, sonst nichts.
 *
 * ── Was die Kennzahl NICHT ist (Red-Team, 08.09.2026) ────────────────────
 *
 * „Kennt keine Rendite" wäre gelogen, und die erste Fassung dieses Kommentars
 * hat das behauptet. Median-Dollarumsatz ist Stückzahl × KURS, und der Kurs ist
 * das kumulierte Ergebnis vergangener Rendite: Bei gleicher Stückzahl gewinnt
 * der Wert, der gestiegen ist. `minPreis` und `maxAlterTage` wirken auf die
 * LETZTE Bar und werfen damit genau die Werte raus, die im Messzeitraum
 * abgestürzt oder verschwunden sind.
 *
 * Das bleibt trotzdem so, aus einem Grund: Was ein Auto-Trader bewegen kann,
 * sind Dollar, nicht Stückzahlen. Dollarumsatz ist das richtige
 * Handelbarkeitsmaß; ihn durch einen Referenzkurs renditeneutral zu machen
 * hieße, Liquidität schlechter zu messen, um eine Zahl schöner zu machen. Der
 * Effekt ist stattdessen benannt, mit einem Test belegt
 * (`test/universe/select.test.ts`) und im Bericht sichtbar — und er ist der
 * kleine Bruder des Survivorship-Problems, das direkt darunter steht.
 *
 * ── Survivorship: die Auswahl ist von HEUTE, der Backtest von gestern ────
 *
 * Der Kandidatenpool ist von Hand geschrieben, und die Wahl misst die letzten
 * `fensterTage`. Beides beschreibt den Stand am Tag des Laufs. Der
 * Walk-Forward rechnet damit über `lookbackDays` zurück — bezüglich der
 * ZUGEHÖRIGKEIT zum Korb sind die OOS-Folds also nicht out-of-sample. Wer im
 * Messzeitraum übernommen, delistet oder unter `minPreis` gefallen ist, kommt
 * gar nicht erst vor.
 *
 * Die Wahl selbst ist kausal — sie SCHNEIDET die Bars bei `jetzt`, statt es
 * vom Aufrufer vorauszusetzen (siehe `bewerte`) —; der Bias entsteht erst
 * dadurch, dass ihr Ergebnis rückwärts angewandt wird. Solange das so ist,
 * sind die OOS-Zahlen optimistisch, und der Bericht sagt das.
 *
 * ── Handwerk ─────────────────────────────────────────────────────────────
 *
 * Median statt Mittelwert: Ein einzelner Quartalszahlen-Tag mit dem Zehnfachen
 * des Umsatzes soll ein sonst dünnes Symbol nicht nach oben tragen.
 *
 * IEX-Volumen genügt, obwohl es nur einen Bruchteil des Gesamtumsatzes ist:
 * Wir handeln auf IEX-Daten. Was wir dort nicht sehen, können wir nicht
 * handeln — also ist die IEX-Liquidität für dieses System das ehrlichere Maß
 * als der konsolidierte Umsatz.
 *
 * Hysterese: Ein Symbol, das schon im Universum ist, behält seinen Platz,
 * solange es innerhalb von `haltePuffer` Rängen hinter der Grenze bleibt. Ohne
 * das tauschte der Korb jede Nacht zwei Werte auf Rauschen aus, und die
 * gepoolte Messung von gestern wäre mit der von heute nicht mehr vergleichbar.
 * Kehrseite: Ein neues Symbol kommt erst herein, wenn ein Bestandswert hinter
 * Rang `max + haltePuffer` fällt.
 */
import type { Bar, Ms } from '../core/types.ts';

export interface UniverseRegeln {
  /** Wie viele Symbole gehandelt werden (Alpaca-IEX-Basis: höchstens 30 inkl. Benchmark). */
  max: number;
  /** Bewertungsfenster in Bars (Tagesbars ⇒ Handelstage). */
  fensterTage: number;
  /** Mindestzahl Bars im Fenster — weniger heißt: Datenlage unklar, nicht handeln. */
  minTage: number;
  /** Mindestkurs in USD (keine Pennystocks: dort ist der Spread der ganze Trade). */
  minPreis: number;
  /** Mindest-Median-Dollarumsatz je Tag im Fenster. */
  minDollarVolumen: number;
  /** Höchstalter der letzten Bar in Kalendertagen (fängt Delisting und Dauer-Halt). */
  maxAlterTage: number;
  /** Wie viele Ränge hinter der Grenze ein Symbol des Bestands seinen Platz behält. */
  haltePuffer: number;
  /** Anteil von `max`, den die Auswahl mindestens erreichen muss (sonst: Datenausfall, Abbruch). */
  minAnteil: number;
  /** Höchstzahl Abgänge gegenüber einer VORIGEN AUSWAHL je Lauf (sonst: Abbruch). */
  maxAbgang: number;
}

export const UNIVERSE_REGELN: UniverseRegeln = {
  max: 30,
  fensterTage: 60,
  minTage: 45,
  minPreis: 5,
  minDollarVolumen: 2_000_000,
  maxAlterTage: 5,
  haltePuffer: 5,
  minAnteil: 0.8,
  maxAbgang: 5,
};

/** Die Regeln des Betriebs für `maxSymbols` Plätze — ein Ort für CLI und Optimierer (ein Pfad). */
export function universeRegelnFuer(maxSymbols: number): UniverseRegeln {
  return { ...UNIVERSE_REGELN, max: maxSymbols };
}

export type UniverseStatus = 'pflicht' | 'bestand' | 'neu' | 'abgelehnt';

export interface UniverseBewertung {
  symbol: string;
  /** Median-Dollarumsatz je Tag im Fenster; 0, wenn nicht berechenbar. */
  dollarVolumen: number;
  /** Bars im Fenster. */
  tage: number;
  letzterKurs: number;
  /** Alter der letzten Bar in Kalendertagen. */
  alterTage: number;
  /** Rang nach Liquidität (1 = höchster Umsatz); null, wenn durch einen Filter gefallen. */
  rang: number | null;
  status: UniverseStatus;
  grund: string;
}

export interface UniverseAuswahl {
  /** Das gewählte Universum, nach Liquidität absteigend. */
  symbols: string[];
  /** Alle Kandidaten mit Rang, Kennzahl und Grund — Grundlage des Berichts. */
  bewertung: UniverseBewertung[];
  zugang: string[];
  abgang: string[];
}

export interface UniverseArgs {
  /** Tagesbars je Kandidat (aufsteigend nach Zeit). */
  kandidaten: ReadonlyMap<string, readonly Bar[]>;
  /** Symbole, die immer dabei sein müssen — der Benchmark. */
  pflicht: readonly string[];
  /** Das gestrige Universum (Hysterese); leer beim ersten Lauf. */
  bestand: readonly string[];
  /**
   * Stammt `bestand` aus einer VORIGEN AUSWAHL (statt aus der Config)? Nur dann
   * greift `maxAbgang`: Der erste Lauf gegen echte Daten darf die von Hand
   * geschriebene Liste komplett neu bestimmen — das ist ja der Zweck.
   */
  bestandIstAuswahl: boolean;
  regeln: UniverseRegeln;
  jetzt: Ms;
}

const TAG_MS = 86_400_000;

function median(werte: number[]): number {
  if (werte.length === 0) return 0;
  const s = [...werte].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Dollarumsatz einer Bar: VWAP, wenn Alpaca ihn liefert, sonst Schlusskurs. */
function dollarUmsatz(b: Bar): number {
  const px = b.vw !== undefined && b.vw > 0 ? b.vw : b.c;
  return px * b.v;
}

interface Roh {
  symbol: string;
  dollarVolumen: number;
  tage: number;
  letzterKurs: number;
  alterTage: number;
  ablehnung: string | null;
}

function bewerte(symbol: string, bars: readonly Bar[], regeln: UniverseRegeln, jetzt: Ms): Roh {
  // Kausal DURCHGESETZT, nicht vorausgesetzt: Der Aufrufer reicht die ganze
  // Serie aus dem Cache — bei einer Stichtags-Messung also auch Bars NACH dem
  // Stichtag. Ohne diesen Schnitt nahm `slice(-fensterTage)` die letzten Bars
  // von HEUTE, und `Math.max(0, …)` machte aus einer Bar aus der Zukunft eine
  // null Tage alte. Drei Stichtags-Proben am 09.09. wählten so denselben Korb
  // wie heute — SPY zu 766 $ „per September 2025". `Bar.t` ist der
  // Bucket-Beginn; ein Stichtag ist das Ende seines Tages, also gehört die
  // Bar des Stichtags dazu.
  const sichtbar = bars.filter((b) => b.t <= jetzt);
  const fenster = sichtbar.slice(-regeln.fensterTage);
  const letzte = fenster[fenster.length - 1];
  const tage = fenster.length;
  const letzterKurs = letzte?.c ?? 0;
  const alterTage = letzte ? Math.max(0, (jetzt - letzte.t) / TAG_MS) : Number.POSITIVE_INFINITY;
  const dollarVolumen = median(fenster.map(dollarUmsatz));
  const f2 = (x: number) => x.toFixed(2);
  let ablehnung: string | null = null;
  // „gar keine Daten" ist kein Liquiditätsurteil, sondern ein Datenproblem — der
  // Text sagt das, und `waehleUniverse` zählt diese Fälle getrennt.
  if (tage === 0) ablehnung = 'keine Tagesbars geliefert — Datenausfall, kein Liquiditätsurteil';
  else if (tage < regeln.minTage) ablehnung = `nur ${tage} Tagesbars im Fenster (mindestens ${regeln.minTage})`;
  else if (!Number.isFinite(alterTage) || alterTage > regeln.maxAlterTage) {
    ablehnung = `letzte Bar ${Number.isFinite(alterTage) ? `${f2(alterTage)} Tage` : 'nie'} alt (höchstens ${regeln.maxAlterTage}) — Delisting oder Dauer-Halt`;
  } else if (letzterKurs < regeln.minPreis) ablehnung = `Kurs ${f2(letzterKurs)} unter ${regeln.minPreis} — der Spread wäre der ganze Trade`;
  else if (dollarVolumen < regeln.minDollarVolumen) {
    ablehnung = `Median-Umsatz ${Math.round(dollarVolumen).toLocaleString('de-DE')} $/Tag unter ${regeln.minDollarVolumen.toLocaleString('de-DE')} $`;
  }
  return { symbol, dollarVolumen, tage, letzterKurs, alterTage, ablehnung };
}

/**
 * Wählt das Universum. Wirft, wenn ein Pflichtsymbol (Benchmark) die Filter
 * nicht besteht: Ohne Benchmark greift kein Marktfilter, und ein Korb ohne
 * Marktfilter ist eine andere Strategie als die gemessene — dann lieber gar
 * nicht liefern und die alte Auswahl stehen lassen.
 */
export function waehleUniverse(a: UniverseArgs): UniverseAuswahl {
  const { regeln } = a;
  if (regeln.max < 1) throw new Error(`universe.maxSymbols muss mindestens 1 sein (ist ${regeln.max}).`);
  const roh = [...a.kandidaten.entries()].map(([sym, bars]) => bewerte(sym, bars, regeln, a.jetzt));

  const pflicht = new Set(a.pflicht);
  for (const p of pflicht) {
    const r = roh.find((x) => x.symbol === p);
    if (!r) throw new Error(`Pflichtsymbol ${p} ist nicht im Kandidatenpool — ohne Benchmark greift kein Marktfilter.`);
    if (r.ablehnung) throw new Error(`Pflichtsymbol ${p} besteht die Liquiditätsprüfung nicht: ${r.ablehnung}`);
  }

  // Rang nur unter den Bestandenen. Gleichstand alphabetisch — der Lauf muss
  // sich Nacht für Nacht reproduzieren lassen.
  const bestanden = roh
    .filter((r) => r.ablehnung === null)
    .sort((x, y) => (y.dollarVolumen - x.dollarVolumen) || (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0));
  const rangVon = new Map(bestanden.map((r, i) => [r.symbol, i + 1]));

  const bestand = new Set(a.bestand);
  const gewaehlt = new Set<string>();
  const status = new Map<string, UniverseStatus>();
  const nimm = (sym: string, st: UniverseStatus): void => {
    if (gewaehlt.size >= regeln.max || gewaehlt.has(sym)) return;
    gewaehlt.add(sym);
    status.set(sym, st);
  };

  // 1. Pflicht (Benchmark) — hat den Marktfilter im Rücken, geht immer mit.
  for (const r of bestanden) if (pflicht.has(r.symbol)) nimm(r.symbol, 'pflicht');
  // 2. Bestand innerhalb des Halte-Puffers — Hysterese gegen nächtliches Umschichten auf Rauschen.
  const halteGrenze = regeln.max + regeln.haltePuffer;
  for (const r of bestanden) if (bestand.has(r.symbol) && rangVon.get(r.symbol)! <= halteGrenze) nimm(r.symbol, 'bestand');
  // 3. Auffüllen nach Rang.
  for (const r of bestanden) nimm(r.symbol, bestand.has(r.symbol) ? 'bestand' : 'neu');

  const symbols = bestanden.filter((r) => gewaehlt.has(r.symbol)).map((r) => r.symbol);

  const bewertung: UniverseBewertung[] = roh
    .map((r) => {
      const rang = rangVon.get(r.symbol) ?? null;
      const st: UniverseStatus = r.ablehnung !== null ? 'abgelehnt' : (status.get(r.symbol) ?? 'abgelehnt');
      const grund =
        r.ablehnung !== null
          ? r.ablehnung
          : st === 'abgelehnt'
            ? `Rang ${rang} — außerhalb der ersten ${regeln.max}`
            : st === 'pflicht'
              ? 'Benchmark — immer dabei'
              : st === 'bestand' && rang! > regeln.max
                ? `Rang ${rang} — Platz behalten (Halte-Puffer bis ${halteGrenze})`
                : `Rang ${rang}`;
      return { symbol: r.symbol, dollarVolumen: r.dollarVolumen, tage: r.tage, letzterKurs: r.letzterKurs, alterTage: r.alterTage, rang, status: st, grund };
    })
    .sort((x, y) => (x.rang ?? Number.MAX_SAFE_INTEGER) - (y.rang ?? Number.MAX_SAFE_INTEGER) || (x.symbol < y.symbol ? -1 : 1));

  const zugang = symbols.filter((s) => !bestand.has(s));
  const abgang = [...bestand].filter((s) => !gewaehlt.has(s)).sort();

  /*
   * Zwei Notbremsen. `backfill` überspringt fehlgeschlagene Blöcke und macht
   * weiter (ein Symbol ohne Daten darf die anderen nicht aufhalten) — ohne die
   * folgenden Prüfungen würde ein Datenausfall für 29 von 30 Werten anstandslos
   * ein Universum `["SPY"]` veröffentlichen, und die 29 offenen Positionen
   * verlören ihre Strategie. Scheitert die Wahl hier, bricht der nächtliche
   * Schritt ab; `meta/engineConfig` und `meta/champion` bleiben stehen, wie sie
   * sind. Nichts zu ändern ist der sichere Ausgang.
   */
  const ohneDaten = roh.filter((r) => r.tage === 0).map((r) => r.symbol);
  const mindestens = Math.max(1, Math.ceil(regeln.max * regeln.minAnteil));
  if (symbols.length < mindestens) {
    throw new Error(
      `Auswahl liefert nur ${symbols.length} von mindestens ${mindestens} Symbolen (${roh.length} Kandidaten, ` +
        `davon ${ohneDaten.length} ohne Daten${ohneDaten.length ? `: ${ohneDaten.slice(0, 10).join(', ')}${ohneDaten.length > 10 ? ' …' : ''}` : ''}) — ` +
        'das ist ein Datenausfall, kein Liquiditätsurteil. Universum bleibt unverändert.',
    );
  }
  if (a.bestandIstAuswahl && abgang.length > regeln.maxAbgang) {
    throw new Error(
      `Auswahl würde ${abgang.length} Symbole auf einmal austauschen (erlaubt: ${regeln.maxAbgang}): ${abgang.join(', ')}. ` +
        'So viel Bewegung an einer Nacht ist ein Datenproblem, keine Liquiditätsverschiebung. Universum bleibt unverändert.',
    );
  }

  return { symbols, bewertung, zugang, abgang };
}
