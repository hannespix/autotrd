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
}

export interface SchattenBeitrag {
  /** Zählt dieses Signal überhaupt? `hold` und kaputte Kurse zählen nicht. */
  zaehlt: boolean;
  /** Kursbewegung in Signalrichtung, in Prozent (vor Kosten). */
  rohPct: number;
  /** Nach Abzug der Roundtrip-Kosten — die Zahl, die über Gewinn entscheidet. */
  nettoPct: number;
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
  return { zaehlt: true, rohPct: r4(roh), nettoPct: r4(roh - roundtripKosten * 100) };
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
}

/** Ein Beitrag in ein laufendes Aggregat einrechnen. */
export function addiereSchatten(
  bisher: SchattenKlasse | undefined,
  beitrag: SchattenBeitrag,
): SchattenKlasse {
  const k = bisher ?? { n: 0, summePct: 0, treffer: 0 };
  if (!beitrag.zaehlt) return k;
  return {
    n: k.n + 1,
    summePct: Math.round((k.summePct + beitrag.nettoPct) * 10_000) / 10_000,
    // Treffer wird VOR Kosten gezählt: Die Trefferquote soll die Güte der
    // Richtungsaussage messen, nicht die Gebührenordnung. Beides zusammen
    // in eine Zahl zu werfen, verschleiert, welcher Teil das Problem ist.
    treffer: k.treffer + (beitrag.rohPct > 0 ? 1 : 0),
    summeRohPct: Math.round(((k.summeRohPct ?? 0) + beitrag.rohPct) * 10_000) / 10_000,
    nRoh: (k.nRoh ?? 0) + 1,
  };
}

/** Aggregat in lesbare Kennzahlen umrechnen. */
export function werteSchattenAus(k: SchattenKlasse | undefined): SchattenAuswertung {
  if (!k || k.n <= 0) {
    return { n: 0, treffer: 0, trefferquote: null, kantePct: null, nRoh: 0, rohPct: null };
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
  return o['kostenOk'] === true
    ? { direction: dir, price, kostenOk: true }
    : { direction: dir, price };
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
 * Zustand des Tages-Slots bestimmen.
 *
 * `leer`/`verfallen` → Slot darf neu belegt werden. `wartet` → Slot NICHT
 * anfassen (das Signal reift noch). `reif` → jetzt bewerten, danach neu
 * belegen. Kaputte oder rückdatierte Einträge zählen als `leer` — im
 * Zweifel nicht raten, wie überall im Schatten.
 */
export function pruefeTagSlot(roh: unknown, jetztMs: number): TagSlotBefund {
  if (!roh || typeof roh !== 'object') return { status: 'leer' };
  const o = roh as Record<string, unknown>;
  const at = typeof o['at'] === 'string' ? Date.parse(o['at']) : NaN;
  if (!Number.isFinite(at)) return { status: 'leer' };
  const alter = jetztMs - at;
  if (alter < 0) return { status: 'leer' };
  if (alter < TAG_HORIZONT_MS) return { status: 'wartet' };
  if (alter > TAG_MAX_ALTER_MS) return { status: 'verfallen' };
  const signal = leseSchattenSignal(roh, jetztMs, TAG_MAX_ALTER_MS);
  return signal ? { status: 'reif', signal } : { status: 'verfallen' };
}
