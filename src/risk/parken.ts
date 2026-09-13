/**
 * Geldmarkt-Parken — eine TREASURY-Funktion, keine Handelsidee.
 *
 * Kapital, das keine Strategie braucht, liegt nicht unverzinst auf dem
 * Konto, sondern in einem kurzlaufenden Staatspapier (Vorgabe-Kandidat BIL).
 * Sie erzeugt kein Signal, sie hat kein Kursziel, sie soll keine Kante haben
 * (Vorregistrierung `docs/wissen/vorregistrierung/2026-09-13-kasse-in-den-geldmarkt.md`).
 *
 * ── Der Befund, der das auslöst (Läufe #46/#47) ──────────────────────────
 *
 * Dieselbe Simulation, einziger Unterschied die Zinsrechnung: ΔSharpe ≈
 * −r_f/σ. Der Abzug trifft gering investierte Kandidaten achtmal härter als
 * den Markt, weil 85 bis 97 % ihres Kapitals unverzinst herumliegen, während
 * der Maßstab voll investiert ist (`regime_allocation` 0,75 ⇒ −1,06 bei
 * 2,60 % eigenem Drawdown). Der Defekt ist nicht die Messung, sondern totes
 * Kapital. Ein echter Allokator legt es in kurzlaufende Staatsanleihen.
 *
 * ── Die sechs Eigenschaften, jede mit einem Wächter ──────────────────────
 *
 *  1. **Blockiert nie einen Einstieg.** Will eine Strategie Kapital, wird
 *     zuerst Geldmarkt verkauft: `decide()` reicht das Bargeld INKLUSIVE des
 *     Parkwerts ins Sizing, und der Freikauf (`pflicht: true`) verkauft, was
 *     die Einstiege dieses Zyklus am Fill brauchen. Der Freikauf kennt weder
 *     Band noch Tagesgrenze — eine Treasury-Funktion, die einen Trade
 *     verhindert, wäre ein Fehler, kein Schutz.
 *  2. **Belegt keinen Positionsplatz und kein Exposure-Budget.** Die
 *     Parkposition zählt weder gegen `risk.maxPositions` noch ins
 *     Brutto-Exposure noch in die Exposure-Kennzahl der Equity-Kurve —
 *     sonst sperrte sich das Konto selbst aus (core/logic.ts,
 *     backtest/simulator.ts).
 *  3. **Kein Stop, kein Ziel, kein Trailing.** Ein Katastrophen-Stop auf
 *     einem Geldmarktpapier wäre sinnlos und im Crash schädlich; die
 *     Parkposition wird deshalb im Executor von `ensureProtectiveStops`
 *     ausgenommen (engine/orders.ts).
 *  4. **Läuft über `decide()`** — in Backtest und Live dieselbe Rechnung,
 *     dieselben Kosten, kein Sonderweg im Simulator.
 *  5. **Schichtet mit Band**: erst ab `bandPct` Prozentpunkten der Equity
 *     Abweichung von der Zielquote, höchstens einmal je Handelstag. Tägliches
 *     Umschichten wäre genau die Krankheit des Vorgängersystems („es wird zu
 *     Tode gehandelt", CLAUDE.md §2).
 *
 *     Folge der Vorgaben (Band 5 Pp > Puffer 2 %), ausgesprochen statt
 *     versteckt: Ein DISKRETIONÄRER Verkauf kann damit praktisch nicht
 *     entstehen — er verlangte ein Bargeld von unter −3 % der Equity, also
 *     einen Margin-Saldo. Verkauft wird faktisch nur, was ein Einstieg
 *     braucht (Freikauf) oder was der Rückzug auflöst. Gekauft wird, sobald
 *     mehr als 7 % der Equity (Puffer + Band) brachliegen. Wer häufiger
 *     umschichten will, setzt `bandPct` unter `bufferPct` — und misst neu.
 *  6. **Per Vorgabe AUS** (`risk.cashParking.enabled: false`). Ohne Config
 *     und ohne Parkposition passiert hier nichts — bitgleich wie vorher.
 *
 * ── Der wichtigste Fallstrick: Doppelführung ─────────────────────────────
 *
 * ENTSCHEIDUNG: **Ausschließlichkeit.** Das Parksymbol gehört der Treasury
 * allein. Führt eine Strategie dasselbe Symbol (z. B. BIL im Korb einer
 * defensiven Allokation), gäbe es zwei Positionen mit zwei Herkünften in
 * einem Symbol — zwei Besitzer einer Menge, zwei Exit-Regeln, und §0.6
 * (Idempotenz an der logischen Einheit) hätte keine Einheit mehr.
 *
 * Gesichert wird das auf drei Ebenen:
 *  - **Config**: `risk.cashParking.symbol` darf nicht im Handelsuniversum
 *    (`universe.symbols` ∪ `universe.candidates`) stehen — sonst Startfehler
 *    (core/config.ts). Das fängt den Regelfall, nicht den Wechsel über Nacht.
 *  - **Laufzeit (maßgeblich)**: Taucht das Parksymbol in einem Zyklus mit
 *    einer Strategie auf, parkt die Treasury NICHT und räumt ihre Position
 *    (Rückzug). Sie blockiert dabei nichts: Solange die Parkposition offen
 *    ist, könnte die Strategie ohnehin nicht einsteigen (offene Position),
 *    und der Rückzug macht das Feld sofort frei.
 *  - **Ausführung**: Der Executor erkennt Orders und Fills des Parksymbols am
 *    SYMBOL und bucht sie nie über den Trade-Pfad (engine/orders.ts).
 *
 * Umgekehrt gilt dasselbe: Liegt im Parksymbol eine Position, die NICHT der
 * Treasury gehört (`PositionState.strategy !== PARK_STRATEGY_ID`), fasst die
 * Treasury sie nicht an — sie kauft dann auch nicht dazu.
 *
 * ── Was ein Park-Fill NICHT ist: ein Trade ───────────────────────────────
 *
 * Kauf und Verkauf des Parkpapiers kosten Spread, Slippage und Gebühren wie
 * jede Order, und diese Kosten treffen die Equity-Kurve (und damit Rendite,
 * Sharpe und Drawdown) in voller Höhe. Sie erzeugen aber KEINEN `Trade`:
 * Trades sind die Grundlage von `oos_trades`, `feeShare`, Profitfaktor und
 * Trefferquote — also von Gates. Eine Treasury-Umschichtung dort mitzuzählen
 * würde Gates verschieben, und diese Änderung fasst kein Gate an (§0.9).
 *
 * ── Grenzen, benannt statt wegdefiniert ──────────────────────────────────
 *
 *  - **Bereinigung der Bars.** BIL schüttet monatlich aus; in ROHEN Bars
 *    (`broker.adjustment: 'raw'`, Vorgabe) trägt der Kurs den Zins NICHT —
 *    das Parken kostet dort Gebühren und bringt nichts. Gemessen werden darf
 *    es nur mit `broker.adjustment: 'all'`.
 *  - **Abrechnung.** Simulator wie Engine behandeln den Verkaufserlös als
 *    sofort verfügbar. Im Margin-Konto stimmt das; im reinen Cash-Konto
 *    gilt T+1, dort kann der Freikauf einen Einstieg um einen Tag verzögern.
 *  - **Kein risikoloser Punkt.** BIL hat Duration, Spread und einen Kurs,
 *    der springen kann. Das Parken kostet echtes Geld und trägt ein kleines
 *    Risiko; in einem Nullzinsumfeld bleibt nur die Gebühr.
 *  - **PDT.** Unter `risk.pdt.minEquity` wird NICHT gekauft (`kaufErlaubt`):
 *    Ein Kauf und der Freikauf desselben Tages wären ein Daytrade und nähmen
 *    einem echten Trade den Platz. Rest, benannt: Fällt die Equity NACH einem
 *    Kauf unter die Schwelle und braucht derselbe Tag einen Freikauf, entsteht
 *    dieser eine Daytrade doch. Er wird in Kauf genommen, weil die Alternative
 *    hieße, einen Einstieg zu blockieren — Eigenschaft 1 wiegt schwerer.
 *  - **Takt.** Geparkt wird im Zyklus von `decide()`, also wenn mindestens ein
 *    gehandeltes Symbol eine neue geschlossene Bar hat. An einem Tag ohne
 *    jede Bar des Universums schichtet die Treasury nicht um.
 */
/**
 * Was die Treasury in einem Zyklus tut. `pflicht` heißt: Dieser Verkauf
 * dient einem Einstieg und kennt weder Band noch Tagesgrenze.
 */
export interface ParkPlan {
  kind: 'none' | 'buy' | 'sell';
  qty: number;
  pflicht: boolean;
  grund: string;
}

/**
 * Strategie-Kennung der Parkposition. Sie ist absichtlich KEINE Strategie
 * aus `src/strategy/`: `decide()`, der Executor und der Simulator erkennen
 * an ihr, dass diese Position der Treasury gehört und nicht bewirtschaftet,
 * gestoppt, gezählt oder als Trade gebucht wird.
 */
export const PARK_STRATEGY_ID = 'cash_parking';

/** Stufe der Parkposition — nie `alpha`/`basis`: Sie trägt keine Latte einer Stufe (risk/limits.ts). */
export const PARK_STUFE = 'cash';

/**
 * Aufschlag auf den Freikauf (20 bp): Der Verkauf zahlt selbst Spread und
 * Gebühren, und die Stückzahl wird aufgerundet — lieber ein paar Dollar zu
 * viel in der Kasse als ein Einstieg, dem am Fill zwei Dollar fehlen.
 */
export const FREIKAUF_ZUSCHLAG = 0.002;

/** Sicherheitsmarge auf den Kaufpreis (20 bp), damit ein Kauf nie das Bargeld überzieht. */
export const KAUF_MARGE = 0.002;

/** Gehört diese Position der Treasury? (Nur sie darf sie anfassen.) */
export function istParkPosition(pos: { strategy: string } | null | undefined): boolean {
  return pos !== null && pos !== undefined && pos.strategy === PARK_STRATEGY_ID;
}

export interface ParkPlanInput {
  /** Kontowert (Basis für Puffer und Band). */
  equity: number;
  /** Freies Bargeld des Kontos. */
  cash: number;
  /** Kurs des Parksymbols (Close der Entscheidungs-Bar), > 0. */
  price: number;
  /** Gehaltene Stücke der Parkposition (≥ 0). */
  qty: number;
  /** Bargeld, das die in DIESEM Zyklus beschlossenen Einstiege am Fill brauchen (≥ 0). */
  reserviert: number;
  /** Band in Prozentpunkten der Equity (Vorgabe 5). */
  bandPct: number;
  /** Bargeld-Puffer in % der Equity, der ungeparkt bleibt (Vorgabe 2). */
  bufferPct: number;
  /** Stückelung (Aktien 1). */
  qtyStep: number;
  /**
   * Darf diskretionär umgeschichtet werden? false ⇒ nur der Freikauf läuft
   * (Halt, Daten nicht frisch, heute schon umgeschichtet, Park-Order offen).
   */
  umschichten: boolean;
  /**
   * Darf gekauft werden? false ⇒ nur Verkäufe (Einstiegssperre von außen,
   * PDT-Schwelle — ein Kauf heute könnte sonst mit dem Freikauf von heute
   * einen Daytrade ergeben und einem echten Trade den Platz nehmen).
   */
  kaufErlaubt: boolean;
}

/** Stückzahl auf die Stückelung ab-/aufrunden (Gleitkomma-Rauschen abgefangen). */
function abStufe(x: number, step: number): number {
  const s = step > 0 ? step : 1;
  return Number((Math.floor(x / s + 1e-9) * s).toFixed(8));
}

function aufStufe(x: number, step: number): number {
  const s = step > 0 ? step : 1;
  return Number((Math.ceil(x / s - 1e-9) * s).toFixed(8));
}

const nichts = (grund: string): ParkPlan => ({ kind: 'none', qty: 0, pflicht: false, grund });

/**
 * Was die Treasury in diesem Zyklus tut — reine Rechnung, für Backtest und
 * Live dieselbe (aufgerufen ausschließlich aus `decide()`).
 *
 * Reihenfolge (jede Stufe ist ein möglicher Ausgang mit Grund):
 *   1. Kurs oder Equity unbrauchbar ⇒ nichts. Geraten wird nicht.
 *   2. **Freikauf**: Reicht das Bargeld für die Einstiege dieses Zyklus
 *      nicht, wird so viel Geldmarkt verkauft, wie fehlt (aufgerundet, mit
 *      Zuschlag für die eigenen Kosten). Ohne Band, ohne Tagesgrenze,
 *      ohne Halt-Vorbehalt — Eigenschaft 1.
 *   3. Diskretionär nicht erlaubt ⇒ nichts.
 *   4. Zielwert = (freies Bargeld nach Reservierungen + Parkwert) − Puffer.
 *      Abweichung < Band ⇒ nichts (Eigenschaft 5).
 *   5. Sonst kaufen bzw. verkaufen, immer auf ganze Stücke, nie über das
 *      verfügbare Bargeld hinaus.
 */
export function planeParken(inp: ParkPlanInput): ParkPlan {
  const { price, qty, qtyStep } = inp;
  if (!(price > 0) || !Number.isFinite(price)) return nichts(`Kurs des Parksymbols unbrauchbar (${price})`);
  if (!(inp.equity > 0) || !Number.isFinite(inp.equity)) return nichts('Equity ≤ 0 — nichts zu parken');

  // 2. Freikauf: Was die Einstiege dieses Zyklus am Fill brauchen.
  const fehlt = inp.reserviert - inp.cash;
  if (fehlt > 0) {
    if (!(qty > 0)) return nichts('Freikauf nötig, aber nichts geparkt');
    const noetig = aufStufe((fehlt * (1 + FREIKAUF_ZUSCHLAG)) / price, qtyStep);
    const stueck = Math.min(qty, noetig);
    if (!(stueck > 0)) return nichts('Freikauf unter einer Stückelung');
    return {
      kind: 'sell',
      qty: stueck,
      pflicht: true,
      grund: `Freikauf für Einstiege: ${fehlt.toFixed(2)} $ fehlen in der Kasse`,
    };
  }

  // 3./4. Diskretionäre Umschichtung.
  if (!inp.umschichten) return nichts('Umschichten in diesem Zyklus nicht erlaubt');
  const parkWert = qty * price;
  const puffer = (inp.equity * inp.bufferPct) / 100;
  const frei = inp.cash - inp.reserviert;
  const ziel = Math.max(0, frei + parkWert - puffer);
  const abweichungPct = (Math.abs(ziel - parkWert) / inp.equity) * 100;
  if (abweichungPct < inp.bandPct) {
    return nichts(`Abweichung ${abweichungPct.toFixed(2)} Pp unter dem Band ${inp.bandPct} Pp — nicht umgeschichtet`);
  }

  if (ziel > parkWert) {
    if (!inp.kaufErlaubt) return nichts('Kauf in diesem Zyklus nicht erlaubt (Einstiegssperre/PDT)');
    // Nie mehr ausgeben als da ist: Der Kaufpreis trägt seine eigenen Kosten.
    const budget = Math.min(ziel - parkWert, Math.max(0, frei));
    const stueck = abStufe(budget / (price * (1 + KAUF_MARGE)), qtyStep);
    if (!(stueck > 0)) return nichts('Kaufmenge unter einer Stückelung');
    return {
      kind: 'buy',
      qty: stueck,
      pflicht: false,
      grund: `Kasse parken: Zielwert ${ziel.toFixed(2)} $ gegen ${parkWert.toFixed(2)} $ (Abweichung ${abweichungPct.toFixed(2)} Pp, Puffer ${inp.bufferPct} %)`,
    };
  }
  const stueck = Math.min(qty, aufStufe((parkWert - ziel) / price, qtyStep));
  if (!(stueck > 0)) return nichts('Verkaufsmenge unter einer Stückelung');
  return {
    kind: 'sell',
    qty: stueck,
    pflicht: false,
    grund: `Puffer auffüllen: Zielwert ${ziel.toFixed(2)} $ gegen ${parkWert.toFixed(2)} $ (Abweichung ${abweichungPct.toFixed(2)} Pp)`,
  };
}

/**
 * Rückzug: die ganze Parkposition auflösen. Gilt, wenn das Parken aus ist,
 * das Symbol gewechselt hat oder eine Strategie das Parksymbol führt —
 * immer `pflicht`, denn ein Rückzug ist ein Abbau und kein neues Engagement
 * (er läuft deshalb auch im Halt, wie jeder Exit, §0.4).
 */
export function planeRueckzug(qty: number, grund: string): ParkPlan {
  if (!(qty > 0)) return nichts(`Rückzug ohne Bestand (${grund})`);
  return { kind: 'sell', qty, pflicht: true, grund: `Rückzug: ${grund}` };
}
