/**
 * Audit-Befund 11.08.: Die Prognose-Statistik hatte keinen Versions-Marker.
 *
 * ── Was das bedeutet hätte ────────────────────────────────────────────────
 *
 * `meta/forecastStats.combos` wächst über `FieldValue.increment` — jede
 * bewertete Prognose addiert auf einen Zähler, der nie zurückgesetzt wird.
 * Aus diesen Zählern wählt `bestParams()` Gewichtung und Lookback, mit denen
 * die Engine prognostiziert und über das Forecast-Vote ECHTE TRADES
 * beeinflusst.
 *
 * Solange die Rechnung gleich bleibt, ist das genau richtig. Ändert man
 * Features, Gewichte, Regime-Dämpfung oder Horizont, addieren sich ab dem
 * Deploy die Treffer ZWEIER Rechnungen in denselben Zähler — dauerhaft, weil
 * nichts sie trennt. Die Trefferquote sähe weiter plausibel aus.
 *
 * Dieselbe Falle wie bei `TAG_RUECKBLICK_V` (schlug am 10.08. zu) und
 * `SCHREIBWEISE_V` — nur auf einem Pfad, der Geld bewegt.
 *
 * ── Warum die Entscheidung eine eigene Funktion ist ───────────────────────
 *
 * Weil sie im Zweifel MESSDATEN VERWIRFT. Das darf nicht aus Versehen
 * passieren und schon gar nicht als Nebenwirkung einer Bedingung, die
 * irgendwo in einem Firestore-Pfad steht.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zaehlerVerwerfen } from '../src/scheduled/evalForecasts.js';
import { FORECAST_V } from '../../shared/src/index.js';

describe('zaehlerVerwerfen', () => {
  it('behält Zähler der AKTUELLEN Fassung', () => {
    expect(zaehlerVerwerfen(FORECAST_V)).toBe(false);
  });

  it('verwirft Zähler einer älteren Fassung', () => {
    expect(zaehlerVerwerfen(FORECAST_V - 1)).toBe(true);
  });

  it('verwirft auch Zähler einer NEUEREN Fassung', () => {
    // Kann beim Zurückrollen eines Deploys passieren. Auch dann mischen sich
    // zwei Rechnungen — die Richtung des Sprungs ändert daran nichts.
    expect(zaehlerVerwerfen(FORECAST_V + 1)).toBe(true);
  });

  it('behält einen Stand OHNE Marker — er stammt aus der Fassung bei Einführung', () => {
    // Wichtig für den Übergang: Am Tag der Einführung trägt kein Dokument
    // einen Marker. Diese Zähler zu verwerfen hieße, die gesamte bisher
    // gesammelte Historie ohne Not wegzuwerfen — die Rechnung hat sich ja
    // gerade NICHT geändert.
    expect(zaehlerVerwerfen(undefined)).toBe(false);
    expect(zaehlerVerwerfen(null)).toBe(false);
  });

  it('verwirft bei einem unsinnigen Wert im Feld', () => {
    // Ein String oder Objekt an dieser Stelle heißt: Das Dokument ist nicht
    // das, wofür wir es halten. Dann lieber neu zählen als weiterrechnen.
    expect(zaehlerVerwerfen('v1')).toBe(true);
    expect(zaehlerVerwerfen({})).toBe(true);
  });

  it('vergleicht gegen die übergebene Fassung, nicht gegen eine feste Zahl', () => {
    // Damit bleibt der Test gültig, wenn FORECAST_V erhöht wird — er prüft
    // die Regel, nicht den Wert.
    expect(zaehlerVerwerfen(7, 7)).toBe(false);
    expect(zaehlerVerwerfen(7, 8)).toBe(true);
  });
});

/* Die reine Funktion allein reicht nicht.
 *
 * Sabotage-Probe: `await pruefeFassung(statsRef)` aus beiden Läufen entfernt
 * — alle sieben Tests oben blieben grün, weil sie die ENTSCHEIDUNG prüfen und
 * nicht ihren Einsatz. Genau die Lücke, die gestern schon einmal aufging.
 *
 * Beide Statistiken müssen die Prüfung durchlaufen: die tägliche UND die
 * Intraday-Variante. Sie haben getrennte Dokumente, aber dieselbe Mechanik —
 * und eine Prüfung, die nur an einem der beiden hängt, wäre schlimmer als
 * keine: Sie erzeugt Vertrauen für beide. */
describe('Quelltext: beide Statistiken prüfen die Fassung', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'evalForecasts.ts');

  /* Nachgezogen am 11.08., als das Aggregat je Symbol in den Marker-Batch
   * wanderte (Befund „evaluated gesetzt, Treffer verloren").
   *
   * Der alte Test suchte die Grenze bei `comboDelta.size > 0` — den gibt es
   * nicht mehr. `indexOf` lieferte dann `-1`, `slice(ab, -1)` fast den ganzen
   * Rest der Datei, und `pruefeFassung` stand darin natürlich irgendwo: Der
   * Test blieb GRÜN und prüfte nichts mehr. Genau die Sorte stiller Ausfall,
   * gegen die er gebaut war.
   *
   * Die Aussage ist heute schärfer, weil die Lage es verlangt: Geschrieben
   * wird jetzt IN der Symbol-Schleife, also muss die Fassungsprüfung davor
   * liegen. Stünde sie dahinter, hätte sie die frisch addierten Zähler schon
   * mitgemischt — und beim Verwerfen genau die Treffer gelöscht, die dieser
   * Lauf gerade gesammelt hat. */
  for (const [doc, schleife] of [
    ['meta/forecastStats', 'for (const [symbol, entries] of dueBySymbol)'],
    ['meta/forecastStatsIntraday', 'for (const [symbol, entries] of bySymbol)'],
  ] as const) {
    it(`${doc}: pruefeFassung steht VOR der Symbol-Schleife`, () => {
      const text = readFileSync(pfad, 'utf8');
      const ab = text.indexOf(`db.doc('${doc}')`);
      expect(ab, `Schreibstelle für ${doc} nicht gefunden`).toBeGreaterThan(0);
      const bis = text.indexOf(schleife, ab);
      expect(bis, `Symbol-Schleife nach ${doc} nicht gefunden`).toBeGreaterThan(ab);
      expect(text.slice(ab, bis)).toContain('pruefeFassung(statsRef)');
    });

    it(`${doc}: das Dokument wird vor dem ersten update angelegt`, () => {
      // `update` scheitert auf einem fehlenden Dokument. Vorher stand das
      // `set({}, { merge: true })` direkt neben dem einen Schreibvorgang am
      // Ende; jetzt muss es vor die Schleife.
      const text = readFileSync(pfad, 'utf8');
      const ab = text.indexOf(`db.doc('${doc}')`);
      const bis = text.indexOf(schleife, ab);
      expect(text.slice(ab, bis)).toContain('statsRef.set({}, { merge: true })');
    });
  }
});

/* ── Der Befund vom 11.08.: Marker gesetzt, Treffer verloren ───────────────
 *
 * Jeder Symbol-Commit setzte `evaluated: true`, während `comboDelta` die
 * Treffer nur im Speicher sammelte — geschrieben wurde erst nach ALLEN
 * Symbolen. Bricht der Lauf dazwischen ab (der Intraday-Zwilling läuft
 * huckepack im Scan und teilt sich dessen 180-s-Timeout), tragen die schon
 * bearbeiteten Prognosen dauerhaft den Marker, ihre Treffer erreichen die
 * Statistik aber nie.
 *
 * Das ist kein Schönheitsfehler: `dirAccuracy` wird dann über eine verzerrte
 * Teilmenge gerechnet, und genau diese Zahl steuert über
 * `accuracyWeightedVote` das Stimmgewicht der Prognose im HANDEL. Nachholbar
 * ist der Verlust nicht, und er hinterlässt keine Spur.
 */
describe('Quelltext: Marker und Zähler wandern gemeinsam', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'evalForecasts.ts');

  it('beide Pfade legen das Aggregat in den Symbol-Batch', () => {
    const text = readFileSync(pfad, 'utf8');
    const treffer = text.match(/aggregatInBatch\(batch, statsRef, symbolDelta\);/g) ?? [];
    expect(treffer.length, 'Tages- UND Intraday-Pfad').toBe(2);
  });

  it('und zwar VOR dem Commit — danach wäre es wirkungslos', () => {
    const text = readFileSync(pfad, 'utf8');
    for (const [i, zeile] of text.split('\n').entries()) {
      if (!zeile.includes('aggregatInBatch(batch, statsRef, symbolDelta);')) continue;
      const naechste = text.split('\n')[i + 1] ?? '';
      expect(naechste, `Zeile ${i + 2} muss der Commit sein`).toContain('await batch.commit()');
    }
  });

  it('es gibt kein lauf-weites comboDelta mehr', () => {
    // Solange es existiert, kann jemand versehentlich wieder hineinsammeln —
    // und der Befund wäre zurück, ohne dass ein Test fällt.
    expect(readFileSync(pfad, 'utf8')).not.toContain('const comboDelta =');
  });

  it('eine Funktion für beide Pfade', () => {
    // Zwei Kopien wären zwei Gelegenheiten, sie verschieden zu ändern — und
    // der Fehler fiele nicht auf, weil beide Statistiken für sich plausibel
    // aussähen.
    const text = readFileSync(pfad, 'utf8');
    expect((text.match(/function aggregatInBatch\(/g) ?? []).length).toBe(1);
  });
});

describe('FORECAST_V', () => {
  it('ist eine ganze Zahl ab 1', () => {
    expect(Number.isInteger(FORECAST_V)).toBe(true);
    expect(FORECAST_V).toBeGreaterThanOrEqual(1);
  });
});
