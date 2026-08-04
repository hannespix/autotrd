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

/** Was eine Anlageklasse gemessen hat — Teilmenge von `AttributionSlice`. */
export interface KlassenErgebnis {
  n: number;
  /** Nettorendite je gehandeltem Dollar in Prozent (nach Gebühren). */
  kantePct: number | null;
}

/** Regler-Grenzen. Identisch zum Überzeugungs-Sizing, damit beide zusammen gedeckelt bleiben. */
export const GEWICHT_MIN = 0;
export const GEWICHT_MAX = 1.5;

/** Ab so vielen Trades gilt eine Klassen-Kante als belegt. */
export const KLASSE_MIN_TRADES = 30;

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

export type Empfehlung = 'verstaerken' | 'behalten' | 'drosseln' | 'abschalten' | 'zu_wenig_daten';

export interface KlassenRat {
  klasse: string;
  n: number;
  kantePct: number | null;
  /** Aktuelles Gewicht (aus der Strategie). */
  gewicht: number;
  empfehlung: Empfehlung;
  /** Gewicht, das die Messung nahelegt. */
  vorschlag: number;
  /** Klartext — landet in der Oberfläche und im Journal. */
  grund: string;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Gewicht auf den erlaubten Bereich begrenzen. */
export function klemmeGewicht(w: number | undefined): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return 1;
  return Math.min(GEWICHT_MAX, Math.max(GEWICHT_MIN, w));
}

/**
 * Empfehlung für eine einzelne Klasse.
 *
 * Die Reihenfolge der Prüfungen ist Absicht — erst Datenmenge, dann
 * Richtung, dann Größe. Genau wie bei `judgeCandidate`: Wer nur das Ergebnis
 * liest, soll trotzdem verstehen, WARUM es so ausfällt.
 */
export function rateKlasse(
  klasse: string,
  ergebnis: KlassenErgebnis,
  gewicht: number,
  minTrades = KLASSE_MIN_TRADES,
): KlassenRat {
  const w = klemmeGewicht(gewicht);
  const basis = { klasse, n: ergebnis.n, kantePct: ergebnis.kantePct, gewicht: w };

  if (ergebnis.kantePct === null || ergebnis.n < minTrades) {
    return {
      ...basis,
      empfehlung: 'zu_wenig_daten',
      // Unverändert lassen, NICHT auf einen Standardwert ziehen: Eine Klasse
      // ohne Beleg soll weder belohnt noch bestraft werden.
      vorschlag: w,
      grund:
        `${ergebnis.n} Trades — für eine Aussage sind ${minTrades} nötig. ` +
        'Gewicht bleibt, wie es ist.',
    };
  }

  const k = ergebnis.kantePct;
  if (k >= KANTE_GUT) {
    return {
      ...basis,
      empfehlung: 'verstaerken',
      vorschlag: r2(Math.min(GEWICHT_MAX, Math.max(w, 1) * 1.25)),
      grund: `Verdient ${k.toFixed(3)} % je gehandeltem Dollar — trägt ihre Reibung klar.`,
    };
  }
  if (k > KANTE_SCHLECHT) {
    return {
      ...basis,
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
      ...basis,
      empfehlung: 'drosseln',
      vorschlag: r2(Math.max(0.25, w * 0.5)),
      grund: `Verliert ${Math.abs(k).toFixed(3)} % je Dollar — halbes Gewicht, weiter beobachten.`,
    };
  }
  return {
    ...basis,
    empfehlung: 'abschalten',
    vorschlag: 0,
    grund:
      `Verliert ${Math.abs(k).toFixed(3)} % je gehandeltem Dollar über ${ergebnis.n} Trades. ` +
      'Das ist keine Marktphase, das ist die Struktur. Der Schatten läuft weiter.',
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
): KlassenBericht {
  const raete = Object.entries(ergebnisse)
    .map(([klasse, e]) => rateKlasse(klasse, e, gewichte[klasse] ?? 1, minTrades))
    .sort((a, b) => (b.kantePct ?? -Infinity) - (a.kantePct ?? -Infinity));

  const aenderungen = raete.filter((r) => Math.abs(r.vorschlag - r.gewicht) > 1e-9).length;
  const belegt = raete.filter((r) => r.empfehlung !== 'zu_wenig_daten');
  const abschalten = raete.filter((r) => r.empfehlung === 'abschalten');

  let fazit: string;
  if (belegt.length === 0) {
    fazit = `Noch keine Klasse hat ${minTrades} Trades — es gibt nichts zu empfehlen.`;
  } else if (aenderungen === 0) {
    fazit = `${belegt.length} Klassen belegt, alle Gewichte passen bereits.`;
  } else {
    fazit =
      `${aenderungen} Änderung${aenderungen === 1 ? '' : 'en'} vorgeschlagen` +
      (abschalten.length > 0
        ? `, darunter ${abschalten.length}× Abschalten (${abschalten.map((r) => r.klasse).join(', ')}).`
        : '.');
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
