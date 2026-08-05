/**
 * Tests der Schatten-Kante je Klasse.
 *
 * Der teuerste Fehler wäre ein gedrehtes Vorzeichen: Dann würde jede
 * funktionierende Short-Signalquelle als Verlust gemessen — und eine Klasse
 * abgeschaltet, die verdient. Entsprechend liegt der Schwerpunkt dort.
 */

import { describe, expect, it } from 'vitest';
import {
  SCHATTEN_MAX_ALTER_MS,
  SCHATTEN_MIN_N,
  addiereSchatten,
  bewerteSchattenSignal,
  leseSchattenSignal,
  werteSchattenAus,
} from '../src/classShadow.js';

/** 0,3 % Roundtrip — der Satz für Aktien/ETFs. */
const KOSTEN = 0.003;

describe('bewerteSchattenSignal — Richtung entscheidet über das Vorzeichen', () => {
  it('wertet einen steigenden Kurs nach „buy" als Treffer', () => {
    const b = bewerteSchattenSignal({ direction: 'buy', price: 100 }, 101, KOSTEN);
    expect(b.zaehlt).toBe(true);
    expect(b.rohPct).toBeCloseTo(1, 4);
    expect(b.nettoPct).toBeCloseTo(0.7, 4); // 1 % − 0,3 % Kosten
  });

  it('wertet einen FALLENDEN Kurs nach „sell" als Treffer', () => {
    // Der Fall, an dem ein gedrehtes Vorzeichen auffliegt: Für ein
    // Verkaufssignal ist ein fallender Kurs ein Erfolg, kein Verlust.
    const b = bewerteSchattenSignal({ direction: 'sell', price: 100 }, 99, KOSTEN);
    expect(b.rohPct).toBeCloseTo(1, 4);
    expect(b.nettoPct).toBeCloseTo(0.7, 4);
  });

  it('wertet einen steigenden Kurs nach „sell" als Fehlschlag', () => {
    const b = bewerteSchattenSignal({ direction: 'sell', price: 100 }, 102, KOSTEN);
    expect(b.rohPct).toBeCloseTo(-2, 4);
    expect(b.nettoPct).toBeCloseTo(-2.3, 4);
  });

  it('zieht die Kosten IMMER ab — auch von einem Gewinn', () => {
    // Eine Bewegung, die exakt die Kosten deckt, ist netto null. Genau das
    // ist die Zahl, um die es geht: Bewegung allein ist kein Gewinn.
    const b = bewerteSchattenSignal({ direction: 'buy', price: 100 }, 100.3, KOSTEN);
    expect(b.rohPct).toBeCloseTo(0.3, 4);
    expect(b.nettoPct).toBeCloseTo(0, 4);
  });
});

describe('bewerteSchattenSignal — was NICHT zählt', () => {
  it('zählt „hold" nicht', () => {
    expect(bewerteSchattenSignal({ direction: 'hold', price: 100 }, 110, KOSTEN).zaehlt).toBe(false);
  });

  it('zählt kaputte Kurse nicht, statt eine Zahl zu erfinden', () => {
    for (const [p, jetzt] of [
      [0, 100],
      [100, 0],
      [-5, 100],
      [Number.NaN, 100],
    ] as const) {
      expect(bewerteSchattenSignal({ direction: 'buy', price: p }, jetzt, KOSTEN).zaehlt).toBe(
        false,
      );
    }
  });

  it('zählt bei unsinnigem Kostensatz nicht', () => {
    expect(bewerteSchattenSignal({ direction: 'buy', price: 100 }, 110, -1).zaehlt).toBe(false);
  });
});

describe('addiereSchatten — laufendes Aggregat', () => {
  it('summiert Netto-Kanten und zählt Signale', () => {
    let k = addiereSchatten(undefined, bewerteSchattenSignal({ direction: 'buy', price: 100 }, 101, KOSTEN));
    k = addiereSchatten(k, bewerteSchattenSignal({ direction: 'buy', price: 100 }, 102, KOSTEN));
    expect(k.n).toBe(2);
    expect(k.summePct).toBeCloseTo(0.7 + 1.7, 3);
    expect(k.treffer).toBe(2);
  });

  it('zählt Treffer VOR Kosten', () => {
    // Eine Bewegung von 0,1 % ist richtig geraten, trägt aber die Reibung
    // nicht. Beides in eine Zahl zu werfen, verschleiert, welcher Teil das
    // Problem ist: die Richtung oder die Gebühren.
    const k = addiereSchatten(
      undefined,
      bewerteSchattenSignal({ direction: 'buy', price: 100 }, 100.1, KOSTEN),
    );
    expect(k.treffer).toBe(1);
    expect(k.summePct).toBeLessThan(0);
  });

  it('lässt das Aggregat von einem nicht zählenden Signal unberührt', () => {
    const vorher = { n: 5, summePct: 2.5, treffer: 3 };
    expect(addiereSchatten(vorher, { zaehlt: false, rohPct: 99, nettoPct: 99 })).toEqual(vorher);
  });
});

describe('werteSchattenAus', () => {
  it('rechnet Trefferquote und mittlere Kante', () => {
    const a = werteSchattenAus({ n: 4, summePct: 2, treffer: 3 });
    expect(a.trefferquote).toBe(0.75);
    expect(a.kantePct).toBe(0.5);
  });

  it('gibt null statt 0, wenn nichts gemessen wurde', () => {
    // Der Unterschied ist wichtig: „keine Daten" ist nicht „Kante null".
    const a = werteSchattenAus(undefined);
    expect(a.trefferquote).toBeNull();
    expect(a.kantePct).toBeNull();
    expect(werteSchattenAus({ n: 0, summePct: 0, treffer: 0 }).kantePct).toBeNull();
  });

  it('bildet eine negative Kante als negative Zahl ab', () => {
    const a = werteSchattenAus({ n: 10, summePct: -3, treffer: 4 });
    expect(a.kantePct).toBe(-0.3);
    expect(a.trefferquote).toBe(0.4);
  });
});

describe('leseSchattenSignal — was aus der Datenbank kommt, ist unknown', () => {
  const JETZT = Date.parse('2026-08-04T15:30:00.000Z');
  const vor = (ms: number): string => new Date(JETZT - ms).toISOString();

  it('liest ein frisches, wohlgeformtes Signal', () => {
    const s = leseSchattenSignal(
      { direction: 'sell', price: 42.5, at: vor(5 * 60_000) },
      JETZT,
    );
    expect(s).toEqual({ direction: 'sell', price: 42.5 });
  });

  it('verwirft eine unbekannte Richtung, statt sie wie „sell" zu behandeln', () => {
    // Der teure Fall: `bewerteSchattenSignal` dreht das Vorzeichen für alles,
    // was nicht 'buy' ist. Käme hier ein `undefined` durch, würde jede
    // Bewegung als Short-Ergebnis verbucht — und eine Klasse fiele wegen
    // eines Datenfehlers aus dem Handel.
    for (const dir of [undefined, null, '', 'BUY', 'long', 0, {}]) {
      expect(leseSchattenSignal({ direction: dir, price: 100, at: vor(60_000) }, JETZT)).toBeNull();
    }
  });

  it('verwirft kaputte Kurse', () => {
    for (const price of [undefined, null, 0, -1, '100', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        leseSchattenSignal({ direction: 'buy', price, at: vor(60_000) }, JETZT),
      ).toBeNull();
    }
  });

  it('verwirft ein Signal ohne oder mit unlesbarem Zeitstempel', () => {
    expect(leseSchattenSignal({ direction: 'buy', price: 100 }, JETZT)).toBeNull();
    expect(leseSchattenSignal({ direction: 'buy', price: 100, at: 'gestern' }, JETZT)).toBeNull();
    expect(leseSchattenSignal({ direction: 'buy', price: 100, at: 12345 }, JETZT)).toBeNull();
  });

  it('verwirft, was über Nacht oder übers Wochenende liegt', () => {
    // Die eigentliche Pointe der Alterprüfung: Über eine Wochenendlücke
    // bewegt sich ein Kurs ein Vielfaches dessen, was in fünf Minuten
    // passiert. Solche Fenster mitzuzählen, machte die Kante zur Funktion
    // der Scan-Lücken — und die sind je Klasse verschieden groß.
    const uebernacht = { direction: 'buy', price: 100, at: vor(17 * 3600_000) };
    expect(leseSchattenSignal(uebernacht, JETZT)).toBeNull();
    expect(leseSchattenSignal({ ...uebernacht, at: vor(SCHATTEN_MAX_ALTER_MS + 1000) }, JETZT))
      .toBeNull();
    // Knapp innerhalb bleibt gültig — ausgefallene Läufe sollen nicht
    // gleich die ganze Messung stoppen.
    expect(leseSchattenSignal({ ...uebernacht, at: vor(SCHATTEN_MAX_ALTER_MS - 1000) }, JETZT))
      .not.toBeNull();
  });

  it('verwirft ein Signal aus der Zukunft', () => {
    // Verstellte Uhr oder verrutschte Zeitzone. Beides ist ein Grund, die
    // Zahl nicht zu verwenden — nicht, sie als „ganz frisch" zu lesen.
    expect(
      leseSchattenSignal({ direction: 'buy', price: 100, at: vor(-60_000) }, JETZT),
    ).toBeNull();
  });

  it('verwirft, was gar kein Objekt ist', () => {
    for (const roh of [undefined, null, 'buy', 42, []]) {
      expect(leseSchattenSignal(roh, JETZT)).toBeNull();
    }
  });

  it('deckt fünf ausgefallene Scans ab', () => {
    // Der Scan läuft alle 5 Minuten. Die Grenze muss großzügiger sein als
    // ein Intervall, sonst reißt jede Verzögerung die Messreihe ab.
    expect(SCHATTEN_MAX_ALTER_MS).toBeGreaterThanOrEqual(25 * 60_000);
  });
});

describe('Mindestmenge', () => {
  it('verlangt mehr Signale als die Trade-Kante Trades', () => {
    // Ein Signal je Scan ist ein schwächerer Datenpunkt als ein
    // abgeschlossener Trade — es fehlen Stop, Ziel und Haltedauer.
    expect(SCHATTEN_MIN_N).toBeGreaterThan(30);
  });
});

/* ── Rohbewegung getrennt von den Kosten (05.08.) ──────────────────────────
 *
 * Anlass war eine Live-Messung: −0,496 % Kante je Signal. Diese Zahl lässt
 * zwei völlig verschiedene Deutungen zu — „Signal ist Rauschen" oder
 * „Signal trägt Information, aber weniger als die TEUERSTE Klasse kostet".
 * Nachts handelt nur Krypto (0,50 % Roundtrip); die gemessene Kante war
 * praktisch identisch mit den Kosten dieser einen Klasse.
 */
describe('Rohbewegung vs. Netto-Kante', () => {
  it('trennt „Richtung stimmt" von „Gebühren fressen sie"', () => {
    // Ein Signal mit +0,3 % Bewegung in Krypto (0,5 % Roundtrip): netto
    // negativ, roh positiv. Genau der Fall, den die Netto-Zahl allein
    // verschweigt.
    const beitrag = bewerteSchattenSignal(
      { direction: 'buy', price: 100, atMs: 0 },
      100.3,
      0.005,
    );
    const a = werteSchattenAus(addiereSchatten(undefined, beitrag));
    expect(a.kantePct).toBeLessThan(0);
    expect(a.rohPct).toBeGreaterThan(0);
    expect(a.rohPct).toBeCloseTo(0.3, 4);
  });

  it('teilt die Rohsumme durch den EIGENEN Zähler, nicht durch n', () => {
    // Der Fallstrick beim Nachrüsten: Ein Altbestand trägt 170 Signale und
    // keine Rohsumme. Käme jetzt EIN frisches Signal mit +1 % dazu, wäre
    // 1/171 ≈ 0,006 % — eine gegen null verzerrte Zahl, an der aber die
    // Entscheidung hängt. Mit eigenem Nenner sind es die vollen 1 %.
    const alt = { n: 170, summePct: -84, treffer: 91 };
    const neu = addiereSchatten(
      alt,
      bewerteSchattenSignal({ direction: 'buy', price: 100, atMs: 0 }, 101, 0),
    );
    const a = werteSchattenAus(neu);
    expect(a.n).toBe(171);
    expect(a.nRoh).toBe(1);
    expect(a.rohPct).toBeCloseTo(1, 4);
  });

  it('meldet „nicht gemessen" statt einer erfundenen Null', () => {
    // Altbestand ohne Rohsumme darf nicht wie „Bewegung war null" aussehen —
    // das würde eine funktionierende Signalquelle zu Unrecht erledigen.
    const a = werteSchattenAus({ n: 170, summePct: -84, treffer: 91 });
    expect(a.kantePct).toBeCloseTo(-0.4941, 3);
    expect(a.rohPct).toBeNull();
    expect(a.nRoh).toBe(0);
  });

  it('dreht die Rohbewegung beim Verkaufssignal mit', () => {
    // Ein fallender Kurs ist beim sell ein Treffer — auch roh.
    const b = bewerteSchattenSignal({ direction: 'sell', price: 100, atMs: 0 }, 99, 0.001);
    const a = werteSchattenAus(addiereSchatten(undefined, b));
    expect(a.rohPct).toBeCloseTo(1, 4);
    expect(a.treffer).toBe(1);
  });
});
