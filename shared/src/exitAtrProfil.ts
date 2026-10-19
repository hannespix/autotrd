/**
 * Woran sterben Trades — getrennt nach Klasse, Einstiegsweg und der
 * Tagesschwankung des Werts beim Einstieg (Loop #138, 19.10.).
 *
 * Anlass: Die aktive Engine verlor bei US-Aktien in sieben Tagen 1,6 % je
 * Trade, überwiegend an Stop-Loss und Trailing. Beim Sockel war die
 * Ursache belegt — ein 2-%-Stop löst bei 3–9 % Tagesschwankung am Rauschen
 * aus. Ob dasselbe Muster die aktive Engine trifft, war nicht messbar: Die
 * Tagesschwankung am Einstieg stand an keinem Trade. Seit dem 19.10.
 * stempelt der Scan sie (`einstiegAtrPct`), und diese Funktion zählt.
 *
 * NUR ANZAHLEN, keine Beträge: Das Ergebnis ist öffentlich (`meta/health`)
 * und muss deshalb unterhalb jeder Konten-Schwelle unbedenklich sein.
 * Reine Messung — keine Regel liest es.
 */

/** Obergrenzen der ATR-Stufen in Prozent (Tages-ATR / Kurs). */
export const ATR_STUFEN_GRENZEN = [1, 2, 3, 5] as const;

export type AtrStufe = 'unter1' | '1bis2' | '2bis3' | '3bis5' | 'ab5' | 'ohne';

/** Stufe einer Einstiegs-Schwankung; fehlend/kaputt ⇒ `ohne` (Altbestand). */
export function atrStufe(atrPct: number | null | undefined): AtrStufe {
  if (typeof atrPct !== 'number' || !Number.isFinite(atrPct) || atrPct <= 0) return 'ohne';
  if (atrPct < 1) return 'unter1';
  if (atrPct < 2) return '1bis2';
  if (atrPct < 3) return '2bis3';
  if (atrPct < 5) return '3bis5';
  return 'ab5';
}

export interface ExitAtrZelle {
  n: number;
  /** Davon mit Gewinn (pnl > 0). */
  wins: number;
  /** Anzahl je ATR-Stufe beim Einstieg. */
  stufen: Partial<Record<AtrStufe, number>>;
}

/** klasse → quelle → Ausstiegsgrund → Zelle. */
export type ExitAtrProfil = Record<string, Record<string, Record<string, ExitAtrZelle>>>;

export interface ExitAtrTrade {
  pnl: number;
  at?: string | null | undefined;
  assetClass?: string | null | undefined;
  quelle?: string | null | undefined;
  riskExit?: string | null | undefined;
  einstiegAtrPct?: number | null | undefined;
}

/**
 * Profil der Schlüsse ab `seitIso` (gleiche Fenster-Regel wie
 * `exitBreakdownSeit`: ohne Zeitstempel zählt ein Trade nicht).
 */
export function exitAtrProfil(trades: readonly ExitAtrTrade[], seitIso: string): ExitAtrProfil {
  const out: ExitAtrProfil = {};
  for (const t of trades) {
    if (typeof t.at !== 'string' || t.at < seitIso) continue;
    if (!Number.isFinite(t.pnl)) continue;
    const klasse = t.assetClass || 'unbekannt';
    const quelle = t.quelle || 'unbekannt';
    const grund = t.riskExit || 'signal';
    const zelle = ((out[klasse] ??= {})[quelle] ??= {})[grund] ??= { n: 0, wins: 0, stufen: {} };
    zelle.n += 1;
    if (t.pnl > 0) zelle.wins += 1;
    const s = atrStufe(t.einstiegAtrPct);
    zelle.stufen[s] = (zelle.stufen[s] ?? 0) + 1;
  }
  return out;
}

/** Profile mehrerer Konten addieren (Anzahlen sind summierbar, Mediane nicht). */
export function exitAtrProfilSumme(teile: readonly ExitAtrProfil[]): ExitAtrProfil {
  const out: ExitAtrProfil = {};
  for (const p of teile) {
    for (const [klasse, qs] of Object.entries(p)) {
      for (const [quelle, gs] of Object.entries(qs)) {
        for (const [grund, z] of Object.entries(gs)) {
          const ziel = ((out[klasse] ??= {})[quelle] ??= {})[grund] ??= { n: 0, wins: 0, stufen: {} };
          ziel.n += z.n;
          ziel.wins += z.wins;
          for (const [s, k] of Object.entries(z.stufen) as Array<[AtrStufe, number]>) {
            ziel.stufen[s] = (ziel.stufen[s] ?? 0) + k;
          }
        }
      }
    }
  }
  return out;
}
