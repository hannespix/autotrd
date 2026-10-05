/**
 * Red-Team-Befund 05.10.: Der Sentiment-Schatten zählte jeden Fall je
 * Lookback — Tag dreimal (10/20/30), intraday zweimal (24/48). Alle
 * Geschwister tragen dieselbe Nachrichtenlage, denselben Basiskurs und
 * denselben End-Kurs; `n` war also aufgebläht, ohne dass eine einzige
 * zusätzliche Beobachtung dahinterstand.
 *
 * Gezählt wird jetzt nur das Dokument des kleinsten Lookbacks. Die Regel
 * hängt am Dokument, nicht an einem Merker im Speicher, weil der Tageslauf
 * unsortiert in 200er-Portionen liest und Geschwister in verschiedenen
 * Läufen landen können.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tallySent, vertrittSentimentFall } from '../src/scheduled/evalForecasts.js';
import { INTRADAY_LOOKBACK_GRID, LOOKBACK_GRID } from '../../shared/src/index.js';

const leer = () => ({ pos: { n: 0, hits: 0 }, neg: { n: 0, hits: 0 } });

describe('vertrittSentimentFall', () => {
  it('genau ein Lookback je Gitter vertritt den Fall', () => {
    expect(LOOKBACK_GRID.filter((lb) => vertrittSentimentFall(lb, LOOKBACK_GRID))).toEqual([10]);
    expect(INTRADAY_LOOKBACK_GRID.filter((lb) => vertrittSentimentFall(lb, INTRADAY_LOOKBACK_GRID))).toEqual([24]);
  });

  it('fremder Lookback und leeres Gitter zählen nicht', () => {
    expect(vertrittSentimentFall(15, LOOKBACK_GRID)).toBe(false);
    expect(vertrittSentimentFall(10, [])).toBe(false);
  });

  it('drei Geschwister eines Falls ergeben n = 1, egal in welcher Reihenfolge sie kommen', () => {
    const delta = leer();
    // Gleiche Lage, gleicher Basis- und End-Kurs — wie in der Produktion.
    for (const lb of [30, 10, 20]) {
      if (vertrittSentimentFall(lb, LOOKBACK_GRID)) tallySent(delta, 1, 100, 103);
    }
    expect(delta.pos).toEqual({ n: 1, hits: 1 });
    expect(delta.neg).toEqual({ n: 0, hits: 0 });
  });

  it('auf zwei Läufe verteilte Geschwister zählen zusammen trotzdem einmal', () => {
    const lauf1 = leer();
    const lauf2 = leer();
    for (const lb of [20, 30]) if (vertrittSentimentFall(lb, LOOKBACK_GRID)) tallySent(lauf1, -1, 100, 97);
    for (const lb of [10]) if (vertrittSentimentFall(lb, LOOKBACK_GRID)) tallySent(lauf2, -1, 100, 97);
    expect(lauf1.neg.n + lauf2.neg.n).toBe(1);
  });
});

describe('Quelltext-Wächter: beide Zählstellen hängen am Vertreter', () => {
  const src = readFileSync(join(__dirname, '../src/scheduled/evalForecasts.ts'), 'utf8');

  it('jeder tallySent-Aufruf steht direkt hinter einem vertrittSentimentFall-Check', () => {
    const aufrufe = [...src.matchAll(/^\s+tallySent\(/gm)];
    expect(aufrufe).toHaveLength(2);
    for (const a of aufrufe) {
      const davor = src.slice(Math.max(0, a.index! - 200), a.index!);
      expect(davor).toMatch(/if \(vertrittSentimentFall\(doc\.lookback, (INTRADAY_)?LOOKBACK_GRID\)\) \{\s*$/);
    }
  });

  it('Tag nutzt das Tages-Gitter, intraday das Intraday-Gitter', () => {
    expect(src.match(/vertrittSentimentFall\(doc\.lookback, LOOKBACK_GRID\)/g)).toHaveLength(1);
    expect(src.match(/vertrittSentimentFall\(doc\.lookback, INTRADAY_LOOKBACK_GRID\)/g)).toHaveLength(1);
  });

  it('die bereinigte Zählung landet getrennt vom aufgeblähten Altbestand', () => {
    expect(src).toMatch(/einmalig: \{\s*\[scope\]:/);
  });
});
