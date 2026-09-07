/**
 * Konto-Tore — die Sperren eines Kontos aus seinem gespeicherten Zustand
 * (Audit 13.08., Hochbefunde H2/H3; seit dem Rückbau der Handelsplattform
 * die EINE Stelle, an der ein Order-Pfad sie abfragt).
 *
 * ── Der Befund, der sie entstehen ließ ────────────────────────────────────
 *
 * Der alte Scan prüfte vor jedem Einstieg Notbremse und Abgleich-Sperre —
 * die anderen Order-Pfade taten es nicht. Ein Konto, das der Scan längst
 * gesperrt hatte, bekam am selben Tag anderswo Käufe — der eigene Leitsatz
 * der Notbremse („eine Bremse, die man umgehen kann, ist keine") war
 * verletzt. Seitdem gibt es die Entscheidung genau einmal, hier.
 *
 * ── Warum aus dem VERMERK statt live gerechnet ────────────────────────────
 *
 * `snapshotEquity` schreibt täglich die Bezugsgröße der Notbremse ans
 * User-Dokument (`risk.vortagEquity*`); ein ausgelöster Breaker und der
 * Abgleich-Vermerk stehen daneben (`risk.breaker*`, `risk.abgleich`). Was
 * hier zählt, ist der ZUSTAND der Sperren — nicht eine Neuvermessung mit
 * frischen Kursen.
 *
 * Exits durchlaufen die Einstiegs-Tore NIE (CLAUDE.md §0.4): Eine offene
 * Position muss schließbar bleiben, gerade wenn das Konto brennt.
 */

import { pruefeBreaker, resetLaeuft, type Strategy } from '../../../shared/src/index.js';

/**
 * Wie lange ein Konto-Abgleich-Vermerk nachwirkt (Stunden).
 *
 * 24 Stunden überbrücken Wochenenden und Ausfälle der Broker-API, ohne dass
 * eine uralte Zahl ewig weiterklemmt. Nach Ablauf gilt der Vermerk als
 * verfallen und sperrt nicht mehr.
 */
export const KAPITAL_DECKEL_STD = 24;

/**
 * Handelstag in New York als `YYYY-MM-DD`.
 *
 * NICHT UTC: Sonst zählte der Abend nach 20:00 ET (Sommer) bzw. 19:00 ET
 * (Winter) schon als neuer Tag, und die Notbremse löste sich rund fünfzehn
 * Stunden vor dem nächsten regulären Reset von selbst — obwohl sie
 * ausgelöst war und niemand sie entriegelt hat. Krypto läuft durch, der
 * Fall ist also nicht theoretisch. Beide Seiten des Vergleichs laufen durch
 * diese Funktion; das gespeicherte Format bleibt ein ISO-Zeitstempel.
 */
export function handelstagET(zeit: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(zeit);
  const teil = (t: string): string => p.find((x) => x.type === t)?.value ?? '';
  return `${teil('year')}-${teil('month')}-${teil('day')}`;
}

/**
 * Hat die Notbremse an DEMSELBEN Handelstag schon ausgelöst?
 *
 * `null`/fehlend heißt „nie ausgelöst"; ein unlesbarer Zeitstempel gilt
 * bewusst als ausgelöst — im Zweifel gesperrt lassen, nicht freigeben.
 */
export function breakerHeuteAusgeloest(marker: unknown, jetzt: Date): boolean {
  if (typeof marker !== 'string' || marker === '') return false;
  const t = Date.parse(marker);
  if (!Number.isFinite(t)) return true;
  return handelstagET(new Date(t)) === handelstagET(jetzt);
}

export interface KontoTore {
  /**
   * Sperrt JEDEN Handel — auch Verkäufe: Während Reset/Übernahme läuft,
   * hinterließe jede Buchung einen Trade, den der Schnitt nicht mitnimmt.
   */
  handel: 'reset_laeuft' | null;
  /** Sperrt nur EINSTIEGE: Notbremse bzw. Buch/Broker-Drift. */
  einstieg: 'breaker_aktiv' | 'abgleich_drift' | null;
  /** Klartext für Fehlermeldung und Log. */
  grund?: string;
}

/**
 * Sperr-Entscheidung aus dem gespeicherten Abgleich-Vermerk (`risk.abgleich`).
 *
 * Fehlbestand (Buch hielt Positionen, die der Broker nicht hat) sperrt,
 * grobe Cash-Abweichung (`konto.zustand === 'grob'`) sperrt, Fremdbestand
 * und kleine Drift nicht. Ein alter Vermerk sperrt NICHT — dieselbe Frist
 * wie beim Kapitaldeckel (`KAPITAL_DECKEL_STD`). Der Vermerk stammt aus dem
 * Buch/Broker-Abgleich der alten Plattform; wer ihn heute noch trägt, wird
 * spätestens nach der Frist wieder frei.
 */
export function abgleichSperreAusVermerk(vermerk: unknown, jetzt: Date): boolean {
  if (typeof vermerk !== 'object' || vermerk === null) return false;
  const v = vermerk as { at?: unknown; fehlbestand?: unknown; konto?: { zustand?: unknown } };
  if (typeof v.at !== 'string') return false;
  const alter = jetzt.getTime() - Date.parse(v.at);
  if (!Number.isFinite(alter) || alter > KAPITAL_DECKEL_STD * 3_600_000) return false;
  if (typeof v.fehlbestand === 'number' && v.fehlbestand > 0) return true;
  return v.konto?.zustand === 'grob';
}

/**
 * Alle Konto-Tore auf einmal, aus dem bereits gelesenen User-Dokument.
 *
 * `snap` ist bewusst nur „etwas mit `.get(feld)`" — Dokument-Snapshot im
 * Betrieb, Stub im Test.
 */
export function kontoTore(
  snap: { get(feld: string): unknown },
  clamped: Strategy,
  jetzt: Date,
): KontoTore {
  if (resetLaeuft(snap.get('risk.resetLaeuftSeit'), jetzt)) {
    return {
      handel: 'reset_laeuft',
      einstieg: null,
      grund:
        'Auf diesem Konto läuft gerade ein Reset oder eine Depot-Übernahme — '
        + 'bitte einen Moment warten und erneut versuchen.',
    };
  }

  const vortag = (snap.get('risk.vortagEquity') as number | undefined) ?? 0;
  const breaker = pruefeBreaker(
    {
      vortagEquity: vortag,
      // Zustand, keine Neuvermessung: Die Grenzprüfung selbst macht der
      // Engine-Takt mit frischen Kursen. Hier zählt, OB die Bremse heute
      // ausgelöst ist.
      jetztEquity: vortag,
      vortagEquityAm: (snap.get('risk.vortagEquityAm') as string | undefined) ?? undefined,
      heute: handelstagET(jetzt),
      bereitsAusgeloest: breakerHeuteAusgeloest(snap.get('risk.breakerAusgeloestAm'), jetzt),
    },
    { dailyLossLimitPct: clamped.engine.dailyLossLimitPct ?? 0 },
  );
  if (!breaker.einstiegErlaubt) {
    return { handel: null, einstieg: 'breaker_aktiv', grund: breaker.grund };
  }

  if (abgleichSperreAusVermerk(snap.get('risk.abgleich'), jetzt)) {
    return {
      handel: null,
      einstieg: 'abgleich_drift',
      grund:
        'Buch und Broker-Depot weichen voneinander ab — neue Einstiege sind '
        + 'gesperrt, bis der Abgleich wieder stimmt. Verkäufe bleiben möglich.',
    };
  }

  return { handel: null, einstieg: null };
}
