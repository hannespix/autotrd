/**
 * turn_of_month — der Monatswechsel. Marktrendite in einem Fünftel der Tage.
 *
 * ── Der Mechanismus ─────────────────────────────────────────────────────
 *
 * Die Rendite des Aktienmarkts ist nicht gleichmäßig über die Handelstage
 * verteilt: Ein auffällig großer Teil fällt auf die letzten Tage eines
 * Monats und die ersten des nächsten. Ariel (1987) fand die positive
 * Rendite auf die erste Monatshälfte konzentriert, Lakonishok & Smidt (1988)
 * das Fenster von vier Tagen um den Monatswechsel über 90 Jahre Dow,
 * McConnell & Xu (2008) trugen im untersuchten Zeitraum praktisch die GANZE
 * Überrendite des Marktes in diesem Fenster zusammen (Literatur H1–H3).
 * Der plausible Grund ist keine Kursformation, sondern Geld: Löhne,
 * Sparpläne und Pensionsbeiträge treffen zum Monatsende ein und werden
 * mechanisch investiert.
 *
 * Deshalb ist diese Familie die ORTHOGONALSTE im Repo: Ihr Einstieg fragt
 * KEINEN Kurs. Er fragt den Kalender. Sie kann nicht mit Trendfolge
 * korrelieren, weil sie nicht weiß, ob ein Trend besteht; sie ist an rund
 * vier von einundzwanzig Handelstagen investiert und sonst in Kasse. Was
 * die fünf bestehenden Familien gemeinsam haben — sie fragen alle „steigt
 * das hier?" — hat sie nicht.
 *
 * ── Die Regel ───────────────────────────────────────────────────────────
 *
 * `entryOffset` = 1 und `exitTradingDay` = 3 heißt wörtlich:
 *
 *   Entscheide am SCHLUSS des Handelstags, auf den noch genau ein
 *   Handelstag des Monats folgt (also am vorletzten), und steige am Schluss
 *   des dritten Handelstags des neuen Monats wieder aus.
 *
 * Weil ein Fill in diesem System immer am OPEN der Folgebar liegt (nie am
 * Close der Entscheidungs-Bar — das ist ein Kurs, den es live nicht gibt),
 * hält die Position tatsächlich `open(letzter Handelstag)` bis
 * `open(vierter Handelstag des neuen Monats)`. Gemessen wird also das
 * klassische Fenster, um je einen halben Tag verschoben: Der Übernacht-Gap
 * in den letzten Handelstag hinein fehlt, der Gap in den vierten Tag kommt
 * dazu. Das ist keine Kleinigkeit — ein großer Teil der Aktienrendite fällt
 * über Nacht an (B3) —, aber es ist die Wahrheit über die Ausführung und
 * wird nicht schöngerechnet.
 *
 * Genau EIN Einstieg je Symbol und Monat. Wird der Einstiegstag blockiert
 * (Platz belegt, Order abgewiesen, Datenalter, Notbremse), fällt der Monat
 * aus — es gibt keinen Nachkauf. Der Preis dafür ist bewusst: Ein zweiter
 * Einstiegstag wäre nach einem ausgelösten Stop ein Wiedereinstieg in
 * dieselbe Bewegung.
 *
 * Kein Trendfilter. Die Quellen finden den Effekt ohne einen, und jeder
 * zusätzliche Filter ist eine Achse, die wir nicht vorregistriert haben
 * (T4: Ein Raster, das man nachträglich verschiebt, misst nichts). Was gegen
 * einen Crash im Fenster hilft, ist der weite Katastrophen-Stop beim Broker
 * (4 × ATR(14), nie nachgezogen, kein Ziel, kein Trailing, kein Short).
 *
 * ── Die Stelle, an der diese Familie falsch werden kann ─────────────────
 *
 * Der Kalender. „Handelstage bis Monatsende" ist NICHT „Kalendertage bis
 * Monatsende": Am 30. April und am 31. Mai wird nicht gehandelt, wenn diese
 * auf ein Wochenende fallen, Karfreitag ist geschlossen, der 4. Juli wird
 * vorgezogen oder nachgeholt. Zwei Fehler sind hier möglich, beide teuer:
 *
 *  1. **Kalendertage zählen** — dann kauft man an Feiertagen, und der
 *     Einstieg verschiebt sich um bis zu vier Tage.
 *  2. **Bars zählen** — das wäre LOOKAHEAD. „Noch ein Handelstag bis
 *     Monatsende" aus der Bar-Serie zu lesen heißt, in die Zukunft zu
 *     schauen: Ob nach der aktuellen Bar noch eine im Monat kommt, steht
 *     erst in der Zukunft. Die Zahl kommt deshalb aus dem NYSE-Kalender
 *     (`core/time.ts`, `isTradingDay`) — einer Funktion von Datum und
 *     Feiertagsregel, nicht von Kursen. Der Präfix-Test in
 *     `test/strategy/turnOfMonth.test.ts` bricht jede Bar-Zählung.
 *
 * Der Kalender ist der algorithmische NYSE-Fallback, nicht der Broker-
 * Kalender: Der Strategie-Vertrag übergibt `precompute` nur Bars. Eine
 * unvorhergesehene Schließung (Staatstrauer, Wetter) verschiebt das Fenster
 * dieser Familie also um einen Tag — benannt, nicht behoben; die
 * Alternative wäre eine Vertragserweiterung (Kalender in `precompute`).
 * Frühschluss-Tage (Tag nach Thanksgiving, 24. Dezember) sind Handelstage
 * und zählen mit — richtig so, sie tragen Rendite.
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { dayKey, isTradingDay, pad2, parseDay } from '../core/time.ts';
import { atr, atrBracket, enterDecision, fmtPx, hold, indAt } from './indicators.ts';
import { req, spec } from './params.ts';

const ATR_LEN = 14;
/** Kein Kursziel: Der Ausstieg ist der Kalender, nicht ein Limit. */
const RR_MULT = 0;

const paramSpace: readonly ParamSpec[] = [
  spec('entryOffset', 0, 3, 1, 'int', 'Einstiegs-Entscheidung am Schluss des Tages, auf den noch so viele Handelstage des Monats folgen (1 = vorletzter)'),
  spec('exitTradingDay', 1, 5, 1, 'int', 'Ausstiegs-Entscheidung am Schluss des n-ten Handelstags des neuen Monats'),
  spec('atrMult', 2, 6, 0.5, 'float', 'Weiter Katastrophen-Stop in ATR(14), nie nachgezogen'),
  spec('maxHoldBars', 5, 15, 1, 'int', 'Zeitstopp als Sicherheitsnetz, falls das Fenster-Ende nie erreicht wird (Datenlücke über einen Monatswechsel)'),
];

const defaults: Params = {
  entryOffset: 1,
  exitTradingDay: 3,
  atrMult: 4,
  maxHoldBars: 8,
};

/* ───────────────────────── Kalender (keine Kurse) ───────────────────────── */

const monatsCache = new Map<string, string[]>();

/**
 * Alle NYSE-Handelstage eines ET-Kalendermonats („YYYY-MM"), aufsteigend.
 * Reine Funktion von Jahr, Monat und Feiertagsregel — sie sieht keine Bars
 * und kann deshalb keine Zukunft aus Kursen beziehen.
 */
export function monatsHandelstage(ym: string): string[] {
  const hit = monatsCache.get(ym);
  if (hit) return hit;
  const { y, m } = parseDay(`${ym}-01`);
  const letzter = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= letzter; d++) {
    const tag = `${y}-${pad2(m)}-${pad2(d)}`;
    if (isTradingDay(tag, 'us_equity')) out.push(tag);
  }
  // Deckel wie in core/time.ts: Der Cache ist winzig (12 Einträge je Jahr),
  // aber er darf in einem Dauerläufer nicht unbegrenzt wachsen.
  if (monatsCache.size > 10_000) monatsCache.clear();
  monatsCache.set(ym, out);
  return out;
}

export interface FensterLage {
  /** Handelstage des Monats VOR diesem Tag (0 = erster Handelstag des Monats). */
  davor: number;
  /** Handelstage des Monats NACH diesem Tag (0 = letzter Handelstag des Monats). */
  danach: number;
}

/**
 * Lage eines ET-Tags im Handelstag-Kalender seines Monats. Gezählt wird mit
 * Vergleichen, nicht über einen Index: Ist der Tag selbst laut Fallback kein
 * Handelstag (unvorhergesehene Schließung, Regeländerung), bleibt die Lage
 * trotzdem wohldefiniert, statt −1 zu liefern und still falsch zu werden.
 */
export function fensterLage(day: string): FensterLage {
  const tage = monatsHandelstage(day.slice(0, 7));
  let davor = 0;
  let danach = 0;
  for (const t of tage) {
    if (t < day) davor++;
    else if (t > day) danach++;
  }
  return { davor, danach };
}

/**
 * Zwei kausale Flaggen je Bar:
 *   `enter`     1 genau am Einstiegstag (noch `entryOffset` Handelstage im Monat).
 *   `imFenster` 1, solange gehalten werden soll: am Einstiegstag und danach
 *               bis zum Schluss des `exitTradingDay`-ten Handelstags des
 *               neuen Monats. 0 ⇒ die führende Position wird geschlossen.
 */
function fensterFlaggen(t: BarSeriesLike['t'], entryOffset: number, exitTradingDay: number): { enter: Float64Array; imFenster: Float64Array } {
  const enter = new Float64Array(t.length);
  const imFenster = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    const lage = fensterLage(dayKey(t[i]!));
    if (lage.danach === entryOffset) enter[i] = 1;
    // Schwanz des alten Monats ab dem Einstiegstag ODER Kopf des neuen
    // Monats bis einschließlich des Tages VOR dem Ausstiegstag. Der
    // Ausstiegstag selbst liegt außerhalb: Dort fällt die Entscheidung, der
    // Fill kommt am Open danach.
    if (lage.danach <= entryOffset || lage.davor <= exitTradingDay - 2) imFenster[i] = 1;
  }
  return { enter, imFenster };
}

function warmupBars(_p: Params): number {
  return ATR_LEN + 2;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  const { enter, imFenster } = fensterFlaggen(bars.t, req(p, 'entryOffset'), req(p, 'exitTradingDay'));
  return {
    enter,
    imFenster,
    atr: atr(bars.h, bars.l, bars.c, ATR_LEN),
  };
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const pos = snap.position;

  if (pos) {
    if (pos.side !== 'long') return hold();
    if (indAt(ind, 'imFenster', i) !== 1) {
      return { kind: 'exit', reason: `Monatswechsel-Fenster beendet (Tag ${fensterLage(dayKey(snap.bars.t[i]!)).davor + 1} des Monats)` };
    }
    const maxHold = req(p, 'maxHoldBars');
    if (pos.barsHeld >= maxHold) return { kind: 'exit', reason: `Zeitstopp (Sicherheitsnetz): ${pos.barsHeld} Bars ≥ ${maxHold}` };
    // Kein Trailing, kein Ziel: Der Ausstieg ist der Kalender.
    return hold();
  }

  if (indAt(ind, 'enter', i) !== 1) return hold();
  const br = atrBracket(close, indAt(ind, 'atr', i), req(p, 'atrMult'), RR_MULT, 'long');
  if (!br) return hold();
  const offset = req(p, 'entryOffset');
  return enterDecision('long', br, `Monatswechsel: noch ${offset} Handelstag${offset === 1 ? '' : 'e'} im Monat, Close ${fmtPx(close)}`);
}

export const strategy: Strategy = {
  id: 'turn_of_month',
  // Tagesbars: Das Fenster ist in Handelstagen definiert.
  timeframes: [1440],
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
};
