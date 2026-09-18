/**
 * time_series_momentum — Zeitreihen-Momentum je Symbol, mit Totband am Ausstieg.
 *
 * ── Warum es diese Familie gibt (Owner-Entscheidung 18.09.2026) ──────────
 *
 * Alle gemessenen Familien holen sich Bewegungen von 1,5–2,5 % über zwei bis
 * drei Handelstage (docs/wissen/analysen/2026-09-15-…, MFE-Median 2,43 %).
 * Bei den Kosten dieses Kontos ist das strukturell zu klein: `fee_share`
 * sinkt NICHT durch selteneres Handeln (Zähler und Nenner skalieren mit der
 * Trade-Zahl), sondern nur durch einen größeren Bruttogewinn JE TRADE — also
 * durch eine größere mitgenommene Bewegung. Die naheliegenden Hebel
 * (Exit-Regel, Ziel, Stop, Trailing) stehen in JEDEM der fünf Gitter und sind
 * mit je 2 850 Trials durchsucht. Ein echter Hebel muss außerhalb liegen.
 *
 * Diese Familie liegt außerhalb, und zwar an drei Stellen zugleich:
 *
 *   1. HORIZONT: Momentum über 3–6 Monate (63–126 Bars), jüngster Monat
 *      ausgelassen (D7). `cross_sectional_momentum` endet bei 120, die
 *      Signalfamilien bei 60-Bar-Kanälen.
 *   2. KEIN RANG: rein symbolweise — die eigene Vergangenheit sagt die eigene
 *      Zukunft (D2, Moskowitz/Ooi/Pedersen 2012, Vertrauen hoch). Damit
 *      kein MIN_KORB, keine Abhängigkeit vom Korb des Nutzers.
 *   3. AUSSTIEG ÜBER DAS VORZEICHEN mit Totband: raus erst, wenn das
 *      Momentum unter −exitBandPct fällt. Kein ATR-Trailing, kein Kanaltief,
 *      kein Monatsfenster, kein Kursziel. Genau das lässt eine Bewegung
 *      laufen, die die anderen Familien nach drei Tagen abschneiden.
 *
 * Täglich bewertet, nicht im Monatsfenster: `regime_allocation` verpasst
 * einen Ausstieg bis zu einen Monat lang; hier wacht das Vorzeichen jeden
 * Tag, das Totband hält Rauschen fern.
 *
 * ── Was sie NICHT tut ────────────────────────────────────────────────────
 *
 *   - Kein Short (§5a: widerlegt), kein Ziel, kein Trailing. Der Stop ist
 *     ein weiter KATASTROPHEN-Stop beim Broker (§0.4), nie nachgezogen; über
 *     ihn bemisst das Risiko-Budget die Stückzahl (core/logic.ts) — ein
 *     weiter Stop heißt eine kleine Position, wie bei jeder Vorlage.
 *   - Das Regime (Close > SMA) ist nur EINSTIEGS-Bedingung: Es verhindert,
 *     in einen Abwärtstrend zu kaufen, dessen Sechsmonats-Rendite noch
 *     positiv ist (Ende 2021). Als Ausstieg würde es den Umschlag
 *     verdoppeln — der Ausstieg gehört dem Vorzeichen allein.
 *   - Nur Tagesbars.
 *
 * ── Bekannte Grenze, nicht wegdefiniert ──────────────────────────────────
 *
 * Ein echtes ZWÖLF-Monats-Momentum (D2) ist mit der Plattform-Geometrie
 * nicht messbar: Das Embargo ist Warmup + 20 Bars und wird vom Ende des
 * IS-Fensters (~252 Bars) abgeschnitten (walkForward.ts, `embargoBarsFor`).
 * Warmup 275 verschluckte das ganze Fenster — genau der Fehler, an dem die
 * erste Fassung von `regime_allocation` scheiterte. Die Decke liegt bei
 * 152 Bars (regimeLen 150 + 2; das Momentum selbst braucht 126 + 21 + 2 =
 * 149) und lässt ~80 Entscheidungs-Bars je IS-Fenster. Die Vorregistrierung
 * nennt das ausdrücklich.
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot, TimeframeMin } from '../core/types.ts';
import { bracketFromStop, enterDecision, fmtPx, hold, indAt, sma } from './indicators.ts';
import { req, spec } from './params.ts';
import { momentum } from './regimeAllocation.ts';

const paramSpace: readonly ParamSpec[] = [
  spec('lookback', 63, 126, 21, 'int', 'Bars des Momentum-Fensters (drei bis sechs Monate); darüber verschluckt das Embargo das IS-Fenster'),
  spec('skip', 0, 21, 21, 'int', 'Jüngste n Bars auslassen (der letzte Monat kehrt eher um, D7)'),
  spec('regimeLen', 50, 150, 50, 'int', 'Einstieg nur über der SMA dieser Länge — nie ein Ausstiegsgrund'),
  spec('exitBandPct', 0, 5, 2.5, 'float', 'Totband: Ausstieg erst, wenn das Momentum unter −x % fällt (0 = beim Vorzeichenwechsel)'),
  spec('stopPct', 10, 30, 5, 'int', 'Katastrophen-Stop unter dem Einstand in % — beim Broker, nie nachgezogen'),
];

const defaults: Params = {
  lookback: 126,
  skip: 21,
  regimeLen: 100,
  exitBandPct: 2.5,
  stopPct: 20,
};

function warmupBars(p: Params): number {
  return Math.max(req(p, 'lookback') + req(p, 'skip'), req(p, 'regimeLen')) + 2;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  return {
    mom: momentum(bars.c, req(p, 'lookback'), req(p, 'skip')),
    regime: sma(bars.c, req(p, 'regimeLen')),
  };
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const mom = indAt(ind, 'mom', i);
  const regime = indAt(ind, 'regime', i);
  const pos = snap.position;
  const lookback = req(p, 'lookback');

  if (pos) {
    // Nur das Vorzeichen mit Totband entscheidet. Kein Trailing, kein
    // Regime-Exit, kein Zeitstopp — und NaN (Aufwärmphase) heißt halten.
    const band = req(p, 'exitBandPct') / 100;
    if (pos.side === 'long' && mom < -band) {
      return { kind: 'exit', reason: `Momentum ${(mom * 100).toFixed(1)} % über ${lookback} Bars unter −${req(p, 'exitBandPct')} %` };
    }
    return hold();
  }

  // Einstieg: eigenes Momentum positiv UND Regime aufwärts. NaN in der
  // Aufwärmphase macht jeden Vergleich false — genau so gewollt.
  if (mom > 0 && close > regime) {
    const stopPct = req(p, 'stopPct');
    const br = bracketFromStop(close, close * (1 - stopPct / 100), 0, 'long');
    if (br) {
      return enterDecision(
        'long',
        br,
        `Zeitreihen-Momentum +${(mom * 100).toFixed(1)} % über ${lookback} Bars, Close ${fmtPx(close)} > SMA${req(p, 'regimeLen')} ${fmtPx(regime)}; Katastrophen-Stop ${stopPct} %`,
      );
    }
  }
  return hold();
}

/** Nur Tagesbars: Ein Monatshorizont auf Minutenbars wäre Unsinn. */
const TAGESBARS: readonly TimeframeMin[] = [1440];

export const strategy: Strategy = {
  id: 'time_series_momentum',
  timeframes: TAGESBARS,
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
};
