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
 * gefährlichste Ausfalltyp überhaupt: Mit dem Scan sterben ATR-Stops,
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
 * JEDEM Lauf gestempelt, auch wenn der Scan wegen geschlossener Märkte früh
 * aussteigt (Skip-Pfad). `lastScanAt` gibt es nur bei vollen Läufen — ein
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
 * Ab wann der Scan als „steht" gilt.
 *
 * Der Takt ist 5 Minuten; 20 Minuten sind vier verpasste Läufe. Ein einzelner
 * langsamer Lauf (Timeout 180 s) oder ein Deploy-Fenster reißt die Schwelle
 * nicht — vier ausgefallene Läufe in Folge tun es nie aus Versehen.
 */
export const SCAN_TOT_MIN = 20;

/**
 * Ab wie vielen Komplett-Fehlschlägen die Kursquelle als gestört gilt.
 *
 * Ein einzelnes kaputtes Symbol ist Alltag (Delisting, Tippfehler in der
 * Watchlist). Wenn aber ein voller Lauf NULL Kurse und mindestens fünf
 * Fehler liefert, ist nicht das Symbol krank, sondern die Quelle — das
 * Yahoo-Bann-Szenario, in dem kein einziger Paper-Stop mehr auslösen kann.
 */
export const KURSQUELLE_MIN_FEHLER = 5;

export function bewerteHerzschlag(e: HerzschlagEingabe): HerzschlagUrteil {
  const ms = e.lastRunAt ? Date.parse(e.lastRunAt) : Number.NaN;
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      grund: 'kein_heartbeat',
      text: 'Noch nie ein Scan-Heartbeat — Scheduler-Job prüfen (existiert scanMarket im Cloud Scheduler?).',
    };
  }

  const minutenAlt = Math.round((e.jetztMs - ms) / 60_000);
  if (minutenAlt > SCAN_TOT_MIN) {
    return {
      ok: false,
      grund: 'scan_steht',
      minutenAlt,
      text:
        `Kein Scan-Lauf seit ${minutenAlt} Minuten (Takt: 5) — Stops, Trailing und `
        + 'Notbremse werden nicht mehr geprüft. Scheduler/Deploy kontrollieren.',
    };
  }

  // Kursquelle: nur bewerten, wenn der letzte Lauf ein VOLLER war. Nach
  // einem Skip-Lauf stammen symbolsOk/symbolsFailed noch vom vorletzten
  // Lauf — auf alten Zahlen zu alarmieren wäre ein Fehlalarm mit Ansage.
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
        `Der letzte Scan lief, aber 0 von ${e.symbolsFailed} Symbolen lieferten Kurse — `
        + 'Kursquelle gestört (Yahoo-Bann?). Ohne Kurse löst kein Software-Stop aus.',
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

/* ── Untätigkeits-Wächter (05.10.) ───────────────────────────────────────────
 *
 * Der Neubau stand wochenlang auf „30 bewertet · 0 Einstiegswunsch", und das
 * sah aus wie Normalbetrieb. Der Herzschlag oben merkt das nicht: Der Scan
 * läuft ja. Diese zweite Frage — „handelt das System überhaupt?" — bekommt
 * deshalb ein eigenes Urteil und ein eigenes Feld (`meta/health.aktivitaet`),
 * NICHT den Herzschlag-Alarm: `healthz` soll bei einem ruhigen Markt nicht
 * mit 503 antworten und den externen Uptime-Check auslösen.
 */

/** Ab diesem Alter gilt die Trade-Zählung als nicht mehr belastbar. */
export const AKTIVITAET_MAX_ALTER_STD = 48;

export interface AktivitaetEingabe {
  jetztMs: number;
  /** `meta/health.konten.gehandelt` — Konten, die den Handelspfad tatsächlich durchliefen. */
  laufend?: number | undefined;
  /** `meta/health.trading.trades7t` — geschlossene Trades der letzten 7 Tage. */
  trades7t?: number | undefined;
  /** `meta/health.trading.at` — wann die Zählung entstand. */
  zaehlungAt?: string | undefined;
}

export interface AktivitaetUrteil {
  ok: boolean;
  text: string;
}

/**
 * Alarm, wenn Engines laufen, aber sieben Tage lang kein Trade geschlossen
 * wurde. Ohne laufende Engine oder ohne frische Zählung gibt es kein Urteil
 * (ok) — ein Wächter, der aus fehlenden Daten Alarm macht, wird abgeschaltet.
 */
export function bewerteAktivitaet(e: AktivitaetEingabe): AktivitaetUrteil {
  const laufend = e.laufend ?? 0;
  if (!(laufend > 0)) return { ok: true, text: 'Keine Engine an — nichts zu erwarten.' };
  const at = e.zaehlungAt ? Date.parse(e.zaehlungAt) : Number.NaN;
  if (!Number.isFinite(at) || e.jetztMs - at > AKTIVITAET_MAX_ALTER_STD * 3_600_000) {
    return { ok: true, text: 'Trade-Zählung nicht frisch — kein Urteil.' };
  }
  if ((e.trades7t ?? 0) === 0) {
    return {
      ok: false,
      text:
        `${laufend} Engine(s) an, aber seit 7 Tagen kein geschlossener Trade — `
        + 'Einstiegs-Sperren im Heartbeat (gate) prüfen. Das System handelt nicht.',
    };
  }
  return { ok: true, text: `${e.trades7t} geschlossene Trades in 7 Tagen.` };
}

/** Was in `meta/health.aktivitaet` steht. */
export interface AktivitaetZustand {
  aktiv: boolean;
  text: string;
  /** Wann der AKTUELLE Alarm begann — bleibt über die Ticks stehen. */
  seit?: string | undefined;
  at: string;
}

export function naechsterAktivitaetsZustand(
  vorher: AktivitaetZustand | undefined,
  urteil: AktivitaetUrteil,
  jetztIso: string,
): AktivitaetZustand {
  if (urteil.ok) return { aktiv: false, text: urteil.text, at: jetztIso };
  const seit = vorher?.aktiv && vorher.seit ? vorher.seit : jetztIso;
  return { aktiv: true, text: urteil.text, seit, at: jetztIso };
}

/* ── Nachrichten-Sammler (KI-Kaskade Stufe 1, 05.10.) ────────────────────────
 *
 * Dritte Frage, drittes Feld (`meta/health.nachrichten`): Kommt der
 * Nachrichtenstrom an? Das Red-Team zeigte zwei Arten, auf die der Sammler
 * stehen kann, ohne dass ein einzelner Lauf scheitert: ein Rückstand, der
 * nicht abnimmt, und Läufe, die abwechselnd gelingen und scheitern. Beides
 * fängt nur ein Blick von außen — Alter des letzten Erfolgs und Abstand zur
 * Gegenwart. Wie bei der Untätigkeit NICHT im Herzschlag-Alarm: Ohne
 * Nachrichten handelt das System weiter, `healthz` bleibt grün.
 */

/** So lange darf der letzte erfolgreiche Lauf her sein (Takt 5 min). */
export const NACHRICHTEN_STILL_MAX_MIN = 30;
/** So weit darf der Sammler hinter der Gegenwart liegen. */
export const NACHRICHTEN_RUECKSTAND_MAX_S = 2 * 3600;

export interface NachrichtenEingabe {
  jetztMs: number;
  letzterLauf?: string | undefined;
  letzterErfolg?: string | undefined;
  grund?: string | null | undefined;
  rueckstandS?: number | null | undefined;
  fehlerFolge?: number | undefined;
}

/** So lange darf der Ereigniskanal für Ausführungen ohne Lebenszeichen bleiben. */
export const FILLSYNC_STILL_MAX_MIN = 30;

export interface FillSyncEingabe {
  jetztMs: number;
  /** `meta/health.fillSync.at` — letzter Lauf des Ereigniskanals. */
  at?: string | undefined;
  /** `meta/health.fillSync.fehler` — Fehler im letzten Lauf. */
  fehler?: number | undefined;
}

/**
 * Vierte Frage, viertes Feld (`meta/health.fillSync`, Drift-Paket 2):
 * Läuft der Ereigniskanal, der Ausführungen des Brokers ins Buch holt?
 * Steht er, wandert jede verpasste Ausführung wieder in den Fremdbestand
 * — genau der Zustand, den er beenden soll. Fehler im Lauf sind kein
 * Alarm für sich (ein Konto mit Netzfehler wiederholt im nächsten Lauf),
 * aber sie stehen im Text.
 */
export function bewerteFillSync(e: FillSyncEingabe): AktivitaetUrteil {
  if (!e.at) return { ok: true, text: 'Ereigniskanal lief noch nie — kein Urteil.' };
  const at = Date.parse(e.at);
  if (!Number.isFinite(at) || e.jetztMs - at > FILLSYNC_STILL_MAX_MIN * 60_000) {
    const min = Number.isFinite(at) ? Math.round((e.jetztMs - at) / 60_000) : null;
    return {
      ok: false,
      text: `Ereigniskanal (fillSync) ${min === null ? 'noch nie' : `seit ${min} min nicht`} gelaufen — Ausführungen des Brokers erreichen das Buch nur noch über den Scan.`,
    };
  }
  return { ok: true, text: `Ereigniskanal läuft${(e.fehler ?? 0) > 0 ? ` (${e.fehler} Fehler im letzten Lauf)` : ''}.` };
}

export function bewerteNachrichten(e: NachrichtenEingabe): AktivitaetUrteil {
  if (!e.letzterLauf) return { ok: true, text: 'Nachrichten-Sammler lief noch nie — kein Urteil.' };
  if (e.grund === 'keine_schluessel') {
    return { ok: false, text: 'Nachrichten-Sammler ohne Alpaca-Schlüssel — es wird nichts gesammelt.' };
  }
  const erfolg = e.letzterErfolg ? Date.parse(e.letzterErfolg) : Number.NaN;
  if (!Number.isFinite(erfolg) || e.jetztMs - erfolg > NACHRICHTEN_STILL_MAX_MIN * 60_000) {
    const min = Number.isFinite(erfolg) ? Math.round((e.jetztMs - erfolg) / 60_000) : null;
    return {
      ok: false,
      text:
        `Nachrichten-Sammler ${min === null ? 'noch nie' : `seit ${min} min nicht`} erfolgreich `
        + `(${e.fehlerFolge ?? 0} Fehlschläge in Folge) — Stand in meta/nachrichtenStand prüfen.`,
    };
  }
  if ((e.rueckstandS ?? 0) > NACHRICHTEN_RUECKSTAND_MAX_S) {
    return {
      ok: false,
      text:
        `Nachrichten-Sammler liegt ${Math.round(((e.rueckstandS ?? 0) / 3600) * 10) / 10} h hinter der Gegenwart `
        + `(${e.fehlerFolge ?? 0} Fehlschläge in Folge) — Rückstand wird abgebaut oder steht.`,
    };
  }
  return { ok: true, text: 'Nachrichten-Sammler läuft.' };
}
