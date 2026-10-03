/**
 * Nebenläufigkeitsgrenze für die Spark-Bündel.
 *
 * ── Wogegen das schützt ───────────────────────────────────────────────────
 *
 * Bisher lief `Promise.allSettled` über ALLE Chunks. Bei 166 Katalog-
 * Symbolen sind das 9 gleichzeitige Anfragen — unauffällig. Mit dem
 * Alpaca-Universum werden daraus mehrere hundert, alle in derselben
 * Millisekunde.
 *
 * Der Fehlerfall wäre besonders heimtückisch: Yahoo antwortet dann mit 429
 * für die ganze Herkunft, jeder Chunk schlägt einzeln fehl, und das Ergebnis
 * sieht aus wie „Yahoo kennt diese Symbole nicht" — also wie ein leeres
 * Universum, nicht wie ein Kontingentproblem. Eine Rangliste aus dem
 * Rest wäre still falsch.
 */
import { describe, expect, it } from 'vitest';
import { mitGrenze, SPARK_PARALLEL } from '../src/core/marketData.js';

/** Aufgabe, die mitzählt, wie viele gleichzeitig laufen. */
function zaehlend(dauerMs = 5): {
  aufgabe: () => Promise<number>;
  hoch: () => number;
  gesamt: () => number;
} {
  let laufend = 0;
  let hoechst = 0;
  let gestartet = 0;
  return {
    aufgabe: async () => {
      gestartet++;
      laufend++;
      hoechst = Math.max(hoechst, laufend);
      await new Promise((r) => setTimeout(r, dauerMs));
      laufend--;
      return gestartet;
    },
    hoch: () => hoechst,
    gesamt: () => gestartet,
  };
}

describe('mitGrenze', () => {
  it('startet nie mehr Aufgaben gleichzeitig als erlaubt', () => {
    const z = zaehlend();
    return mitGrenze(
      Array.from({ length: 40 }, () => z.aufgabe),
      5,
    ).then(() => {
      expect(z.hoch()).toBeLessThanOrEqual(5);
      expect(z.gesamt()).toBe(40);
    });
  });

  it('nutzt die Grenze auch aus — sonst wäre es nur langsam', async () => {
    const z = zaehlend(10);
    await mitGrenze(
      Array.from({ length: 40 }, () => z.aufgabe),
      5,
    );
    expect(z.hoch()).toBe(5);
  });

  it('führt jede Aufgabe genau einmal aus, in Reihenfolge der Ergebnisse', async () => {
    const aufgaben = Array.from({ length: 12 }, (_, i) => () => Promise.resolve(i * 2));
    const out = await mitGrenze(aufgaben, 3);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual(
      aufgaben.map((_, i) => i * 2),
    );
  });

  it('ein Fehler beendet die anderen nicht — er landet an seiner Stelle', async () => {
    // Genau das Verhalten, das der Spark-Batch braucht: Ein gescheiterter
    // Chunk kostet seine 20 Symbole, nie den ganzen Lauf.
    const aufgaben = [
      () => Promise.resolve('a'),
      () => Promise.reject(new Error('kaputt')),
      () => Promise.resolve('c'),
    ];
    const out = await mitGrenze(aufgaben, 2);
    expect(out[0]).toMatchObject({ status: 'fulfilled', value: 'a' });
    expect(out[1]?.status).toBe('rejected');
    expect(out[2]).toMatchObject({ status: 'fulfilled', value: 'c' });
  });

  it('kommt mit weniger Aufgaben als Arbeitern klar', async () => {
    const out = await mitGrenze([() => Promise.resolve(1)], 8);
    expect(out).toHaveLength(1);
  });

  it('kommt mit einer leeren Liste klar, ohne zu hängen', async () => {
    expect(await mitGrenze([], 8)).toEqual([]);
  });

  it('behandelt Grenze 0 wie 1, statt gar nichts zu tun', async () => {
    // Eine Grenze von 0 wäre ein stiller Totalausfall: kein Arbeiter, kein
    // Ergebnis, kein Fehler.
    const out = await mitGrenze([() => Promise.resolve('x')], 0);
    expect(out[0]).toMatchObject({ status: 'fulfilled', value: 'x' });
  });

  it('die Vorgabe ist konservativ genug für tausende Symbole', () => {
    expect(SPARK_PARALLEL).toBeLessThanOrEqual(10);
    expect(SPARK_PARALLEL).toBeGreaterThanOrEqual(4);
  });
});
