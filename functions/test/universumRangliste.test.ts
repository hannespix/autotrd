/**
 * Universum in die Momentum-Rangliste (Task 123).
 *
 * Owner-Frage 11.08.: „Können wir nicht einfach alle verfügbaren
 * Alpaca-Symbole in die Beobachtung nehmen?" Die billige Ebene dafür ist die
 * TÄGLICHE Rangliste: gleicher Rechenweg, tausendfacher Suchraum. Die teure
 * Ebene (5-Minuten-Kursversorgung) bleibt ausdrücklich eine begrenzte
 * Auswahl — genau die Arbeitsteilung aus dem universumSync-Modulkopf.
 *
 * Die Wächter sichern die Grenzen der Erweiterung, nicht nur ihre Existenz:
 * Spark-Fallback, Chart-Backfill und Positionierungs-Messung bleiben
 * bewusst beim Katalog — jede dieser Stellen würde mit 11.000 Kandidaten
 * still zum Kosten- oder Speicherproblem.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { rankingKandidaten } from '../src/scheduled/momentumRun.js';

const hier = dirname(fileURLToPath(import.meta.url));
const lauf = readFileSync(join(hier, '../src/scheduled/momentumRun.ts'), 'utf8');

describe('rankingKandidaten — die pure Vereinigungsregel', () => {
  it('vereinigt Katalog und Universum ohne Doppelte', () => {
    const out = rankingKandidaten(['AAPL', 'QQQ'], new Set(['PLTR', 'AAPL']));
    expect(out.sort()).toEqual(['AAPL', 'PLTR', 'QQQ']);
  });

  it('leeres Universum (Sync lief nie / Lesefehler) ⇒ exakt der Katalog', () => {
    expect(rankingKandidaten(['AAPL', 'QQQ'], new Set())).toEqual(['AAPL', 'QQQ']);
  });
});

describe('momentumRun — Verdrahtung und Grenzen (Quelltext-Wächter)', () => {
  it('die Rangliste bewertet Katalog ∪ Universum', () => {
    expect(lauf).toContain('rankingKandidaten(katalog, await ladeUniversumSymbole())');
    expect(lauf).toContain('getSparkDailyCloses(kandidaten)');
  });

  it('der Spark-FALLBACK bleibt beim Katalog (keine 11.000 Leer-Reads)', () => {
    const fallback = lauf.indexOf('Rückfall auf ohlcDaily');
    expect(fallback).toBeGreaterThan(0);
    const block = lauf.slice(fallback, fallback + 700);
    expect(block).toContain('for (const sym of katalog)');
    expect(block).not.toContain('for (const sym of kandidaten)');
  });

  it('Chart-Backfill und Positionierung bleiben Katalog-Sache', () => {
    expect(lauf).toContain('chartLuecken = chartHistorieFehlt(katalog, stand)');
    expect(lauf).toContain('messePositionierung(katalog, now)');
  });

  it('das Tages-Protokoll misst Abdeckung über die KANDIDATEN', () => {
    expect(lauf).toContain('universum: kandidaten.length');
    expect(lauf).toContain('kandidaten.length - closesMap.size');
  });
});
