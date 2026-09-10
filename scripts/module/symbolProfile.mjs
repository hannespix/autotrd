/**
 * Symbolprofil nach Firestore (`meta/symbolProfile`) — reine Logik ohne
 * SDK, damit sie mit dem Firestore-Fake der Functions-Tests prüfbar ist
 * (`functions/test/fakes/firestore.ts`). `publish-profile.mjs` ruft sie mit
 * dem echten Admin-SDK auf.
 *
 * Was hier geprüft wird, bevor etwas geschrieben wird:
 *   - Format: `version` 1, `profile` als Liste von Einträgen mit `symbol`
 *     und `taktik` (das Frontend liest genau diese Felder; ein anderes
 *     Format wird abgelehnt, nie geraten — wie bei `meta/champion`).
 *   - Größe: EIN Dokument, höchstens `MAX_PROFIL_BYTES` (Firestore deckelt
 *     Dokumente bei 1 MiB; 40 Symbole sind rund 40 kB — die Grenze ist eine
 *     Notbremse gegen ein aufgeblähtes Format, keine Erwartung).
 *   - Inhalt: keine Konto- oder Nutzerdaten. Das Profil ist plattformweit
 *     dasselbe (Universum, Champion, Marktdaten) und liegt deshalb wie
 *     `meta/champion` in der öffentlichen Allowlist der Rules.
 */

import { Buffer } from 'node:buffer';

export const SYMBOL_PROFILE_PFAD = 'meta/symbolProfile';
/** Notbremse unter Firestores 1-MiB-Grenze — derselbe Rand wie beim Optimierer-Bericht. */
export const MAX_PROFIL_BYTES = 900_000;

/**
 * Format prüfen. Gibt den Fehlertext zurück oder null, wenn das Profil
 * veröffentlicht werden darf.
 * @param {unknown} roh
 * @returns {string | null}
 */
export function pruefeProfil(roh) {
  if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) return 'profile.json ist kein Objekt';
  const p = /** @type {Record<string, unknown>} */ (roh);
  if (p.version !== 1) return `unbekannte Profil-Version ${String(p.version)} — Datei prüfen statt überschreiben`;
  if (typeof p.generatedAt !== 'number' || !Number.isFinite(p.generatedAt)) return 'generatedAt fehlt';
  if (!Array.isArray(p.profile)) return 'profile ist keine Liste';
  for (const [i, e] of p.profile.entries()) {
    if (typeof e !== 'object' || e === null) return `profile[${i}] ist kein Objekt`;
    const x = /** @type {Record<string, unknown>} */ (e);
    if (typeof x.symbol !== 'string' || x.symbol.length === 0) return `profile[${i}] ohne symbol`;
    if (typeof x.taktik !== 'object' || x.taktik === null) return `profile[${i}] (${x.symbol}) ohne taktik`;
    const q = /** @type {Record<string, unknown>} */ (x.taktik).quelle;
    if (q !== 'champion' && q !== 'basis' && q !== 'config' && q !== 'keine') return `profile[${i}] (${x.symbol}): taktik.quelle ${String(q)} unbekannt`;
  }
  const doppelt = p.profile.map((e) => /** @type {{symbol: string}} */ (e).symbol).filter((s, i, all) => all.indexOf(s) !== i);
  if (doppelt.length > 0) return `doppelte Symbole: ${[...new Set(doppelt)].join(', ')}`;
  return null;
}

/** Bytes des Dokuments als JSON — Näherung für Firestores Größenrechnung. */
export function profilBytes(doc) {
  return Buffer.byteLength(JSON.stringify(doc), 'utf8');
}

/**
 * Das Dokument, das nach `meta/symbolProfile` geht: das Profil unverändert
 * plus `publishedAt`. Wirft bei falschem Format oder Übergröße.
 * @param {unknown} profil
 * @param {unknown} publishedAt — Firestore-Timestamp (oder ein Fake im Test)
 */
export function profilDokument(profil, publishedAt) {
  const fehler = pruefeProfil(profil);
  if (fehler !== null) throw new Error(`Symbolprofil nicht veröffentlicht: ${fehler}`);
  const doc = { .../** @type {Record<string, unknown>} */ (profil), publishedAt };
  const bytes = profilBytes({ ...doc, publishedAt: null });
  if (bytes > MAX_PROFIL_BYTES) {
    throw new Error(`Symbolprofil nicht veröffentlicht: ${bytes} Bytes über der Grenze von ${MAX_PROFIL_BYTES} — ein Dokument je Symbol wäre der nächste Schritt`);
  }
  return { doc, bytes };
}

/** Kurzfassung für das Job-Log — keine Kursdaten, nur was man beim Prüfen sehen will. */
export function profilZusammenfassung(profil) {
  const p = /** @type {{ generatedAt: number; now?: number; lauf?: Record<string, unknown>; profile: Array<{ symbol: string; taktik: { quelle: string; einstiege: string | null } }> }} */ (profil);
  const je = {};
  for (const e of p.profile) je[e.taktik.quelle] = (je[e.taktik.quelle] ?? 0) + 1;
  return {
    generatedAt: p.generatedAt,
    now: p.now ?? null,
    lauf: p.lauf ?? null,
    symbole: p.profile.length,
    taktiken: je,
    gesperrt: p.profile.filter((e) => e.taktik.einstiege === 'gesperrt').map((e) => e.symbol),
    ziel: SYMBOL_PROFILE_PFAD,
  };
}

/**
 * Schreiben — gegen den minimalen Firestore-Vertrag (`doc(path).set(data)`),
 * den das Admin-SDK und der Test-Fake gleichermaßen erfüllen.
 * @param {{ doc: (path: string) => { set: (data: Record<string, unknown>) => Promise<unknown> } }} db
 * @param {unknown} profil
 * @param {unknown} publishedAt
 */
export async function veroeffentlicheProfil(db, profil, publishedAt) {
  const { doc, bytes } = profilDokument(profil, publishedAt);
  await db.doc(SYMBOL_PROFILE_PFAD).set(doc);
  return { pfad: SYMBOL_PROFILE_PFAD, bytes, symbole: /** @type {{ profile: unknown[] }} */ (profil).profile.length };
}
