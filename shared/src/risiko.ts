/**
 * Risiko-Bestätigung bei der Kontoanlage (Owner-Auftrag 22.08.).
 *
 * „Jeder soll bei der Anmeldung bestätigen, dass er auf eigenes Risiko
 *  handelt und die Risikohinweise gelesen hat. Ich will mich nicht
 *  angreifbar machen. Nur neue Kunden!"
 *
 * ── Warum eine VERSION und nicht bloss ein Häkchen ──────────────────────
 *
 * Ein gespeichertes `true` beweist nichts. Es sagt nicht, WOZU jemand
 * zugestimmt hat, und schon gar nicht, ob der Text damals derselbe war wie
 * heute. Deshalb hält der Vermerk die Fassung fest, der zugestimmt wurde.
 * Ändert sich der Risikohinweis inhaltlich, wird hier die Version
 * hochgezählt — dann ist an jedem Konto ablesbar, welchen Stand es
 * bestätigt hat.
 *
 * ── Warum das SERVERSEITIG sitzt ────────────────────────────────────────
 *
 * Ein Häkchen im Formular ist keine Zustimmung, sondern eine Anzeige.
 * Wer den Client umgeht, hätte sonst ein Konto ohne Bestätigung — und
 * genau dieses Konto wäre das Problem. Die Profil-Anlage verlangt die
 * Version deshalb selbst und legt ohne sie gar kein Konto an.
 *
 * ── „Nur neue Kunden" ───────────────────────────────────────────────────
 *
 * Die Prüfung sitzt HINTER dem Bestandskonto-Check der Profil-Anlage.
 * Wer schon ein Profil hat, wird nicht gefragt und nicht ausgesperrt —
 * dieselbe Regel wie bei der Zugangsstufe (`core/access.ts`, 26.07.):
 * additiv und idempotent, ohne den laufenden Betrieb anzufassen.
 */

/**
 * Fassung des Risikohinweises, der zugestimmt wird.
 *
 * Nur hochzählen, wenn sich der Hinweis INHALTLICH ändert — eine neue
 * Version verlangt von neuen Konten eine neue Zustimmung und macht alte
 * Vermerke als „zu einem anderen Stand" erkennbar. Für Tippfehler ist sie
 * nicht gedacht.
 */
export const RISIKO_VERSION = '2026-08-22';

/** Vermerk am Konto — was, wann, zu welcher Fassung. */
export interface RisikoVermerk {
  version: string;
  at: string;
}

/**
 * Ist das eine gültige Zustimmung zur AKTUELLEN Fassung?
 *
 * Bewusst streng auf Gleichheit: Eine Zustimmung zu einer älteren Fassung
 * ist eine Zustimmung zu einem anderen Text. Sie mag für den Bestand
 * gelten, aber sie legt kein neues Konto an.
 */
export function istAktuelleRisikoVersion(roh: unknown): roh is string {
  return typeof roh === 'string' && roh === RISIKO_VERSION;
}

/**
 * Vermerk aus einem User-Dokument lesen — `null`, wenn keiner dasteht.
 *
 * Streng geprüft, weil an diesem Feld eine Rechtsfrage hängt: Ein halb
 * geschriebener Vermerk darf nicht als Zustimmung durchgehen.
 */
export function leseRisikoVermerk(roh: unknown): RisikoVermerk | null {
  if (typeof roh !== 'object' || roh === null) return null;
  const v = roh as { version?: unknown; at?: unknown };
  if (typeof v.version !== 'string' || v.version.length === 0) return null;
  if (typeof v.at !== 'string' || v.at.length === 0) return null;
  return { version: v.version, at: v.at };
}
