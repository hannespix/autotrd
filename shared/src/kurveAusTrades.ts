/**
 * Depot-Kurve aus den Trades bauen, wenn keine Snapshots vorliegen.
 *
 * ── Der Befund (Owner 12.08.) ─────────────────────────────────────────────
 *
 * Die Teilen-Karte zeigte „0,00 %", „noch kein Zeitraum" und „Noch zu wenige
 * Tage für eine Kurve" — bei NEUN geschlossenen Trades, Profit-Faktor 0,12
 * und −191,06 $ je Trade. Die Kennzahlen daneben stimmten; nur die Kurve war
 * leer.
 *
 * Der Grund ist keine fehlende Information, sondern die falsche Quelle:
 * `depotAufteilung` baut die Kurve ausschließlich aus den Tages-Snapshots,
 * die `snapshotEquity` um 23:15 schreibt. Wer heute anfängt zu handeln, hat
 * abends einen Punkt und morgen zwei — vorher „zu wenige Tage". Ein Reset
 * löscht die Snapshots und setzt denselben Zustand wieder her, obwohl das
 * Handelsjournal voll ist.
 *
 * Dabei trägt jeder geschlossene Trade beides, was eine Kurve braucht: einen
 * Zeitpunkt und ein Ergebnis. Kumuliert ergibt das die realisierte
 * Entwicklung — ab dem ersten Trade, ohne auf Mitternacht zu warten.
 *
 * ── Was diese Kurve IST und was nicht ─────────────────────────────────────
 *
 * Sie ist die REALISIERTE Kurve: Sie bewegt sich, wenn eine Position
 * geschlossen wird, und sonst nicht. Die Snapshot-Kurve ist die
 * MARK-TO-MARKET-Kurve: Sie bewegt sich täglich mit den Kursen, auch wenn
 * nichts gehandelt wurde.
 *
 * Beide sind richtig und beantworten verschiedene Fragen — „was habe ich
 * vereinnahmt?" gegen „was ist mein Depot wert?". Deshalb ersetzt diese
 * Funktion die Snapshots NICHT, sie springt nur ein, solange es zu wenige
 * gibt. Und die Karte muss sagen, welche der beiden sie zeigt: Eine Kurve
 * ohne Angabe ihrer Bedeutung ist eine Einladung zum Fehlschluss.
 */

/** Ein geschlossener Trade — Zeitpunkt und realisiertes Ergebnis. */
export interface KurvenTrade {
  /** ISO-Zeitstempel des Abschlusses. */
  at: string;
  /** Realisiertes Ergebnis in Kontowährung. */
  pnl: number;
}

/** Ein Punkt der Kurve — dasselbe Format wie die Snapshot-Serie. */
export interface KurvenPunkt {
  date: string;
  equity: number;
}

/**
 * Ab wie vielen Snapshots die echte Kurve gewinnt.
 *
 * Zwei, weil eine Kurve aus einem Punkt keine Kurve ist — und weil genau
 * diese Grenze schon in der Teilen-Karte steht (`tage.length >= 2`). Sie
 * hier zu wiederholen ist Absicht: Wer die eine ändert, soll über die
 * andere stolpern.
 */
export const SNAPSHOT_MIN = 2;

const tagVon = (iso: string): string => iso.slice(0, 10);

/**
 * Realisierte Kurve aus geschlossenen Trades.
 *
 * Startpunkt ist die Kapitalbasis am Tag VOR dem ersten Abschluss: Ohne ihn
 * begänne die Kurve bereits mit dem ersten Ergebnis und zeigte einen Sprung
 * aus dem Nichts. Danach ein Punkt je Handelstag mit der kumulierten
 * Summe — Tage ohne Abschluss erzeugen keinen Punkt, weil an ihnen
 * realisiert nichts geschah.
 *
 * Trades ohne verwertbaren Zeitstempel oder ohne endliches `pnl` fallen
 * heraus, statt die Kurve mit `NaN` zu vergiften.
 */
export function kurveAusTrades(trades: readonly KurvenTrade[], basis: number): KurvenPunkt[] {
  if (!Number.isFinite(basis)) return [];
  const gueltig = trades
    .filter((t) => typeof t?.at === 'string' && t.at.length >= 10 && Number.isFinite(t?.pnl))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (gueltig.length === 0) return [];

  // Summe je Tag — mehrere Abschlüsse an einem Tag ergeben EINEN Punkt.
  const jeTag = new Map<string, number>();
  for (const t of gueltig) {
    const tag = tagVon(t.at);
    jeTag.set(tag, (jeTag.get(tag) ?? 0) + t.pnl);
  }

  const tage = [...jeTag.keys()].sort();
  const start = vortag(tage[0]!);
  const punkte: KurvenPunkt[] = [{ date: start, equity: runde(basis) }];
  let stand = basis;
  for (const tag of tage) {
    stand += jeTag.get(tag)!;
    punkte.push({ date: tag, equity: runde(stand) });
  }
  return punkte;
}

/**
 * Welche Serie die Anzeige benutzen soll — und woher sie stammt.
 *
 * Die Herkunft wandert MIT, weil die Karte sie benennen muss. Eine
 * realisierte Kurve, die als Depotwert gelesen wird, führt in die Irre:
 * Sie steht still, während eine offene Position läuft.
 */
export interface KurvenWahl {
  serie: KurvenPunkt[];
  herkunft: 'snapshots' | 'trades' | 'leer';
  /** Kurzer Hinweis für die Anzeige; leer, wenn nichts zu erklären ist. */
  hinweis: string;
}

export function waehleKurve(
  snapshots: readonly KurvenPunkt[] | null | undefined,
  trades: readonly KurvenTrade[] | null | undefined,
  basis: number,
  minSnapshots = SNAPSHOT_MIN,
): KurvenWahl {
  const snaps = (snapshots ?? []).filter((s) => Number.isFinite(s?.equity));
  if (snaps.length >= minSnapshots) {
    return { serie: [...snaps], herkunft: 'snapshots', hinweis: '' };
  }
  const ausTrades = kurveAusTrades(trades ?? [], basis);
  if (ausTrades.length >= 2) {
    return {
      serie: ausTrades,
      herkunft: 'trades',
      // Kurz genug für eine Bildunterschrift, deutlich genug, dass niemand
      // sie für den Depotwert hält.
      hinweis: 'realisiert — bewegt sich nur bei Abschlüssen',
    };
  }
  return { serie: [], herkunft: 'leer', hinweis: '' };
}

const runde = (x: number): number => Math.round(x * 100) / 100;

/** Kalendertag davor — der Ankerpunkt der Kurve. */
function vortag(tag: string): string {
  const ms = Date.parse(`${tag}T00:00:00Z`);
  if (!Number.isFinite(ms)) return tag;
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}
