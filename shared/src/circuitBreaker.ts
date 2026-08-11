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
  /**
   * Tag, an dem `vortagEquity` festgestellt wurde (`YYYY-MM-DD`).
   *
   * ── Audit-Befund 11.08. ─────────────────────────────────────────────────
   *
   * `snapshotEquity` schrieb dieses Datum von Anfang an mit — gelesen hat es
   * nie jemand. Damit blieb ein Fall unsichtbar, der jederzeit eintreten
   * kann: Fällt der Tageslauf aus (Deploy-Fenster, Scheduler-Fehler), bleibt
   * die Bezugsgröße von vorgestern oder älter stehen. Der Vergleich misst
   * dann einen MEHRTAGES-Verlust gegen eine TAGES-Grenze.
   *
   * Die Richtung ist die sichere: Die Bremse löst eher zu früh aus als zu
   * spät. Falsch war nur der Klartext — „heute 4,10 % Verlust" über drei Tage
   * ist eine Behauptung, die der Owner nicht überprüfen kann, und sie schickt
   * ihn bei der Ursachensuche in die falsche Richtung.
   */
  vortagEquityAm?: string | undefined;
  /** Heutiges Datum (`YYYY-MM-DD`) — Bezug für das Alter oben. */
  heute?: string | undefined;
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
  /**
   * Alter der Bezugsgröße in Tagen; `null`, wenn keins bestimmbar ist.
   *
   * 0 oder 1 ist der Normalfall (der Tageslauf läuft täglich, auch am
   * Wochenende — Krypto handelt durch). Alles darüber heißt: Der Tageslauf
   * ist ausgefallen, und `verlustPct` ist kein Tagesverlust mehr.
   */
  bezugTageAlt: number | null;
  /** Klartext für Oberfläche und Journal. */
  grund: string;
}

/** Ab hier ist die Bezugsgröße nicht mehr „von gestern". */
export const BEZUG_MAX_TAGE = 1;

/**
 * Wie alt ist die Bezugsgröße in Tagen?
 *
 * Reine Datumsrechnung über UTC-Mitternacht — beide Seiten kommen als
 * `YYYY-MM-DD` und werden auch so verglichen. Unlesbare Angaben ergeben
 * `null`: „weiß nicht" ist eine ehrlichere Antwort als eine erfundene Zahl,
 * und der Aufrufer behandelt sie wie „keine Warnung".
 */
export function bezugTageAlt(vortagEquityAm?: string, heute?: string): number | null {
  if (!vortagEquityAm || !heute) return null;
  const a = Date.parse(`${vortagEquityAm}T00:00:00Z`);
  const b = Date.parse(`${heute}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Wie lange ein Reset-Marker den Handel sperrt (Minuten).
 *
 * ── Warum es diesen Marker gibt (Audit-Befund 11.08.) ─────────────────────
 *
 * `resetWallet` arbeitet in vielen Schritten: Trades archivieren (seitenweise
 * zu 200), fünf Unterlisten rekursiv löschen, Schattendepots leeren, zuletzt
 * das Wallet neu setzen. Bei einer gewachsenen Historie dauert das
 * Sekunden bis Minuten — und der Scan läuft alle fünf Minuten weiter.
 *
 * Fällt ein Scan in dieses Fenster, entsteht ein Zustand, den niemand mehr
 * auseinanderdividieren kann: eine Position, die nach dem `recursiveDelete`
 * angelegt wurde und deshalb bleibt, während ihr Kauf-Trade schon ins Archiv
 * gewandert ist. Oder ein Kauf, dessen Abbuchung das abschließende
 * `wallet.paperBalance = startkapital` einfach überschreibt — Geld ausgegeben,
 * Saldo wieder voll.
 *
 * ── Warum der Marker VERFÄLLT ─────────────────────────────────────────────
 *
 * Ein Marker ohne Verfall ist eine Falle: Stirbt die Funktion mitten im Reset
 * (Timeout, Deploy), bliebe er für immer stehen — und das Konto handelte nie
 * wieder, ohne dass irgendwo ein Fehler steht. Zehn Minuten sind großzügig
 * gegenüber jedem realistischen Reset und kurz genug, dass ein abgestürzter
 * Lauf höchstens zwei Scans kostet.
 */
export const RESET_SPERRE_MIN = 10;

/**
 * Läuft gerade ein Reset auf diesem Konto?
 *
 * Alles, was kein brauchbarer Zeitstempel ist, gilt als „kein Reset" — ein
 * kaputtes Feld darf ein Konto nicht stilllegen.
 */
export function resetLaeuft(marker: unknown, jetzt: Date, maxMin = RESET_SPERRE_MIN): boolean {
  if (typeof marker !== 'string' || marker === '') return false;
  const t = Date.parse(marker);
  if (!Number.isFinite(t)) return false;
  const alterMin = (jetzt.getTime() - t) / 60_000;
  // Betrag, nicht Vorzeichen: Ein Marker aus der Zukunft (Uhr-Versatz
  // zwischen Diensten) soll sperren, aber ein um Jahre verrutschter Stempel
  // darf das Konto nicht jahrelang stilllegen. Beide Richtungen verfallen
  // nach demselben Fenster.
  return Math.abs(alterMin) < maxMin;
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
  const alter = bezugTageAlt(lage.vortagEquityAm, lage.heute);
  /* Hängt an JEDEN Grund an, sobald die Bezugsgröße nicht mehr von gestern
   * ist. Absichtlich am Grund und nicht an einer eigenen Stufe: Der Wert
   * bleibt gültig und die Bremse konservativ — falsch war nur die Behauptung,
   * es handle sich um einen Tagesverlust. */
  const hinweis =
    alter !== null && alter > BEZUG_MAX_TAGE
      ? ` Achtung: Die Bezugsgröße stammt vom ${lage.vortagEquityAm ?? '?'} (${alter} Tage alt) —`
        + ' der Tageslauf ist ausgefallen, der Wert deckt mehrere Tage ab.'
      : '';
  const frei = (grund: string, verlustPct: number | null = null): BreakerBefund => ({
    stufe: 'frei',
    einstiegErlaubt: true,
    verlustPct,
    grenzePct: grenze > 0 ? grenze : null,
    bezugTageAlt: alter,
    grund: grund + hinweis,
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
      bezugTageAlt: alter,
      grund:
        `Notbremse ist ausgelöst (heute ${verlustPct.toFixed(2)} % Verlust, Grenze ${grenze} %). `
        + 'Sie bleibt aktiv, bis sie von Hand zurückgesetzt wird.'
        + hinweis,
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
    bezugTageAlt: alter,
    grund:
      `Tages-Verlustgrenze erreicht: ${verlustPct.toFixed(2)} % gegen ${grenze} %. `
      + (cfg.flattenOnBreach
        ? 'Offene Positionen werden geschlossen.'
        : 'Keine neuen Einstiege. Bestehende Ausstiege laufen weiter — '
          + 'ein Zwangsverkauf würde Buchverluste zum schlechtesten Zeitpunkt festschreiben.')
      + hinweis,
  };
}
