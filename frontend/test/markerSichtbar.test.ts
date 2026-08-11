/**
 * Owner-Meldung 11.08.: „Kauf Punkte und Veto Zeichnung und News werden
 * momentan nicht immer im Chart angezeigt je nach anderen Indikatoren.
 * warum? sobald die aktiviert sind sollten sie auch immer eingeblendet
 * werden."
 *
 * ── Die Antwort auf das „warum" ───────────────────────────────────────────
 *
 * Lightweight Charts zeichnet nichts, was an einer AUSGEBLENDETEN Serie
 * hängt. Die Marker hingen an der Kerzen-Serie — und die wird genau dann
 * unsichtbar geschaltet, wenn ein anderer Chart-Typ gewählt ist:
 *
 *     candle.applyOptions({ visible: (isCandle || combineActive) && candlesWanted })
 *
 * Also bei Linie, Fläche, Baseline, Bars und im Vektor-Look „Kerzen aus".
 * Genau die Umschalter, die der Owner als „andere Indikatoren" beschreibt.
 *
 * ── Warum das besonders ärgerlich ist ─────────────────────────────────────
 *
 * Die Regel war bekannt und stand als Kommentar direkt daneben — bei der
 * Träger-Serie, die am 04.08. für die PREISLINIEN eingeführt wurde, mit
 * derselben Begründung („im Vektor-Look wären Einstieg und Stop sonst genau
 * dann weg, wenn man ruhig auf den Kurs schauen will"). Für die Marker galt
 * sie weiter nicht.
 *
 * Dieselbe Fehlerfamilie wie mehrfach im Backend-Audit: Eine Regel ist
 * aufgeschrieben, gelöst — und gilt nur für den Fall, für den sie erfunden
 * wurde.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quelle = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'chart.ts'), 'utf8');

const setMarkersBlock = (): string => {
  const text = quelle();
  const ab = text.indexOf('    setMarkers(markers): void {');
  expect(ab, 'setMarkers nicht gefunden').toBeGreaterThan(0);
  return text.slice(ab, text.indexOf('\n    },', ab));
};

describe('Marker hängen an einer immer sichtbaren Serie', () => {
  it('setMarkers schreibt auf die Träger-Serie, nicht auf die Kerzen', () => {
    /* Der Kern. `candle.setMarkers(...)` war der Befund — die Serie ist bei
     * jedem Nicht-Kerzen-Typ unsichtbar, und damit sind es die Marker auch. */
    const b = setMarkersBlock();
    expect(b).toContain('lineHost.setMarkers(');
    expect(b).not.toContain('candle.setMarkers(');
  });

  it('nirgends sonst werden Marker auf die Kerzen gesetzt', () => {
    expect(quelle()).not.toContain('candle.setMarkers');
  });

  it('die Träger-Serie wird für Marker mit Daten versorgt', () => {
    /* Ohne Daten zeichnet Lightweight Charts auch auf einer sichtbaren Serie
     * keine Marker: Es gibt dann keinen Bar, an den sie sich hängen könnten.
     * Vorher wurde die Serie NUR gefüttert, wenn Preislinien hingen — bei
     * einem Symbol ohne offene Position also nie. */
    const b = setMarkersBlock();
    expect(b).toContain('markerAnzahl = markers.length;');
    expect(b).toContain('hostVersorgen();');
  });

  it('die Kerzen-Serie ist nachweislich nicht immer sichtbar', () => {
    // Das ist die Voraussetzung des ganzen Befunds — steht sie eines Tages
    // auf „immer sichtbar", ist dieser Test die Stelle, die es merkt.
    expect(quelle()).toContain('visible: (isCandle || combineActive) && candlesWanted');
  });
});

describe('Die Träger-Serie versorgt beide Lasten', () => {
  const versorgen = (): string => {
    const text = quelle();
    const ab = text.indexOf('const hostVersorgen = (');
    return text.slice(ab, text.indexOf('\n  };', ab));
  };

  it('sie zählt Preislinien UND Marker', () => {
    // Eine Bedingung, zwei Lasten. Getrennt zu zählen wäre die Gelegenheit,
    // die Serie zu leeren, während die andere Last noch daran hängt.
    expect(versorgen()).toContain('geplanteLinien > 0 || markerAnzahl > 0');
  });

  it('Preislinien melden ihren KÜNFTIGEN Stand', () => {
    /* `priceLines.size` ist beim Aufruf noch der Stand von eben — die neuen
     * Linien werden erst danach angelegt. Ohne den Parameter bliebe die
     * Serie beim ersten Setzen leer. */
    const text = quelle();
    expect(text).toContain('hostVersorgen(lines.length);');
    const ab = text.indexOf('hostVersorgen(lines.length);');
    expect(text.slice(ab, ab + 300)).toContain('for (const spec of lines)');
  });

  it('die alte Sonderbehandlung ist weg', () => {
    // Sie fütterte nur nach Preislinien und war damit die Hälfte des
    // Befunds.
    expect(quelle()).not.toContain('const brauchtHost = lines.length > 0;');
  });
});

describe('Die Sammelstelle im Dashboard bleibt, wie sie ist', () => {
  const dash = (): string =>
    readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

  it('es gibt weiterhin genau EINEN setMarkers-Aufruf je Chart', () => {
    // Verteilte Aufrufe waren früher die Quelle von Sync-Fehlern; der Fix
    // hier darf daran nichts ändern.
    const treffer = dash().match(/\.setMarkers\(/g) ?? [];
    expect(treffer.length).toBe(2); // Haupt-Chart + Grid-Panel
  });

  it('News, Veto und Einstiegs-Marker laufen alle über applyMarkers', () => {
    const text = dash();
    const ab = text.indexOf('function applyMarkers(): void {');
    const block = text.slice(ab, text.indexOf('\n}', ab));
    expect(block).toContain('newsChartMarkers(');
    expect(block).toContain('vetoAnzeige()');
    expect(block).toContain('positionsMarker(times)');
  });
});
