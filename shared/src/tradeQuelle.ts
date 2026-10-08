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
 *  2. Ohne Steckbrief: `source: 'manual'` ist ein Hand-Trade aus der Zeit
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
  if (t.source === 'manual') return 'hand';
  if (t.riskExit === 'momentum_rebalance') return 'momentum';
  if (t.riskExit === 'core_rebalance' || t.riskExit === 'core_aufloesung') return 'sockel';
  if (t.sync === true) return 'sync';
  return 'unbekannt';
}
