/**
 * Die Zerlegung des Depot-Verlaufs.
 *
 * Der Fehler, gegen den hier geprüft wird, ist der einzige, der wirklich weh
 * täte: eine Zerlegung, deren Teile NICHT die Gesamtlinie ergeben. Sie sähe
 * genauso aus wie eine richtige, und man würde Entscheidungen darauf stützen,
 * welche Trades angeblich wie viel beigetragen haben.
 *
 * Zweiter Schwerpunkt sind die Fenstergrenzen: Ein Trade, der vor dem
 * Fensteranfang geschlossen wurde, steckt schon in der Bezugslinie. Zählte
 * man ihn noch einmal, wäre die Zerlegung um genau diesen Betrag falsch —
 * und der Rest („offen") würde ihn spiegelverkehrt ausgleichen, sodass die
 * Summe trotzdem stimmt. Genau deshalb reicht die Summenprüfung allein nicht.
 */
import { describe, expect, it } from 'vitest';
import {
  type DepotTag,
  type HistoryTrade,
  stapelBaender,
  zerlegeDepot,
} from '../src/index.js';

function tag(date: string, equity: number): DepotTag {
  return { date, equity };
}

function trade(symbol: string, date: string, pnl: number | null, stunde = 20): HistoryTrade {
  return {
    symbol,
    side: 'sell',
    qty: 1,
    price: 100,
    executedAt: `${date}T${String(stunde).padStart(2, '0')}:00:00.000Z`,
    ...(pnl === null ? {} : { pnl }),
  };
}

/** Fünf Tage, drei Symbole, ein offener Anteil — der Normalfall. */
const SERIE = [
  tag('2026-08-03', 10_000),
  tag('2026-08-04', 10_050),
  tag('2026-08-05', 9_980),
  tag('2026-08-06', 10_120),
  tag('2026-08-07', 10_300),
];
const TRADES = [
  trade('AAPL', '2026-08-04', 40),
  trade('MSFT', '2026-08-05', -90),
  trade('AAPL', '2026-08-06', 120),
  trade('NVDA', '2026-08-07', 25),
];

describe('zerlegeDepot — die Summen-Identität', () => {
  it('Basis + alle Bänder + offen ergibt an JEDEM Tag exakt die Equity', () => {
    const z = zerlegeDepot(SERIE, TRADES);
    for (let i = 0; i < z.tage.length; i++) {
      const summe = z.basis + z.baender.reduce((s, b) => s + b.werte[i]!, 0) + z.offen[i]!;
      expect(summe, `Tag ${z.tage[i]}`).toBeCloseTo(z.equity[i]!, 6);
    }
  });

  it('gilt auch, wenn Bänder gebündelt werden', () => {
    // Der Deckel darf nichts verschlucken: Was nicht einzeln gezeigt wird,
    // muss im Rest-Band stecken, nicht im Nirwana.
    const z = zerlegeDepot(SERIE, TRADES, { maxBaender: 1 });
    expect(z.baender.map((b) => b.key)).toEqual(['AAPL', '__rest__']);
    const i = z.tage.length - 1;
    const summe = z.basis + z.baender.reduce((s, b) => s + b.werte[i]!, 0) + z.offen[i]!;
    expect(summe).toBeCloseTo(z.equity[i]!, 6);
    // Und das Rest-Band trägt genau die beiden übrigen Symbole.
    expect(z.baender[1]!.trades).toBe(2);
    expect(z.baender[1]!.summe).toBeCloseTo(-90 + 25, 6);
  });
});

describe('zerlegeDepot — Beiträge', () => {
  const z = zerlegeDepot(SERIE, TRADES);

  it('bündelt je Symbol und kumuliert über die Zeit', () => {
    const aapl = z.baender.find((b) => b.key === 'AAPL')!;
    expect(aapl.trades).toBe(2);
    // Tag 0 noch nichts, ab dem 04. die 40, ab dem 06. zusätzlich die 120.
    expect(aapl.werte).toEqual([0, 40, 40, 160, 160]);
    expect(aapl.summe).toBe(160);
  });

  it('sortiert nach BETRAG, nicht nach Vorzeichen — der größte Verlust steht vorn', () => {
    // Ein Verlust von 90 ist eine größere Bewegung als ein Gewinn von 25 und
    // gehört deshalb weiter nach oben in die Liste.
    expect(z.baender.map((b) => b.key)).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('trennt im Trade-Modus jeden Abschluss einzeln', () => {
    const t = zerlegeDepot(SERIE, TRADES, { modus: 'trade' });
    expect(t.baender).toHaveLength(4);
    expect(t.baender.every((b) => b.trades === 1)).toBe(true);
    // Zwei AAPL-Trades an verschiedenen Tagen dürfen nicht denselben
    // Schlüssel bekommen — sonst überschriebe der zweite den ersten.
    expect(new Set(t.baender.map((b) => b.key)).size).toBe(4);
  });

  it('der Rest ist die Bewegung, die aus keinem Abschluss kam', () => {
    // 03.→07. sind +300 Equity, davon 95 realisiert ⇒ 205 unrealisiert.
    expect(z.offen[z.offen.length - 1]).toBeCloseTo(300 - (40 - 90 + 120 + 25), 6);
    // Am ersten Tag ist per Definition nichts passiert.
    expect(z.offen[0]).toBe(0);
  });
});

describe('zerlegeDepot — Fenstergrenzen', () => {
  it('zählt Trades VOR dem Fenster nicht mit — sie stecken schon in der Basis', () => {
    const z = zerlegeDepot(SERIE, [trade('AAPL', '2026-07-30', 500), ...TRADES]);
    expect(z.ausserhalb.vorher).toBe(1);
    expect(z.baender.find((b) => b.key === 'AAPL')!.summe).toBe(160); // ohne die 500
  });

  it('zählt Trades NACH dem letzten Snapshot nicht mit — sie sind in keiner Equity', () => {
    const z = zerlegeDepot(SERIE, [...TRADES, trade('TSLA', '2026-08-09', 70)]);
    expect(z.ausserhalb.nachher).toBe(1);
    expect(z.baender.some((b) => b.key === 'TSLA')).toBe(false);
  });

  it('zählt einen Trade AM ersten Fenstertag nicht mit — er steckt schon in der Basis', () => {
    /*
     * Dieser Fall hat beim ersten Entwurf einen echten Fehler aufgedeckt: Die
     * Grenze war „vor dem Fenster" statt „am oder vor dem Fenstertag". Der
     * Trade wurde dadurch doppelt gezählt — einmal in der Bezugslinie, einmal
     * als Band —, und der Rest glich ihn spiegelverkehrt aus. Die
     * Summenprüfung blieb grün, die Zerlegung war falsch.
     */
    const z = zerlegeDepot([tag('2026-08-07', 500)], TRADES);
    expect(z.ausserhalb.vorher).toBe(4);
    expect(z.baender).toEqual([]);
    expect(z.offen).toEqual([0]);
  });

  it('schiebt einen Abschluss NACH 17:15 ET auf den Folge-Snapshot', () => {
    // 22:00 UTC = 18:00 ET (Sommerzeit) — der 17:15-Lauf war schon durch.
    // Ohne diese Regel liefe das Band einen Tag vor der Equity-Linie her.
    const spaet = trade('AAPL', '2026-08-04', 40, 22);
    const z = zerlegeDepot(SERIE, [spaet]);
    expect(z.baender[0]!.werte).toEqual([0, 0, 40, 40, 40]);
  });

  it('vor 17:15 ET zählt derselbe Tag', () => {
    // 20:00 UTC = 16:00 ET — noch vor dem Lauf.
    const z = zerlegeDepot(SERIE, [trade('AAPL', '2026-08-04', 40, 20)]);
    expect(z.baender[0]!.werte).toEqual([0, 40, 40, 40, 40]);
  });

  it('ordnet einen Trade ohne eigenen Snapshot-Tag dem NÄCHSTEN zu', () => {
    // Wochenende: Trade am Samstag, nächster Snapshot am Montag. Ohne diese
    // Regel verschwände sein Ergebnis lautlos im Rest.
    const serie = [tag('2026-08-07', 10_000), tag('2026-08-10', 10_200)];
    const z = zerlegeDepot(serie, [trade('BTC-USD', '2026-08-08', 150)]);
    expect(z.baender[0]!.werte).toEqual([0, 150]);
    expect(z.ausserhalb).toEqual({ vorher: 0, nachher: 0 });
  });

  it('offene Trades (ohne pnl) tragen nichts bei', () => {
    const z = zerlegeDepot(SERIE, [...TRADES, trade('AMZN', '2026-08-05', null)]);
    expect(z.baender.some((b) => b.key === 'AMZN')).toBe(false);
  });
});

describe('zerlegeDepot — Randfälle', () => {
  it('leere Serie ⇒ leeres Ergebnis, kein Absturz', () => {
    const z = zerlegeDepot([], TRADES);
    expect(z).toEqual({ tage: [], equity: [], basis: 0, baender: [], offen: [], ausserhalb: { vorher: 0, nachher: 0 } });
  });

  it('sortiert eine verdrehte Serie, statt ihr zu glauben', () => {
    // Die Firestore-Abfrage liest absteigend und dreht um; ein Fehler dort
    // würde hier sonst eine rückwärts laufende Zeitachse erzeugen.
    const z = zerlegeDepot([...SERIE].reverse(), TRADES);
    expect(z.tage[0]).toBe('2026-08-03');
    expect(z.basis).toBe(10_000);
  });

  it('wirft kaputte Equity-Werte raus', () => {
    const z = zerlegeDepot([...SERIE, { date: '2026-08-08', equity: NaN }], TRADES);
    expect(z.tage).toHaveLength(5);
  });

});

describe('stapelBaender', () => {
  const z = zerlegeDepot(SERIE, TRADES);
  const f = stapelBaender(z);

  it('hängt den offenen Anteil als letztes Band an', () => {
    expect(f[f.length - 1]!.key).toBe('__offen__');
    expect(f).toHaveLength(z.baender.length + 1);
  });

  it('setzt jedes Band dort an, wo das vorige aufhört', () => {
    const i = z.tage.length - 1;
    let erwartet = 0;
    for (const b of f) {
      const [u, o] = b.kanten[i]!;
      // Genau eine Kante liegt auf dem Stand VOR diesem Band, die andere danach.
      expect(Math.min(u, o) === erwartet || Math.max(u, o) === erwartet).toBe(true);
      erwartet = b.lauf[i]!;
    }
  });

  it('die laufende Summe nach dem LETZTEN Band ist die Equity-Änderung', () => {
    /*
     * Das ist die Aussage der ganzen Grafik, und sie hat den ersten Entwurf
     * gekippt: Der stapelte Gewinne nach oben und Verluste nach unten. Bei
     * +40, −90 und +30 reichte der Stapel dann von −90 bis +70, während die
     * Equity um −20 gefallen war — die Depot-Linie lag weder oben noch unten,
     * und „die Flächen ergeben zusammen dein Depot" war am Bild nicht
     * nachvollziehbar. Mit der laufenden Summe ist sie es.
     */
    for (let i = 0; i < z.tage.length; i++) {
      expect(f[f.length - 1]!.lauf[i], `Tag ${z.tage[i]}`).toBeCloseTo(z.equity[i]! - z.basis, 6);
    }
  });

  it('ordnet Gewinner vor Verlierer, damit die Treppe nicht hin und her zackt', () => {
    const keys = f.map((b) => b.key);
    expect(keys).toEqual(['AAPL', 'NVDA', 'MSFT', '__offen__']);
  });
});
