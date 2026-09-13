/**
 * vigilant_allocation — Momentum über vier Horizonte, Rotation in den
 * Geldmarkt statt in die Kasse.
 *
 * ── Was hier NICHT drin ist (zuerst, damit es niemand überliest) ─────────
 *
 * Der Kanarienvogel von Keller & Keuning FEHLT. Sein Mechanismus („ist das
 * 13612W-Momentum von EEM oder LQD negativ, dann defensiv") verlangt, dass
 * eine Strategie FREMDE Zeitreihen liest. Der Vertrag in `core/types.ts`
 * gibt das nicht her: Eine Strategie sieht ihre eigenen Bars, eine
 * Benchmark und ihren Rang im Korb (`SymbolSnapshot`) — mehr nicht, und das
 * aus gutem Grund (§0.2: Querschnitt entsteht ausschließlich in `decide()`).
 * Was diese Datei baut, ist die im Vertrag mögliche Hälfte: dieselbe
 * Kennzahl, dieselbe Monatsentscheidung, dieselbe defensive Rotation — aber
 * ausgelöst vom eigenen Momentum jedes Papiers, nicht von einem Wächterkorb.
 * Der Unterschied ist die Frühzeitigkeit: Der Kanarienvogel dreht, BEVOR das
 * eigene Momentum der Risikopapiere kippt. Was dafür an `core/types.ts`,
 * `core/logic.ts` und beiden Aufrufern fehlt, steht in der Vorregistrierung
 * (`docs/wissen/vorregistrierung/2026-09-12-drei-sleeves.md`, Abschnitt
 * „Erweiterung des Vertrags"). Ohne diese Erweiterung ist der Name eine
 * Absichtserklärung, kein Zustand.
 *
 * ── Warum es die Familie trotzdem gibt (und sie keine sechste Variante ist)
 *
 * `regime_allocation` kann diesen Korb NICHT einfach mitmessen, und zwar aus
 * einem einzigen, nachrechenbaren Grund: Ihre Rangkennzahl ist
 * `mom / rvol` (D5, Volatilitätsnormierung gegen Momentum-Crashs). Ein
 * Geldmarkt-Papier hat eine realisierte Volatilität nahe null — BIL schwankt
 * um 0,1 % p. a. Für 1,5 % Jahresertrag ergibt das `0,015 / 0,001 = 15`,
 * während SPY in einem guten Jahr auf `0,20 / 0,15 = 1,3` kommt. Mit einem
 * Geldmarkt-Surrogat im Korb stünde bei `regime_allocation` also IMMER
 * Bargeld auf Rang 1 — auch im Bullenmarkt. Die Familie ist ohne diese
 * Normierung nicht denkbar (sonst gewinnt das volatilste Papier), und mit
 * ihr ist der Geldmarkt nicht denkbar. Deshalb eine eigene Familie mit der
 * Kennzahl der Literatur, die genau dieses Problem nicht hat.
 *
 * Der zweite Grund steht in `befunde.md` (Lauf #42): Alle fünf bisherigen
 * Familien sind long-only auf Aktien und verlieren im fallenden Markt
 * GLEICHZEITIG. `momentum_pullback` besteht acht von zehn Gates und fällt an
 * `fold_positive_share` (9 von 18 Quartalen positiv) und
 * `fold_concentration` — nicht an einer schwachen Regel, sondern daran, dass
 * Okt. 2021 bis Dez. 2022 für eine reine Aktien-Long-Wette kein positives
 * Quartal hergibt. Ein Fold OHNE Trades zählt dabei nicht als positiv
 * (Netto 0): Aussitzen hilft dem Gate nicht, im Geldmarkt liegen und den
 * Zins verdienen schon. Genau das ist die Aufgabe dieser Familie.
 *
 * ── Die Kennzahl: 13612W ────────────────────────────────────────────────
 *
 *   score = 12·r(21) + 4·r(63) + 2·r(126) + 1·r(252)
 *
 * — der gewichtete Mittelwert der Renditen über 1, 3, 6 und 12 Monate
 * (Keller & Keuning 2017/2018; Literatur D8). Die Gewichte sind FEST, keine
 * Suchachse: Sie stammen aus der Quelle, nicht aus unseren Daten. Zwei
 * Eigenschaften, auf die es ankommt:
 *
 *   1. Der Faktor 12 auf dem jüngsten Monat macht die Kennzahl SCHNELL —
 *      sie dreht Wochen vor einem 12-Monats-Momentum. Das ist der Ersatz für
 *      die Frühzeitigkeit, die ohne Kanarienvogel fehlt.
 *   2. Sie ist NICHT volatilitätsnormiert. Ein Geldmarkt-Papier bekommt
 *      genau den Rang, den sein Ertrag verdient — im Bullenmarkt den
 *      letzten, im Bärenmarkt den ersten. Anders als bei D7 wird der jüngste
 *      Monat hier also nicht ausgelassen, sondern am STÄRKSTEN gewichtet:
 *      Diese Familie sucht keine Momentum-Prämie über Monate, sie sucht den
 *      Ausstieg. Der Preis ist mehr Umschlag — den misst `fee_share`.
 *
 * ── Die Entscheidung ────────────────────────────────────────────────────
 *
 * Im Rebalance-Fenster (dieselben REBAL_TAGE Handelstage je Monat wie
 * `regime_allocation`, dieselbe Funktion — nicht nachgebaut):
 *
 *   RELATIV  Rang ≤ `topN` im Korb (Rangliste baut `decide()`, §0.2).
 *   ABSOLUT  eigenes 13612W > 0 — sonst nichts, auch nicht als Stärkster.
 *
 * Das ist Dual Momentum (D4) auf einem GEMISCHTEN Korb: Risikopapiere und
 * defensive Papiere rangieren gegeneinander. Fällt alles, stehen die
 * defensiven oben und sind zugleich die einzigen mit positivem Momentum —
 * die Rotation in Anleihen bzw. den Geldmarkt fällt aus der Rangliste heraus,
 * sie braucht keine Sonderregel.
 *
 * Der Korb gehört in die Config, nicht in den Code (`universe.symbols` der
 * Probe-Config). Was er enthalten MUSS, damit die Familie ihre Aufgabe
 * erfüllt: ein Geldmarkt-Surrogat (BIL, ersatzweise SHY). 2022 fielen
 * Aktien UND Anleihen — IEF, TLT, LQD und HYG verloren zweistellig, GLD lag
 * flach; das einzige Papier mit klar positivem Ertrag war das kurze Ende.
 * Ohne BIL/SHY im Korb ist diese Familie im Bärenmarkt in Kasse, und Kasse
 * verdient nichts (siehe oben, Gate `fold_positive_share`).
 *
 * Bereinigte Tagesbars sind für den Geldmarkt PFLICHT (`broker.adjustment:
 * all`): BIL schüttet monatlich aus, roh ist seine Kurve ein Sägezahn um
 * einen flachen Mittelwert — sein 13612W wäre dann etwa null statt positiv,
 * und die defensive Seite fiele still aus (Red-Team M7).
 *
 * Ausstieg im Fenster: eigenes Momentum negativ oder Rang schlechter als
 * `exitRank`. Dazwischen entscheidet die Familie nichts; es wacht allein der
 * weite Katastrophen-Stop beim Broker (T8/F1), der nie nachgezogen wird.
 * Kein Kursziel, kein Trailing, kein Short.
 *
 * ── Bekannte Grenzen ────────────────────────────────────────────────────
 *
 *   - Kein Kanarienvogel (oben).
 *   - Warmup 255 Bars (12 Monate + Reserve): Das IS-Fenster einer Probe muss
 *     größer sein als Warmup + 20 Embargo-Bars, sonst wirft der Walk-Forward
 *     (`optimizer.isDays` ≥ 500 in der Probe-Config; derselbe Befund, an dem
 *     die erste `regime_allocation`-Fassung scheiterte).
 *   - Im Alpha-Pfad bemisst die Stop-Distanz die Stückzahl: 20 % Stop heißt
 *     2,5 % der Equity je Position bei 0,5 % Risiko je Trade. Gemessen wird
 *     damit die REGEL (Sharpe, Folds, Kosten sind skalenfrei), nicht die
 *     Allokation. Wer die Allokation messen will, braucht `SizingSpec`
 *     (`allocation`) — die gibt es heute nur für die Basis-Stufe (K4).
 *   - Absolute Ränge (`topN`) statt Ranganteil: Bei einem festen, kleinen
 *     Korb ist die Zahl der Positionen das Ziel, nicht ein Anteil des Korbs.
 *     Fällt live ein Papier ohne Bar aus, meint „Rang ≤ 2" weiterhin „die
 *     zwei stärksten der Anwesenden" — das ist hier die robustere Lesart
 *     (der Vorbehalt in `core/types.ts` gilt einem 30-Aktien-Korb mit
 *     IEX-Lücken).
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { fmtPx, hold, indAt, nanArray } from './indicators.ts';
import { req, spec } from './params.ts';
import { REBAL_TAGE, rebalanceFenster } from './regimeAllocation.ts';

/**
 * Horizonte (Handelstage ≈ 1, 3, 6, 12 Monate) und Gewichte des 13612W.
 * FEST aus der Quelle — nie eine Suchachse, sonst ist es unsere Kennzahl und
 * nicht ihre.
 */
export const MOM_HORIZONTE: readonly number[] = [21, 63, 126, 252];
export const MOM_GEWICHTE: readonly number[] = [12, 4, 2, 1];

/**
 * Mindestzahl rangierter Papiere, damit „die zwei stärksten" eine Allokation
 * ist und kein Münzwurf über die Anwesenden. Der Korb dieser Familie ist
 * klein und fest (etwa neun ETFs), deshalb nicht `MIN_KORB` aus
 * `crossSectionalMomentum` (8) — der ist für 30 Aktien gedacht und würde
 * diese Familie schon bei zwei fehlenden Bars stilllegen.
 */
export const MIN_KORB_VIGILANT = 5;

const paramSpace: readonly ParamSpec[] = [
  spec('topN', 1, 4, 1, 'int', 'Einstieg, solange das Papier unter den topN stärksten des Korbs liegt'),
  spec('exitRank', 2, 6, 1, 'int', 'Ausstieg im Fenster, sobald es schlechter als dieser Rang ist (≥ topN — das Gitter kann das nicht erzwingen, die Vorregistrierung schon)'),
  spec('stopPct', 10, 25, 5, 'int', 'Katastrophen-Stop unter dem Einstand in % — beim Broker, nie nachgezogen'),
];

const defaults: Params = {
  topN: 2,
  exitRank: 4,
  stopPct: 20,
};

function warmupBars(_p: Params): number {
  // Der längste Horizont braucht close[i−252]; erster endlicher Wert an Index 252.
  return Math.max(...MOM_HORIZONTE) + 3;
}

/**
 * 13612W: gewichtete Summe der Renditen über die vier Horizonte. NaN, solange
 * einer der Horizonte nicht vollständig in der Vergangenheit liegt — in der
 * Aufwärmphase wird nicht geschätzt (§ Indikator-Konvention).
 */
export function momentum13612w(close: BarSeriesLike['c']): Float64Array {
  const out = nanArray(close.length);
  const maxH = Math.max(...MOM_HORIZONTE);
  for (let i = maxH; i < close.length; i++) {
    const jetzt = close[i]!;
    if (!Number.isFinite(jetzt) || jetzt <= 0) continue;
    let summe = 0;
    let ok = true;
    for (let k = 0; k < MOM_HORIZONTE.length; k++) {
      const davor = close[i - MOM_HORIZONTE[k]!]!;
      if (!Number.isFinite(davor) || davor <= 0) {
        ok = false;
        break;
      }
      summe += MOM_GEWICHTE[k]! * (jetzt / davor - 1);
    }
    if (ok) out[i] = summe;
  }
  return out;
}

function precompute(bars: BarSeriesLike, _p: Params): IndicatorSet {
  return {
    mom: momentum13612w(bars.c),
    rebal: rebalanceFenster(bars.t),
  };
}

/** Rangkennzahl: das 13612W selbst — roh, NICHT durch die Schwankung geteilt (siehe Kopf). Den Rang baut core/logic.ts. */
function crossScore(snap: SymbolSnapshot, ind: IndicatorSet, _p: Params): number | null {
  const mom = indAt(ind, 'mom', snap.i);
  return Number.isFinite(mom) ? mom : null;
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  // Außerhalb des Fensters entscheidet diese Familie NICHTS — weder Einstieg
  // noch Ausstieg. Der Katastrophen-Stop liegt beim Broker.
  if (indAt(ind, 'rebal', i) !== 1) return hold();

  const mom = indAt(ind, 'mom', i);
  const rang = snap.rank;
  const pos = snap.position;

  if (pos) {
    if (pos.side !== 'long') return hold();
    if (Number.isFinite(mom) && mom < 0) return { kind: 'exit', reason: `13612W negativ (${(mom * 100).toFixed(1)})` };
    // Ohne belastbaren Rang (zu kleiner Korb, veraltete Bar) kein Urteil über relative Stärke.
    if (rang && rang.of >= MIN_KORB_VIGILANT && rang.rank > req(p, 'exitRank')) {
      return { kind: 'exit', reason: `relative Stärke verloren: Rang ${rang.rank}/${rang.of}` };
    }
    return hold();
  }

  if (!rang || rang.of < MIN_KORB_VIGILANT || rang.rank > req(p, 'topN')) return hold();
  // Dual Momentum: Der relativ Stärkste eines fallenden Korbs ist nur der,
  // der am wenigsten fällt — das ist kein Kaufgrund.
  if (!Number.isFinite(mom) || !(mom > 0)) return hold();

  const stop = close * (1 - req(p, 'stopPct') / 100);
  return {
    kind: 'enter',
    side: 'long',
    stop,
    reason: `Rang ${rang.rank}/${rang.of}, 13612W ${(mom * 100).toFixed(1)}, Close ${fmtPx(close)}`,
  };
}

export const strategy: Strategy = {
  id: 'vigilant_allocation',
  // Nur Tagesbars: Ein Monatsrhythmus auf 5-Minuten-Bars wäre Unsinn (wie regime_allocation).
  timeframes: [1440],
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
  crossScore,
};

export { REBAL_TAGE };
