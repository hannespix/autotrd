/**
 * Totmann-Wächter: merkt das System selbst, dass es steht?
 *
 * ── Der Befund (Audit 13.08., K-4) ────────────────────────────────────────
 *
 * `meta/health.lastScanAt` wurde bei jedem Lauf geschrieben — aber NICHTS
 * prüfte dessen Alter. `healthz` antwortete statisch `ok: true` und bewies
 * damit nur, dass die Function deployt ist, nicht dass der Scheduler feuert.
 * Ein stehender Scheduler sah von außen aus wie ein ruhiger Markt. Das ist
 * kein theoretisches Risiko: In der Projekthistorie fehlte der
 * Scheduler-Job einmal WOCHENLANG, und es fiel erst auf, als der Owner
 * leere Dashboards meldete.
 *
 * Für ein System, das unbeaufsichtigt Positionen hält, ist das der
 * gefährlichste Ausfalltyp überhaupt: Mit dem Takt sterben Trailing-Stops,
 * Take-Profit, Trailing-Nachzug und die Notbremsen-Prüfung — und niemand
 * ruft an.
 *
 * ── Die Konstruktion ──────────────────────────────────────────────────────
 *
 * Die Bewertung ist PUR und lebt hier, weil sie an drei Stellen dieselbe
 * Antwort geben muss:
 *   1. `healthz` (HTTP): antwortet 503, wenn der Herzschlag steht — damit
 *      schlägt der EXTERNE Uptime-Check an. Das ist die einzige Schicht,
 *      die auch dann lebt, wenn der komplette Scheduler tot ist.
 *   2. Der `wachhund`-Scheduler: schreibt den Alarm nach `meta/health.alarm`
 *      und ins Error-Log (Log-basierte Alerts).
 *   3. Das Dashboard: rechnet dasselbe Urteil aus `lastRunAt` clientseitig —
 *      unabhängig davon, ob Wächter-Function und Log-Alert existieren.
 *
 * Als Herzschlag dient `lastRunAt`, nicht `lastScanAt`: `lastRunAt` wird bei
 * JEDEM Takt gestempelt, auch wenn er wegen geschlossener Märkte oder
 * gehaltener Lease früh aussteigt (Skip-Pfad). `lastScanAt` gibt es nur bei
 * vollen Läufen — ein
 * Wochenende ohne Krypto in den Watchlists würde sonst Fehlalarme werfen.
 */

/** Auszug aus `meta/health`, den die Bewertung braucht. */
export interface HerzschlagEingabe {
  jetztMs: number;
  /** Jeder Lauf stempelt das — auch der Skip-Pfad (scanMarket). */
  lastRunAt?: string | undefined;
  /** Nur volle Läufe; `null` heißt: der letzte Lauf war ein voller. */
  lastRunSkipped?: string | null | undefined;
  /** Symbole des letzten VOLLEN Laufs, die Kurse geliefert haben. */
  symbolsOk?: number | undefined;
  /** Symbole des letzten vollen Laufs, die gescheitert sind. */
  symbolsFailed?: number | undefined;
}

export type AlarmGrund = 'kein_heartbeat' | 'scan_steht' | 'kursquelle_gestoert';

export interface HerzschlagUrteil {
  ok: boolean;
  grund?: AlarmGrund;
  /** Alter des letzten Laufs in Minuten (gerundet), wenn bekannt. */
  minutenAlt?: number;
  /** Deutscher Satz für Log, healthz-Antwort und Dashboard. */
  text: string;
}

/**
 * Ab wann der Engine-Takt als „steht" gilt.
 *
 * Der Takt ist EINE Minute (`engineTick`), und er stempelt den Herzschlag auch
 * dann, wenn er wegen geschlossener Märkte oder gehaltener Lease früh aussteigt
 * — ein frischer `lastRunAt` heißt also wirklich „die Function lebt". Zehn
 * Minuten sind neun verpasste Läufe: Ein Deploy-Fenster oder ein langsamer Lauf
 * reißt die Schwelle nicht, ein echter Ausfall schon. Tiefer zu gehen bringt
 * nichts, weil der Wächter selbst nur alle zehn Minuten läuft.
 *
 * (Vorher 20 Minuten für den 5-Minuten-Scan des Vorgängers.)
 */
export const TAKT_TOT_MIN = 10;

/**
 * Ab wie vielen Komplett-Fehlschlägen die Kursquelle als gestört gilt.
 *
 * Ein einzelnes kaputtes Symbol ist Alltag (Delisting, Schreibweise). Wenn aber
 * ein voller Takt NULL Kurse und mindestens fünf Fehler liefert, ist nicht das
 * Symbol krank, sondern die Quelle: abgelaufener Datenkey, Alpaca-Störung,
 * gesperrter Feed. Dann entscheidet niemand mehr — Einstiege fallen aus, und
 * Trailing-Stops werden nicht mehr nachgezogen.
 */
export const KURSQUELLE_MIN_FEHLER = 5;

export function bewerteHerzschlag(e: HerzschlagEingabe): HerzschlagUrteil {
  const ms = e.lastRunAt ? Date.parse(e.lastRunAt) : Number.NaN;
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      grund: 'kein_heartbeat',
      text: 'Noch nie ein Takt-Heartbeat — Scheduler-Job prüfen (existiert engineTick im Cloud Scheduler?).',
    };
  }

  const minutenAlt = Math.round((e.jetztMs - ms) / 60_000);
  if (minutenAlt > TAKT_TOT_MIN) {
    return {
      ok: false,
      // Der Code bleibt `scan_steht`: Er steht in `meta/health.alarm` und wird
      // dort verglichen — ein neuer Wert hieße für einen laufenden Alarm „neue
      // Ursache" und löste eine zweite Benachrichtigung aus.
      grund: 'scan_steht',
      minutenAlt,
      text:
        `Kein Engine-Takt seit ${minutenAlt} Minuten (Takt: 1 Minute) — Trailing, `
        + 'Signal-Exits und Notbremse werden nicht mehr geprüft; Schutz-Stops liegen '
        + 'beim Broker und greifen weiter. Scheduler/Deploy kontrollieren.',
    };
  }

  // Kursquelle: nur bewerten, wenn der letzte Takt ein VOLLER war. Nach
  // einem Skip-Takt (Markt zu, Lease gehalten) stammen symbolsOk/symbolsFailed
  // noch vom vorletzten — auf alten Zahlen zu alarmieren wäre ein Fehlalarm.
  if (
    e.lastRunSkipped == null
    && e.symbolsOk === 0
    && (e.symbolsFailed ?? 0) >= KURSQUELLE_MIN_FEHLER
  ) {
    return {
      ok: false,
      grund: 'kursquelle_gestoert',
      minutenAlt,
      text:
        `Der letzte Takt lief, aber 0 von ${e.symbolsFailed} Symbolen lieferten Kurse — `
        + 'Kursquelle gestört (Datenkey, Alpaca-Störung?). Ohne Kurse entscheidet '
        + 'die Engine nicht: keine Einstiege, kein Trailing.',
    };
  }

  return { ok: true, minutenAlt, text: `Letzter Lauf vor ${Math.max(0, minutenAlt)} min.` };
}

/** Was in `meta/health.alarm` steht. */
export interface AlarmZustand {
  aktiv: boolean;
  grund?: AlarmGrund | undefined;
  text: string;
  /** Wann der AKTUELLE Alarm begann — bleibt über die Ticks stehen. */
  seit?: string | undefined;
  /** Letzte Bewertung. */
  at: string;
}

/**
 * Alarm-Übergang: neuer Zustand aus altem Zustand + frischem Urteil.
 *
 * `seit` bleibt stehen, solange derselbe Grund anhält — „Alarm seit 04:32"
 * ist die Information, die man beim Aufwachen braucht; ein `seit`, das bei
 * jedem 10-Minuten-Tick weiterspringt, wäre wertlos. Ein Grund-Wechsel
 * (scan_steht → kursquelle_gestoert) ist ein NEUER Alarm und setzt neu.
 */
export function naechsterAlarm(
  vorher: AlarmZustand | undefined,
  urteil: HerzschlagUrteil,
  jetztIso: string,
): AlarmZustand {
  if (urteil.ok) {
    return { aktiv: false, text: urteil.text, at: jetztIso };
  }
  const seit =
    vorher?.aktiv && vorher.grund === urteil.grund && vorher.seit ? vorher.seit : jetztIso;
  return { aktiv: true, grund: urteil.grund, text: urteil.text, seit, at: jetztIso };
}
