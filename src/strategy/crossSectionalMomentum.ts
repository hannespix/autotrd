/**
 * cross_sectional_momentum — relative Stärke im Korb.
 *
 * ── Warum es diese Strategie gibt ─────────────────────────────────────────
 *
 * Die vier bisherigen Vorlagen fragen jedes Symbol EINZELN: „steigt das?".
 * Auf 30 stark korrelierten Großwerten ist die Antwort fast immer dieselbe
 * wie beim Index. Die Messungen vom 08.09.2026 zeigen genau das: In zwei von
 * drei Zeitrahmen kehrt sich die Rangfolge zwischen OOS und Holdout
 * vollständig um — die Walk-Forward-Auswahl greift dann vor allem das
 * Marktregime des Fensters ab, und Regime halten nicht bis zum nächsten.
 * Shorts helfen dagegen nicht (gemessen, `docs/ARCHITEKTUR.md` §5a): Dieselbe
 * Frage rückwärts zu stellen ist immer noch dieselbe Frage.
 *
 * Diese Strategie stellt eine andere: nicht „steigt NVDA?", sondern **„ist
 * NVDA stärker als die anderen 29?"**. Ob der Markt insgesamt steigt, kürzt
 * sich in dieser Frage heraus — steigen alle, ist niemand relativ stark.
 * Genau das ist die Kante, die eine symbolweise Strategie strukturell nicht
 * haben kann.
 *
 * ── Wie die Kennzahl gebaut ist ───────────────────────────────────────────
 *
 * `skip` überspringt die jüngsten Bars: Kurzfristig kehren Kurse eher um als
 * dass sie weiterlaufen; die klassische Momentum-Kennzahl lässt deshalb das
 * letzte Stück aus. `volAdjust` teilt die Rendite durch die Schwankung
 * derselben Periode — sonst gewinnt schlicht das volatilste Symbol den
 * Rangvergleich, und das ist keine Stärke, sondern nur mehr Rauschen.
 *
 * ── Was hier NICHT passiert ───────────────────────────────────────────────
 *
 * Die Rangliste baut diese Datei nicht selbst. Sie liefert nur `crossScore`;
 * den Rang bildet `decide()` in `core/logic.ts` — EINMAL je Bar, für beide
 * Welten identisch, ausschließlich aus geschlossenen Bars. Wer die Rangliste
 * im Backtest anders bauen würde als live, hätte sich genau den Messfehler
 * gebaut, gegen den der ganze Neubau gerichtet ist.
 *
 * Kein Short: Die Messung vom 08.09. hat Shorts auf diesem Korb widerlegt.
 * Die schwächsten Symbole zu shorten ist die naheliegende Erweiterung — sie
 * kommt erst, wenn die Long-Seite eine Kante zeigt.
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { TIMEFRAMES } from '../core/types.ts';
import { atr, atrBracket, enterDecision, fmtPx, hold, indAt, nanArray, stddev, trailOrHold } from './indicators.ts';
import { req, spec } from './params.ts';

const paramSpace: readonly ParamSpec[] = [
  spec('lookback', 20, 120, 20, 'int', 'Bars, über die die relative Stärke gemessen wird'),
  spec('skip', 0, 5, 1, 'int', 'Jüngste n Bars auslassen (kurzfristige Umkehr nicht mitmessen)'),
  spec('topPct', 0.05, 0.35, 0.05, 'float', 'Einstieg, solange das Symbol in den stärksten x % liegt'),
  spec('exitPct', 0.3, 0.8, 0.1, 'float', 'Ausstieg, sobald es schwächer als x % des Korbs ist'),
  spec('volAdjust', 0, 1, 1, 'int', 'Rendite durch Schwankung teilen (sonst gewinnt nur das volatilste Symbol)'),
  spec('atrLen', 7, 21, 7, 'int', 'ATR-Länge für Stop und Trailing'),
  spec('atrMult', 1.5, 4, 0.5, 'float', 'Erststop-Distanz in ATR'),
  spec('trailMult', 0, 5, 1, 'float', 'Trailing-Distanz in ATR (0 = aus); zieht erst im Plus nach'),
];

const defaults: Params = {
  lookback: 60,
  skip: 1,
  topPct: 0.2,
  exitPct: 0.5,
  volAdjust: 1,
  atrLen: 14,
  atrMult: 2.5,
  trailMult: 3,
};

/**
 * Mindestgröße des Korbs, damit ein Ranganteil überhaupt etwas aussagt.
 * Bei fünf Symbolen ist „in den stärksten 20 %" genau eines — das ist keine
 * Querschnitts-Aussage mehr, sondern Rauschen mit Extraschritt.
 */
export const MIN_KORB = 8;

function warmupBars(p: Params): number {
  return req(p, 'lookback') + req(p, 'skip') + Math.max(req(p, 'atrLen'), 2) + 2;
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

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  const lookback = req(p, 'lookback');
  const skip = req(p, 'skip');
  return {
    mom: momentum(bars.c, lookback, skip),
    // Schwankung derselben Periode, als Anteil vom Kurs — macht Symbole
    // verschiedener Preisklassen vergleichbar.
    vol: stddev(bars.c, lookback),
    atr: atr(bars.h, bars.l, bars.c, req(p, 'atrLen')),
  };
}

/**
 * Kennzahl für den Rangvergleich. Sieht nur `snap.bars` bis `snap.i` — die
 * Rangbildung selbst passiert in `core/logic.ts`.
 */
function crossScore(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): number | null {
  const i = snap.i;
  const mom = indAt(ind, 'mom', i);
  if (!Number.isFinite(mom)) return null;
  if (req(p, 'volAdjust') !== 1) return mom;
  const close = snap.bars.c[i];
  const vol = indAt(ind, 'vol', i);
  if (close === undefined || close <= 0 || !Number.isFinite(vol) || vol <= 0) return null;
  // Rendite je Einheit Schwankung; die Schwankung als Anteil vom Kurs.
  return mom / (vol / close);
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const atrNow = indAt(ind, 'atr', i);
  const pos = snap.position;
  const rang = snap.rank;

  if (pos) {
    // Ohne Rang (zu kleiner Korb, veraltete Bar, Aufwärmphase) wird NICHT
    // ausgestiegen: Ein fehlender Rang ist keine Information über das Symbol.
    // Stop und Trailing laufen weiter, der Broker-Stop ohnehin.
    if (rang && rang.of >= MIN_KORB && pos.side === 'long' && rang.pct > req(p, 'exitPct')) {
      return { kind: 'exit', reason: `relative Stärke verloren: Rang ${rang.rank}/${rang.of}` };
    }
    return trailOrHold(pos, close, atrNow, req(p, 'trailMult'));
  }

  if (!rang || rang.of < MIN_KORB) return hold();
  if (rang.pct > req(p, 'topPct')) return hold();
  const br = atrBracket(close, atrNow, req(p, 'atrMult'), 0, 'long');
  if (!br) return hold();
  return enterDecision('long', br, `stärkstes Fünftel: Rang ${rang.rank}/${rang.of}, Close ${fmtPx(close)}`);
}

export const strategy: Strategy = {
  id: 'cross_sectional_momentum',
  timeframes: TIMEFRAMES,
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
  crossScore,
};
