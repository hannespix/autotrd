/**
 * Audit-Befund 11.08. (A7): Der Reset lief ohne Lauf-Marker.
 *
 * ── Was zwischen Anfang und Ende passiert ─────────────────────────────────
 *
 * `resetWallet` arbeitet in vielen Schritten: Trades seitenweise (200) ins
 * Archiv verschieben, fünf Unterlisten rekursiv löschen, Schattendepots der
 * Regelbäume leeren, zuletzt das Wallet neu setzen. Bei gewachsener Historie
 * dauert das Sekunden bis Minuten.
 *
 * Der Scan läuft in dieser Zeit weiter — alle fünf Minuten, für alle Konten.
 * Fällt einer ins Fenster, entsteht ein Zustand, den hinterher niemand mehr
 * auseinanderdividiert:
 *
 *  - eine Position, die NACH dem `recursiveDelete` angelegt wurde und
 *    deshalb bleibt, während ihr Kauf-Trade längst im Archiv liegt;
 *  - ein Kauf, dessen Abbuchung das abschließende
 *    `paperBalance = startkapital` einfach überschreibt — Geld ausgegeben,
 *    Saldo wieder voll.
 *
 * Beides ist still. Es gibt keine Fehlermeldung, keinen Log-Eintrag, nichts
 * in der Oberfläche. Der Reset soll die MESSGRUNDLAGE herstellen; ohne
 * Marker konnte er sie zerstören.
 *
 * ── Warum der Marker verfällt ─────────────────────────────────────────────
 *
 * Ein Marker ohne Verfall ist die schlimmere Falle: Stirbt die Funktion
 * mitten im Reset (Timeout, Deploy), bliebe er für immer stehen — und das
 * Konto handelte nie wieder, ohne dass irgendwo ein Fehler steht.
 */
import { describe, expect, it } from 'vitest';
import { RESET_SPERRE_MIN, resetLaeuft } from '../src/circuitBreaker.js';

const JETZT = new Date('2026-08-11T14:00:00Z');
const vor = (min: number): string => new Date(JETZT.getTime() - min * 60_000).toISOString();

describe('resetLaeuft', () => {
  it('ein frischer Marker sperrt', () => {
    expect(resetLaeuft(vor(0), JETZT)).toBe(true);
    expect(resetLaeuft(vor(3), JETZT)).toBe(true);
  });

  it('kurz vor Ablauf sperrt noch', () => {
    expect(resetLaeuft(vor(RESET_SPERRE_MIN - 0.1), JETZT)).toBe(true);
  });

  it('ein abgelaufener Marker sperrt NICHT mehr', () => {
    /* Der wichtigste Test hier. Ein Reset, der mitten im Lauf abstirbt,
     * hinterlässt einen Marker, den niemand mehr aufräumt. Ohne Verfall
     * handelte dieses Konto nie wieder — und die einzige Spur wäre eine
     * Zahl im Heartbeat, die niemand liest. */
    expect(resetLaeuft(vor(RESET_SPERRE_MIN), JETZT)).toBe(false);
    expect(resetLaeuft(vor(60), JETZT)).toBe(false);
  });

  it('kein Marker ⇒ keine Sperre', () => {
    expect(resetLaeuft(undefined, JETZT)).toBe(false);
    expect(resetLaeuft(null, JETZT)).toBe(false);
    expect(resetLaeuft('', JETZT)).toBe(false);
  });

  it('ein unbrauchbarer Wert legt kein Konto still', () => {
    // Ein kaputtes Feld darf nicht dieselbe Wirkung haben wie ein echter
    // Reset. Im Zweifel handeln: Der Schaden eines übersehenen Resets ist
    // begrenzt, der eines dauerhaft gesperrten Kontos nicht.
    expect(resetLaeuft('gerade eben', JETZT)).toBe(false);
    expect(resetLaeuft(42, JETZT)).toBe(false);
    expect(resetLaeuft({ seit: 'jetzt' }, JETZT)).toBe(false);
    expect(resetLaeuft(true, JETZT)).toBe(false);
  });

  it('ein Marker knapp aus der Zukunft sperrt', () => {
    // Uhr-Versatz zwischen Diensten. Hier zu handeln wäre riskanter als eine
    // Sperre, die ohnehin nach Minuten verfällt.
    expect(resetLaeuft(vor(-2), JETZT)).toBe(true);
  });

  it('ein weit verrutschter Stempel sperrt NICHT jahrelang', () => {
    // Die Kehrseite der Regel darüber: Läge ein Marker ein Jahr in der
    // Zukunft, stünde das Konto ein Jahr still.
    expect(resetLaeuft(vor(-60 * 24 * 365), JETZT)).toBe(false);
  });

  it('das Fenster ist einstellbar, die Voreinstellung benannt', () => {
    expect(RESET_SPERRE_MIN).toBe(10);
    expect(resetLaeuft(vor(20), JETZT, 30)).toBe(true);
    expect(resetLaeuft(vor(20), JETZT, 5)).toBe(false);
  });
});
