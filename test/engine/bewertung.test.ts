/**
 * Die Bewertungszeile: „Habe ich dieses Symbol überhaupt angesehen?"
 *
 * ── Warum dieser Wächter existiert ────────────────────────────────────────
 *
 * Am 16.09.2026 sagte das Symbolprofil für BAC einen Einstieg voraus, die
 * Engine stellte keine Order, und das Journal enthielt zu BAC NICHTS. Aus
 * „nichts" liess sich nicht ablesen, welcher von vier Fällen vorlag:
 *
 *   (a) bewertet, und `decide()` sagte „halten"   → schreibt nichts
 *   (b) keine neue geschlossene Bar               → schreibt nichts
 *   (c) gar keine Bars                            → schreibt nichts
 *   (d) neue Bar, aber KEINE Taktik               → schreibt nichts,
 *       verbraucht die Bar aber (`lastBarAt` gilt für alles in `newBars`)
 *
 * (d) ist der unangenehme Fall: Das Symbol gilt danach als gesehen und wird
 * an diesem Tag nicht mehr bewertet. Er sah aus wie (a).
 *
 * Die Zeile trennt sie. Sie hängt an den BARS, nicht am Takt — sonst wäre sie
 * das nächste Takt-Rauschen (PR #510: eine Notiz je Minute hatte genau diese
 * Diagnose verdeckt). Kein neuer Bar-Stapel, keine Zeile.
 */
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import { OPEN1, TEN_CLOSES, minuteBars, scriptedStrategy, startScenario, testConfig } from '../fakes/harness.ts';

const T1 = OPEN1 + 10 * MIN + 5_000;

/** Die Bewertungszeile des jüngsten Takts (`decision` mit `note: 'bewertung'`). */
const zeilen = (sc: Awaited<ReturnType<typeof startScenario>>) => sc.events('decision').filter((e) => e.note === 'bewertung');

describe('Bewertungszeile', () => {
  it('steht einmal je Bar-Stapel — und NICHT je Takt', async () => {
    const sc = await startScenario({ config: testConfig({ universe: { symbols: ['AAPL'] } }), defaultStrategy: scriptedStrategy({}) });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(zeilen(sc)).toHaveLength(1);

    // Zweiter Takt OHNE neue Bar: keine zweite Zeile. Das ist die
    // Anti-Rausch-Eigenschaft — ohne sie schriebe die Plattform sie je Minute.
    await sc.engine.tick(T1 + 30_000);
    expect(zeilen(sc), 'ohne neuen Bar-Stapel darf nichts dazukommen — sonst ist es Takt-Rauschen').toHaveLength(1);
  });

  it('nennt die Zahlen, an denen „nicht bewertet" von „bewertet und nichts gewollt" hängt', async () => {
    const sc = await startScenario({ config: testConfig({ universe: { symbols: ['AAPL'] } }), defaultStrategy: scriptedStrategy({}) });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);
    expect(zeilen(sc)[0]).toMatchObject({ symbole: 1, neueBar: 1, bewertet: 1, einstiegsWunsch: 0, gesperrt: 0, ohneBars: [], ohneTaktik: [] });
  });

  it('WÄCHTER: ein Symbol mit neuer Bar, aber ohne Taktik, steht namentlich da — seine Bar ist verbraucht', async () => {
    // Genau der Fall, der wie „halten" aussah: `strategyFor` gibt null, die
    // Schleife bricht ab, `lastBarAt` wird trotzdem gesetzt. Vorher spurlos.
    const sc = await startScenario({
      config: testConfig({ universe: { symbols: ['AAPL', 'MSFT'] } }),
      defaultStrategy: scriptedStrategy({}),
      strategies: { MSFT: null },
    });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    sc.pushBars('MSFT', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);

    const z = zeilen(sc)[0]!;
    expect(z.neueBar).toBe(2);
    expect(z.bewertet, 'zwei Bars, eine Bewertung — die Differenz ist der stille Fall').toBe(1);
    expect(z.ohneTaktik).toEqual(['MSFT']);
    expect(String(z.text), 'im Klartext, damit es im Bericht auffällt').toContain('OHNE TAKTIK');
  });

  it('WÄCHTER: ein Symbol ganz ohne Bars steht namentlich da — es ist nie in die Bewertung gekommen', async () => {
    const sc = await startScenario({
      config: testConfig({ universe: { symbols: ['AAPL', 'NODATA'] } }),
      defaultStrategy: scriptedStrategy({}),
    });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);

    const z = zeilen(sc)[0]!;
    expect(z.ohneBars).toEqual(['NODATA']);
    expect(z.neueBar, 'ohne Bars kommt das Symbol nicht einmal in newBars').toBe(1);
  });

  it('WÄCHTER: steht die Zeile auch dann, wenn KEIN Symbol bewertbar war?', async () => {
    /*
     * Mein erster Entwurf schrieb sie innerhalb von `if (inputs.length > 0)`.
     * Damit schwieg sie ausgerechnet im schlimmsten Fall: Korb voll, Bars da,
     * aber keine einzige Taktik — `decide()` kommt nie dran, und das Journal
     * sieht aus wie an einem ruhigen Tag. Der erste Wächter merkte es nicht,
     * weil er nur „keine neue Bar" geprüft hat.
     */
    const sc = await startScenario({
      config: testConfig({ universe: { symbols: ['AAPL', 'MSFT'] } }),
      defaultStrategy: null,
      strategies: { AAPL: null, MSFT: null },
    });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    sc.pushBars('MSFT', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);

    const z = zeilen(sc);
    expect(z, 'ohne diese Zeile ist „kein Eintrag" nicht von „alles ruhig" zu unterscheiden').toHaveLength(1);
    expect(z[0]!.bewertet).toBe(0);
    expect([...(z[0]!.ohneTaktik as string[])].sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('ein Einstiegswunsch wird namentlich genannt — sonst weiss man, dass einer da war, aber nicht welcher', async () => {
    const sc = await startScenario({
      config: testConfig({ universe: { symbols: ['AAPL'] } }),
      defaultStrategy: scriptedStrategy({ enterAt: 0, holdsOvernight: true }),
    });
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(T1);

    const z = zeilen(sc)[0]!;
    expect(z.einstiegsWunsch).toBe(1);
    expect(String(z.text)).toContain('1 Einstiegswunsch (AAPL)');
  });
});
