/**
 * Struktur-Prüfung des ALT-Payloads `{ strategy }` (Übergang).
 *
 * Bis zum Umbau auf `settings.auto` prüfte diese Datei das komplette flache
 * Strategie-Schema Feld für Feld — Hebel, Sockel, Konfluenz, Kostenschwelle.
 * Der Auto-Trader liest aus `settings.strategy` nur noch EIN Feld,
 * `engine.running` (Start/Stop-Schalter der Engine); die alten
 * Handelsparameter sind Altdaten ohne Wirkung (`autoSettingsFromLegacy`
 * leitet daraus einmalig Risiko-Werte ab). Geprüft wird deshalb nur noch,
 * was gelesen wird: ein Objekt, kein verschachteltes Alt-Alt-Schema
 * (strategy/indices/risk_management/execution — die bekannte kaputte
 * Variante darf nie wieder gespeichert werden), `engine` als Objekt und
 * `engine.running` als Boolean. Pure Funktion, keine Laufzeit-Abhängigkeiten.
 *
 * ── Meldungen sind CODES, keine Prosa (Sprachumschalter Phase 3) ──────────
 *
 * Jedes Problem hat die Form `val.<muster>|<feld>|<p1>|<p2>` — Parameter
 * enthalten nie ein `|`. Der Klartext (Deutsch ODER Englisch) entsteht erst
 * im Frontend (`valText` in i18n.ts); dieselben Codes wirft die Callable als
 * HttpsError, `serverText` löst sie dort auf. Das Feld steht IMMER als erster
 * Parameter im Code, damit Logs und Tests greifbar bleiben. Dasselbe Format
 * nutzt `validateAutoSettings` (autoSettings.ts) für das neue Schema.
 */

/** Bekannte Schlüssel der kaputten Alt-Alt-Struktur — hart verboten. */
const LEGACY_KEYS = ['strategy', 'indices', 'risk_management', 'execution'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Prüft, ob `value` als Alt-Strategie LESBAR ist. Liefert eine Liste von
 * Problem-CODES (Kopf dieser Datei); leer ⇒ `engine.running` ist auswertbar.
 */
export function validateStrategy(value: unknown): string[] {
  if (!isRecord(value)) return ['val.keinObjekt'];

  const problems: string[] = [];
  for (const key of LEGACY_KEYS) {
    if (key in value) problems.push(`val.altSchema|${key}`);
  }
  if (!('engine' in value)) problems.push('val.pflichtFehlt|engine');
  if (problems.length > 0) return problems;

  if (!isRecord(value.engine)) return ['val.objekt|engine'];
  if (typeof value.engine.running !== 'boolean') problems.push('val.boolean|engine.running');
  return problems;
}

/**
 * Der Engine-Schalter aus einem Alt-Payload — `undefined`, wenn das Payload
 * die Struktur-Prüfung nicht besteht. Der einzige Wert, den der Auto-Trader
 * aus `settings.strategy` übernimmt.
 */
export function engineRunningAus(value: unknown): boolean | undefined {
  if (validateStrategy(value).length > 0) return undefined;
  return (value as { engine: { running: boolean } }).engine.running;
}
