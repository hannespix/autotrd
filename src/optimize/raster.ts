/**
 * Raster der Beförderung (Regel 2, Owner-Entscheidung 18.09.2026,
 * `docs/wissen/vorregistrierung/2026-09-18-befoerderung-auf-drei-rastern.md`).
 *
 * Ein Raster ist dieselbe Einheit, bei der ALLE Serien — Korb, Kandidatenpool,
 * Benchmark, Parkpapier — so geschnitten sind, dass die letzten `anker`
 * Handelstage der Zeitachse der Einheit fehlen. Der Fold-Plan ist am Datenende
 * verankert; ein Tag weniger verschiebt jede Fold-Grenze um einen Tag. Genau
 * das war der Befund K1/K3 des Prüfers vom 18.09.2026: dieselbe Kette
 * bestand in drei aufeinanderfolgenden Nächten 6/10, 5/10 und 10/10 Gates.
 * Mit dem Generator je Strategie und Fenster (search.ts `rngFuer`) sieht eine
 * Familie auf Raster −1 heute dieselben Gitterpunkte wie gestern auf −0 —
 * die Raster eines Laufs SIND die letzten Nächte, ohne den Freiheitsgrad
 * „welche Nacht zählt".
 *
 * Hier wird nur geschnitten. Was auf dem Schnitt gemessen wird, entscheidet
 * `run.ts` mit denselben Funktionen wie auf Raster 0 — nichts wird aus
 * Raster 0 übernommen, nichts hier nachgerechnet.
 */
import { BarSeries } from '../core/bars.ts';
import type { Bar, BarSeriesLike, Ms } from '../core/types.ts';
import type { Zeitachse } from './walkForward.ts';

/**
 * Das exklusive Ende des Rasters `anker`: Bars mit `t < ende` bleiben, die
 * letzten `anker` Handelstage der Achse fallen weg. Für `anker` 0 gibt es
 * keinen Schnitt (null). Eine Achse, die kürzer ist als der Anker, hat kein
 * solches Raster — das ist ein Fehler, kein leeres Raster.
 */
export function rasterEnde(achse: Zeitachse, anker: number): Ms | null {
  if (!Number.isInteger(anker) || anker < 0) throw new Error(`Raster: Anker muss eine ganze Zahl ≥ 0 sein, bekommen ${anker}`);
  if (anker === 0) return null;
  if (achse.length <= anker) throw new Error(`Raster −${anker}: die Zeitachse hat nur ${achse.length} Handelstage`);
  return achse.t[achse.length - anker]!;
}

/** Die Bars vor `ende` — eine Kopie, keine Sicht; ohne Schnitt dieselbe Serie. */
export function schneideSerie(bars: BarSeriesLike, ende: Ms | null): BarSeriesLike {
  if (ende === null) return bars;
  let hi = 0;
  while (hi < bars.length && bars.t[hi]! < ende) hi++;
  if (hi === bars.length) return bars;
  const out: Bar[] = [];
  for (let i = 0; i < hi; i++) out.push(bars.at(i));
  return BarSeries.from(out);
}

/** Jede Serie des Korbs vor `ende`; Serien ohne verbleibende Bars fallen weg (sie wären auch damals nicht handelbar gewesen). */
export function schneideKorb(korb: ReadonlyMap<string, BarSeriesLike>, ende: Ms | null): ReadonlyMap<string, BarSeriesLike> {
  if (ende === null) return korb;
  const out = new Map<string, BarSeriesLike>();
  for (const [symbol, bars] of korb) {
    const s = schneideSerie(bars, ende);
    if (s.length > 0) out.set(symbol, s);
  }
  return out;
}

/** Anzeigename eines Rasters: „−0", „−1", … (Handelstage vom Datenende). */
export function rasterKennung(anker: number): string {
  return `−${anker}`;
}
