/**
 * autotrd — Margin und Hebel (Owner-Wunsch 28.07.).
 *
 * ── Was es VORHER gab: keinen Hebel ────────────────────────────────────────
 *
 * Der Kauf prüfte `kosten > balance → zu_wenig_cash`, war also strikt
 * bar gedeckt. Auch der Leerverkauf sah nur AUS wie Margin: Er reservierte
 * den vollen Gegenwert (`margin = qty × preis`) und war damit zu 100 %
 * besichert — im Kommentar stand es sogar so. Geliehen wurde nie etwas.
 *
 * ── Warum Hebel OHNE Liquidation eine Lüge wäre ────────────────────────────
 *
 * Die Kaufkraft zu verdoppeln ist eine Zeile Code. Genau deshalb ist es die
 * gefährlichste Art, dieses Feature zu bauen: Ein Simulator, der Hebel
 * gewährt, aber Positionen nie zwangsweise schließt, zeigt systematisch zu
 * gute Ergebnisse. Verluste dürfen dort beliebig tief laufen und sich wieder
 * erholen — in der Realität wäre das Konto längst glattgestellt worden.
 *
 * Wer daraus ablesen würde, dass Hebel „funktioniert", zöge exakt den
 * falschen Schluss. Deshalb gehören drei Dinge untrennbar zusammen, und
 * dieses Modul enthält alle drei:
 *
 *  1. **Kaufkraft** = Eigenkapital × Hebel − bereits investierter Wert
 *  2. **Nachschussgrenze**: Fällt das Eigenkapital unter einen Anteil des
 *     Positionswerts, wird zwangsweise geschlossen (Reg T: 25 %)
 *  3. **Margin-Zinsen** auf das geliehene Geld — Hebel ist nicht gratis
 *
 * Ohne (2) und (3) schmeichelt jede Auswertung dem Hebel; mit ihnen zeigt
 * sie, was er wirklich kostet.
 *
 * ── Was Hebel mathematisch tut ─────────────────────────────────────────────
 *
 * Er multipliziert BEIDE Richtungen. Bei 3× wird aus 10 % Kursgewinn 30 %
 * Kontogewinn — und aus 10 % Verlust 30 %. Das Konto ist bei 33 % Kursverlust
 * rechnerisch bei null; die Nachschussgrenze greift lange vorher. Diese
 * Symmetrie ist der ganze Punkt, und sie steht hier, weil sie in jeder
 * Werbung für Hebelprodukte fehlt.
 */

/** Reg-T-Erhaltungsmarge der US-Brokerage: 25 % des Positionswerts. */
export const DEFAULT_MAINTENANCE_MARGIN = 0.25;

/**
 * Jahreszins auf geliehenes Geld.
 *
 * 8 % ist die Größenordnung, die US-Broker Kleinanlegern für kleine Beträge
 * berechnen (Stand 2026: je nach Haus 5–12 %). Lieber etwas zu hoch als zu
 * niedrig — eine zu günstige Annahme schönt genau das, was hier ehrlich
 * gemessen werden soll.
 */
export const DEFAULT_MARGIN_RATE = 0.08;

/** Obergrenze der Risiko-Hülle. 1 = kein Hebel. */
export const MAX_LEVERAGE = 3;

export interface MarginState {
  /** Barbestand. NEGATIV bedeutet: geliehen. */
  cash: number;
  /** Marktwert aller offenen Positionen (Shorts negativ). */
  positionsValue: number;
  /** Eigenkapital = Cash + Positionswert. Das ist „was dir gehört". */
  equity: number;
  /** Geliehener Betrag = max(0, −Cash). */
  borrowed: number;
  /** Was noch gekauft werden darf, ohne den Hebel zu überschreiten. */
  buyingPower: number;
  /**
   * Eigenkapital ÷ Positionswert. `null` ohne Positionen (nicht Unendlich —
   * „unendlich sicher" ist keine Zahl, mit der eine Vergleichslogik rechnen
   * sollte).
   */
  marginLevel: number | null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Der vollständige Kontostand unter Hebel.
 *
 * `positionsValue` muss den Marktwert enthalten, nicht den Einstand: Die
 * Nachschussgrenze fragt, was die Position HEUTE wert ist. Mit dem Einstand
 * gerechnet würde ein Margin Call nie ausgelöst, weil sich der Nenner nicht
 * bewegt — der häufigste Fehler in selbstgebauten Margin-Simulationen.
 */
export function marginState(
  cash: number,
  positionsValue: number,
  leverage = 1,
  exposure?: number,
): MarginState {
  const hebel = Math.max(1, leverage);
  const equity = cash + positionsValue;
  // Der Betrag der Positionen zählt: Ein Short bindet genauso Sicherheit wie
  // ein Long. Mit dem vorzeichenbehafteten Wert würde ein Short die
  // Auslastung SENKEN, und ein perfekt gehedgtes Konto hätte unendliche
  // Kaufkraft — was es an keiner echten Börse hat.
  //
  // `exposure` trennt zwei Größen, die nur bei reinen Long-Depots dieselbe
  // Zahl sind: `positionsValue` ist der RÜCKFLUSS beim Schließen (so rechnet
  // dieses System die Equity — beim Short steckt die schon abgezogene
  // Sicherheitsleistung drin), `exposure` ist der am Markt bewegte Gegenwert.
  // Besichert werden muss der Gegenwert. Ohne diese Trennung wirkte ein
  // Short, dessen Margin bereits vom Cash abging, als hätte er kaum
  // Sicherheit gebunden.
  const belegt = typeof exposure === 'number' && Number.isFinite(exposure)
    ? Math.abs(exposure)
    : Math.abs(positionsValue);
  return {
    cash: r2(cash),
    positionsValue: r2(positionsValue),
    equity: r2(equity),
    borrowed: r2(Math.max(0, -cash)),
    buyingPower: r2(Math.max(0, equity * hebel - belegt)),
    marginLevel: belegt > 0 ? Math.round((equity / belegt) * 10_000) / 10_000 : null,
  };
}

/**
 * Muss zwangsweise geschlossen werden?
 *
 * True, sobald das Eigenkapital unter den geforderten Anteil des
 * Positionswerts fällt. Ohne Positionen niemals — ein Konto ohne Risiko
 * kann keinen Margin Call haben, auch wenn der Cash negativ ist.
 */
export function needsLiquidation(
  state: Pick<MarginState, 'marginLevel'>,
  maintenanceMargin = DEFAULT_MAINTENANCE_MARGIN,
): boolean {
  if (state.marginLevel === null) return false;
  return state.marginLevel < maintenanceMargin;
}

/**
 * Zinsen auf das geliehene Geld für `days` Tage.
 *
 * Taggenau (360-Tage-Basis wie im Bankwesen üblich), damit ein Halten über
 * Nacht spürbar wird und ein Intraday-Roundtrip praktisch nichts kostet —
 * genau das Verhalten, das die Wahl zwischen kurz und lang halten
 * beeinflussen soll.
 */
export function marginInterest(
  borrowed: number,
  days: number,
  annualRate = DEFAULT_MARGIN_RATE,
): number {
  if (!(borrowed > 0) || !(days > 0) || !(annualRate > 0)) return 0;
  return Math.round(borrowed * annualRate * (days / 360) * 100) / 100;
}

/**
 * Reicht die Kaufkraft für diese Order?
 *
 * Bewusst getrennt von `marginState`, weil hier die einzige Stelle ist, an
 * der ein Kauf abgelehnt wird — sie soll in Tests einzeln ansteuerbar sein.
 */
export function canAfford(state: Pick<MarginState, 'buyingPower'>, cost: number): boolean {
  return cost > 0 && cost <= state.buyingPower + 1e-9;
}

/**
 * Wie viel Stück bei gegebener Kaufkraft und Positionsgröße.
 *
 * ── Der Fehler, der hier zuerst drinstand ─────────────────────────────────
 *
 * Zuerst rechnete die Tranche vom EIGENKAPITAL — mit der Begründung, der
 * Hebel dürfe nicht doppelt wirken. Der Emulator-Lauf hat gezeigt, dass
 * damit gar nichts wirkt: Bei 10 % je Position und höchstens 10 Positionen
 * (den Voreinstellungen) kommt das Depot auf exakt 100 % des Eigenkapitals.
 * Die Kaufkraft von 300 % wurde nie auch nur angekratzt. Der Hebel wäre eine
 * Einstellung gewesen, die man umlegen kann und die nichts tut — schlimmer
 * als gar kein Hebel, weil sie funktionierend aussieht.
 *
 * ── Was stattdessen gilt ──────────────────────────────────────────────────
 *
 * `maxPositionPct` ist ein Anteil am DEPOT, und unter Hebel ist das Depot
 * größer. Die Tranche skaliert deshalb mit: `Eigenkapital × Hebel × Anteil`.
 * Bei 3×, 10 % und 10 Positionen ergibt das genau die 300 % Auslastung, die
 * der Hebel verspricht — nicht mehr.
 *
 * Doppelt wirkt er dabei nicht: Die Kaufkraft deckelt die Summe ALLER
 * Positionen weiterhin bei `Eigenkapital × Hebel`. Was mit dem Hebel
 * tatsächlich mitwächst, ist das Klumpenrisiko — bei 3× stecken hinter
 * „10 % je Position" 30 % des Eigenkapitals. Das ist die ehrliche Folge
 * eines Hebels und keine Nebenwirkung, die sich wegkonstruieren ließe.
 */
export function sizeWithMargin(
  state: Pick<MarginState, 'equity' | 'buyingPower'>,
  maxPositionPct: number,
  effPrice: number,
  fractional = false,
  leverage = 1,
): number {
  if (!(effPrice > 0) || !(maxPositionPct > 0)) return 0;
  const hebel = Math.min(Math.max(1, Number.isFinite(leverage) ? leverage : 1), MAX_LEVERAGE);
  const tranche = Math.min((state.equity * hebel * maxPositionPct) / 100, state.buyingPower);
  if (!(tranche > 0)) return 0;
  const roh = tranche / effPrice;
  return fractional ? Math.floor(roh * 1e6) / 1e6 : Math.floor(roh);
}

/** Eine Position, wie der Nachschuss-Wächter sie sieht. */
export interface MarginExposure {
  symbol: string;
  /** Rückfluss beim Schließen zum aktuellen Kurs — Beitrag zum Eigenkapital. */
  value: number;
  /**
   * Am Markt bewegter Gegenwert (Stück × Kurs, immer ≥ 0) — das, was
   * besichert werden muss. Fehlt er, gilt |value|; beim Long ist das
   * dasselbe, beim Short nicht (siehe `marginState`).
   */
  exposure?: number;
}

/**
 * Welche Positionen zwangsweise geschlossen werden müssen — und in welcher
 * Reihenfolge.
 *
 * Ohne diese Funktion wäre der Hebel eine Schönfärberei (siehe Modul-Kopf).
 * Sie ist die Stelle, an der ein zu tief gelaufenes Konto Realität wird.
 *
 * Warum das Schließen überhaupt hilft: Ein Verkauf zum Marktpreis lässt das
 * EIGENKAPITAL unverändert (Position raus, Cash rein) und senkt nur den
 * belegten Positionswert. Die Marge (Eigenkapital ÷ Positionswert) steigt
 * dadurch — deshalb genügt es, so lange zu schließen, bis die Grenze wieder
 * eingehalten ist, statt alles glattzustellen.
 *
 * Sortiert nach GRÖSSTER Position zuerst. Das ist die Reihenfolge, die mit
 * den wenigsten Zwangsverkäufen auskommt — jeder einzelne kostet Gebühren und
 * schließt eine Position, die sich vielleicht erholt hätte. Nach dem größten
 * Verlust zu sortieren wäre intuitiver, führte aber regelmäßig zu mehr
 * Verkäufen für dasselbe Ergebnis.
 */
export function liquidationPlan(
  positions: MarginExposure[],
  cash: number,
  maintenanceMargin = DEFAULT_MAINTENANCE_MARGIN,
): string[] {
  const gueltig = positions.filter((p) => p.symbol && Number.isFinite(p.value));
  const beleg = (p: MarginExposure): number =>
    typeof p.exposure === 'number' && Number.isFinite(p.exposure) ? Math.abs(p.exposure) : Math.abs(p.value);
  const equity = gueltig.reduce((s, p) => s + p.value, cash);
  let belegt = gueltig.reduce((s, p) => s + beleg(p), 0);
  if (!(belegt > 0) || !Number.isFinite(equity)) return [];
  if (equity / belegt >= maintenanceMargin) return [];

  const out: string[] = [];
  for (const p of [...gueltig].sort((a, b) => beleg(b) - beleg(a))) {
    out.push(p.symbol);
    belegt -= beleg(p);
    // Alles zu: mehr geht nicht, auch wenn die Grenze rechnerisch nicht
    // erreicht ist (Eigenkapital ≤ 0 — das Konto ist dann tatsächlich hin).
    if (!(belegt > 0)) break;
    if (equity / belegt >= maintenanceMargin) break;
  }
  return out;
}

/**
 * Zusätzliche Stimmen ÜBER der Einstiegsschwelle, die Hebel verlangt.
 *
 * Owner-Vorgabe 28.07.: „Margin-Trades dürfen nur ausgeführt werden, wenn
 * der Algorithmus sich sehr sicher ist." Genau das ist der Grund für diese
 * Konstante — und sie ist die wichtigste Sicherung des ganzen Moduls.
 */
export const MARGIN_CONFLUENCE_BONUS = 2;

/**
 * Absolute Untergrenze der Stimmenzahl für Hebel — unabhängig davon, wie
 * niedrig die Einstiegsschwelle steht.
 *
 * Der Bonus oben misst den ABSTAND zur Schwelle, und das allein hätte einen
 * Fehlanreiz: Wer die Einstiegsschwelle auf 1 stellt, bekäme den Hebel schon
 * mit 3 Stimmen — also mit einer LOCKEREREN Einstellung LEICHTER. Genau
 * verkehrt herum. Beide Bedingungen müssen erfüllt sein; die strengere
 * gewinnt.
 */
export const MARGIN_MIN_CONFLUENCE = 3;

/**
 * Der Hebel, der für DIESE eine Entscheidung tatsächlich gilt.
 *
 * Ein pauschaler Hebel wäre der Fehler: Er wirkt dann auch auf das
 * schwächste gerade noch zulässige Signal — also ausgerechnet dort, wo die
 * Trefferquote am niedrigsten ist. Hebel gehört auf Überzeugung, nicht auf
 * Gewohnheit.
 *
 * Die Überzeugung wird hier als ABSTAND zur Einstiegsschwelle gemessen, nicht
 * als absolute Stimmenzahl: Wer seine Schwelle auf 3 stellt, hat mit 3
 * Stimmen ein Grenzsignal — wer sie auf 1 stellt, hat mit 3 Stimmen ein
 * starkes. Dieselbe Zahl bedeutet je nach Einstellung etwas anderes.
 *
 * Dazu kommt eine absolute Untergrenze (`MARGIN_MIN_CONFLUENCE`), weil der
 * Abstand allein sich austricksen ließe: Eine niedrige Einstiegsschwelle
 * senkte sonst auch die Hebel-Schwelle — die lockerste Einstellung bekäme
 * den Hebel am leichtesten.
 *
 * Unterhalb der Schwelle wird nicht etwa weniger gehebelt, sondern GAR
 * nicht: Der Trade läuft dann bar gedeckt wie bisher. Ein halber Hebel auf
 * ein halbes Signal wäre ein Kompromiss, den niemand begründen könnte.
 */
export function effectiveLeverage(
  confluence: number,
  requiredConfluence: number,
  leverage: number,
  bonus = MARGIN_CONFLUENCE_BONUS,
): number {
  const hebel = Math.min(Math.max(1, leverage), MAX_LEVERAGE);
  if (hebel <= 1) return 1;
  if (!Number.isFinite(confluence) || !Number.isFinite(requiredConfluence)) return 1;
  const schwelle = Math.max(requiredConfluence + bonus, MARGIN_MIN_CONFLUENCE);
  return confluence >= schwelle ? hebel : 1;
}
