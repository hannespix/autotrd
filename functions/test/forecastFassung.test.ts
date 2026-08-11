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

  for (const doc of ['meta/forecastStats', 'meta/forecastStatsIntraday']) {
    it(`${doc} läuft durch pruefeFassung`, () => {
      const text = readFileSync(pfad, 'utf8');
      const ab = text.indexOf(`db.doc('${doc}')`);
      expect(ab, `Schreibstelle für ${doc} nicht gefunden`).toBeGreaterThan(0);
      // Die Prüfung muss VOR dem Fortschreiben stehen — danach hätte sie
      // die frisch addierten Zähler schon mitgemischt.
      const bis = text.indexOf('comboDelta.size > 0', ab);
      expect(text.slice(ab, bis)).toContain('pruefeFassung(statsRef)');
    });
  }
});

describe('FORECAST_V', () => {
  it('ist eine ganze Zahl ab 1', () => {
    expect(Number.isInteger(FORECAST_V)).toBe(true);
    expect(FORECAST_V).toBeGreaterThanOrEqual(1);
  });
});
