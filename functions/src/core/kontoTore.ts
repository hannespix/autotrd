/**
 * Konto-Tore für Order-Pfade AUSSERHALB des 5-Minuten-Scans
 * (Audit 13.08., Hochbefunde H2/H3).
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * Der Scan prüft vor jedem Einstieg Notbremse und Abgleich-Sperre — die
 * beiden anderen Order-Pfade taten es nicht: `momentumRun` (Momentum-Depot
 * und Kern-Sockel) kannte weder Bremse noch Sperre, die Handeingabe
 * (`trade`-Callable) kannte zwar die Bremse, aber keine Abgleich-Sperre und
 * kein Positionslimit. Ein Konto, das der Scan längst gesperrt hatte, bekam
 * am selben Tag Sockel-Käufe bis 60 % der Equity — der eigene Leitsatz der
 * Notbremse („eine Bremse, die man umgehen kann, ist keine") war an zwei von
 * drei Pfaden verletzt.
 *
 * ── Warum aus dem VERMERK statt live gerechnet ────────────────────────────
 *
 * Der Scan misst alle fünf Minuten Equity und Broker-Abgleich und schreibt
 * beides ans User-Dokument (`risk.*`). Diese Pfade laufen seltener (täglich
 * bzw. auf Klick) und haben weder frische Kurse noch einen Grund, den Broker
 * ein zweites Mal zu fragen: Was hier zählt, ist der ZUSTAND der Sperren.
 * Dieselbe Entscheidung wie in der Handeingabe seit M12 — jetzt an einer
 * Stelle statt in Kopien, die auseinanderlaufen.
 *
 * Exits durchlaufen die Einstiegs-Tore NIE (Leitsatz aus dem Scan): Eine
 * offene Position muss schließbar bleiben, gerade wenn das Konto brennt.
 */

import { pruefeBreaker, resetLaeuft, type Strategy } from '../../../shared/src/index.js';
import { KAPITAL_DECKEL_STD } from './broker.js';
import { breakerHeuteAusgeloest, handelstagET } from '../scheduled/scanMarket.js';

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
 * Spiegelt die Live-Entscheidung von `abgleichFuerKonto`: Fehlbestand (Buch
 * hält Positionen, die der Broker nicht hat) sperrt, grobe Cash-Abweichung
 * (`konto.zustand === 'grob'`) sperrt, Fremdbestand und kleine Drift nicht.
 * Ein alter Vermerk (Broker längst getrennt) sperrt NICHT — der Live-Abgleich
 * würde dann `kein_broker` melden; dieselbe Frist wie beim Kapitaldeckel.
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
      // Zustand, keine Neuvermessung: Die Grenzprüfung selbst macht der Scan
      // mit frischen Kursen. Hier zählt, OB die Bremse heute ausgelöst ist.
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
