/**
 * Audit-Befund 11.08. (A6): `vortagEquityAm` wurde geschrieben und nie
 * gelesen.
 *
 * ── Was das Feld leisten sollte ───────────────────────────────────────────
 *
 * Die Notbremse vergleicht das Eigenkapital JETZT gegen `risk.vortagEquity`
 * — den Stand, den der Tageslauf um 17:15 ET festgehalten hat. Das Datum
 * dieses Standes stand von Anfang an daneben. Gefragt hat es nie jemand.
 *
 * ── Warum das zählt ───────────────────────────────────────────────────────
 *
 * Fällt der Tageslauf aus — Deploy-Fenster, Scheduler-Fehler, ein Fehler in
 * einem einzelnen Konto —, bleibt die Bezugsgröße von vorgestern oder älter
 * stehen. Der Vergleich misst dann einen MEHRTAGES-Verlust gegen eine
 * TAGES-Grenze.
 *
 * Die Richtung ist die sichere: Die Bremse löst eher zu früh aus als zu spät,
 * und ein gesperrtes Konto verliert kein Geld. Falsch war der Klartext.
 * „Notbremse ist ausgelöst (heute 4,10 % Verlust)" über drei Tage ist eine
 * Behauptung, die der Owner nicht überprüfen kann — und sie schickt ihn bei
 * der Ursachensuche in die falsche Richtung: Er sucht den Verlust von heute,
 * den es so nie gab.
 *
 * Deshalb bleibt die ENTSCHEIDUNG unverändert und nur die Begründung wird
 * ehrlich. Eine Bremse zu lockern, weil eine Zahl alt ist, wäre die
 * gefährliche Variante.
 */
import { describe, expect, it } from 'vitest';
import { BEZUG_MAX_TAGE, bezugTageAlt, pruefeBreaker } from '../src/circuitBreaker.js';

describe('bezugTageAlt', () => {
  it('gestern ist ein Tag alt', () => {
    expect(bezugTageAlt('2026-08-10', '2026-08-11')).toBe(1);
  });

  it('derselbe Tag ist null Tage alt', () => {
    // Kommt zwischen 17:15 ET und Mitternacht vor — der Normalfall am Abend.
    expect(bezugTageAlt('2026-08-11', '2026-08-11')).toBe(0);
  });

  it('rechnet über Monatsgrenzen', () => {
    expect(bezugTageAlt('2026-07-30', '2026-08-02')).toBe(3);
  });

  it('rechnet über den Jahreswechsel', () => {
    expect(bezugTageAlt('2025-12-30', '2026-01-02')).toBe(3);
  });

  it('ohne Angabe gibt es kein Alter', () => {
    // „Weiß nicht" ist ehrlicher als eine erfundene Zahl — und der Aufrufer
    // behandelt es wie „keine Warnung", statt grundlos zu warnen.
    expect(bezugTageAlt(undefined, '2026-08-11')).toBe(null);
    expect(bezugTageAlt('2026-08-11', undefined)).toBe(null);
    expect(bezugTageAlt('', '')).toBe(null);
  });

  it('unlesbare Angaben ergeben null, keinen NaN', () => {
    // NaN würde durch jeden Vergleich fallen und lautlos „keine Warnung"
    // bedeuten — richtig, aber aus dem falschen Grund.
    expect(bezugTageAlt('gestern', '2026-08-11')).toBe(null);
    expect(bezugTageAlt('2026-08-11', '11.08.2026')).toBe(null);
  });

  it('ein Datum aus der Zukunft ergibt eine negative Zahl, keine Warnung', () => {
    // Kann bei einem Uhr-Versatz zwischen Diensten auftreten. Warnen wäre
    // hier falsch: Die Bezugsgröße ist nicht zu ALT.
    expect(bezugTageAlt('2026-08-12', '2026-08-11')).toBe(-1);
  });
});

describe('pruefeBreaker meldet eine veraltete Bezugsgröße', () => {
  const lage = (patch: Record<string, unknown> = {}): Parameters<typeof pruefeBreaker>[0] => ({
    vortagEquity: 10_000,
    jetztEquity: 9_500,
    heute: '2026-08-11',
    ...patch,
  });
  const cfg = { dailyLossLimitPct: 3 };

  it('frische Bezugsgröße ⇒ kein Hinweis', () => {
    const b = pruefeBreaker(lage({ vortagEquityAm: '2026-08-10' }), cfg);
    expect(b.bezugTageAlt).toBe(1);
    expect(b.grund).not.toContain('Achtung');
  });

  it('zwei Tage alt ⇒ Hinweis im Klartext, mit Datum und Alter', () => {
    const b = pruefeBreaker(lage({ vortagEquityAm: '2026-08-09' }), cfg);
    expect(b.bezugTageAlt).toBe(2);
    expect(b.grund).toContain('2026-08-09');
    expect(b.grund).toContain('2 Tage alt');
  });

  it('der Hinweis erscheint AUCH im Sperrfall', () => {
    /* Der wichtigste Fall überhaupt: Genau dann liest der Owner den Text,
     * und genau dann stand vorher „heute X %" über einem Wert, der mehrere
     * Tage abdeckt. */
    const b = pruefeBreaker(
      lage({ jetztEquity: 9_000, vortagEquityAm: '2026-08-07' }),
      cfg,
    );
    expect(b.einstiegErlaubt).toBe(false);
    expect(b.grund).toContain('4 Tage alt');
  });

  it('und im Zustand „bereits ausgelöst"', () => {
    const b = pruefeBreaker(
      lage({ bereitsAusgeloest: true, vortagEquityAm: '2026-08-07' }),
      cfg,
    );
    expect(b.stufe).toBe('gesperrt');
    expect(b.grund).toContain('4 Tage alt');
  });

  it('die ENTSCHEIDUNG ändert sich durch das Alter nicht', () => {
    /* Der Kern. Eine Bremse zu lockern, weil eine Zahl alt ist, wäre die
     * gefährliche Auflösung dieses Befunds: Ausgerechnet nach einem
     * ausgefallenen Tageslauf — also nach einer Störung — stünde das Konto
     * dann ohne Bremse da. */
    const alt = pruefeBreaker(lage({ jetztEquity: 9_000, vortagEquityAm: '2026-07-01' }), cfg);
    const frisch = pruefeBreaker(lage({ jetztEquity: 9_000, vortagEquityAm: '2026-08-10' }), cfg);
    expect(alt.stufe).toBe(frisch.stufe);
    expect(alt.einstiegErlaubt).toBe(frisch.einstiegErlaubt);
    expect(alt.verlustPct).toBe(frisch.verlustPct);
  });

  it('ohne Datum bleibt alles wie bisher', () => {
    // Bestandskonten, deren letzter Snapshot vor der Einführung liegt, dürfen
    // nicht plötzlich eine Warnung tragen.
    const b = pruefeBreaker(lage(), cfg);
    expect(b.bezugTageAlt).toBe(null);
    expect(b.grund).not.toContain('Achtung');
  });

  it('auch bei ausgeschalteter Bremse steht das Alter im Befund', () => {
    // Die Zahl ist eine Diagnose über den Tageslauf, keine über die Bremse.
    const b = pruefeBreaker(lage({ vortagEquityAm: '2026-08-05' }), { dailyLossLimitPct: 0 });
    expect(b.bezugTageAlt).toBe(6);
  });

  it('die Schwelle ist eine benannte Konstante, kein verstreuter Wert', () => {
    expect(BEZUG_MAX_TAGE).toBe(1);
    const grenzfall = pruefeBreaker(lage({ vortagEquityAm: '2026-08-10' }), cfg);
    expect(grenzfall.grund).not.toContain('Achtung');
  });
});
