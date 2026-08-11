/**
 * Zwei Audit-Befunde vom 11.08.: Zahlen, die Handelsentscheidungen steuern.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rateKlasse, reglerSchritt, positionValue } from '../../shared/src/index.js';

/* ── Befund A: „drosseln" schaltete abgeschaltete Klassen wieder EIN ───────
 *
 * `bewerteKante` gab im Drossel-Zweig `Math.max(0.25, w * 0.5)` zurück. Bei
 * einem Gewicht von 0 ist das 0,25 — aus „halbes Gewicht" wurde eine
 * Aktivierung, und zwar auf NEGATIVE Kante hin.
 *
 * Der Weg war vollautomatisch: `snapshotEquity` ruft `berateKlassen` →
 * `reglerSchritt` und schreibt das Ergebnis ohne Rückfrage nach
 * `settings.strategy.engine.classWeights` (`classAutoTune` ist per Default
 * an). Danach greift `klassenGewicht(...) <= 0 → 'klasse_aus'` im Scan nicht
 * mehr, und die Klasse handelt wieder — mit `sizeFactor × 0,25`.
 *
 * Im Journal stand `von: 0, nach: 0.25` mit dem Text „halbes Gewicht, weiter
 * beobachten". Die Meldung beschrieb eine Drosselung, ausgeführt wurde eine
 * Aktivierung.
 *
 * Damit war der Riegel offen, den der Modulkopf von `classAdvisor.ts`
 * ausdrücklich beschreibt: Der Rückweg aus dem Schatten sei „eng: nur bei
 * Gewicht 0, nur mit belegtem und POSITIVEM Schatten". Hier führte er bei
 * negativer Kante zurück — der einzige Fall, für den er nie gedacht war.
 */
describe('Befund A: eine abgeschaltete Klasse bleibt aus', () => {
  /* Geprüft wird über `rateKlasse` — die Schnittstelle, die `berateKlassen`
   * und damit `snapshotEquity` tatsächlich ruft. Die Bewertung selbst ist
   * modulintern; sie über einen Umweg zu erreichen hieße, den Weg zu prüfen,
   * den niemand geht. `n = 60` liegt über KLASSE_MIN_TRADES, damit Pfad 1
   * (eigene Trades) greift und nicht Schatten oder globaler Beleg. */
  const rat = (kantePct: number, gewicht: number): ReturnType<typeof rateKlasse> =>
    rateKlasse('crypto', { n: 60, kantePct }, gewicht);

  it('drosseln lässt ein Gewicht von 0 auf 0', () => {
    // Der eigentliche Befund. Vorher: 0,25.
    const r = rat(-0.05, 0);
    expect(r.empfehlung).toBe('drosseln');
    expect(r.vorschlag).toBe(0);
  });

  it('und sagt das auch — der Text passt zur Zahl', () => {
    // Vorher stand „halbes Gewicht, weiter beobachten" über einer
    // Aktivierung. Ein Journal, dessen Text etwas anderes sagt als die
    // Zahl daneben, ist als Nachweis wertlos.
    expect(rat(-0.05, 0).grund).toContain('bleibt aus');
    expect(rat(-0.05, 1).grund).toContain('halbes Gewicht');
  });

  it('eine LAUFENDE Klasse wird weiterhin halbiert', () => {
    expect(rat(-0.05, 1).vorschlag).toBe(0.5);
    expect(rat(-0.05, 0.8).vorschlag).toBe(0.4);
  });

  it('und die 0,25-Untergrenze gilt für sie weiter', () => {
    // Sie bleibt richtig: Sonst führte wiederholtes Halbieren eine laufende
    // Klasse still gegen null — ein Abschalten ohne Beschluss.
    expect(rat(-0.05, 0.4).vorschlag).toBe(0.25);
    expect(rat(-0.05, 0.1).vorschlag).toBe(0.25);
  });

  it('der Regler bewegt eine ausgeschaltete Klasse nicht mehr', () => {
    // `reglerSchritt` ist die Stelle, deren Ergebnis snapshotEquity nach
    // `engine.classWeights` schreibt. Sie ist der Punkt, an dem aus einer
    // Empfehlung ein echtes Handelsgewicht wird.
    expect(reglerSchritt(rat(-0.05, 0))).toBe(0);
  });

  it('bei einer laufenden Klasse bewegt er weiterhin', () => {
    expect(reglerSchritt(rat(-0.05, 1))).toBe(0.75);
  });

  it('abschalten bleibt abschalten', () => {
    // Der harte Zweig darunter war nie betroffen — hier nur als Beleg, dass
    // der Fix ihn nicht angefasst hat.
    expect(rat(-0.5, 1).empfehlung).toBe('abschalten');
    expect(rat(-0.5, 1).vorschlag).toBe(0);
  });

  it('und die positiven Zweige ebenso', () => {
    expect(rat(0.5, 1).empfehlung).toBe('verstaerken');
    expect(rat(0.5, 0).vorschlag).toBeGreaterThan(0);
  });

  it('der Schatten-Rückweg bleibt der EINZIGE Weg zurück', () => {
    /* Der Riegel, den der Modulkopf beschreibt: „nur bei Gewicht 0, nur mit
     * belegtem und POSITIVEM Schatten". Nach dem Fix gibt es genau einen
     * Pfad, der ein Gewicht von 0 anhebt — und er verlangt eine positive
     * Messung. */
    const mitSchatten = (schattenKante: number): ReturnType<typeof rateKlasse> =>
      rateKlasse('crypto', { n: 0, kantePct: null, schatten: { n: 400, kantePct: schattenKante } }, 0);
    expect(mitSchatten(0.2).vorschlag).toBeGreaterThan(0);
    expect(mitSchatten(0.2).empfehlung).toBe('zurueckholen');
    // Negativer Schatten holt nicht zurück.
    expect(mitSchatten(-0.2).vorschlag).toBe(0);
  });
});

/* ── Befund B: Der Momentum-Lauf bewertete Shorts mit falschem Vorzeichen ──
 *
 * Zwei Stellen in `momentumRun.ts` rechneten `equity += qty × Kurs`, während
 * sieben andere Stellen im Repo längst `positionValue` rufen. Für einen Short
 * ist der Marktwert das falsche Vorzeichen: Richtig ist `qty × Einstand +
 * (Einstand − Kurs) × qty` — gebundene Margin plus unrealisierter Gewinn.
 *
 * Dieselbe Formel-Dopplung wie bei `shadowEquity` einen Tag zuvor.
 */
describe('Befund B: Depotwert im Momentum-Lauf', () => {
  const short = { qty: 100, avgEntry: 50, side: 'short' as const };

  it('ein verlustreicher Short senkt die Equity, statt sie zu heben', () => {
    // 5.000 Cash + Short 100 @ 50, Kurs jetzt 60.
    // Falsch: 5.000 + 100·60 = 11.000. Richtig: 5.000 + 4.000 = 9.000.
    expect(5_000 + positionValue(short, 60)).toBe(9_000);
  });

  it('ein gewinnbringender Short hebt sie', () => {
    expect(5_000 + positionValue(short, 40)).toBe(11_000);
  });

  it('ohne Kurs wird konservativ zum Einstand bewertet', () => {
    expect(positionValue(short, null)).toBe(5_000);
  });

  it('Longs verhalten sich unverändert', () => {
    expect(positionValue({ qty: 10, avgEntry: 100 }, 120)).toBe(1_200);
    expect(positionValue({ qty: 10, avgEntry: 100 }, null)).toBe(1_000);
  });
});

/* Wie bei den Paketen davor: Die Formel allein sagt nichts darüber, ob der
 * Lauf sie auch benutzt. Beide Stellen stecken in einer Firestore-Schleife;
 * ein Test, der sie nachbaut, prüfte die Nachbildung. */
describe('Quelltext: der Momentum-Lauf rechnet nicht mehr selbst', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'momentumRun.ts');

  it('keine handgerechnete Depotbewertung mehr', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toMatch(/equity \+= pos\.qty \* /);
    expect(text).not.toMatch(/equity \+= .*\bpos\.qty\b.*preise\.get/);
  });

  it('beide Equity-Summen laufen über positionValue', () => {
    const text = readFileSync(pfad, 'utf8');
    const treffer = text.match(/equity \+= positionValue\(/g) ?? [];
    expect(treffer.length, 'Rebalancing UND Kern-Satellit').toBe(2);
  });
});
