/**
 * Börsen-Uhr vom Broker (Alpaca-Sync Punkt 2, 05.08.).
 *
 * Unsere eigene Marktzeit-Rechnung (`marketOpenForClass`) ist ein reiner
 * Wochentag+Uhrzeit-Kalender — sie kennt weder FEIERTAGE noch HALBTAGE
 * (Thanksgiving-Freitag und Heiligabend schließen 13:00 ET). Die Folgen sind
 * asymmetrisch: An Feiertagen scannt die Engine ins Leere (nur Verschwendung),
 * an Halbtagen hält sie über einen Schluss, den sie nicht kommen sah — mit
 * offenen Positionen und ohne letzten Blick auf die Stops (echtes Risiko).
 *
 * Alpaca weiß beides exakt (`/v2/clock`). Die Ablesung wird in
 * `meta/alpacaClock` geteilt: EIN Abruf versorgt alle Instanzen, und die
 * Grenzpunkte (nextOpen/nextClose) erlauben es, den Zustand minutengenau
 * fortzuschreiben, ohne ständig neu zu fragen (`boersenOffenLautUhr`).
 *
 * Grundsatz: Die Uhr darf die Kalenderrechnung nur ÜBERSTEUERN, nie ersetzen.
 * Liefert sie `null` (nie abgelesen, zu alt, Wissen erschöpft), gilt die
 * eigene Rechnung — ein Broker-Ausfall darf den Scan nicht anhalten.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import {
  boersenOffenLautUhr,
  classify,
  marketOpenForClass,
  usSessionClass,
  type BoersenUhr,
} from '../../../shared/src/index.js';
import { alpacaUhr } from './alpacaBroker.js';
import { brokerVerbindungLesend } from './orderRouting.js';

const UHR_DOC = 'meta/alpacaClock';
/** Ablesungen jünger als 5 min werden nicht erneuert — der Scan-Takt reicht. */
const FRISCH_MS = 5 * 60_000;
const CACHE_MS = 60_000;

let cache: { bis: number; uhr: BoersenUhr | null } | null = null;

/** Für Tests: Prozess-Cache leeren. */
export function vergissBoersenUhr(): void {
  cache = null;
}

async function leseAblesung(jetztMs: number): Promise<BoersenUhr | null> {
  if (cache && cache.bis > jetztMs) return cache.uhr;
  try {
    const d = await getFirestore().doc(UHR_DOC).get();
    const uhr = d.exists ? (d.data() as BoersenUhr) : null;
    cache = { bis: jetztMs + CACHE_MS, uhr };
    return uhr;
  } catch (err) {
    // Transient — NICHT cachen, damit der nächste Aufruf es wieder versucht.
    logger.warn('Börsen-Uhr: meta/alpacaClock nicht lesbar', err);
    return null;
  }
}

/**
 * Zustand der US-Börse laut Broker-Uhr — `true`/`false`, oder `null`, wenn
 * keine belastbare Ablesung existiert (dann gilt die eigene Rechnung).
 */
export async function boersenOffen(jetztMs: number): Promise<boolean | null> {
  return boersenOffenLautUhr(await leseAblesung(jetztMs), jetztMs);
}

/**
 * Offen-Entscheidung je Symbol: Broker-Uhr für US-Session-Klassen,
 * eigene Kalenderrechnung für alles andere und als Fallback.
 */
export function offenMitUhr(sym: string, now: Date, uhrOffen: boolean | null): boolean {
  const kl = classify(sym);
  if (uhrOffen !== null && usSessionClass(kl)) return uhrOffen;
  return marketOpenForClass(kl, now);
}

/**
 * Uhr beim Broker ablesen und persistieren — höchstens alle 5 Minuten.
 *
 * Die Uhr ist für alle Konten identisch, also reicht IRGENDEINE lesende
 * Verbindung; probiert werden die übergebenen Konten der Reihe nach. Ohne
 * Verbindung oder bei Fehlern passiert bewusst nichts: Der Scan läuft dann
 * mit der eigenen Kalenderrechnung weiter, wie vor diesem Modul.
 */
export async function aktualisiereBoersenUhr(
  kontoUids: string[],
  jetztMs: number = Date.now(),
): Promise<void> {
  const alt = await leseAblesung(jetztMs);
  if (alt) {
    const at = Date.parse(alt.at);
    if (Number.isFinite(at) && jetztMs - at < FRISCH_MS) return;
  }
  for (const uid of kontoUids) {
    let verbindung;
    try {
      verbindung = await brokerVerbindungLesend(uid, jetztMs);
    } catch {
      continue;
    }
    if (!verbindung) continue;
    try {
      const ablesung = await alpacaUhr(verbindung.mode, verbindung.schluessel);
      if (!ablesung.nextOpen || !ablesung.nextClose) return;
      const uhr: BoersenUhr = { ...ablesung, at: new Date(jetztMs).toISOString() };
      cache = { bis: jetztMs + CACHE_MS, uhr };
      await getFirestore().doc(UHR_DOC).set(uhr);
      return;
    } catch (err) {
      logger.warn(`Börsen-Uhr über Konto ${uid} nicht ablesbar`, err);
    }
  }
}
