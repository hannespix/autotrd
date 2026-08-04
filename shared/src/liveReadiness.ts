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
 *   `minTrades`      Ab wann bedeutet eine Trefferquote überhaupt etwas? Bei
 *                    rund 20 % Trefferquote schwankt der Anteil über 50
 *                    Trades noch um mehr als die Hälfte seines Werts. 200 ist
 *                    die Grenze, ab der ein Profitfaktor kein Zufall mehr ist.
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
 *                    Marktphase gesehen zu haben.
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
 */
export const REIFE_SCHWELLEN: ReifeSchwellen = {
  minTrades: 200,
  minProfitFactor: 1.2,
  maxFeeShare: 0.5,
  minNetPnl: 0,
  minTageStrecke: 30,
};

export interface ReifeKriterium {
  /** Kurzname für die Oberfläche. */
  name: string;
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
      erfuellt: k.trades >= schwellen.minTrades,
      ist: `${k.trades} Trades`,
      soll: `≥ ${schwellen.minTrades}`,
    },
    {
      name: 'Profitfaktor',
      // null (keine Verluste) gilt NICHT als erfüllt: Ein Konto ohne einen
      // einzigen Verlusttrade hat entweder zu wenige Trades oder ein Problem
      // mit der Buchung. Beides ist kein Grund, echtes Geld freizugeben.
      erfuellt: k.profitFactor !== null && k.profitFactor >= schwellen.minProfitFactor,
      ist: pf(k.profitFactor),
      soll: `≥ ${schwellen.minProfitFactor.toFixed(2)}`,
    },
    {
      name: 'Gebührenanteil',
      erfuellt: k.feeShare !== null && k.feeShare <= schwellen.maxFeeShare,
      ist: pct(k.feeShare),
      soll: `≤ ${Math.round(schwellen.maxFeeShare * 100)} %`,
    },
    {
      name: 'Nettoergebnis',
      erfuellt: k.netPnl !== null && k.netPnl > schwellen.minNetPnl,
      ist: geld(k.netPnl),
      soll: `> ${schwellen.minNetPnl.toFixed(2)} $`,
    },
    {
      name: 'Messstrecke',
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
