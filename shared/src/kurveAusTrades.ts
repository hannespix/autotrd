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

/**
 * Warum die Anzeige zeigt, was sie zeigt (Owner-Frage 12.08.).
 *
 * „Noch zu wenige Snapshot-Tage für eine Kurve" sagt, DASS etwas fehlt, aber
 * nicht WARUM — und genau das war die Frage: „warum noch keine Tageskurve!?!"
 * bei vollem Handelsjournal. Die Gründe sind verschieden und führen zu
 * verschiedenen Schlüssen:
 *
 *   - Es wurde noch nie abgeschlossen → warten auf den ersten Trade.
 *   - Es gibt Abschlüsse, aber keine Snapshots → der Tageslauf um 23:15 hat
 *     noch nicht gegriffen (oder ein Reset hat die Serie geleert). Dann
 *     springt die realisierte Kurve ein, und der Satz sagt, dass es sie ist.
 *   - Ein Reset liegt dazwischen → die Serie beginnt bei null, obwohl das
 *     Konto alt ist. Ohne diesen Hinweis sucht man den Fehler im System.
 *
 * Pur und getestet, weil dieser Satz an drei Stellen der Oberfläche steht
 * (Performance-Karte, Depot-Verlauf, Teilen-Karte) — dreimal formuliert
 * wäre er dreimal anders.
 */
export interface ErklaerungEingabe {
  herkunft: KurvenWahl['herkunft'];
  /** Vorhandene Tages-Snapshots. */
  snapshots: number;
  /** Geschlossene Trades, aus denen eine Kurve gebaut werden könnte. */
  trades: number;
  /** Schnittmarke des letzten Resets (ISO), falls es einen gab. */
  resetAm?: string | undefined;
}

/** Wann der Tageslauf schreibt — 17:15 New York, in Mitteleuropa 23:15. */
const SNAPSHOT_UHRZEIT = '23:15';

/* ── Strukturierte Teile statt fertiger Sätze (EN-Tranche 5, 21.08.) ─────
 *
 * Der deutsche Satz unten bleibt als Referenz-Formulierung: Der Golden-Test
 * hält ihn fest, und der Bild-Prüfstand der Depot-Grafik rendert ihn. Die
 * Oberfläche baut ihren Satz seit dieser Tranche aus den TEILEN — Code plus
 * Zahlen, aus denen jede Sprache ihre eigene Fassung formt.
 *
 * Beide Wege benutzen dieselbe Fallunterscheidung (`erklaerungsTeile`),
 * damit deutsche und englische Fassung nie auseinanderlaufen. */
export type KurvenErklaerungTeil =
  | { code: 'ausAbschluessen'; trades: number }
  | { code: 'nochKeineAbschluesse' }
  | { code: 'ohneZeitpunktOderErgebnis'; trades: number }
  | { code: 'keineSnapshots'; resetAm?: string; uhrzeit: string }
  | { code: 'einSnapshot'; resetAm?: string; uhrzeit: string };

/** Die Fallunterscheidung — EINE Quelle für beide Sprachen. */
export function erklaerungsTeile(e: ErklaerungEingabe): KurvenErklaerungTeil[] {
  if (e.herkunft === 'snapshots') return [];
  const teile: KurvenErklaerungTeil[] = [];
  if (e.herkunft === 'trades') {
    teile.push({ code: 'ausAbschluessen', trades: e.trades });
  } else if (e.trades <= 0) {
    teile.push({ code: 'nochKeineAbschluesse' });
  } else {
    // Abschlüsse ohne Zeitstempel/Ergebnis sind ein DATENFEHLER — dieser
    // Fall trägt bewusst keinen Snapshot-Zusatz, sonst klänge er wie
    // „noch zu früh".
    return [{ code: 'ohneZeitpunktOderErgebnis', trades: e.trades }];
  }
  const reset = e.resetAm && e.resetAm.length >= 10 ? e.resetAm.slice(0, 10) : undefined;
  if (e.snapshots <= 0) {
    teile.push({ code: 'keineSnapshots', uhrzeit: SNAPSHOT_UHRZEIT, ...(reset ? { resetAm: reset } : {}) });
  } else if (e.snapshots === 1) {
    teile.push({ code: 'einSnapshot', uhrzeit: SNAPSHOT_UHRZEIT, ...(reset ? { resetAm: reset } : {}) });
  }
  return teile;
}

function snapshotSatz(snapshots: number, resetAm: string | undefined): string {
  const seitReset = resetAm && resetAm.length >= 10 ? ` (Reset am ${resetAm.slice(0, 10)})` : '';
  if (snapshots <= 0) {
    return `Tages-Snapshots gibt es noch keine${seitReset} — der nächste entsteht um ${SNAPSHOT_UHRZEIT}.`;
  }
  if (snapshots === 1) {
    return `Erst ein Tages-Snapshot${seitReset} — ab zwei entsteht die Depotwert-Kurve (einer je Tag, ${SNAPSHOT_UHRZEIT}).`;
  }
  return '';
}

export function kurvenErklaerung(e: ErklaerungEingabe): string {
  if (e.herkunft === 'snapshots') return '';

  if (e.herkunft === 'trades') {
    const n = `${e.trades} ${e.trades === 1 ? 'Abschluss' : 'Abschlüssen'}`;
    return `Kurve aus ${n} gerechnet — realisiert, sie bewegt sich nur bei Abschlüssen. ${snapshotSatz(e.snapshots, e.resetAm)}`.trim();
  }

  if (e.trades <= 0) {
    return `Noch keine abgeschlossenen Trades — die Kurve beginnt mit dem ersten Abschluss. ${snapshotSatz(e.snapshots, e.resetAm)}`.trim();
  }
  // Abschlüsse vorhanden, trotzdem keine Kurve: dann fehlt ihnen der
  // Zeitstempel oder das Ergebnis. Das ist ein Datenfehler und darf nicht wie
  // „noch zu früh" klingen.
  return `${e.trades} ${e.trades === 1 ? 'Abschluss trägt' : 'Abschlüsse tragen'} keinen verwertbaren Zeitpunkt oder kein Ergebnis — daraus lässt sich keine Kurve bauen.`;
}

const runde = (x: number): number => Math.round(x * 100) / 100;

/** Kalendertag davor — der Ankerpunkt der Kurve. */
function vortag(tag: string): string {
  const ms = Date.parse(`${tag}T00:00:00Z`);
  if (!Number.isFinite(ms)) return tag;
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}
