/**
 * Wer bekommt tiefe Chart-Historie? (Befund 09.08.)
 *
 * Anlass war eine Owner-Meldung: „der ndx Index liefert keine Daten. wenn ich
 * ihn anklicke ist ein leeres Chart da." Die Vermutung ging Richtung Alpaca;
 * die Ursache lag woanders und bestand aus zwei Hälften, die einander ergänzt
 * haben:
 *
 *  1. `isTradable` schließt alles mit `^` aus (universe.ts:282). Damit fasst
 *     `scanMarket` Indizes nie an — und der schreibt `bars` und `ohlc5m`.
 *  2. Der Backfill in `momentumRun` zog genau die Symbole nach, für die das
 *     Spark-Bündel zu wenig Closes FÜRS RANKING lieferte. Spark liefert `^NDX`
 *     aber 251 Closes (am 09.08. live gegen Yahoo geprüft) — der Index galt
 *     also als versorgt und bekam nie ein `ohlcDaily`-Doc.
 *
 * Kein Schreiber, leeres Chart, sichtbarer Kurs (die Kachel hängt am
 * Spark-Bündel). Diese Tests halten die Trennung fest, an der es lag:
 * „reicht fürs Ranking" und „hat Chart-Historie" sind verschiedene Fragen,
 * und Handelbarkeit ist für die zweite ohne Belang.
 */
import { describe, expect, it } from 'vitest';
import { chartHistorieFehlt } from '../src/scheduled/momentumRun.js';
import { DEEP_BACKFILL_V } from '../src/core/marketData.js';

describe('chartHistorieFehlt', () => {
  it('nimmt einen Index auf, dem die Historie fehlt — obwohl er nicht handelbar ist', () => {
    // Der Kern des Befunds: `^NDX` wird angezeigt und angeklickt, also braucht
    // er ein Chart. Dass niemand ihn handeln kann, ändert daran nichts.
    expect(chartHistorieFehlt(['^NDX', 'AAPL'], new Map([['AAPL', DEEP_BACKFILL_V]])))
      .toEqual(['^NDX']);
  });

  it('lässt aus, was bereits auf dem aktuellen Stand ist', () => {
    const stand = new Map<string, unknown>([['^NDX', DEEP_BACKFILL_V], ['AAPL', DEEP_BACKFILL_V]]);
    expect(chartHistorieFehlt(['^NDX', 'AAPL'], stand)).toEqual([]);
  });

  it('holt einen ÄLTEREN Stand erneut', () => {
    // Bis 09.08. schrieb momentumRun die 1 und scanMarket die 2 — ein Symbol
    // konnte damit als erledigt markiert sein und trotzdem die alte, auf fünf
    // Jahre gekürzte Historie tragen.
    expect(chartHistorieFehlt(['^NDX'], new Map([['^NDX', 1]]))).toEqual(['^NDX']);
  });

  it('behandelt ein unbekanntes Symbol wie eines ohne Historie', () => {
    expect(chartHistorieFehlt(['NEU'], new Map())).toEqual(['NEU']);
  });

  it('nimmt Devisen und Futures mit — auch sie sind nicht handelbar', () => {
    // Dieselbe Falle wie beim Index: `isTradable` sagt nein, das Chart braucht
    // trotzdem Daten.
    expect(chartHistorieFehlt(['EURUSD=X', 'GC=F', '^VIX'], new Map()))
      .toEqual(['EURUSD=X', 'GC=F', '^VIX']);
  });

  it('erhält die Katalog-Reihenfolge — der Rotations-Cursor zählt darauf', () => {
    // Der Backfill nimmt `BACKFILL_PRO_LAUF` Symbole ab einem gespeicherten
    // Cursor. Wäre die Reihenfolge je Lauf anders, überspränge die Rotation
    // Symbole und holte andere doppelt.
    const katalog = ['A', 'B', 'C', 'D'];
    expect(chartHistorieFehlt(katalog, new Map([['B', DEEP_BACKFILL_V]])))
      .toEqual(['A', 'C', 'D']);
  });

  it('ein leerer Katalog ergibt eine leere Liste', () => {
    expect(chartHistorieFehlt([], new Map())).toEqual([]);
  });
});
