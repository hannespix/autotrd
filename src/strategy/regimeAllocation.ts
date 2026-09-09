/**
 * regime_allocation — Allokation nach Regime und relativer Stärke, monatlich.
 *
 * ── Warum es diese Familie gibt ───────────────────────────────────────────
 *
 * Vier Fenster am 09.09.2026 (docs/ARCHITEKTUR.md §5a.12): Keine der vier
 * signalgetriebenen Vorlagen schlägt kaufen-und-halten, und im Bärenmarkt
 * 2022 verlieren alle. Sie fragen täglich „steigt das?" oder „ist das
 * stärker?", steigen mit engen ATR-Stops ein und wieder aus und handeln
 * damit dutzende Male im Quartal. Die Momentum- und Trendfolge-Literatur
 * sagt seit Jahrzehnten dasselbe: Die Kante — soweit es sie gibt — liegt
 * nicht im Signal, sondern in der AUSFÜHRUNG: selten entscheiden, breit
 * streuen, das Risiko am Regime und an der Schwankung bemessen, Gewinner
 * nicht mit Stops abschneiden.
 *
 * Diese Familie stellt deshalb drei Fragen, und nur einmal im Monat:
 *
 *   1. RELATIV — gehört das Symbol zu den stärksten des Korbs? `crossScore`
 *      ist das 12-1-Momentum je Einheit Schwankung; den Rang baut `decide()`
 *      in core/logic.ts, einmal je Bar, für beide Welten (§0.2).
 *   2. REGIME — notiert es über seinem langen gleitenden Mittel?
 *   3. ABSOLUT — ist sein eigenes Momentum positiv? Dual Momentum: relativ
 *      UND absolut. In Bärenmärkten ist „der relativ Stärkste" oft nur der,
 *      der am wenigsten fällt.
 *
 * Nur wenn alle drei ja sagen, kauft sie — mit einem Gewicht aus
 * Zielvolatilität / realisierter Volatilität (Risikoparität statt
 * Stop-Distanz; `weight` auf der Entscheidung, angewandt in core/logic.ts)
 * und einem WEITEN Katastrophen-Stop beim Broker (§0.4). Zwischen zwei
 * Rebalance-Tagen entscheidet sie nichts; nur der Broker-Stop wacht.
 *
 * ── Was hier bewusst fehlt ────────────────────────────────────────────────
 *
 * Kein Trailing-Stop, kein Kursziel: Beides schneidet die rechte Flanke ab,
 * von der Momentum lebt (Owner-Befund: „Trailing vom Einstand ⇒ Verkauf bei
 * −3 % statt −25 %"). Kein Short (§5a: widerlegt). Keine Intraday-Bars: Ein
 * monatlicher Allokator auf 5-Minuten-Bars wäre Unsinn — `timeframes` ist
 * allein der Tag.
 *
 * ── Wo die Freiheitsgrade liegen ──────────────────────────────────────────
 *
 * Sieben Achsen auf groben Gittern. Der Rebalance-Rhythmus ist FEST
 * monatlich, die Volatilitäts-Länge fest ein Quartal: weniger Achsen,
 * weniger, was die Deflated Sharpe abziehen muss. Wer hier eine Achse
 * ergänzt, ergänzt eine Suche.
 */
import { dayKey } from '../core/time.ts';
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { MIN_KORB } from './crossSectionalMomentum.ts';
import { fmtPx, hold, indAt, nanArray, sma, stddev } from './indicators.ts';
import { req, spec } from './params.ts';

/** Handelstage je Jahr — Annualisierung der realisierten Volatilität. */
const TAGE_JE_JAHR = 252;
/** Fenster der realisierten Volatilität in Bars — fest ein Quartal, keine Suchachse. */
export const VOL_LEN = 63;

const paramSpace: readonly ParamSpec[] = [
  spec('lookback', 126, 252, 42, 'int', 'Bars des Momentum-Fensters (ein halbes bis ein Jahr)'),
  spec('skip', 0, 21, 21, 'int', 'Jüngste n Bars auslassen (12-1: der letzte Monat kehrt eher um)'),
  spec('regimeLen', 100, 250, 50, 'int', 'Länge des gleitenden Mittels, über dem das Regime „aufwärts" heißt'),
  spec('topPct', 0.1, 0.4, 0.1, 'float', 'Einstieg, solange das Symbol in den stärksten x % des Korbs liegt'),
  spec('exitPct', 0.4, 0.8, 0.2, 'float', 'Ausstieg am Rebalance-Tag, sobald es schwächer als x % des Korbs ist'),
  spec('targetVolPct', 5, 20, 5, 'int', 'Zielvolatilität je Position p. a. in % — Gewicht = Ziel / realisiert, höchstens 1'),
  spec('stopPct', 10, 25, 5, 'int', 'Katastrophen-Stop unter dem Einstand in % — liegt beim Broker, wird nie nachgezogen'),
];

const defaults: Params = {
  lookback: 210,
  skip: 21,
  regimeLen: 200,
  topPct: 0.2,
  exitPct: 0.6,
  targetVolPct: 10,
  stopPct: 20,
};

function warmupBars(p: Params): number {
  return Math.max(req(p, 'lookback') + req(p, 'skip'), req(p, 'regimeLen'), VOL_LEN + 1) + 2;
}

/** Rendite über `lookback` Bars, endend `skip` Bars vor der aktuellen. */
function momentum(close: BarSeriesLike['c'], lookback: number, skip: number): Float64Array {
  const out = nanArray(close.length);
  for (let i = lookback + skip; i < close.length; i++) {
    const jetzt = close[i - skip];
    const davor = close[i - skip - lookback];
    if (jetzt === undefined || davor === undefined || davor <= 0) continue;
    out[i] = jetzt / davor - 1;
  }
  return out;
}

/** Annualisierte Schwankung der Tagesrenditen über VOL_LEN Bars (Anteil, nicht Prozent). */
function realisierteVol(close: BarSeriesLike['c']): Float64Array {
  const r = nanArray(close.length);
  for (let i = 1; i < close.length; i++) {
    const a = close[i - 1];
    const b = close[i];
    if (a !== undefined && b !== undefined && a > 0 && b > 0) r[i] = b / a - 1;
  }
  const sd = stddev(r, VOL_LEN);
  const out = nanArray(close.length);
  for (let i = 0; i < sd.length; i++) {
    const x = sd[i]!;
    if (Number.isFinite(x)) out[i] = x * Math.sqrt(TAGE_JE_JAHR);
  }
  return out;
}

/**
 * 1 an der ersten Bar eines neuen Kalendermonats (ET), sonst 0. Kausal: sieht
 * nur t[i] und t[i−1]. Die allererste Bar rebalanciert nie — sie hat keine
 * Geschichte, aus der ein Urteil käme.
 */
function monatswechsel(t: BarSeriesLike['t']): Float64Array {
  const out = new Float64Array(t.length);
  for (let i = 1; i < t.length; i++) {
    if (dayKey(t[i]!).slice(0, 7) !== dayKey(t[i - 1]!).slice(0, 7)) out[i] = 1;
  }
  return out;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  return {
    mom: momentum(bars.c, req(p, 'lookback'), req(p, 'skip')),
    sma: sma(bars.c, req(p, 'regimeLen')),
    rvol: realisierteVol(bars.c),
    rebal: monatswechsel(bars.t),
  };
}

/** Kennzahl für den Rangvergleich: Momentum je Einheit Schwankung. Den Rang baut core/logic.ts. */
function crossScore(snap: SymbolSnapshot, ind: IndicatorSet, _p: Params): number | null {
  const mom = indAt(ind, 'mom', snap.i);
  const rvol = indAt(ind, 'rvol', snap.i);
  if (!Number.isFinite(mom) || !Number.isFinite(rvol) || rvol <= 0) return null;
  return mom / rvol;
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  // Zwischen zwei Rebalance-Tagen entscheidet diese Familie NICHTS — weder
  // Einstieg noch Ausstieg. Der Katastrophen-Stop liegt beim Broker.
  if (indAt(ind, 'rebal', i) !== 1) return hold();

  const mom = indAt(ind, 'mom', i);
  const regime = indAt(ind, 'sma', i);
  const rang = snap.rank;
  const pos = snap.position;

  if (pos) {
    if (pos.side !== 'long') return hold();
    if (Number.isFinite(regime) && close < regime) return { kind: 'exit', reason: `Regime verloren: Close ${fmtPx(close)} unter Mittel ${fmtPx(regime)}` };
    if (Number.isFinite(mom) && mom < 0) return { kind: 'exit', reason: `absolutes Momentum negativ (${(mom * 100).toFixed(1)} %)` };
    // Ohne Rang (zu kleiner Korb, veraltete Bar) kein Urteil über relative Stärke.
    if (rang && rang.of >= MIN_KORB && rang.pct > req(p, 'exitPct')) {
      return { kind: 'exit', reason: `relative Stärke verloren: Rang ${rang.rank}/${rang.of}` };
    }
    return hold();
  }

  if (!rang || rang.of < MIN_KORB || rang.pct > req(p, 'topPct')) return hold();
  if (!Number.isFinite(regime) || !(close > regime)) return hold();
  if (!Number.isFinite(mom) || !(mom > 0)) return hold();
  const rvol = indAt(ind, 'rvol', i);
  if (!Number.isFinite(rvol) || !(rvol > 0)) return hold();

  // Gewicht: Zielvolatilität / realisierte Volatilität, höchstens voll.
  // Den Deckel (maxPositionPct, Exposure, Bargeld) setzt das Sizing.
  const weight = Math.min(1, req(p, 'targetVolPct') / 100 / rvol);
  const stop = close * (1 - req(p, 'stopPct') / 100);
  return {
    kind: 'enter',
    side: 'long',
    stop,
    weight,
    reason: `Rang ${rang.rank}/${rang.of}, Regime auf, Momentum ${(mom * 100).toFixed(1)} %, Vol ${(rvol * 100).toFixed(0)} % ⇒ Gewicht ${(weight * 100).toFixed(0)} %`,
  };
}

export const strategy: Strategy = {
  id: 'regime_allocation',
  timeframes: [1440],
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
  crossScore,
};
