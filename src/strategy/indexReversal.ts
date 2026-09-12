/**
 * index_reversal — kurzfristige Umkehr, aber nur auf breiten Index-ETFs.
 *
 * ── Warum überhaupt noch eine Umkehr-Familie ────────────────────────────
 *
 * `mean_reversion` gibt es schon, und ihr Messstand ist mager (ein Treffer,
 * der einer Rasterverschiebung um sechs Tage nicht standhält, T4/§5a.15).
 * Diese Familie ist NICHT dieselbe Regel mit anderen Zahlen, sondern die
 * Antwort auf die Frage, warum die alte scheitert. Drei Unterschiede, jeder
 * mit einem Grund:
 *
 *  1. **Der Gegenstand.** Sie ist für BREITE INDEX-ETFs gebaut (SPY, QQQ,
 *     IWM, DIA), nicht für Einzelaktien. Ein Index hat keine eigenen
 *     Nachrichten: Ein Rücksetzer ist dort Liquiditätsnachfrage, bei einer
 *     Einzelaktie oft eine Gewinnwarnung — und in die greift man mit einer
 *     Umkehr-Regel hinein. Das Universum steht in der Config, nicht im Code;
 *     der Kopf sagt trotzdem, wofür die Regel gemessen wurde, denn auf 30
 *     Einzelwerten misst man etwas anderes (T10).
 *  2. **Der Ausstieg.** `mean_reversion` steigt bei `Close > SMA(20)` aus —
 *     der Rückkehr zum Mittel. Nach einem scharfen Rücksetzer liegt dieses
 *     Mittel weit oben; die Position wartet. Hier ist der Ausstieg die
 *     ERSTE Stärke: Schluss über dem Vortageshoch. Das verkürzt die
 *     Haltedauer auf Tage, erhöht die Aktivität und nimmt den Teil der
 *     Bewegung mit, der statistisch belegt ist (E1: die Umkehr ist kurz;
 *     wer länger hält, handelt wieder Trend).
 *  3. **Der Querschnitt.** Sie liefert `crossScore` = −RSI: Wenn vier
 *     Indizes am selben Tag zurücksetzen und nur zwei Plätze frei sind,
 *     bekommt der TIEFSTE Rücksetzer den Platz, nicht der, den die Rotation
 *     zuerst aufruft. Die Rangliste baut ausschließlich `decide()` (§0.2);
 *     diese Datei liest den Rang nicht einmal. Nebenwirkung, benannt: Sobald
 *     eine Strategie im Zyklus `crossScore` hat, sortiert `core/logic.ts`
 *     rangierte Symbole VOR unrangierte. In einem gemischten Zyklus
 *     (Champion auf anderen Symbolen) bekämen die Symbole dieser Familie
 *     also die knappen Plätze zuerst. Gemessen wird sie allein auf ihrem
 *     Korb; wer sie mischt, muss das wissen.
 *
 * ── Die Regel ───────────────────────────────────────────────────────────
 *
 * Einstieg long, wenn beides gilt:
 *   - `Close > SMA(trendLen)` — der Trendfilter. Er ist der Grund, warum die
 *     Sache überlebt: Rücksetzer im Aufwärtstrend kaufen, nicht ins fallende
 *     Messer greifen. Ohne ihn ist die Regel 2008 und 2022 eine Falle.
 *   - `RSI(rsiLen) < rsiEntry` — das kurzfristige Extrem. Die Variante „N
 *     Minus-Schlüsse in Folge" wird BEWUSST nicht zusätzlich angeboten: Sie
 *     misst dasselbe in anderen Koordinaten (RSI(2) < 10 heißt praktisch
 *     zwei kräftige Minustage) und wäre eine Achse mehr, die niemand
 *     gemessen hat.
 *
 * Ausstieg, was zuerst kommt: RSI über `rsiExit`, Schluss über dem
 * Vortageshoch (`exitOnPrevHigh`), oder der Zeitstopp `maxHoldBars`. Der
 * Zeitstopp ist Pflicht und nicht abschaltbar: Eine offene Position ohne
 * Ausstiegsgrund war im Vorgängersystem eine Fehlerquelle, und eine
 * Umkehr-These, die nach fünf Tagen nicht aufgegangen ist, war falsch.
 *
 * Der Stop ist weit (4 × ATR(14)) und wird NIE nachgezogen: Umkehr mit engem
 * Stop verkauft systematisch am Tief (T8, F1 — Stops helfen bei Momentum und
 * schaden bei Umkehr). Kein Kursziel: Das Ziel ist der Ausstieg oben, und
 * ein Limit-Bein würde ihn nur vorwegnehmen. Kein Short (§5a widerlegt).
 *
 * ── Was sie kostet und woran sie stirbt ─────────────────────────────────
 *
 * Bei 3 bp Slippage und 2 bp halbem Spread kostet ein Round-Trip rund 10 bp.
 * Der mittlere Bruttogewinn eines RSI(2)-Rücksetzers auf einem Index liegt
 * im Bereich weniger Zehntelprozent — `fee_share` (≤ 50 %) ist damit das
 * bindende Gate, nicht die Trefferquote. Der Effekt hat nach 2010
 * nachgelassen und versagt in starken Trends (Literatur E2, Vertrauen
 * niedrig). Beides steht in der Vorregistrierung, beides wird gemessen,
 * nichts davon wird weggelobt.
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { atr, atrBracket, enterDecision, fmtPx, hold, indAt, rollingMax, rsi, sma } from './indicators.ts';
import { req, spec } from './params.ts';

/** Feste Längen — bewusst keine Suchachse (weniger Freiheitsgrade, T4). */
const ATR_LEN = 14;
/** Kein Kursziel: Der Ausstieg ist das Signal, nicht ein Limit. */
const RR_MULT = 0;

const paramSpace: readonly ParamSpec[] = [
  spec('trendLen', 100, 250, 50, 'int', 'SMA des eigenen Schlusskurses; Einstieg nur darüber'),
  spec('rsiLen', 2, 6, 2, 'int', 'Kurzer RSI (Connors/Alvarez: 2)'),
  spec('rsiEntry', 5, 25, 5, 'int', 'Einstieg, wenn der RSI darunter liegt'),
  spec('rsiExit', 60, 80, 5, 'int', 'Ausstieg, wenn der RSI darüber liegt'),
  spec('exitOnPrevHigh', 0, 1, 1, 'int', 'Ausstieg beim ersten Schluss über dem Vortageshoch'),
  spec('maxHoldBars', 2, 10, 1, 'int', 'Zeitstopp in Bars — Pflicht, nicht abschaltbar'),
  spec('atrMult', 2, 6, 0.5, 'float', 'Weiter Katastrophen-Stop in ATR(14), nie nachgezogen'),
];

const defaults: Params = {
  trendLen: 200,
  rsiLen: 2,
  rsiEntry: 10,
  rsiExit: 70,
  exitOnPrevHigh: 1,
  maxHoldBars: 5,
  atrMult: 4,
};

function warmupBars(p: Params): number {
  // rsiLen + 1: Der RSI hat seinen ersten Wert an Index n.
  return Math.max(req(p, 'trendLen'), req(p, 'rsiLen') + 1, ATR_LEN) + 2;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  return {
    trend: sma(bars.c, req(p, 'trendLen')),
    rsi: rsi(bars.c, req(p, 'rsiLen')),
    atr: atr(bars.h, bars.l, bars.c, ATR_LEN),
    // Hoch der VORHERIGEN Bar: rollingMax über ein Fenster von 1 ist per
    // Konvention [i−1, i−1] — die eigene Bar ist ausgeschlossen (indicators.ts).
    prevHigh: rollingMax(bars.h, 1),
  };
}

/**
 * Rangkennzahl: je überverkaufter, desto weiter vorn. Sie entscheidet NICHTS
 * in dieser Datei — `core/logic.ts` baut daraus den Rang und vergibt die
 * knappen Plätze danach.
 */
function crossScore(snap: SymbolSnapshot, ind: IndicatorSet, _p: Params): number | null {
  const r = indAt(ind, 'rsi', snap.i);
  return Number.isFinite(r) ? -r : null;
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const rsiNow = indAt(ind, 'rsi', i);
  const pos = snap.position;

  if (pos) {
    if (pos.side !== 'long') return hold();
    const rsiExit = req(p, 'rsiExit');
    if (rsiNow > rsiExit) return { kind: 'exit', reason: `RSI${req(p, 'rsiLen')} ${rsiNow.toFixed(1)} über ${rsiExit}` };
    const prevHigh = indAt(ind, 'prevHigh', i);
    if (req(p, 'exitOnPrevHigh') === 1 && close > prevHigh) {
      return { kind: 'exit', reason: `erste Stärke: Close ${fmtPx(close)} über Vortageshoch ${fmtPx(prevHigh)}` };
    }
    const maxHold = req(p, 'maxHoldBars');
    if (pos.barsHeld >= maxHold) return { kind: 'exit', reason: `Zeitstopp: ${pos.barsHeld} Bars ≥ ${maxHold}` };
    // KEIN Trailing: siehe Kopf (T8/F1).
    return hold();
  }

  const trend = indAt(ind, 'trend', i);
  // NaN in der Aufwärmphase macht jeden Vergleich false — genau so gewollt.
  if (!(close > trend)) return hold();
  if (!(rsiNow < req(p, 'rsiEntry'))) return hold();
  const br = atrBracket(close, indAt(ind, 'atr', i), req(p, 'atrMult'), RR_MULT, 'long');
  if (!br) return hold();
  return enterDecision('long', br, `Rücksetzer im Aufwärtstrend: RSI${req(p, 'rsiLen')} ${rsiNow.toFixed(1)} < ${req(p, 'rsiEntry')}, Close > SMA${req(p, 'trendLen')} ${fmtPx(trend)}`);
}

export const strategy: Strategy = {
  id: 'index_reversal',
  // Tagesbars: Auf Intraday-Bars frisst der Umschlag die Kante (T1, §5a.10).
  timeframes: [1440],
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
  crossScore,
};
