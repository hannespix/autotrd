/**
 * Notbremse: Tages-Verlustgrenze je Konto (M12 `core/risk.ts`).
 *
 * ── Wozu, wenn es doch Stop-Loss gibt ─────────────────────────────────────
 *
 * Der Stop-Loss schützt eine POSITION. Er hilft nicht gegen den Fall, der
 * Konten wirklich leert: viele kleine Verluste hintereinander an einem Tag,
 * jeder für sich regelkonform gestoppt. Bei 39 beobachteten Symbolen, einem
 * 5-Minuten-Takt und einer Trefferquote um 24 % ist eine Verlustserie kein
 * Ausnahmefall, sondern der Normalfall — sie kostet nur an manchen Tagen
 * mehr als an anderen.
 *
 * Ein Tages-Limit beantwortet die Frage, die kein einzelner Stop
 * beantworten kann: Wann hört man auf?
 *
 * ── Warum EINSTIEGE sperren und nicht alles glattstellen ──────────────────
 *
 * Zwangsverkauf beim Erreichen der Grenze klingt entschlossen und ist meist
 * falsch: Er realisiert Buchverluste zum schlechtesten Zeitpunkt des Tages
 * und macht aus einer Zwischenkorrektur einen endgültigen Verlust. Die
 * bestehenden Ausstiege (Stop, Ziel, Trailing, Signal) laufen ohnehin
 * weiter — sie sind die richtige Instanz für die Frage, wann eine EINZELNE
 * Position aufgibt.
 *
 * Deshalb: `blockNew` ist die Standardstufe, `flattenAll` bleibt eine
 * bewusst getrennte, härtere Stufe für den Fall, dass jemand sie ausdrücklich
 * will. Und die Regel gilt für BEIDE Handelspfade — Automatik wie manueller
 * Klick. Eine Bremse, die man mit einem Handel umgehen kann, ist keine.
 *
 * ── Warum realisiert UND unrealisiert zählen ──────────────────────────────
 *
 * Nur realisierte Verluste zu zählen, hat eine unangenehme Eigenschaft: Wer
 * nicht verkauft, löst die Bremse nie aus. Genau das Verhalten — Verlierer
 * laufen lassen — soll sie aber bremsen. Also zählt der Tagesverlust gegen
 * den Kontostand vom Vortag, inklusive offener Positionen.
 */

/** Momentaufnahme, gegen die geprüft wird. */
export interface BreakerLage {
  /** Eigenkapital am Ende des Vortags (Cash + bewertete Positionen). */
  vortagEquity: number;
  /** Eigenkapital jetzt — inklusive Buchgewinnen und -verlusten. */
  jetztEquity: number;
  /** Bereits ausgelöst und noch nicht zurückgesetzt? */
  bereitsAusgeloest?: boolean;
}

export interface BreakerConfig {
  /** Tages-Verlustgrenze in Prozent des Vortags-Eigenkapitals. 0 = aus. */
  dailyLossLimitPct?: number | undefined;
  /**
   * Beim Auslösen zusätzlich alle Positionen schließen?
   *
   * Standard ist FALSE, und das ist die wichtigere Einstellung: Ein
   * Zwangsverkauf realisiert Buchverluste zum schlechtesten Zeitpunkt.
   */
  flattenOnBreach?: boolean | undefined;
}

export type BreakerStufe = 'frei' | 'gesperrt' | 'glattstellen';

export interface BreakerBefund {
  stufe: BreakerStufe;
  /** Dürfen neue Positionen eröffnet werden? */
  einstiegErlaubt: boolean;
  /** Tagesverlust in Prozent (positiv = Verlust), null ohne Vortagsbasis. */
  verlustPct: number | null;
  /** Die Grenze, gegen die geprüft wurde. */
  grenzePct: number | null;
  /** Klartext für Oberfläche und Journal. */
  grund: string;
}

/** Grenze, die als „aus" gilt. */
export const BREAKER_AUS = 0;

/**
 * Höchste zulässige Tagesgrenze.
 *
 * Über 25 % ist keine Notbremse mehr, sondern Dekoration: Ein Konto, das an
 * einem Tag ein Viertel verliert, hat ein anderes Problem als eine fehlende
 * Obergrenze. Der Deckel verhindert außerdem, dass ein Tippfehler (250 statt
 * 2,5) die Bremse still abschaltet.
 */
export const BREAKER_MAX_PCT = 25;

/** Grenze auf den erlaubten Bereich ziehen; Unsinn wird zu „aus". */
export function klemmeBreaker(pct: number | undefined): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return BREAKER_AUS;
  return Math.min(BREAKER_MAX_PCT, pct);
}

/**
 * Prüft, ob die Notbremse greift.
 *
 * Die Reihenfolge der Prüfungen ist Absicht: erst „ist sie überhaupt an?",
 * dann „gibt es eine Basis?", dann die Zahl. Wer nur das Ergebnis liest,
 * soll trotzdem sehen, WARUM es so ausfällt.
 */
export function pruefeBreaker(lage: BreakerLage, cfg: BreakerConfig): BreakerBefund {
  const grenze = klemmeBreaker(cfg.dailyLossLimitPct);
  const frei = (grund: string, verlustPct: number | null = null): BreakerBefund => ({
    stufe: 'frei',
    einstiegErlaubt: true,
    verlustPct,
    grenzePct: grenze > 0 ? grenze : null,
    grund,
  });

  if (grenze <= 0) return frei('Notbremse ist ausgeschaltet.');
  if (!(lage.vortagEquity > 0)) {
    // Ohne Vortagswert gibt es keinen Bezugspunkt. Sperren wäre hier falsch:
    // Ein frisches Konto hat noch keinen — es hat aber auch noch nichts
    // verloren.
    return frei('Kein Vortagswert — die Bremse braucht eine Messgrundlage.');
  }

  const verlustPct = Math.round(((lage.vortagEquity - lage.jetztEquity) / lage.vortagEquity) * 10_000) / 100;

  // Einmal ausgelöst, bleibt sie ausgelöst — bis jemand sie ausdrücklich
  // zurücksetzt. Eine Bremse, die sich löst, sobald der Kurs kurz
  // zurückkommt, hätte an genau dem Tag nichts verhindert, an dem sie
  // gebraucht wird.
  if (lage.bereitsAusgeloest) {
    return {
      stufe: cfg.flattenOnBreach ? 'glattstellen' : 'gesperrt',
      einstiegErlaubt: false,
      verlustPct,
      grenzePct: grenze,
      grund:
        `Notbremse ist ausgelöst (heute ${verlustPct.toFixed(2)} % Verlust, Grenze ${grenze} %). `
        + 'Sie bleibt aktiv, bis sie von Hand zurückgesetzt wird.',
    };
  }

  if (verlustPct < grenze) {
    return frei(
      `Tagesverlust ${verlustPct.toFixed(2)} % von ${grenze} % — Einstiege frei.`,
      verlustPct,
    );
  }

  return {
    stufe: cfg.flattenOnBreach ? 'glattstellen' : 'gesperrt',
    einstiegErlaubt: false,
    verlustPct,
    grenzePct: grenze,
    grund:
      `Tages-Verlustgrenze erreicht: ${verlustPct.toFixed(2)} % gegen ${grenze} %. `
      + (cfg.flattenOnBreach
        ? 'Offene Positionen werden geschlossen.'
        : 'Keine neuen Einstiege. Bestehende Ausstiege laufen weiter — '
          + 'ein Zwangsverkauf würde Buchverluste zum schlechtesten Zeitpunkt festschreiben.'),
  };
}
