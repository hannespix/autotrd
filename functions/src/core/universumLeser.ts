/**
 * universumLeser — die Mitglieder-Sicht auf das gespeicherte Alpaca-Universum.
 *
 * `universumSync` legt täglich ab, welche Papiere der Broker wirklich handelt
 * (`meta/alpacaUniversum/bloecke/{i}`, in UNSERER Schreibweise, OTC bereits
 * ausgefiltert). Dieses Modul ist der LESER dazu — die eine Frage, die
 * Handeingabe, Watchlist-Prüfung und Scan gemeinsam haben (Stufe 3, Task 121):
 * Ist dieses Symbol ein echtes, handelbares Papier, auch wenn es nicht im
 * handverlesenen Katalog steht?
 *
 * ── Warum ein Cache mit Verfall ───────────────────────────────────────────
 *
 * Das Universum sind ~11.000 Einträge in einer Handvoll Blöcke. Sie bei jedem
 * Trade-Callable neu zu lesen wäre Verschwendung; sie für die Lebensdauer der
 * Instanz einzufrieren hieße, ein Delisting erst beim Kaltstart zu bemerken.
 * Dieselbe Abwägung wie beim Symbol-Cache der Broker-Grenze (Task 122):
 * begrenzte Frist, danach frisch lesen.
 *
 * ── Fail-safe: leer, nie kaputt ───────────────────────────────────────────
 *
 * Ist das Universum nicht lesbar (Sync lief nie, Firestore-Fehler), liefert
 * der Leser den letzten bekannten Stand oder die LEERE Menge. Leer bedeutet:
 * Es gilt wieder nur der Katalog — exakt das Verhalten vor Stufe 3. Ein
 * Lesefehler kann also nichts freischalten, nur die Erweiterung pausieren.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

/** Wie lange ein gelesener Stand gilt. Das Universum ändert sich täglich. */
export const UNIVERSUM_CACHE_MS = 30 * 60 * 1000;

/**
 * Symbole aus den rohen Block-Dokumenten ziehen — pur, damit die einzige
 * nicht-triviale Logik (defensives Lesen fremder Dokumentformen) testbar ist.
 */
export function symboleAusBloecken(bloecke: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const block of bloecke) {
    const liste = (block as { symbole?: unknown } | null | undefined)?.symbole;
    if (!Array.isArray(liste)) continue;
    for (const eintrag of liste) {
      const sym = (eintrag as { symbol?: unknown } | null | undefined)?.symbol;
      if (typeof sym === 'string' && sym.length > 0) out.add(sym);
    }
  }
  return out;
}

let cache: { symbole: ReadonlySet<string>; bis: number } | null = null;

/**
 * Alle Symbole des gespeicherten Universums — gecacht mit Verfall.
 *
 * Auch die LEERE Antwort wird gecacht: Lief der Sync noch nie, würde sonst
 * jeder Aufruf die Sammlung erneut abfragen, ohne dass sich vor dem nächsten
 * Sync-Lauf etwas ändern kann.
 */
export async function ladeUniversumSymbole(jetztMs = Date.now()): Promise<ReadonlySet<string>> {
  if (cache && jetztMs < cache.bis) return cache.symbole;
  try {
    const snap = await getFirestore().collection('meta/alpacaUniversum/bloecke').get();
    const symbole = symboleAusBloecken(snap.docs.map((d) => d.data()));
    cache = { symbole, bis: jetztMs + UNIVERSUM_CACHE_MS };
    return symbole;
  } catch (err) {
    logger.warn('Universum nicht lesbar — es gilt vorerst nur der Katalog', err);
    return cache?.symbole ?? new Set<string>();
  }
}
