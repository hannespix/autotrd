/**
 * Depot-Kurve aus Trades, wenn Snapshots fehlen.
 *
 * Der Anlassfall vom 12.08. steht als eigener Test drin: neun Trades, keine
 * Snapshots — und trotzdem muss eine Kurve entstehen.
 */
import { describe, expect, it } from 'vitest';

import {
  SNAPSHOT_MIN,
  kurvenErklaerung,
  kurveAusTrades,
  waehleKurve,
  type KurvenTrade,
} from '../src/kurveAusTrades.js';

const t = (at: string, pnl: number): KurvenTrade => ({ at, pnl });

describe('kurveAusTrades', () => {
  it('beginnt am Vortag mit der Kapitalbasis', () => {
    const k = kurveAusTrades([t('2026-08-10T14:00:00.000Z', -100)], 100_000);
    expect(k[0]).toEqual({ date: '2026-08-09', equity: 100_000 });
    expect(k[1]).toEqual({ date: '2026-08-10', equity: 99_900 });
  });

  it('kumuliert über die Tage', () => {
    const k = kurveAusTrades(
      [
        t('2026-08-10T14:00:00.000Z', -100),
        t('2026-08-11T15:00:00.000Z', +250),
        t('2026-08-12T16:00:00.000Z', -50),
      ],
      10_000,
    );
    expect(k.map((p) => p.equity)).toEqual([10_000, 9_900, 10_150, 10_100]);
  });

  it('fasst mehrere Abschlüsse eines Tages zu EINEM Punkt zusammen', () => {
    const k = kurveAusTrades(
      [
        t('2026-08-10T10:00:00.000Z', -100),
        t('2026-08-10T14:00:00.000Z', -200),
        t('2026-08-10T18:00:00.000Z', +50),
      ],
      1_000,
    );
    expect(k).toHaveLength(2); // Anker + ein Handelstag
    expect(k[1]).toEqual({ date: '2026-08-10', equity: 750 });
  });

  it('sortiert unsortierte Eingaben', () => {
    const k = kurveAusTrades(
      [t('2026-08-12T10:00:00.000Z', +30), t('2026-08-10T10:00:00.000Z', -10)],
      500,
    );
    expect(k.map((p) => p.date)).toEqual(['2026-08-09', '2026-08-10', '2026-08-12']);
    expect(k.map((p) => p.equity)).toEqual([500, 490, 520]);
  });

  it('wirft kaputte Trades raus statt die Kurve zu vergiften', () => {
    const k = kurveAusTrades(
      [
        t('2026-08-10T10:00:00.000Z', -100),
        { at: '', pnl: 5 } as KurvenTrade,
        { at: '2026-08-11T10:00:00.000Z', pnl: Number.NaN },
        { at: 'kaputt', pnl: 7 } as KurvenTrade,
      ],
      1_000,
    );
    expect(k.every((p) => Number.isFinite(p.equity))).toBe(true);
    expect(k[k.length - 1]!.equity).toBe(900);
  });

  it('liefert nichts ohne Trades oder ohne brauchbare Basis', () => {
    expect(kurveAusTrades([], 1_000)).toEqual([]);
    expect(kurveAusTrades([t('2026-08-10T10:00:00.000Z', 1)], Number.NaN)).toEqual([]);
  });
});

describe('waehleKurve', () => {
  const snaps = [
    { date: '2026-08-10', equity: 100_000 },
    { date: '2026-08-11', equity: 99_000 },
  ];
  const trades = [t('2026-08-10T14:00:00.000Z', -500), t('2026-08-11T14:00:00.000Z', -300)];

  it('nimmt Snapshots, sobald es genug gibt', () => {
    const w = waehleKurve(snaps, trades, 100_000);
    expect(w.herkunft).toBe('snapshots');
    expect(w.serie).toHaveLength(2);
    expect(w.hinweis).toBe('');
  });

  it('springt auf die Trade-Kurve ein, wenn Snapshots fehlen', () => {
    const w = waehleKurve([], trades, 100_000);
    expect(w.herkunft).toBe('trades');
    expect(w.serie).toHaveLength(3); // Anker + zwei Handelstage
    expect(w.hinweis).toContain('realisiert');
  });

  it('springt auch bei EINEM Snapshot ein — ein Punkt ist keine Kurve', () => {
    const w = waehleKurve([snaps[0]!], trades, 100_000);
    expect(w.herkunft).toBe('trades');
  });

  it('meldet ehrlich „leer", wenn beides fehlt', () => {
    const w = waehleKurve([], [], 100_000);
    expect(w.herkunft).toBe('leer');
    expect(w.serie).toEqual([]);
  });

  it('reproduziert den Anlassfall: 9 Trades, keine Snapshots', () => {
    // Owner-Screenshot 12.08.: „0,00 %", „noch kein Zeitraum", „Noch zu
    // wenige Tage für eine Kurve" — bei 9 geschlossenen Trades mit
    // Ø −191,06 $. Genau das darf nicht mehr passieren.
    const neun: KurvenTrade[] = [
      t('2026-08-10T14:00:00.000Z', -510.26),
      t('2026-08-10T15:00:00.000Z', -180.4),
      t('2026-08-10T16:00:00.000Z', +95.2),
      t('2026-08-11T14:00:00.000Z', -310.5),
      t('2026-08-11T15:00:00.000Z', -88.9),
      t('2026-08-11T16:00:00.000Z', +140.1),
      t('2026-08-12T14:00:00.000Z', -402.3),
      t('2026-08-12T15:00:00.000Z', -120.0),
      t('2026-08-12T16:00:00.000Z', +57.5),
    ];
    const w = waehleKurve([], neun, 100_000);
    expect(w.herkunft).toBe('trades');
    // Anker + drei Handelstage — eine Kurve, kein „zu wenige Tage".
    expect(w.serie).toHaveLength(4);
    expect(w.serie[0]!.equity).toBe(100_000);
    // Summe der neun: −1 319,56
    expect(w.serie[3]!.equity).toBeCloseTo(98_680.44, 2);
    // Und der Zeitraum ist damit belegbar, nicht „noch kein Zeitraum".
    expect(w.serie[w.serie.length - 1]!.date).toBe('2026-08-12');
  });

  it('hat eine Schwelle, die zur Karte passt', () => {
    // Die Teilen-Karte prüft `tage.length >= 2` — dieselbe Grenze.
    expect(SNAPSHOT_MIN).toBe(2);
  });
});

describe('kurvenErklaerung — die Anzeige sagt WARUM (Owner-Frage 12.08.)', () => {
  it('schweigt, wenn die echte Snapshot-Kurve läuft', () => {
    expect(kurvenErklaerung({ herkunft: 'snapshots', snapshots: 12, trades: 9 })).toBe('');
  });

  it('benennt die realisierte Kurve als solche', () => {
    const s = kurvenErklaerung({ herkunft: 'trades', snapshots: 0, trades: 9 });
    expect(s).toContain('9 Abschlüssen');
    expect(s).toContain('realisiert');
    // Und sagt, wann die Depotwert-Kurve nachkommt.
    expect(s).toContain('23:15');
  });

  it('nennt den Reset, wenn die Serie deswegen leer ist', () => {
    // Genau der Fall des Owners: altes Konto, volles Journal, leere Serie.
    const s = kurvenErklaerung({
      herkunft: 'trades',
      snapshots: 1,
      trades: 9,
      resetAm: '2026-08-11T09:20:00.000Z',
    });
    expect(s).toContain('Reset am 2026-08-11');
    expect(s).toContain('Erst ein Tages-Snapshot');
  });

  it('unterscheidet „noch nie gehandelt" von „Daten kaputt"', () => {
    const leer = kurvenErklaerung({ herkunft: 'leer', snapshots: 0, trades: 0 });
    expect(leer).toContain('Noch keine abgeschlossenen Trades');

    const kaputt = kurvenErklaerung({ herkunft: 'leer', snapshots: 0, trades: 4 });
    expect(kaputt).toContain('keinen verwertbaren Zeitpunkt');
    expect(kaputt).not.toContain('Noch keine abgeschlossenen Trades');
  });

  it('sagt im Einzahl-Fall nicht „1 Abschlüssen"', () => {
    expect(kurvenErklaerung({ herkunft: 'trades', snapshots: 0, trades: 1 })).toContain(
      '1 Abschluss ',
    );
    expect(kurvenErklaerung({ herkunft: 'leer', snapshots: 0, trades: 1 })).toContain(
      '1 Abschluss trägt',
    );
  });

  it('erfindet keinen Reset, wenn keiner stattfand', () => {
    expect(kurvenErklaerung({ herkunft: 'trades', snapshots: 1, trades: 3 })).not.toContain('Reset');
  });
});
