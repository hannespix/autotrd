/**
 * Herkunft eines geschlossenen Trades (Task 17, 08.10.) — WELCHER Weg hat
 * die Position eröffnet?
 *
 * Anlass: Krypto verliert nach Gebühren (146 Trades, Gebühren 1.316 $ gegen
 * Brutto +691 $), aber die Klassen-Kante sagt nur, DASS die Klasse verliert
 * — nicht, ob Konfluenz, Regelbaum, Momentum, Sockel, KI-Probe oder Hand-
 * Trades die Verluste tragen. Hebel 1a (#544) scheiterte genau daran: Ein
 * Kostenhebel am Konfluenz-Pfad hätte ins Leere gegriffen, wenn der Verlust
 * aus dem Momentum-Pfad kommt, der kein Kostentor kennt. Erst messen, dann
 * drehen.
 *
 * Die Herkunft steht nirgends als Feld — sie steckt in dem, was das
 * Trade-Dokument ohnehin trägt: `source` (engine | manual), dem Steckbrief-
 * Schlüssel `bucket` (beim Schließen von der Position übernommen, Signatur
 * im 3. Segment) und dem Ausstiegsgrund. Pure, ohne Lesevorgänge.
 */
import { istKiProbeBucket } from './kiAktion.js';

export type TradeQuelle =
  | 'konfluenz'
  | 'regelbaum'
  | 'momentum'
  | 'sockel'
  | 'ki_probe'
  | 'hand'
  | 'sync'
  | 'unbekannt';

/** Alle Werte — Reihenfolge ist die Anzeige-Reihenfolge im Lagebericht. */
export const TRADE_QUELLEN: readonly TradeQuelle[] = [
  'konfluenz',
  'regelbaum',
  'momentum',
  'sockel',
  'ki_probe',
  'hand',
  'sync',
  'unbekannt',
];

export interface TradeQuelleFelder {
  source?: unknown;
  bucket?: unknown;
  riskExit?: unknown;
  /** `adoptBroker` bucht Broker-Bestand mit `sync: true` nach — kein eigener Einstieg. */
  sync?: unknown;
  /** Beim Öffnen an der Position gestempelt und auf den Trade kopiert (Task 18). */
  quelle?: unknown;
}

/** Ist `q` ein benannter Einstiegsweg (kein `sync`/`unbekannt`, kein Fremdwert)? */
export function istEinstiegsweg(q: unknown): q is TradeQuelle {
  return typeof q === 'string' && (TRADE_QUELLEN as readonly string[]).includes(q) && quelleBekannt(q);
}

/**
 * Einstiegsweg aus einer Lauf-Kennung (Task 18). Die Kennung steht am ENDE
 * der clientOrderId (`clientOrderId()` in alpacaBroker: bei Überlänge wird
 * die uid gekappt, nie der Lauf) oder liegt als bloße `laufId` vor:
 *   `man-2026-10-08T10_03Z` → hand · `mom-2026-10-08` → momentum ·
 *   `core-2026-10-08` → sockel. Ein reiner Scan-Zeitstempel ist MEHRDEUTIG
 *   (Konfluenz, Regelbaum oder KI-Probe) und ergibt null — ebenso `exit-`,
 *   `puls-`, `-schutz`, `fill-sync`. Reihenfolge: `man-` vor jedem
 *   generischen Zeitstempel, verankert am Ende.
 */
export function quelleAusLauf(kennung: unknown): TradeQuelle | null {
  if (typeof kennung !== 'string' || kennung.length === 0) return null;
  const k = kennung.replace(/[^A-Za-z0-9-]/g, '_');
  // Scan-Wege (09.10.): als Suffix der Kennung, weil der Zeitstempel allein
  // Konfluenz, Regelbaum und KI-Probe nicht unterscheidet (Red-Team H1).
  for (const [weg, suffix] of Object.entries(LAUF_WEG_SUFFIX)) {
    if (k.endsWith(`-${suffix}`)) return weg as TradeQuelle;
  }
  if (/(^|-)man-\d{4}-\d{2}-\d{2}T\d{2}_\d{2}Z$/.test(k)) return 'hand';
  if (/(^|-)mom-\d{4}-\d{2}-\d{2}$/.test(k)) return 'momentum';
  if (/(^|-)core-\d{4}-\d{2}-\d{2}$/.test(k)) return 'sockel';
  return null;
}

/**
 * Suffix je Scan-Weg in der Order-Kennung (09.10.). Die Kennung ist der
 * einzige Kanal, der Scan → Broker → fillSync/adoptBroker überlebt; ohne
 * Suffix legte jede Nachbuchung einer Scan-Order die Position ohne Herkunft
 * an (Red-Team 09.10., H1). Momentum/Sockel/Hand tragen ihren Weg schon
 * als Präfix (`mom-`, `core-`, `man-`) und brauchen keins. Drei Zeichen,
 * damit die 128-Zeichen-Grenze der clientOrderId weiter die uid kappt.
 */
export const LAUF_WEG_SUFFIX: Readonly<Record<'konfluenz' | 'regelbaum' | 'ki_probe', string>> = {
  konfluenz: 'kfl',
  regelbaum: 'rgb',
  ki_probe: 'kip',
};

/** Lauf-Kennung eines ERÖFFNENDEN Auftrags mit Weg-Suffix; ohne Scan-Weg unverändert (deterministisch je Signal → Idempotenz bleibt). */
export function laufMitWeg(laufId: string, weg: TradeQuelle | null): string {
  const suffix = weg !== null && weg in LAUF_WEG_SUFFIX ? LAUF_WEG_SUFFIX[weg as keyof typeof LAUF_WEG_SUFFIX] : null;
  return suffix ? `${laufId}-${suffix}` : laufId;
}

/**
 * Was eine ÖFFNENDE Buchung an die Position stempelt (Task 18): ein
 * ausdrücklich mitgegebener Einstiegsweg, sonst der aus dem Steckbrief
 * (dieselbe Lesart wie beim Schließen) — und nur, wenn er benannt ist.
 */
export function einstiegsQuelle(t: Pick<TradeQuelleFelder, 'quelle' | 'source' | 'bucket'>): TradeQuelle | null {
  if (istEinstiegsweg(t.quelle)) return t.quelle;
  const aus = tradeQuelle({ source: t.source, bucket: t.bucket });
  return quelleBekannt(aus) ? aus : null;
}

/** Quellen, die einen EINSTIEGSWEG benennen — `sync`/`unbekannt` sind Lücken, keine Pfade. */
export function quelleBekannt(q: string): boolean {
  return q !== 'sync' && q !== 'unbekannt';
}

/**
 * Die Quelle ist der EINSTIEGSWEG — nie der Ausstieg (Red-Team 08.10., H1/H2:
 * Die erste Fassung las `source: 'manual'` zuerst und machte aus einer von
 * Hand verkauften Momentum-Position einen Hand-Trade; und die Signatur
 * `manuell`, die trade.ts jedem Hand-KAUF stempelt, fiel als Konfluenz
 * durch — exakt in den Eimer, an dem der Kostenhebel ansetzen sollte).
 *
 * Reihenfolge der Prüfung ist Teil des Vertrags:
 *  1. Der Steckbrief zuerst — er wird beim ÖFFNEN gestempelt und beim
 *     Schließen auf den Trade kopiert, egal wer schließt (Scan, Stop,
 *     Rebalance, Hand). Signaturen: `manuell` (Hand-Kauf, trade.ts),
 *     `ki`/`lex` nur bei KI-ALLEIN-Proben, `momentum`, `core` (Sockel),
 *     `regelbaum`; alles andere ist eine Konfluenz aus Indikator-Stimmen.
 *  2. Ohne Steckbrief: das beim Öffnen gestempelte `quelle` (Task 18) —
 *     dann `source: 'manual'` als Hand-Trade aus der Zeit
 *     vor dem Stempel; der Ausstiegsgrund verrät noch Momentum und Sockel
 *     (ihre Verkäufe tragen eigene Gründe).
 *  3. Nachgebuchter Bestand (`sync`, adoptBroker) hat keinen Einstiegsweg
 *     im System; der Rest ist unbekannt (Altbestand, per fillSync eröffnet,
 *     aufgestockt ohne Steckbrief). Beide sind LÜCKEN der Messung und
 *     werden als Deckung ausgewiesen, nicht als Pfad gelesen.
 */
export function tradeQuelle(t: TradeQuelleFelder): TradeQuelle {
  if (typeof t.bucket === 'string' && t.bucket.length > 0) {
    if (istKiProbeBucket(t.bucket)) return 'ki_probe';
    const sig = t.bucket.split('|')[2] ?? '';
    if (sig === 'manuell') return 'hand';
    if (sig === 'momentum') return 'momentum';
    if (sig === 'core') return 'sockel';
    if (sig === 'regelbaum') return 'regelbaum';
    if (sig.length > 0 && sig !== 'keine') return 'konfluenz';
  }
  // Beim Öffnen gestempelt (Task 18) — deckt Positionen ohne Steckbrief, die
  // per Lauf-Kennung nachgebucht wurden. NACH dem Steckbrief, damit der
  // dokumentierte Vertrag (H1/H2) unverändert bleibt.
  if (istEinstiegsweg(t.quelle)) return t.quelle;
  if (t.source === 'manual') return 'hand';
  if (t.riskExit === 'momentum_rebalance') return 'momentum';
  if (t.riskExit === 'core_rebalance' || t.riskExit === 'core_aufloesung') return 'sockel';
  if (t.sync === true) return 'sync';
  return 'unbekannt';
}
