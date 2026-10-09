/**
 * Anzeige-Kopie der KI-Einordnungen nach `users/{uid}/kiAnzeige/{sym}` (Task 22).
 *
 * JE KONTO, nicht in `market/**` (Red-Team 09.10.): Die KI beurteilt nur
 * Symbole, die ein Teilnehmer beobachtet oder hält. Eine gemeinsame Kopie
 * verriete deshalb jedem angemeldeten Nutzer Watchlist und Depot der
 * Teilnehmer. Jedes Konto bekommt nur die Einordnungen zu SEINEN Symbolen.
 *
 * Läuft am ENDE von runKiNachrichten, nach Urteilen, Budget und Stand; der
 * Aufrufer fängt jeden Fehler ab, und jedes Symbol ist zusätzlich einzeln
 * abgesichert. Was hier ausfällt oder an der Zeitgrenze liegen bleibt, holt
 * der nächste Lauf nach (Rückblick, `kiAnzeigeMischen` ist idempotent).
 *
 * Was in die Kopie darf, entscheidet allein die Whitelist in
 * shared/src/kiAnzeige.ts — kein Freitext, keine Schlagzeile, keine Kurse.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import {
  KI_ANZEIGE_V,
  kiAnzeigeEintrag,
  kiAnzeigeMischen,
  type KiAnzeigeEintrag,
} from '../../../shared/src/index.js';

/** Höchstens so viele Urteile je Lauf (die NEUESTEN — absteigend sortiert). */
const MAX_URTEILE = 400;
/** Katalog-Symbole (BTC-USD, ^GSPC, EURUSD=X …) — nie „.“/„..“, nie „/“. */
const SYMBOL = /^(?!\.{1,2}$)[A-Za-z0-9.^=-]{1,24}$/;
/** Unter dieser Restzeit wird nichts Neues mehr begonnen. */
const MIN_REST_MS = 15_000;

export interface KiAnzeigeAuftrag {
  seitIso: string;
  jetztIso: string;
  /** Relevante Symbole je Konto; ohne diese Zuordnung wird nichts geschrieben. */
  jeKonto: Map<string, Set<string>> | null;
  restMs: () => number;
}

/** Gibt die Zahl der geschriebenen Dokumente zurück. */
export async function kiAnzeigeAktualisieren(db: Firestore, a: KiAnzeigeAuftrag): Promise<number> {
  if (!a.jeKonto || a.jeKonto.size === 0) return 0;
  const snap = await db.collection('kiUrteile')
    .where('decidedAt', '>=', a.seitIso)
    .orderBy('decidedAt', 'desc')
    .limit(MAX_URTEILE)
    .get();
  const je = new Map<string, KiAnzeigeEintrag[]>();
  for (const d of snap.docs) {
    const daten = d.data() as Record<string, unknown>;
    const symbol = daten['symbol'];
    if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) continue;
    const e = kiAnzeigeEintrag(d.id, daten);
    if (!e) continue;
    je.set(symbol, [...(je.get(symbol) ?? []), e]);
  }
  let geschrieben = 0;
  for (const [uid, symbole] of a.jeKonto) {
    for (const symbol of symbole) {
      const neu = je.get(symbol);
      if (!neu || !SYMBOL.test(symbol)) continue;
      if (a.restMs() < MIN_REST_MS) return geschrieben;
      try {
        const ref = db.doc(`users/${uid}/kiAnzeige/${symbol}`);
        const alt = (await ref.get()).get('verlauf') as unknown;
        const verlauf = kiAnzeigeMischen(alt, neu);
        // Unverändert ⇒ kein Schreibvorgang (der Rückblick liest Urteile mehrfach).
        if (JSON.stringify(verlauf) === JSON.stringify(kiAnzeigeMischen(alt, []))) continue;
        await ref.set({ v: KI_ANZEIGE_V, at: a.jetztIso, verlauf });
        geschrieben += 1;
      } catch (err) {
        logger.warn(`kiAnzeige: ${symbol} nicht geschrieben`, err);
      }
    }
  }
  return geschrieben;
}
