/**
 * Schatten-Kante je Anlageklasse — die Messung, die weiterläuft, wenn eine
 * Klasse abgeschaltet ist (MG4).
 *
 * ── Warum es das braucht ──────────────────────────────────────────────────
 *
 * Die Klassen-Kante aus `attribution()` entsteht aus AUSGEFÜHRTEN Trades.
 * Setzt der Regler eine Klasse auf 0, entstehen keine neuen mehr — die
 * Empfehlung friert auf dem Stand des Abschaltens ein, und die Entscheidung
 * wird faktisch endgültig. Genau das sollte der Regler nicht sein.
 *
 * Dieselbe Zirkularität ist im Projekt schon zweimal aufgetreten: Ein
 * stillgelegtes Konto wird nie live-reif; ein Filter, der alles blockt,
 * beendet die Datensammlung, die ihn korrigieren würde. Beide Male war die
 * Antwort, die MESSUNG von der AUSFÜHRUNG zu trennen. Hier auch.
 *
 * ── Warum aus Signalen und nicht aus simulierten Trades ───────────────────
 *
 * Ein Schatten-Depot je Klasse müsste Positionen, Cash und Haltedauern
 * mitführen — viel Zustand für eine Frage, die einfacher ist: Sagen die
 * Signale dieser Klasse die Richtung richtig voraus, und zwar weit genug,
 * um die Reibung zu tragen?
 *
 * Genau das misst diese Datei. Ein Signal zeigt in eine Richtung, der Kurs
 * bewegt sich bis zum nächsten Scan, und die Differenz — vorzeichenrichtig
 * zur Signalrichtung, abzüglich Roundtrip-Kosten — ist die Kante dieses
 * Signals. Kein Depot, kein Cash, keine Haltedauer.
 *
 * Das ist bewusst NICHT dasselbe wie die realisierte Trade-Kante: Es fehlen
 * Stop, Ziel und Haltedauer. Es ist die Kante der SIGNALQUELLE, nicht die
 * der Ausführung. Für die Frage „soll diese Klasse wieder mithandeln?" ist
 * das die richtige Größe — und sie ist zum Nulltarif zu haben, weil Signale
 * und Kurse ohnehin bei jedem Scan entstehen.
 */

/** Ein Signal aus dem vorigen Scan, gegen das jetzt gemessen wird. */
export interface SchattenSignal {
  direction: 'buy' | 'sell' | 'hold';
  /** Kurs zum Zeitpunkt des Signals. */
  price: number;
  /**
   * Hätte dieses Signal die scharfe Kostenschwelle passiert? (MI2, 05.08.)
   *
   * Fehlt das Feld, stammt das Signal aus der Zeit vor dieser Messung. Dann
   * zählt es NICHT in die gefilterte Variante — `true` anzunehmen wäre der
   * bequeme Fehler: Eine ungefilterte Zahl in einem Zähler namens
   * „gefiltert" ist schlimmer als ein leerer Zähler, weil sie aussieht wie
   * ein Ergebnis.
   */
  kostenOk?: boolean;
  /**
   * Signaltyp zur Exit-Stil-Messung (Owner-Go 06.08.): 'trend' | 'umkehr' |
   * 'gemischt'. Fehlt das Feld (Altbestand), zählt das Signal in keine der
   * typisierten Varianten — dieselbe Regel wie bei `kostenOk`.
   */
  typ?: string;
  /**
   * ATR in Prozent je Kerze zum SIGNALZEITPUNKT — der Nenner der
   * Einfangquote (11.08.).
   *
   * ── Wozu ──────────────────────────────────────────────────────────────
   *
   * `costGate` prüft „erwartete Bewegung × Einfangquote > Kosten". Die
   * Einfangquote war eine Konstante aus einer einzigen Messwoche — mit dem
   * ausdrücklichen Hinweis im Quelltext, dass sie „aus der laufenden
   * Attribution nachgeführt" gehört, sobald genug Trades vorliegen. Diese
   * Nachführung braucht beide Seiten des Bruchs: Was hat sich BEWEGT
   * (`rohPct`, wird schon gemessen) und was war zu ERWARTEN.
   *
   * ── Warum eingefroren ─────────────────────────────────────────────────
   *
   * Der ATR ist später nicht mehr rekonstruierbar: Eine halbe Stunde danach
   * steht ein anderer im Speicher, und ein Nenner aus einem anderen Moment
   * macht die Quote falsch, ohne dass man es ihr ansieht. Deshalb hier
   * festgehalten, wie `kostenOk` und `typ` auch.
   *
   * Fehlend = Altbestand oder kein ATR. Zählt dann in keinen Quoten-Zähler;
   * die Quote fällt auf die Annahme zurück.
   */
  atrPct?: number;
  /**
   * Kerzenlänge in Minuten, auf der `atrPct` gerechnet wurde.
   *
   * Muss mitkommen, weil nur der Schreiber die Zeitbasis kennt: Bei
   * 5-Minuten-Signalen ist eine Kerze fünf Minuten, bei Tagessignalen
   * 1 440. Ein hier fest angenommener Wert wäre für die eine Hälfte der
   * Klassen um den Faktor 288 daneben.
   */
  barMin?: number;
  /**
   * Wie alt das Signal beim Bewerten war, in Millisekunden — der HORIZONT.
   *
   * Wird beim Lesen gesetzt, nicht gespeichert. Der Wert ist nicht konstant:
   * Fällt ein Scan aus, ist das Signal zehn statt fünf Minuten alt, und über
   * die doppelte Zeit ist auch die erwartete Bewegung größer (√2). Mit einem
   * angenommenen Fünf-Minuten-Horizont zu rechnen hieße, die Einfangquote
   * genau in den Störungsphasen zu überschätzen.
   */
  alterMs?: number;
}

export interface SchattenBeitrag {
  /** Zählt dieses Signal überhaupt? `hold` und kaputte Kurse zählen nicht. */
  zaehlt: boolean;
  /** Kursbewegung in Signalrichtung, in Prozent (vor Kosten). */
  rohPct: number;
  /** Nach Abzug der Roundtrip-Kosten — die Zahl, die über Gewinn entscheidet. */
  nettoPct: number;
  /** Erwartete Bewegung über den Signal-Horizont (fehlend = nicht messbar). */
  erwartetPct?: number;
  /**
   * Über WELCHES Zeitfenster gemessen wurde, in Millisekunden (17.08.).
   *
   * Die Zahl, die den Befund vom 17.08. sichtbar gemacht hätte: Der
   * Klassen-Schatten zog von einer Fünf-Minuten-Bewegung die vollen
   * Roundtrip-Kosten ab, während live seit dem 15.08. eine Mindesthalte von
   * 48 h gilt. Kante und Kosten standen in der Anzeige nebeneinander — der
   * HORIZONT, der beide erst vergleichbar macht, stand nirgends. Wer eine
   * Kante ohne ihr Zeitfenster liest, liest eine Zahl ohne Einheit.
   */
  alterMs?: number;
}

/**
 * Was ein einzelnes Signal gebracht hätte.
 *
 * Das Vorzeichen dreht sich bei `sell`: Ein fallender Kurs ist dort ein
 * Treffer. Wer das vergisst, misst jede funktionierende Short-Signalquelle
 * als Verlust — derselbe Fehler, der im Broker beim Short-P&L lauert.
 */
export function bewerteSchattenSignal(
  signal: SchattenSignal,
  kursJetzt: number,
  roundtripKosten: number,
): SchattenBeitrag {
  const leer: SchattenBeitrag = { zaehlt: false, rohPct: 0, nettoPct: 0 };
  if (signal.direction === 'hold') return leer;
  if (!(signal.price > 0) || !(kursJetzt > 0)) return leer;
  if (!Number.isFinite(roundtripKosten) || roundtripKosten < 0) return leer;

  const bewegung = ((kursJetzt - signal.price) / signal.price) * 100;
  const roh = signal.direction === 'buy' ? bewegung : -bewegung;
  const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;
  return {
    zaehlt: true,
    rohPct: r4(roh),
    nettoPct: r4(roh - roundtripKosten * 100),
    ...(typeof signal.alterMs === 'number' && signal.alterMs > 0
      ? { alterMs: signal.alterMs }
      : {}),
    ...erwarteteBewegung(signal),
  };
}

/**
 * Erwartete Bewegung über den tatsächlichen Signal-Horizont, in Prozent.
 *
 * Liefert ein LEERES Objekt, wenn eine der drei Zutaten fehlt oder unsinnig
 * ist. Kein Ersatzwert: „nicht messbar" muss von „Erwartung null"
 * unterscheidbar bleiben — die Null würde später als Nenner eine unendliche
 * Einfangquote erzeugen und der Klasse unbegrenzt Kapital freigeben.
 */
function erwarteteBewegung(signal: SchattenSignal): { erwartetPct?: number } {
  const { atrPct, barMin, alterMs } = signal;
  if (typeof atrPct !== 'number' || !Number.isFinite(atrPct) || atrPct <= 0) return {};
  if (typeof barMin !== 'number' || !Number.isFinite(barMin) || barMin <= 0) return {};
  if (typeof alterMs !== 'number' || !Number.isFinite(alterMs) || alterMs <= 0) return {};
  // √-Skalierung wie in costGate.expectedMovePct — bewusst dieselbe Physik.
  // Linear zu rechnen würde die erwartete Bewegung über längere Horizonte
  // massiv überschätzen und damit die gemessene Einfangquote drücken.
  const bars = alterMs / 60_000 / barMin;
  const erwartet = atrPct * Math.sqrt(bars);
  if (!Number.isFinite(erwartet) || erwartet <= 0) return {};
  return { erwartetPct: Math.round(erwartet * 10_000) / 10_000 };
}

/** Laufendes Aggregat einer Klasse — additiv, damit es über Scans wächst. */
export interface SchattenKlasse {
  /** Bewertete Signale (ohne `hold`). */
  n: number;
  /** Summe der Netto-Kanten in Prozent. */
  summePct: number;
  /** Wie oft die Richtung stimmte (vor Kosten). */
  treffer: number;
  /**
   * Summe der ROHEN Bewegungen in Prozent — vor Abzug der Kosten (05.08.).
   *
   * Der Grund für dieses Feld ist ein konkreter Messbefund: Der
   * Signal-Schatten zeigte nach vier Stunden eine Kante von −0,496 % je
   * Signal. Diese Zahl allein lässt zwei völlig verschiedene Deutungen zu:
   *
   *   1. Das Signal trägt keine Information — die Bewegung ist Rauschen.
   *   2. Das Signal trägt Information, aber weniger, als die TEUERSTE
   *      Anlageklasse an Gebühren verlangt.
   *
   * Der Unterschied ist entscheidend, weil nachts nur Krypto handelt
   * (0,50 % Roundtrip) und tags Aktien (0,10 %). Eine Signalquelle mit
   * +0,3 % Rohbewegung verliert in Krypto und gewinnt in Aktien — als
   * Netto-Summe über beide sieht sie nur nach „verliert" aus.
   *
   * Fehlendes Feld = Altbestand. Die Auswertung liefert dann `null` statt
   * einer erfundenen Zahl.
   */
  summeRohPct?: number;
  /**
   * Wie viele Signale in `summeRohPct` eingeflossen sind — eigener Zähler,
   * NICHT `n`.
   *
   * Der Grund ist ein Fehler, der beim Nachrüsten fast passiert wäre: Ein
   * Aggregat aus der Zeit vor dem Feld trägt 170 Signale und keine
   * Rohsumme. Teilte man die frische Rohsumme durch dieses `n`, käme eine
   * systematisch gegen null verzerrte Zahl heraus — und zwar genau die
   * Zahl, an der die Entscheidung hängt, ob eine Signalquelle Information
   * trägt. Mit eigenem Nenner stört der Altbestand nicht; er wird nur
   * nicht mitgezählt.
   */
  nRoh?: number;
  /**
   * Summe der ERWARTETEN Bewegungen — der Nenner der Einfangquote (11.08.).
   */
  summeErwartetPct?: number;
  /**
   * Summe der ROHEN Bewegungen GENAU DERSELBEN Signale wie
   * `summeErwartetPct` — der Zähler der Einfangquote.
   *
   * Warum nicht `summeRohPct` wiederverwenden? Weil deren Signalmenge eine
   * andere ist: Ein Signal ohne Erwartungswert (Altbestand, kein ATR)
   * fließt dort ein, hier nicht. Ein Bruch aus zwei verschieden erhobenen
   * Summen ist keine Quote, sondern eine Zahl, die zufällig entsteht — und
   * an ihr hängt, ob eine Anlageklasse Kapital bekommt.
   *
   * Dieselbe Vorsicht wie bei `nRoh`, aus demselben Grund: Beim Nachrüsten
   * des Rohfeldes wäre fast durch `n` geteilt worden.
   */
  summeRohBeiErwartet?: number;
  /** Wie viele Signale in beide Summen eingeflossen sind. */
  nErwartet?: number;
  /**
   * Summe der gemessenen Horizonte in Millisekunden (17.08.) — der Nenner
   * der Frage „über welches Zeitfenster ist diese Kante entstanden?".
   *
   * Wieder EIGENER Zähler (`nAlter`), aus dem inzwischen dreifach belegten
   * Grund: Ein Aggregat aus der Zeit vor diesem Feld trägt hunderte Signale
   * und keine Altersumme. Durch `n` geteilt käme ein systematisch gegen null
   * gezogener Horizont heraus — und ein Schatten, der fälschlich „5 Minuten"
   * meldet, ist genau der Befund, den dieses Feld aufdecken soll.
   */
  summeAlterMs?: number;
  /** Wie viele Signale in `summeAlterMs` eingeflossen sind. */
  nAlter?: number;
}

export interface SchattenAuswertung {
  n: number;
  treffer: number;
  /** Trefferquote 0…1; null ohne Signale. */
  trefferquote: number | null;
  /** Mittlere Netto-Kante je Signal in Prozent; null ohne Signale. */
  kantePct: number | null;
  /** Wie viele Signale in `rohPct` eingeflossen sind (eigener Nenner). */
  nRoh: number;
  /**
   * Mittlere ROHE Bewegung je Signal in Prozent, vor Kosten; null ohne
   * Signale oder wenn das Aggregat noch aus der Zeit vor dem Feld stammt.
   *
   * Positiv bei negativer `kantePct` heißt: Die Richtung stimmt, die
   * Gebühren fressen sie. Das ist eine Kostenfrage (andere Klasse, längerer
   * Horizont) und keine Absage an die Signalquelle.
   */
  rohPct: number | null;
  /** Wie viele Signale beide Quoten-Summen tragen (eigener Nenner). */
  nErwartet: number;
  /** Mittlere ERWARTETE Bewegung je Signal in Prozent; null ohne Messung. */
  erwartetPct: number | null;
  /**
   * Mittlere ROHE Bewegung GENAU DER Signale, die auch einen Erwartungswert
   * haben — der Zähler der Einfangquote. Null ohne Messung.
   *
   * Sieht `rohPct` zum Verwechseln ähnlich und ist es nicht: andere
   * Signalmenge. Nur DIESE Zahl darf gegen `erwartetPct` gerechnet werden.
   */
  rohBeiErwartetPct: number | null;
  /** Wie viele Signale einen gemessenen Horizont tragen (eigener Nenner). */
  nAlter: number;
  /**
   * Mittlerer gemessener Horizont in MINUTEN — die Einheit der Kante.
   *
   * `null` heißt „nicht gemessen" (Altbestand). Steht hier 5, während die
   * Klasse live 2 880 Minuten halten muss, ist die Kante über ein Fenster
   * entstanden, das es im Handel nicht gibt — und dann ist sie kein Beleg,
   * sondern ein Kategorienfehler.
   */
  alterMin: number | null;
}

/** Ein Beitrag in ein laufendes Aggregat einrechnen. */
export function addiereSchatten(
  bisher: SchattenKlasse | undefined,
  beitrag: SchattenBeitrag,
): SchattenKlasse {
  const k = bisher ?? { n: 0, summePct: 0, treffer: 0 };
  if (!beitrag.zaehlt) return k;
  const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;
  // Die beiden Quoten-Summen wachsen NUR GEMEINSAM. Getrennt fortgeschrieben
  // wären sie irgendwann über verschiedene Signalmengen gebildet, und ihr
  // Quotient hätte keine Bedeutung mehr.
  const quote =
    beitrag.erwartetPct !== undefined && beitrag.erwartetPct > 0
      ? {
          summeErwartetPct: r4((k.summeErwartetPct ?? 0) + beitrag.erwartetPct),
          summeRohBeiErwartet: r4((k.summeRohBeiErwartet ?? 0) + beitrag.rohPct),
          nErwartet: (k.nErwartet ?? 0) + 1,
        }
      : {};
  return {
    n: k.n + 1,
    summePct: r4(k.summePct + beitrag.nettoPct),
    // Treffer wird VOR Kosten gezählt: Die Trefferquote soll die Güte der
    // Richtungsaussage messen, nicht die Gebührenordnung. Beides zusammen
    // in eine Zahl zu werfen, verschleiert, welcher Teil das Problem ist.
    treffer: k.treffer + (beitrag.rohPct > 0 ? 1 : 0),
    summeRohPct: r4((k.summeRohPct ?? 0) + beitrag.rohPct),
    nRoh: (k.nRoh ?? 0) + 1,
    // Horizont-Summe: bestehende erhalten, neue nur bei gemessenem Alter.
    ...(k.summeAlterMs !== undefined
      ? { summeAlterMs: k.summeAlterMs, nAlter: k.nAlter ?? 0 }
      : {}),
    ...(typeof beitrag.alterMs === 'number' && beitrag.alterMs > 0
      ? {
          summeAlterMs: (k.summeAlterMs ?? 0) + beitrag.alterMs,
          nAlter: (k.nAlter ?? 0) + 1,
        }
      : {}),
    // Bestehende Quoten-Summen erhalten, auch wenn dieser Beitrag keine hat.
    ...(k.summeErwartetPct !== undefined
      ? {
          summeErwartetPct: k.summeErwartetPct,
          summeRohBeiErwartet: k.summeRohBeiErwartet ?? 0,
          nErwartet: k.nErwartet ?? 0,
        }
      : {}),
    ...quote,
  };
}

/** Aggregat in lesbare Kennzahlen umrechnen. */
export function werteSchattenAus(k: SchattenKlasse | undefined): SchattenAuswertung {
  if (!k || k.n <= 0) {
    return {
      n: 0,
      treffer: 0,
      trefferquote: null,
      kantePct: null,
      nRoh: 0,
      rohPct: null,
      nErwartet: 0,
      erwartetPct: null,
      rohBeiErwartetPct: null,
      nAlter: 0,
      alterMin: null,
    };
  }
  const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;
  return {
    n: k.n,
    treffer: k.treffer,
    trefferquote: r4(k.treffer / k.n),
    kantePct: r4(k.summePct / k.n),
    // Ein Aggregat aus der Zeit vor dem Feld hat KEINE Rohsumme. Dann `null`
    // statt 0: „nicht gemessen" ist eine andere Aussage als „Bewegung null",
    // und die zweite würde eine Signalquelle zu Unrecht erledigen.
    // Geteilt wird durch den EIGENEN Zähler, nicht durch `n` — siehe nRoh.
    nRoh: k.nRoh ?? 0,
    rohPct:
      k.summeRohPct === undefined || !k.nRoh || k.nRoh <= 0
        ? null
        : r4(k.summeRohPct / k.nRoh),
    nErwartet: k.nErwartet ?? 0,
    erwartetPct:
      k.summeErwartetPct === undefined || !k.nErwartet || k.nErwartet <= 0
        ? null
        : r4(k.summeErwartetPct / k.nErwartet),
    rohBeiErwartetPct:
      k.summeRohBeiErwartet === undefined || !k.nErwartet || k.nErwartet <= 0
        ? null
        : r4(k.summeRohBeiErwartet / k.nErwartet),
    nAlter: k.nAlter ?? 0,
    // In MINUTEN, nicht Millisekunden: Die Zahl wird gegen `minHoldMin`
    // gelesen — 2 880 gegen 5 ist auf einen Blick verständlich,
    // 172 800 000 gegen 300 000 ist es nicht.
    alterMin:
      k.summeAlterMs === undefined || !k.nAlter || k.nAlter <= 0
        ? null
        : Math.round((k.summeAlterMs / k.nAlter / 60_000) * 100) / 100,
  };
}

/**
 * Wie viele Signale eine Schatten-Aussage tragen muss.
 *
 * Höher als die 30 Trades der Trade-Kante, und zwar aus einem Grund: Ein
 * Signal je Scan und Symbol ist ein viel schwächerer Datenpunkt als ein
 * abgeschlossener Trade — es fehlen Stop, Ziel und Haltedauer. Mehr davon
 * sind nötig, um dasselbe Vertrauen zu rechtfertigen.
 */
export const SCHATTEN_MIN_N = 200;

/**
 * Dieselbe Frage für den HALTEDAUER-Schatten (Owner-Go 17.08.): 60.
 *
 * ── Warum weniger als 200 ─────────────────────────────────────────────────
 *
 * Die 200 oben sind ausdrücklich damit begründet, dass ein Fünf-Minuten-
 * Signal „ein viel schwächerer Datenpunkt als ein abgeschlossener Trade"
 * sei — es fehlten Stop, Ziel und Haltedauer. Genau dieses Argument trägt
 * für die Halte-Reihe nicht mehr: Sie MISST die Haltedauer. Was ihr
 * gegenüber einem echten Trade noch fehlt, sind Stop, Ziel und
 * Positionsgröße — deutlich weniger als vorher.
 *
 * Die Zahl ist deshalb an der Trade-Schwelle bemessen, nicht an der alten
 * Signal-Schwelle: `KLASSE_MIN_TRADES` ist 30, und ein Halte-Signal ist
 * schwächer als ein Trade — also das Doppelte. Es ist dieselbe Verdopplung,
 * mit der `GLOBAL_MIN_TRADES` (50) die Heterogenität fremder Konten
 * bezahlt. Nichts daran ist eine runde Wunschzahl.
 *
 * ── Was das praktisch bedeutet ────────────────────────────────────────────
 *
 * Bei 13 Krypto-Symbolen und 48 h Horizont entstehen ~6,5 unabhängige
 * Beobachtungen am Tag. 200 wären gut ein Monat, 60 sind gut neun Tage.
 * Der Rückweg bleibt eng — Kante > 0 und Rückkehr nur mit halbem Gewicht
 * sind unverändert; nur die Wartezeit ist jetzt an den Informationsgehalt
 * der Messung angepasst statt an den einer anderen Messung.
 */
export const SCHATTEN_HALTE_MIN_N = 60;

/**
 * Wie alt ein Signal höchstens sein darf, um noch bewertet zu werden.
 *
 * Der Scan läuft alle 5 Minuten; 30 Minuten decken also auch fünf
 * ausgefallene Läufe ab. Was darüber liegt, ist kein Signalfenster mehr,
 * sondern eine Lücke: Übernacht, Wochenende, oder ein Symbol, das die
 * Top-N-Auswahl tagelang nicht mitgenommen hat.
 *
 * Warum das nicht egal ist: Über eine Wochenendlücke bewegt sich ein Kurs
 * ein Vielfaches dessen, was in fünf Minuten passiert. Solche Fenster
 * mitzuzählen, machte die Kante zur Funktion der Scan-Lücken statt der
 * Signalgüte — und zwar systematisch zugunsten der Klassen mit den
 * größten Lücken. Genau die Klassen, über deren Abschaltung sie
 * entscheiden soll.
 */
export const SCHATTEN_MAX_ALTER_MS = 30 * 60 * 1000;

/**
 * Ein gespeichertes Signal einlesen — mit Alters- und Formprüfung.
 *
 * Die Daten kommen aus Firestore und sind damit `unknown`: Ein Feld kann
 * fehlen, ein älteres Dokument eine andere Form haben. Der teure Fehler
 * wäre eine unbekannte Richtung, die stillschweigend wie `sell` behandelt
 * wird — dann misst der Schatten Rauschen und eine Klasse fliegt raus.
 * Deshalb hier: im Zweifel `null`, nicht raten.
 */
export function leseSchattenSignal(
  roh: unknown,
  jetztMs: number,
  maxAlterMs: number = SCHATTEN_MAX_ALTER_MS,
): SchattenSignal | null {
  if (!roh || typeof roh !== 'object') return null;
  const o = roh as Record<string, unknown>;

  const dir = o['direction'];
  if (dir !== 'buy' && dir !== 'sell' && dir !== 'hold') return null;

  const price = o['price'];
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;

  const at = o['at'];
  if (typeof at !== 'string') return null;
  const tMs = Date.parse(at);
  if (!Number.isFinite(tMs)) return null;

  const alter = jetztMs - tMs;
  // Negatives Alter heißt: Uhr verstellt oder Zeitzone verrutscht. Beides
  // ist ein Grund, die Zahl NICHT zu verwenden.
  if (alter < 0 || alter > maxAlterMs) return null;

  // Nur ein ECHTES `true` zählt. Ein fehlendes oder anders getipptes Feld
  // bleibt weg — siehe SchattenSignal.kostenOk.
  const typ = o['typ'];
  const atrPct = o['atrPct'];
  const barMin = o['barMin'];
  // Der Horizont ist das GEMESSENE Alter, nicht das erwartete Scan-Intervall.
  // Er wandert IMMER mit (17.08.) und nicht mehr nur zusammen mit dem ATR:
  // Das Alter ist die Einheit der Kante, nicht Zubehör der Einfangquote. An
  // die Quote gekoppelt fehlte er genau dort, wo er gebraucht wurde — die
  // Tages- und Halte-Slots führen keinen ATR mit, und ausgerechnet bei ihnen
  // ist der Horizont die Aussage.
  const messbar =
    typeof atrPct === 'number' &&
    Number.isFinite(atrPct) &&
    atrPct > 0 &&
    typeof barMin === 'number' &&
    Number.isFinite(barMin) &&
    barMin > 0 &&
    alter > 0;
  return {
    direction: dir,
    price,
    ...(o['kostenOk'] === true ? { kostenOk: true } : {}),
    // Nur bekannte Typen wandern mit — ein Tippfehler wird keine Kategorie.
    ...(typ === 'trend' || typ === 'umkehr' || typ === 'gemischt' ? { typ } : {}),
    ...(alter > 0 ? { alterMs: alter } : {}),
    ...(messbar ? { atrPct, barMin } : {}),
  };
}

/* ── Tages-Horizont (Task 94, Entscheidung 05.08.) ──────────────────────────
 *
 * Die Kostenschwellen-Messung hat die Diagnose gedreht: Die Live-Signale
 * tragen Information (roh +0,022 % je Signal, Treffer 52 %), aber im
 * 5-Minuten-Horizont ist die Bewegung eine Größenordnung kleiner als die
 * Roundtrip-Kosten. Der Hebel wäre „länger halten" — und ob er trägt, soll
 * eine Messung sagen, keine Vermutung: dieselben Live-Signale, bewertet am
 * NÄCHSTEN Tag statt am nächsten Scan.
 *
 * Mechanik: Ein eigener Slot (`lastSignalTag` am Markt-Dokument) wird mit
 * einem buy/sell-Signal belegt und dann NICHT überschrieben, bis der
 * Horizont erreicht ist — sonst würde der 5-Minuten-Takt das Signal
 * ersetzen, bevor es je einen Tag alt ist. Nach ≥24 h wird gegen den dann
 * aktuellen Kurs bewertet und der Slot neu belegt.
 */

/** Frühestens nach dieser Zeit wird bewertet: der „nächste Tag". */
export const TAG_HORIZONT_MS = 24 * 3_600_000;

/**
 * Spätestens bis dahin — sonst verfällt das Signal unbewertet.
 *
 * 96 h decken das Wochenende (Freitag-Signal → Bewertung Montag nach
 * ~66 h). Was älter ist, stammt aus einer echten Lücke (Symbol aus dem
 * Scan gefallen, Feiertagskette) und würde die Kante zur Funktion der
 * Lücken machen statt der Signalgüte.
 */
export const TAG_MAX_ALTER_MS = 96 * 3_600_000;

export type TagSlotBefund =
  | { status: 'leer' }
  | { status: 'wartet' }
  | { status: 'reif'; signal: SchattenSignal }
  | { status: 'verfallen' };

/**
 * Zustand eines HORIZONT-Slots bestimmen — die allgemeine Fassung.
 *
 * `leer`/`verfallen` → Slot darf neu belegt werden. `wartet` → Slot NICHT
 * anfassen (das Signal reift noch). `reif` → jetzt bewerten, danach neu
 * belegen. Kaputte oder rückdatierte Einträge zählen als `leer` — im
 * Zweifel nicht raten, wie überall im Schatten.
 *
 * Der Horizont ist Parameter und keine Konstante mehr (17.08.), weil er
 * inzwischen von der Anlageklasse abhängt: Krypto muss live 48 h halten,
 * Aktien 24 h. Die Mechanik ist dieselbe — und sie soll genau EINMAL im Repo
 * stehen, damit der Doppelzähl-Defekt vom 07.08. nicht in einer zweiten
 * Kopie zurückkommt.
 */
export function pruefeHorizontSlot(
  roh: unknown,
  jetztMs: number,
  horizontMs: number,
  maxAlterMs: number,
): TagSlotBefund {
  if (!roh || typeof roh !== 'object') return { status: 'leer' };
  const o = roh as Record<string, unknown>;
  const at = typeof o['at'] === 'string' ? Date.parse(o['at']) : NaN;
  if (!Number.isFinite(at)) return { status: 'leer' };
  const alter = jetztMs - at;
  if (alter < 0) return { status: 'leer' };
  if (alter < horizontMs) return { status: 'wartet' };
  if (alter > maxAlterMs) return { status: 'verfallen' };
  const signal = leseSchattenSignal(roh, jetztMs, maxAlterMs);
  return signal ? { status: 'reif', signal } : { status: 'verfallen' };
}

/** Zustand des TAGES-Slots (Task 94) — unveränderte Fassung mit 24 h/96 h. */
export function pruefeTagSlot(roh: unknown, jetztMs: number): TagSlotBefund {
  return pruefeHorizontSlot(roh, jetztMs, TAG_HORIZONT_MS, TAG_MAX_ALTER_MS);
}

export type TagSlotAktion = 'neu' | 'loeschen' | 'lassen';

/**
 * Was der Scan mit dem Tages-Slot TUN muss, nachdem `pruefeTagSlot`
 * gesprochen hat.
 *
 * Der Fall, für den diese Funktion existiert (Defekt-Fund 07.08., bevor der
 * erste Slot reifte): Ein REIFER Slot wurde nur überschrieben, wenn das
 * heutige Signal buy/sell war. Bei `hold` blieb er stehen — und wurde beim
 * nächsten Scan ERNEUT bewertet, alle fünf Minuten, bis irgendwann ein
 * buy/sell kam. Bis zu 12 Doppelzählungen je Stunde, systematisch in ruhigen
 * Phasen — die Tages-Kante wäre eine Funktion der Marktstille geworden statt
 * der Signalgüte. Deshalb: Ein reifer Slot wird IMMER verbraucht — neu
 * belegt, wenn es ein frisches Signal gibt, sonst gelöscht. Verfallene
 * Slots werden aus demselben Grund aufgeräumt statt liegen gelassen.
 */
export function tagSlotAktion(
  status: TagSlotBefund['status'],
  direction: 'buy' | 'sell' | 'hold',
): TagSlotAktion {
  const frisch = direction === 'buy' || direction === 'sell';
  if (status === 'wartet') return 'lassen'; // reift noch — niemals anfassen
  if (frisch) return 'neu';
  return status === 'reif' || status === 'verfallen' ? 'loeschen' : 'lassen';
}

/* ── Halte-Horizont: messen, wie lange live gehalten wird (17.08.) ──────────
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * Owner-Frage 16.08.: „seit unserem letzten Update, das für mehr Einkommen
 * sorgen sollte, gibt es quasi keine Bewegung mehr." Krypto stand auf
 * Gewicht 0, und der einzige Rückweg — die Schatten-Kante — zeigte −0,488 %
 * je Signal. Beim Nachrechnen war die Kante nicht das Problem, sondern ihre
 * EINHEIT:
 *
 *   Der Klassen-Schatten misst die Bewegung von einem Scan zum nächsten,
 *   also über FÜNF MINUTEN, und zieht davon die vollen Roundtrip-Kosten ab.
 *   Live gilt für Krypto seit dem 15.08. eine Mindesthalte von 48 STUNDEN.
 *
 * Gemessen wurden also 0,011 % Rohbewegung gegen 0,50 % Kosten — eine
 * Rechnung, die keine Signalquelle der Welt gewinnen kann, und die mit dem
 * Handel, den sie freigeben soll, nichts zu tun hat. Der Rückweg war nicht
 * eng, er war zu.
 *
 * ── Warum ein Slot und keine Warteschlange ────────────────────────────────
 *
 * Naheliegend wäre, JEDES Signal 48 h aufzubewahren und dann zu bewerten —
 * 576 Signale je Symbol und Fenster statt einem. Das wäre die bequeme Zahl:
 * Diese Fenster ÜBERLAPPEN sich fast vollständig, sie messen 576-mal
 * dieselbe Kursbewegung. n=200 wäre in drei Tagen erreicht und trüge die
 * Information von zwei unabhängigen Beobachtungen. Die Beweisschwelle sähe
 * erfüllt aus, ohne erfüllt zu sein — genau der Fehler, den `nRoh` und
 * `summeRohBeiErwartet` an anderer Stelle verhindern.
 *
 * Deshalb: EIN Slot je Symbol, nicht überlappende Fenster. Der Preis ist
 * ehrlich benannt — bei 13 Krypto-Symbolen und 48 h Horizont sind das ~6,5
 * unabhängige Beobachtungen am Tag, also rund einen Monat bis zur
 * Beweisschwelle. Wer schneller will, braucht mehr SYMBOLE, nicht mehr
 * Messpunkte je Symbol.
 */

/**
 * Kulanz oberhalb des Horizonts, bis ein Halte-Signal verfällt.
 *
 * Deckt Marktlücken: Ein Aktiensignal, das Freitagmittag reif würde, wird
 * erst Montag nach der Öffnung bewertet (~66 h). Ohne Kulanz wäre die Kante
 * eine Funktion des Kalenders — und zwar systematisch zulasten der Klassen
 * mit den größten Lücken.
 *
 * 72 h ist keine neue Zahl, sondern die, die der Tages-Slot seit dem 05.08.
 * benutzt: `TAG_MAX_ALTER_MS` (96 h) minus `TAG_HORIZONT_MS` (24 h). Dass
 * beide Fassungen dieselbe Kulanz verwenden, ist Absicht und wird im Test
 * festgenagelt.
 */
export const HALTE_KULANZ_MS = 72 * 3_600_000;

/** Spätestens so alt darf ein Halte-Signal beim Bewerten sein. */
export function halteMaxAlterMs(horizontMs: number): number {
  const h = Number.isFinite(horizontMs) && horizontMs > 0 ? horizontMs : 0;
  return h + HALTE_KULANZ_MS;
}

/**
 * Zustand des HALTE-Slots — derselbe Mechanismus wie beim Tages-Slot, nur
 * mit dem Horizont der Anlageklasse (`wirksameMindesthalte`).
 *
 * Ein Horizont von 0 ist zulässig und bedeutet, was er sagt: Eine Klasse
 * ohne Mindesthalte darf sofort wieder aussteigen, für sie IST das nächste
 * Scan-Fenster die Haltedauer. Die Bewertung fällt dann mit der
 * Fünf-Minuten-Messung zusammen — nicht aus Nachlässigkeit, sondern weil das
 * für diese Klasse die richtige Zeitbasis ist.
 */
export function pruefeHalteSlot(
  roh: unknown,
  jetztMs: number,
  horizontMs: number,
): TagSlotBefund {
  const h = Number.isFinite(horizontMs) && horizontMs > 0 ? horizontMs : 0;
  return pruefeHorizontSlot(roh, jetztMs, h, halteMaxAlterMs(h));
}

/* ── Signaltyp: Trend oder Umkehr (Owner-Go 06.08.) ─────────────────────────
 *
 * Die Exit-Stil-Hypothese: Ein TREND-Signal (MACD stimmt zu) sollte laufen
 * dürfen (nachziehender Stop, längerer Horizont), ein UMKEHR-Signal
 * (RSI/Bollinger stimmen zu) sollte sein Ziel abräumen (kurzer Horizont).
 * Ob das stimmt, sollen die Schatten-Varianten je Signaltyp zeigen, BEVOR
 * irgendein Exit-Verhalten umgebaut wird: Verdient `trend` im
 * Tages-Horizont und `umkehr` im 5-Minuten-Horizont, ist der Exit-Stil der
 * Hebel — sonst ist auch diese Idee nur eine Vermutung gewesen.
 */
export type SignalTyp = 'trend' | 'umkehr' | 'gemischt';

/**
 * Signaltyp aus den Indikator-Stimmen bestimmen.
 *
 * Gezählt werden nur Stimmen, die MIT der Signalrichtung stimmen: MACD ist
 * der Trendfolger, RSI und Bollinger sind die Umkehr-Familie. Stimmen beide
 * Familien zu → `gemischt` (eigene Kategorie statt Münzwurf). Die
 * Forecast-Stimme gehört bewusst zu keiner Familie — sie ist eine
 * Prognose, kein Indikator-Charakter.
 */
export function bestimmeSignalTyp(
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger' | 'forecast', string>>,
  direction: 'buy' | 'sell' | 'hold',
): SignalTyp | null {
  if (direction !== 'buy' && direction !== 'sell') return null;
  const trend = votes.macd === direction;
  const umkehr = votes.rsi === direction || votes.bollinger === direction;
  if (trend && umkehr) return 'gemischt';
  if (trend) return 'trend';
  if (umkehr) return 'umkehr';
  return null;
}
