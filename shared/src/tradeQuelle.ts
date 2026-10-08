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

/**
 * Reihenfolge der Prüfung ist Teil des Vertrags:
 *  1. Hand-Trades zuerst — ein manueller Verkauf einer Engine-Position bleibt
 *     ein Hand-Ausstieg, egal welchen Steckbrief die Position trug.
 *  2. Nachgebuchter Bestand (`sync`) hat keinen Einstiegsweg im System.
 *  3. Dann der Steckbrief: KI-/Lexikon-Probe VOR den festen Signaturen, weil
 *     `ki` nur in Proben vorkommt; `momentum`/`core`/`regelbaum` sind feste
 *     Signaturen, alles andere ist eine Konfluenz aus Indikator-Stimmen.
 *  4. Ohne Steckbrief verrät noch der Ausstiegsgrund Momentum und Sockel
 *     (ihre Verkäufe tragen eigene Gründe) — der Rest ist unbekannt:
 *     Altbestand, per fillSync eröffnet, aufgestockt ohne Steckbrief.
 */
export function tradeQuelle(t: TradeQuelleFelder): TradeQuelle {
  if (t.source === 'manual') return 'hand';
  if (t.sync === true) return 'sync';
  if (typeof t.bucket === 'string' && t.bucket.length > 0) {
    if (istKiProbeBucket(t.bucket)) return 'ki_probe';
    const sig = t.bucket.split('|')[2] ?? '';
    if (sig === 'momentum') return 'momentum';
    if (sig === 'core') return 'sockel';
    if (sig === 'regelbaum') return 'regelbaum';
    if (sig.length > 0 && sig !== 'keine') return 'konfluenz';
  }
  if (t.riskExit === 'momentum_rebalance') return 'momentum';
  if (t.riskExit === 'core_rebalance' || t.riskExit === 'core_aufloesung') return 'sockel';
  return 'unbekannt';
}
