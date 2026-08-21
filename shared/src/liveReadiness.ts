/**
 * Live-Reife: Darf dieses System echtes Geld bewegen?
 *
 * Owner-Maxime 04.08.: „so lange testen mit paper wallet wie notwendig. bis
 * man sicher nur noch Gewinn schreibt, dann erst den Schalter umlegen, aber
 * trotzdem schon theoretisch startklar sein. jederzeit."
 *
 * Genau das steht hier in Code. Der Schalter existiert und ist jederzeit
 * bedienbar — aber er greift erst, wenn die Zahlen es hergeben. Eine Maxime,
 * die nur in einem Chatverlauf steht, überlebt keinen ungeduldigen Abend;
 * eine, die als Guard im Ausführungspfad sitzt, schon.
 *
 * ── Warum das ein GUARD ist und keine Empfehlung ──────────────────────────
 *
 * Man könnte die Zahlen anzeigen und den Menschen entscheiden lassen. Das
 * wäre schwächer, und zwar genau dann, wenn es darauf ankommt: Der Moment,
 * in dem jemand den Schalter gegen die Datenlage umlegen will, ist der
 * Moment, in dem er die Datenlage am wenigsten sehen will. Deshalb ist die
 * Reife eine harte Bedingung im selben Pfad wie die anderen Broker-Guards —
 * sie LOCKERT nichts, sie kommt oben drauf.
 *
 * ── Die Schwellen, und warum sie so stehen ────────────────────────────────
 *
 * Keine ist geraten; jede beantwortet eine konkrete Frage:
 *
 *   `minTrades`      Ab wann bedeutet eine Trefferquote überhaupt etwas?
 *                    Ursprünglich 200 — kalibriert im 5-Minuten-Zeitalter
 *                    (525 Trades in zwei Tagen; 200 waren eine Woche). Seit
 *                    dem Tages-Regime (Zeitrahmen daily, Mindesthalte 1 Tag,
 *                    Kostenschwelle) schüttet das System diese Währung
 *                    absichtlich nicht mehr aus: 200 Trades wären Monate bis
 *                    Jahre. Owner-Entscheidung 13.08. („innerhalb von ca.
 *                    zwei Wochen live, wenn alles gut funktioniert"): 40 —
 *                    bei gutem Lauf zwei Wochen Tages-Handel. Ein
 *                    Tages-Trade trägt statistisch mehr als ein
 *                    5-Minuten-Trade (größere Bewegung je Trade, weniger
 *                    Rauschen), und die Qualitäts-Hürden darunter bleiben
 *                    unverändert scharf — gelockert wurde NUR die Stückzahl,
 *                    nicht die Beweislast.
 *   `minProfitFactor` Nicht 1,0, sondern mit Puffer. Papierhandel unterschätzt
 *                    die Wirklichkeit systematisch: Teilausführungen, echte
 *                    Slippage in dünnen Büchern, verpasste Kurse zwischen
 *                    Signal und Order. Wer bei exakt 1,0 umschaltet, schaltet
 *                    live auf unter 1,0.
 *   `maxFeeShare`    Frisst die Reibung mehr als die Hälfte des Bruttoergeb-
 *                    nisses, ist das System zu handelsintensiv — dann trägt
 *                    es zwar rechnerisch, aber jede Verschlechterung der
 *                    Ausführung kippt es sofort.
 *   `minNetPnl`      Der Profitfaktor kann über 1 liegen, während unterm
 *                    Strich nichts hängen bleibt. Beides muss stimmen.
 *   `minTageStrecke` Gewinn über drei Tage ist Wetter, nicht Klima. Die
 *                    Messstrecke muss lang genug sein, um mehr als eine
 *                    Marktphase gesehen zu haben. 30 → 14 (Owner 13.08.,
 *                    dieselbe Entscheidung wie bei `minTrades`): zwei Wochen
 *                    ununterbrochen grüner Paper-Handel unter den scharfen
 *                    Filtern von heute. Ein Reset löscht die Strecke — wer
 *                    eine schlechte Strecke wegwirft, behält nicht deren
 *                    Reife.
 *
 * ── Was hier NICHT geprüft wird ───────────────────────────────────────────
 *
 * Ob die Broker-Verbindung steht und ob das Depot mit dem eigenen Buch
 * übereinstimmt — das macht `brokerStatus` gegen den echten Endpunkt. Diese
 * Datei ist pur und weiß nichts von Netzwerken.
 */

/** Kennzahlen, aus denen sich die Reife ergibt (Teilmenge von TradingHealth). */
export interface ReifeKennzahlen {
  /** Geschlossene Trades in der Messstrecke. */
  trades: number;
  /** Bruttogewinn ÷ Bruttoverlust; null ohne Verluste. */
  profitFactor: number | null;
  /** Anteil der Gebühren am Bruttoergebnis (0…1); null ohne Brutto. */
  feeShare: number | null;
  /** Nettoergebnis nach Gebühren; null, wenn zurückgehalten. */
  netPnl: number | null;
  /** Länge der ununterbrochenen Messstrecke in Tagen. */
  tageStrecke?: number | undefined;
}

export interface ReifeSchwellen {
  minTrades: number;
  minProfitFactor: number;
  maxFeeShare: number;
  minNetPnl: number;
  minTageStrecke: number;
}

/**
 * Voreinstellung. Bewusst streng: Der Fehler „zu früh scharf" kostet Geld,
 * der Fehler „zu spät scharf" kostet Zeit. Die beiden sind nicht gleich teuer.
 *
 * Rekalibriert am 13.08. auf ausdrückliche Owner-Ansage („bitte optimiere
 * die cashguards. es soll möglich sein innerhalb von ca. zwei Wochen live
 * oder mit echtgeld Handeln zu können, wenn es alles gut funktioniert"):
 * `minTrades` 200 → 40 und `minTageStrecke` 30 → 14 — die MENGEN-Hürden
 * passen jetzt zum bewusst entschleunigten Tages-Regime. Die drei
 * QUALITÄTS-Hürden (Profitfaktor, Gebührenanteil, Nettoergebnis) sind
 * unangetastet: „wenn es alles gut funktioniert" ist weiter die Bedingung,
 * nicht die Hoffnung. Zwei schlechte Wochen öffnen genauso wenig wie vorher.
 */
export const REIFE_SCHWELLEN: ReifeSchwellen = {
  minTrades: 40,
  minProfitFactor: 1.2,
  maxFeeShare: 0.5,
  minNetPnl: 0,
  minTageStrecke: 14,
};

/** Sprachneutrale Kennung je Kriterium (EN-Tranche 5, 21.08.).
 *
 *  `name` bleibt daneben stehen: Der deutsche Kurzname steht in
 *  gespeicherten Reife-Dokumenten und im Fazit-Satz; ihn nachträglich zu
 *  ändern wäre eine Migration ohne Not. Die Oberfläche übersetzt über den
 *  Code — und fällt auf `name` zurück, wo ein altes Dokument ihn nicht hat. */
export type ReifeCode =
  | 'stichprobe'
  | 'profitfaktor'
  | 'gebuehrenanteil'
  | 'nettoergebnis'
  | 'messstrecke';

export interface ReifeKriterium {
  /** Kurzname für die Oberfläche. */
  name: string;
  /** Sprachneutral — die Oberfläche übersetzt hierüber. */
  code?: ReifeCode;
  erfuellt: boolean;
  /** Was gemessen wurde — als Klartext, damit die Zahl sichtbar bleibt. */
  ist: string;
  /** Was nötig wäre. */
  soll: string;
}

export interface ReifeBefund {
  /** Darf echtes Geld fließen? */
  bereit: boolean;
  kriterien: ReifeKriterium[];
  /** Wie viele Kriterien stehen (für eine Fortschrittsanzeige). */
  erfuellt: number;
  gesamt: number;
  /** Offene Kriterien sprachneutral — die Oberfläche baut daraus ihren Satz.
   *  Optional, weil ältere gespeicherte Befunde ihn nicht tragen. */
  offeneCodes?: ReifeCode[];
  /** Ein Satz, der den Zustand zusammenfasst. */
  fazit: string;
}

const pf = (v: number | null): string => (v === null ? '—' : v.toFixed(2));
const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)} %`);
const geld = (v: number | null): string => (v === null ? '—' : `${v.toFixed(2)} $`);

/**
 * Reife-Prüfung.
 *
 * ALLE Kriterien werden ausgewertet, auch wenn das erste schon durchfällt:
 * Wer wissen will, wie weit er noch ist, braucht die vollständige Liste und
 * nicht das erste Hindernis.
 */
export function liveReife(
  k: ReifeKennzahlen,
  schwellen: ReifeSchwellen = REIFE_SCHWELLEN,
): ReifeBefund {
  const kriterien: ReifeKriterium[] = [
    {
      name: 'Stichprobe',
      code: 'stichprobe',
      erfuellt: k.trades >= schwellen.minTrades,
      ist: `${k.trades} Trades`,
      soll: `≥ ${schwellen.minTrades}`,
    },
    {
      name: 'Profitfaktor',
      code: 'profitfaktor',
      // null (keine Verluste) gilt NICHT als erfüllt: Ein Konto ohne einen
      // einzigen Verlusttrade hat entweder zu wenige Trades oder ein Problem
      // mit der Buchung. Beides ist kein Grund, echtes Geld freizugeben.
      erfuellt: k.profitFactor !== null && k.profitFactor >= schwellen.minProfitFactor,
      ist: pf(k.profitFactor),
      soll: `≥ ${schwellen.minProfitFactor.toFixed(2)}`,
    },
    {
      name: 'Gebührenanteil',
      code: 'gebuehrenanteil',
      erfuellt: k.feeShare !== null && k.feeShare <= schwellen.maxFeeShare,
      ist: pct(k.feeShare),
      soll: `≤ ${Math.round(schwellen.maxFeeShare * 100)} %`,
    },
    {
      name: 'Nettoergebnis',
      code: 'nettoergebnis',
      erfuellt: k.netPnl !== null && k.netPnl > schwellen.minNetPnl,
      ist: geld(k.netPnl),
      soll: `> ${schwellen.minNetPnl.toFixed(2)} $`,
    },
    {
      name: 'Messstrecke',
      code: 'messstrecke',
      erfuellt: (k.tageStrecke ?? 0) >= schwellen.minTageStrecke,
      ist: `${k.tageStrecke ?? 0} Tage`,
      soll: `≥ ${schwellen.minTageStrecke}`,
    },
  ];

  const erfuellt = kriterien.filter((x) => x.erfuellt).length;
  const bereit = erfuellt === kriterien.length;
  const offen = kriterien.filter((x) => !x.erfuellt).map((x) => x.name);

  return {
    bereit,
    kriterien,
    erfuellt,
    gesamt: kriterien.length,
    /* Die offenen Kriterien als CODES — damit die Oberfläche denselben Satz
     * in jeder Sprache bauen kann, ohne den gespeicherten deutschen `fazit`
     * zu zerlegen. */
    offeneCodes: kriterien.filter((x) => !x.erfuellt).map((x) => x.code!),
    fazit: bereit
      ? 'Alle Kriterien erfüllt — der Schalter greift, sobald beide Freigaben stehen.'
      : `Noch nicht bereit (${erfuellt}/${kriterien.length}): ${offen.join(', ')}.`,
  };
}

/**
 * Die Kante, die ein Trade im Mittel bringt — gegen das, was er kostet.
 *
 * Diese Zahl fehlte, und ihr Fehlen war der Grund, warum die Kostenschwelle
 * jahrelang nichts blockte: `costGate` prüft, ob sich ein Instrument genug
 * BEWEGT. Bewegung ist aber kein Gewinn — ein Random Walk mit 2 % Auslenkung
 * hat Erwartungswert null. Was zählt, ist der Anteil dieser Bewegung, den die
 * Signale tatsächlich einfangen.
 *
 * Am 04.08. gemessen: 514 Trades, brutto +1.455,82 $, Gebühren 3.049,01 $.
 * Das sind +0,143 % Bruttorendite je Trade gegen 0,3 % Roundtrip-Kosten —
 * jeder Trade verdient rund die Hälfte dessen, was er kostet. Das System
 * hat einen echten, positiven Vorteil; er ist nur zu klein für die Frequenz,
 * mit der er abgerufen wird.
 */
export interface KanteJeTrade {
  /** Bruttoergebnis je Trade in Prozent des eingesetzten Volumens. */
  bruttoPct: number | null;
  /** Roundtrip-Kosten je Trade in Prozent. */
  kostenPct: number | null;
  /** bruttoPct − kostenPct: die Zahl, die über Gewinn oder Verlust entscheidet. */
  nettoPct: number | null;
  /**
   * Wie oft die Kante die Kosten deckt. < 1 heißt: strukturell defizitär,
   * unabhängig von Glück oder Marktphase.
   */
  deckung: number | null;
}

/**
 * Kante je Trade aus den aggregierten Zahlen zurückrechnen.
 *
 * Das Volumen je Trade ist nicht direkt bekannt, lässt sich aber aus den
 * Gebühren ableiten: Gebühr = Volumen × Satz. Deshalb der Satz als Eingabe —
 * er steht seit dem 04.08. an jedem Trade (`feeRate`) und ist damit die
 * verlässlichste Brücke zwischen Betrag und Rendite.
 */
export function kanteJeTrade(
  trades: number,
  bruttoPnl: number,
  fees: number,
  roundtripSatz: number,
): KanteJeTrade {
  const leer: KanteJeTrade = { bruttoPct: null, kostenPct: null, nettoPct: null, deckung: null };
  if (!(trades > 0) || !(fees > 0) || !(roundtripSatz > 0)) return leer;

  const gebuehrJeTrade = fees / trades;
  const volumenJeTrade = gebuehrJeTrade / roundtripSatz;
  if (!(volumenJeTrade > 0)) return leer;

  const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;
  const bruttoPct = r4((bruttoPnl / trades / volumenJeTrade) * 100);
  const kostenPct = r4(roundtripSatz * 100);
  return {
    bruttoPct,
    kostenPct,
    nettoPct: r4(bruttoPct - kostenPct),
    deckung: kostenPct > 0 ? r4(bruttoPct / kostenPct) : null,
  };
}
