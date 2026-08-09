/**
 * Anlageklassen ein- und ausregeln — auf Basis dessen, was sie tatsächlich
 * verdienen.
 *
 * Owner-Vorschlag 04.08.: „kann man für die einzelnen Handelsklassen auch
 * Schieberegler einbauen? am besten Shadow-Trades mit allen handeln lassen
 * damit man die theoretische Performance messen kann, und dann eine
 * Empfehlung ausgeben welche Handelsklassen jeweils am besten performen.
 * auch einen Auto-Regler …"
 *
 * ── Warum ein REGLER und kein Schalter ────────────────────────────────────
 *
 * Ein An/Aus-Schalter kennt nur zwei Antworten auf eine Frage, die
 * stufenlos ist. Die Messung vom 04.08. zeigt Kanten von −0,41 % bis
 * +0,81 % — dazwischen liegt alles. Ein Faktor kann das abbilden: 0 heißt
 * aus, 1 unverändert, 1,5 verstärkt. Er läuft über denselben `sizeFactor`,
 * den das Überzeugungs-Sizing schon benutzt, und passt damit zur
 * Owner-Direktive „je sicherer und klarer die Gewinn-Chancen bei einem
 * Trade sind, desto mehr soll investiert werden".
 *
 * Wichtiger noch: Ein Regler kann GRADUELL nachziehen. Ein Schalter, der auf
 * eine Woche schlechter Zahlen hin umspringt und auf die nächste zurück,
 * erzeugt mehr Schaden als er verhindert.
 *
 * ── Warum der Schatten über ALLE Klassen laufen muss ──────────────────────
 *
 * Das ist der Kern des Vorschlags und der Grund, warum er trägt. Wer eine
 * Klasse abschaltet, hört auf, sie zu messen — und kann nie feststellen, ob
 * die Entscheidung noch stimmt. Dieselbe Zirkularität wie beim Live-Reife-
 * Gate („ein stillgelegtes Konto wird nie reif") und bei der Kostenschwelle
 * („ein Filter, der alles blockt, beendet die Datensammlung").
 *
 * Deshalb: Der Regler steuert nur die AUSFÜHRUNG. Signale, Schatten-P&L und
 * damit die Empfehlung entstehen weiter für jede Klasse, auch für die mit
 * Gewicht 0. Eine abgeschaltete Klasse kann sich zurückverdienen.
 *
 * ── Warum die Empfehlung eine Evidenzschwelle braucht ─────────────────────
 *
 * Am 04.08. hatte `indices` genau EINEN Trade und `stocks_global` ebenfalls
 * einen. Eine Empfehlung auf dieser Grundlage wäre Münzwurf mit Nachkomma-
 * stellen. Die Schwelle hier ist bewusst dieselbe Größenordnung wie beim
 * Auto-Tuner (`EVIDENCE_DEFAULTS.minTrades = 30`): Was den Kapitaleinsatz
 * verändert, braucht Belege, keine Anekdoten.
 */

import { SCHATTEN_MIN_N } from './classShadow.js';
import { MIN_ACCOUNTS } from './globalLearning.js';

/** Was eine Anlageklasse gemessen hat — Teilmenge von `AttributionSlice`. */
export interface KlassenErgebnis {
  n: number;
  /** Nettorendite je gehandeltem Dollar in Prozent (nach Gebühren). */
  kantePct: number | null;
  /**
   * Schatten-Kante der Signalquelle (MG4) — die Messung, die auch ohne
   * Ausführung weiterläuft. Zählt nur, wenn realisierte Trades fehlen.
   */
  schatten?: { n: number; kantePct: number | null };
  /**
   * Dieselbe Klasse über ALLE Konten (MG5, Owner-Go 09.08.).
   *
   * ── Warum es diese Ebene braucht ────────────────────────────────────────
   *
   * Am 09.08. stand in der Erkenntnis-Chronik belegt, dass `etf_thematic`
   * über 58 Trades −0,76 % je Dollar verliert — und der Regler hätte
   * trotzdem nichts getan. Grund: Er verlangt 30 Trades IN DIESER KLASSE IN
   * DIESEM KONTO, und die 58 verteilen sich über sieben Konten. Die
   * Erkenntnis war also belegt, der Hebel aber verriegelt.
   *
   * Das widerspricht der Owner-Direktive, dass sich das Tool als Ganzes
   * verbessern soll und nicht nur je Nutzer. Ein Konto muss nicht selbst
   * 30 Mal Lehrgeld zahlen, wenn die Antwort anderswo schon gemessen wurde.
   *
   * ── Warum die Latte höher liegt als bei eigenen Trades ──────────────────
   *
   * Fremde Konten handeln mit anderen Einstellungen: andere Loadouts, andere
   * Stops, andere Watchlists. Dieselbe Klasse kann dort etwas anderes sein
   * als hier. Deshalb `GLOBAL_MIN_TRADES` deutlich über `KLASSE_MIN_TRADES`
   * und zusätzlich `MIN_ACCOUNTS` beitragende Konten — bei einem einzigen
   * Konto wäre der „globale" Wert schlicht dessen eigener.
   */
  global?: { n: number; kantePct: number | null; konten: number };
}

/** Regler-Grenzen. Identisch zum Überzeugungs-Sizing, damit beide zusammen gedeckelt bleiben. */
export const GEWICHT_MIN = 0;
export const GEWICHT_MAX = 1.5;

/** Ab so vielen Trades gilt eine Klassen-Kante als belegt. */
export const KLASSE_MIN_TRADES = 30;

/**
 * Ab so vielen Trades ÜBER ALLE KONTEN zählt der globale Beleg.
 *
 * Fast das Doppelte der eigenen Schwelle. Der Aufschlag bezahlt die
 * Heterogenität: Die Trades stammen aus Konten mit anderen Einstellungen,
 * also ist jeder einzelne für dieses Konto weniger aussagekräftig als ein
 * eigener. Zusammen mit `MIN_ACCOUNTS` verhindert das, dass ein einzelnes
 * vielhandelndes Konto dem ganzen Bestand seine Erfahrung aufdrängt.
 */
export const GLOBAL_MIN_TRADES = 50;

/**
 * Obergrenze, die ein globaler Beleg vergeben darf.
 *
 * Die Asymmetrie ist Absicht und folgt derselben Logik wie beim Schatten,
 * nur andersherum: Drosseln und Abschalten dürfen auf Fremdmessung hin
 * passieren, denn ein Fehlalarm kostet nur entgangene Chancen. VERSTÄRKEN
 * erhöht den Einsatz — dafür soll dieses Konto selbst geliefert haben.
 * Über 1,0 hinaus geht es also nur mit eigenen Trades.
 */
export const GLOBAL_MAX_GEWICHT = 1;

/**
 * Kante, ab der eine Klasse als klar tragend gilt (in Prozent je Dollar).
 *
 * 0,1 % ist nicht willkürlich: Die Roundtrip-Kosten liegen je nach Klasse
 * zwischen 0,1 % und 0,5 %. Eine Kante, die darunter liegt, ist im Rauschen
 * der Ausführung — sie kann durch einen einzigen ungünstigen Spread kippen.
 */
export const KANTE_GUT = 0.1;

/** Kante, ab der eine Klasse als defizitär gilt. */
export const KANTE_SCHLECHT = 0;

export type Empfehlung =
  | 'verstaerken'
  | 'behalten'
  | 'drosseln'
  | 'abschalten'
  | 'zurueckholen'
  | 'zu_wenig_daten';

/**
 * Gewicht, mit dem eine abgeschaltete Klasse zurückkommt.
 *
 * Ein Probelos, kein Vertrauensvorschuss: Der Schatten misst die
 * SIGNALQUELLE, nicht die Ausführung — ihm fehlen Stop, Ziel und
 * Haltedauer. Halbes Gewicht erzeugt wieder echte Trades (und damit die
 * Kante, die wirklich zählt), ohne viel zu kosten, falls der Schatten zu
 * gut aussah.
 */
export const SCHATTEN_PROBELOS = 0.5;

/** Worauf sich die Empfehlung stützt. */
export type Belegquelle = 'eigen' | 'global' | 'schatten' | 'keine';

export interface KlassenRat {
  klasse: string;
  /** EIGENE Trades dieses Kontos — bleibt auch dann stehen, wenn global entschieden wurde. */
  n: number;
  /** EIGENE Kante dieses Kontos. */
  kantePct: number | null;
  /** Aktuelles Gewicht (aus der Strategie). */
  gewicht: number;
  empfehlung: Empfehlung;
  /** Gewicht, das die Messung nahelegt. */
  vorschlag: number;
  /** Klartext — landet in der Oberfläche und im Journal. */
  grund: string;
  /**
   * Woher der Beleg stammt. Ohne dieses Feld ließe sich in der Karte nicht
   * unterscheiden, ob „drosseln" auf eigenen Trades beruht oder auf denen
   * anderer Konten — ein Unterschied, der für die Bewertung zählt.
   */
  quelle: Belegquelle;
  /** Die Zahlen, auf denen die Empfehlung fußt (bei `eigen` identisch zu n/kantePct). */
  belegN: number;
  belegKantePct: number | null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Gewicht auf den erlaubten Bereich begrenzen. */
export function klemmeGewicht(w: number | undefined): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return 1;
  return Math.min(GEWICHT_MAX, Math.max(GEWICHT_MIN, w));
}

/**
 * Kante → Empfehlung + Vorschlag. Die eigentliche Skala, unabhängig davon,
 * WOHER die Kante kommt.
 *
 * Ausgelagert, damit eigener und globaler Beleg garantiert dieselben
 * Schwellen benutzen. Zwei Kopien dieser Kaskade wären der sichere Weg,
 * dass sie beim nächsten Feinschliff auseinanderlaufen — und niemand würde
 * es merken, weil beide Zweige für sich plausibel blieben.
 *
 * `deckel` begrenzt, wie weit hoch der Vorschlag gehen darf: Beim globalen
 * Beleg auf 1,0, weil Verstärken eigene Trades verlangt (s. GLOBAL_MAX_GEWICHT).
 */
function bewerteKante(
  k: number,
  n: number,
  w: number,
  deckel: number,
): { empfehlung: Empfehlung; vorschlag: number; grund: string } {
  if (k >= KANTE_GUT) {
    return {
      empfehlung: 'verstaerken',
      vorschlag: r2(Math.min(deckel, Math.max(w, 1) * 1.25)),
      grund: `Verdient ${k.toFixed(3)} % je gehandeltem Dollar — trägt ihre Reibung klar.`,
    };
  }
  if (k > KANTE_SCHLECHT) {
    return {
      empfehlung: 'behalten',
      vorschlag: r2(Math.min(w, 1)),
      grund:
        `Verdient ${k.toFixed(3)} % je Dollar — positiv, aber unter ${KANTE_GUT} % ` +
        'und damit im Rauschen der Ausführung. Nicht verstärken.',
    };
  }
  // Ab hier: Kante ≤ 0. Wie hart gedrosselt wird, hängt davon ab, wie tief
  // sie liegt — eine Klasse knapp unter null ist etwas anderes als eine, die
  // pro Dollar systematisch verbrennt.
  if (k > -0.1) {
    return {
      empfehlung: 'drosseln',
      vorschlag: r2(Math.max(0.25, w * 0.5)),
      grund: `Verliert ${Math.abs(k).toFixed(3)} % je Dollar — halbes Gewicht, weiter beobachten.`,
    };
  }
  return {
    empfehlung: 'abschalten',
    vorschlag: 0,
    grund:
      `Verliert ${Math.abs(k).toFixed(3)} % je gehandeltem Dollar über ${n} Trades. ` +
      'Das ist keine Marktphase, das ist die Struktur. Der Schatten läuft weiter.',
  };
}

/**
 * Empfehlung für eine einzelne Klasse.
 *
 * Die Reihenfolge der Prüfungen ist Absicht — erst Datenmenge, dann
 * Richtung, dann Größe. Genau wie bei `judgeCandidate`: Wer nur das Ergebnis
 * liest, soll trotzdem verstehen, WARUM es so ausfällt.
 *
 * Die Belegquellen stehen in einer festen Rangfolge, und die ist keine
 * Geschmacksfrage:
 *
 *   1. EIGENE Trades — sie messen genau diese Einstellungen an genau diesem
 *      Konto. Nichts schlägt das.
 *   2. RÜCKWEG aus dem Schatten — nur bei Gewicht 0 und positivem Schatten.
 *      Steht VOR dem globalen Beleg, und der Grund ist der wichtigste
 *      Halbsatz in dieser Datei (s. u.).
 *   3. GLOBALER Beleg (MG5) — echte Trades, aber aus fremden Konten mit
 *      anderen Einstellungen. Höhere Latte, und Verstärken ist gedeckelt.
 *   4. Sonst: kein Beleg, Gewicht bleibt.
 *
 * ── Warum der Rückweg vor dem Gesamtbestand steht ─────────────────────────
 *
 * Weil der Bestand sich sonst selbst einfriert. Schaltet er eine Klasse in
 * ALLEN Konten ab — und genau das tut er, wenn die Kante deutlich negativ
 * ist —, dann entstehen in dieser Klasse keine neuen Trades mehr. Die
 * globale Kante bleibt für immer auf dem Stand des Abschalt-Tages stehen,
 * spricht bei jedem Lauf dasselbe Urteil, und der Schatten, der die einzige
 * fortlaufende Messung wäre, käme nie zu Wort.
 *
 * Das ist exakt die Zirkularität, gegen die MG4 gebaut wurde („wer aufhört
 * zu messen, kann nie feststellen, ob die Entscheidung noch stimmt") — sie
 * wäre mit dem globalen Beleg durch die Hintertür zurückgekommen. Der
 * Rückweg führt auf halbes Gewicht, erzeugt also wieder echte Trades, und
 * genau die korrigieren den globalen Beleg. Er bleibt dabei eng: nur bei
 * Gewicht 0, nur mit belegtem und positivem Schatten.
 */
export function rateKlasse(
  klasse: string,
  ergebnis: KlassenErgebnis,
  gewicht: number,
  minTrades = KLASSE_MIN_TRADES,
  schattenMinN = SCHATTEN_MIN_N,
  globalMinTrades = GLOBAL_MIN_TRADES,
  globalMinKonten = MIN_ACCOUNTS,
): KlassenRat {
  const w = klemmeGewicht(gewicht);
  const basis = { klasse, n: ergebnis.n, kantePct: ergebnis.kantePct, gewicht: w };

  // 1) Eigene Trades.
  if (ergebnis.kantePct !== null && ergebnis.n >= minTrades) {
    return {
      ...basis,
      ...bewerteKante(ergebnis.kantePct, ergebnis.n, w, GEWICHT_MAX),
      quelle: 'eigen',
      belegN: ergebnis.n,
      belegKantePct: ergebnis.kantePct,
    };
  }

  // 2) Rückweg aus dem Schatten. MUSS vor dem globalen Beleg stehen, sonst
  // friert eine einmal abgeschaltete Klasse für immer ein (s. Kopf).
  const s = ergebnis.schatten;
  const schattenBelegt = !!s && s.kantePct !== null && s.n >= schattenMinN;
  if (schattenBelegt && w === 0 && s!.kantePct! > 0) {
    return {
      ...basis,
      empfehlung: 'zurueckholen',
      vorschlag: SCHATTEN_PROBELOS,
      grund:
        `Abgeschaltet, aber der Schatten verdient ${s!.kantePct!.toFixed(3)} % je Signal ` +
        `über ${s!.n} Signale. Mit halbem Gewicht zurück in den Handel — nur echte ` +
        'Trades können den Verdacht bestätigen.',
      quelle: 'schatten',
      belegN: s!.n,
      belegKantePct: s!.kantePct,
    };
  }

  // 3) Globaler Beleg — dieselbe Skala, strengere Zulassung.
  const g = ergebnis.global;
  if (
    g &&
    g.kantePct !== null &&
    g.n >= globalMinTrades &&
    g.konten >= globalMinKonten
  ) {
    const b = bewerteKante(g.kantePct, g.n, w, GLOBAL_MAX_GEWICHT);
    return {
      ...basis,
      ...b,
      grund:
        `${b.grund} Beleg aus dem Gesamtbestand: ${g.n} Trades über ${g.konten} Konten ` +
        `(eigene: ${ergebnis.n}, für einen eigenen Beleg wären ${minTrades} nötig).` +
        (b.empfehlung === 'verstaerken'
          ? ` Verstärkt wird höchstens auf ${GLOBAL_MAX_GEWICHT} — darüber hinaus zählen nur eigene Trades.`
          : ''),
      quelle: 'global',
      belegN: g.n,
      belegKantePct: g.kantePct,
    };
  }

  // 4) Kein Beleg. Der Schatten kommt hier nicht mehr vor: Er darf
  // ausschließlich ZURÜCKHOLEN (oben, Schritt 2), nie abschalten. Ihm fehlt
  // der Stop, der reale Verluste kappt — eine negative Schatten-Kante ist
  // deshalb kein Beleg für einen negativen Trade-Ertrag. Und wenn die Klasse
  // ohnehin läuft (Gewicht > 0), ist nicht das Gewicht das Problem, sondern
  // die fehlende Gelegenheit; daran ändert der Regler nichts.
  return {
    ...basis,
    empfehlung: 'zu_wenig_daten',
    // Unverändert lassen, NICHT auf einen Standardwert ziehen: Eine Klasse
    // ohne Beleg soll weder belohnt noch bestraft werden.
    vorschlag: w,
    grund:
      `${ergebnis.n} Trades — für eine Aussage sind ${minTrades} nötig. `
      + (g && g.kantePct !== null
        ? `Der Gesamtbestand steht bei ${g.kantePct.toFixed(3)} % über ${g.n} Trades aus ${g.konten} Konten; `
          + `dafür wären ${globalMinTrades} Trades aus ${globalMinKonten} Konten nötig. `
        : '')
      + (schattenBelegt
        ? `Der Schatten steht bei ${s!.kantePct!.toFixed(3)} % je Signal (${s!.n}); `
          + 'er kann eine Klasse zurückholen, aber keine abschalten. '
        : '')
      + 'Gewicht bleibt, wie es ist.',
    quelle: 'keine',
    belegN: ergebnis.n,
    belegKantePct: ergebnis.kantePct,
  };
}

export interface KlassenBericht {
  raete: KlassenRat[];
  /** Klassen, deren Vorschlag vom aktuellen Gewicht abweicht. */
  aenderungen: number;
  /** Ein Satz für die Oberfläche. */
  fazit: string;
}

/**
 * Empfehlung für alle gemessenen Klassen, sortiert nach Kante.
 *
 * Absteigend sortiert, damit oben steht, was verdient — und unten, was
 * kostet. Eine alphabetische Liste würde denselben Inhalt tragen und
 * niemandem etwas sagen.
 */
export function berateKlassen(
  ergebnisse: Record<string, KlassenErgebnis>,
  gewichte: Record<string, number> = {},
  minTrades = KLASSE_MIN_TRADES,
  schattenMinN = SCHATTEN_MIN_N,
): KlassenBericht {
  const raete = Object.entries(ergebnisse)
    .map(([klasse, e]) => rateKlasse(klasse, e, gewichte[klasse] ?? 1, minTrades, schattenMinN))
    // Nach der Kante sortieren, die die Empfehlung TRÄGT — sonst rutschte
    // eine global belegte Klasse ans Ende, nur weil ihre eigene Kante null
    // ist. Genau die Klassen sollen aber oben stehen, über die etwas
    // ausgesagt werden kann.
    .sort((a, b) => (b.belegKantePct ?? -Infinity) - (a.belegKantePct ?? -Infinity));

  const aenderungen = raete.filter((r) => Math.abs(r.vorschlag - r.gewicht) > 1e-9).length;
  const belegt = raete.filter((r) => r.empfehlung !== 'zu_wenig_daten');
  const abschalten = raete.filter((r) => r.empfehlung === 'abschalten');

  let fazit: string;
  if (belegt.length === 0) {
    fazit = `Noch keine Klasse hat ${minTrades} Trades — es gibt nichts zu empfehlen.`;
  } else if (aenderungen === 0) {
    fazit = `${belegt.length} Klassen belegt, alle Gewichte passen bereits.`;
  } else {
    const zurueck = raete.filter((r) => r.empfehlung === 'zurueckholen');
    const teile: string[] = [];
    if (abschalten.length > 0) {
      teile.push(`${abschalten.length}× Abschalten (${abschalten.map((r) => r.klasse).join(', ')})`);
    }
    if (zurueck.length > 0) {
      teile.push(`${zurueck.length}× Rückkehr aus dem Schatten (${zurueck.map((r) => r.klasse).join(', ')})`);
    }
    fazit =
      `${aenderungen} Änderung${aenderungen === 1 ? '' : 'en'} vorgeschlagen` +
      (teile.length > 0 ? `, darunter ${teile.join(' und ')}.` : '.');
  }
  return { raete, aenderungen, fazit };
}

/**
 * Ein Schritt des Auto-Reglers.
 *
 * ── Warum er nicht einfach den Vorschlag übernimmt ────────────────────────
 *
 * Weil eine Messung eine Momentaufnahme ist. Springt das Gewicht bei jeder
 * Auswertung auf den vollen Vorschlag, schwingt es zwischen den Wochen hin
 * und her — und jedes Umschalten kostet Trades, die zur alten Einstellung
 * gehörten. Deshalb bewegt sich der Regler höchstens `schrittweite` weit auf
 * den Vorschlag zu. Aus einem Sprung wird eine Annäherung.
 *
 * Die einzige Ausnahme ist die 0: Wer strukturell verbrennt, wird sofort
 * abgeschaltet, nicht in Etappen. Der Schatten misst weiter, ein Rückweg
 * bleibt also offen — und ein Fehlalarm kostet nur entgangene Chancen,
 * während das Zögern echtes Geld kostet.
 */
export function reglerSchritt(rat: KlassenRat, schrittweite = 0.25): number {
  if (rat.empfehlung === 'zu_wenig_daten') return rat.gewicht;
  if (rat.empfehlung === 'abschalten') return 0;
  const diff = rat.vorschlag - rat.gewicht;
  if (Math.abs(diff) <= schrittweite) return r2(rat.vorschlag);
  return r2(klemmeGewicht(rat.gewicht + Math.sign(diff) * schrittweite));
}
