/**
 * Zugangsstufen (Owner-Auftrag 26.07.) — Firebase-Seite.
 *
 * „Registrierung nicht für jeden frei. Ohne Freischaltung soll man das Tool
 *  sehen, aber die Engine nicht starten."
 *
 * Dieselbe Regel gilt bereits in der Supabase-Datenbank (Migration 0006).
 * Bis zur Umschaltung läuft der Betrieb aber auf Firebase — ohne diesen
 * Riegel könnte sich hier jeder registrieren und sofort handeln.
 *
 * ZWEI Entscheidungen, die man kennen muss:
 *
 * 1. Das Feld liegt als `accessLevel` auf OBERSTER Ebene des User-Dokuments,
 *    NICHT unter `settings`. Die Firestore-Regeln erlauben dem Client
 *    Updates ausschließlich auf `settings` — läge die Stufe dort, könnte
 *    sich jeder mit einem Einzeiler selbst freischalten.
 *
 * 2. FEHLENDES Feld gilt als freigeschaltet. Das ist Absicht: Bestehende
 *    Konten (der Owner selbst) haben das Feld nicht und dürfen durch diese
 *    Änderung nicht ausgesperrt werden. Neu angelegte Profile bekommen
 *    ausdrücklich 'pending' — die Sperre wirkt also ab sofort für jeden
 *    Neuzugang, ohne den laufenden Betrieb anzufassen (additiv + idempotent,
 *    CLAUDE.md §9).
 */

export type AccessLevel = 'pending' | 'approved' | 'blocked';

/** Stufe aus einem User-Dokument lesen; fehlend = Bestandskonto = frei. */
export function accessLevelOf(data: Record<string, unknown> | undefined): AccessLevel {
  const raw = (data?.accessLevel ?? 'approved') as string;
  return raw === 'pending' || raw === 'blocked' ? raw : 'approved';
}

/**
 * Darf dieses Konto handeln (Engine starten, Orders auslösen)?
 * EINE Wahrheit für Scan, Callables und UI — nie einzeln nachbauen.
 */
export function mayTrade(data: Record<string, unknown> | undefined): boolean {
  return accessLevelOf(data) === 'approved';
}

/** Verständlicher Grund für die Oberfläche bzw. die Fehlermeldung. */
export function accessDeniedReason(level: AccessLevel): string {
  return level === 'blocked'
    ? 'Dieses Konto wurde gesperrt. Bitte wende dich an den Betreiber.'
    : 'Dein Zugang wird noch geprüft. Bis zur Freischaltung kannst du alles ansehen, '
      + 'aber nicht handeln — du bekommst Bescheid, sobald es so weit ist.';
}
