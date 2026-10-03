/**
 * Der Universums-Filter entscheidet, was das System überhaupt handeln kann.
 *
 * ── Warum das ein eigener, gründlicher Test ist ───────────────────────────
 *
 * Ein Fehler hier fällt nirgends auf. Zu STRENG: Ein Papier fehlt, und
 * niemand vermisst, was er nie gesehen hat. Zu LOCKER: Tausende OTC-Papiere
 * mit mehrprozentigem Spread kommen in die Rangliste, das System kauft sie
 * mit voller Überzeugung, und der Spread frisst den Trade, bevor die
 * Strategie überhaupt eine Chance hatte. Beides sieht im Betrieb aus wie
 * „läuft".
 *
 * Deshalb ist der Filter pur und wird hier Kriterium für Kriterium
 * festgenagelt — jedes mit einem Fall, der ohne dieses Kriterium
 * durchrutschen würde.
 */
import { describe, expect, it } from 'vitest';
import { universumFilter, type AlpacaAssetRoh } from '../src/core/alpacaUniversum.js';

/** Ein handelbares NASDAQ-Papier — Grundlage, die jeder Fall abwandelt. */
const gut = (ueber: Partial<AlpacaAssetRoh> = {}): AlpacaAssetRoh => ({
  symbol: 'AAPL',
  name: 'Apple Inc. Common Stock',
  exchange: 'NASDAQ',
  class: 'us_equity',
  status: 'active',
  tradable: true,
  fractionable: true,
  shortable: true,
  ...ueber,
});

describe('universumFilter — was hereinkommt', () => {
  it('nimmt ein aktives, handelbares Börsenpapier auf', () => {
    expect(universumFilter([gut()])).toEqual([
      {
        symbol: 'AAPL',
        name: 'Apple Inc. Common Stock',
        klasse: 'us_equity',
        fractionable: true,
        shortable: true,
      },
    ]);
  });

  it('nimmt alle vier zugelassenen Aktienbörsen', () => {
    const boersen = ['NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'BATS'];
    const rohe = boersen.map((b, i) => gut({ symbol: `S${i}`, exchange: b }));
    expect(universumFilter(rohe)).toHaveLength(boersen.length);
  });

  it('übernimmt fractionable und shortable vom Broker, statt sie zu raten', () => {
    const [a] = universumFilter([gut({ fractionable: false, shortable: false })]);
    expect(a).toMatchObject({ fractionable: false, shortable: false });
  });

  it('fällt beim Namen auf das Symbol zurück, statt leer zu bleiben', () => {
    expect(universumFilter([gut({ name: undefined })])[0]?.name).toBe('AAPL');
  });

  it('sortiert — die Rangliste soll bei gleichen Daten gleich aussehen', () => {
    const rohe = ['TSLA', 'AAPL', 'MSFT'].map((s) => gut({ symbol: s }));
    expect(universumFilter(rohe).map((e) => e.symbol)).toEqual(['AAPL', 'MSFT', 'TSLA']);
  });
});

describe('universumFilter — was draußen bleibt', () => {
  it('verwirft inaktive Papiere (delisted)', () => {
    expect(universumFilter([gut({ status: 'inactive' })])).toEqual([]);
  });

  it('verwirft nicht handelbare Papiere', () => {
    // Alpaca führt Papiere, die es nur bewertet, aber nicht handelt. Sie
    // täten so, als gäbe es einen Kandidaten mehr.
    expect(universumFilter([gut({ tradable: false })])).toEqual([]);
  });

  it('verwirft OTC — der eigentliche Zweck der Börsenliste', () => {
    // Der größte Teil der über zehntausend Alpaca-Symbole notiert OTC. Ohne
    // diesen Filter wäre das Universum zu 80 % aus Papieren mit Spreads,
    // gegen die keine Strategie anläuft.
    for (const b of ['OTC', 'OTCM', 'PINK', '']) {
      expect(universumFilter([gut({ exchange: b })]), b).toEqual([]);
    }
  });

  it('verwirft Optionen — die haben eine eigene Risikologik', () => {
    expect(universumFilter([gut({ class: 'us_option', symbol: 'AAPL260116C00150000' })])).toEqual(
      [],
    );
  });

  it('verwirft Symbole ohne Namen im Feld symbol', () => {
    expect(universumFilter([gut({ symbol: '' }), gut({ symbol: undefined })])).toEqual([]);
  });

  it('verwirft Doppelte — dasselbe Symbol darf nur einmal ranken', () => {
    expect(universumFilter([gut(), gut()])).toHaveLength(1);
  });
});

describe('universumFilter — Schreibweisen', () => {
  it('übersetzt Anteilsklassen in unsere Schreibweise', () => {
    // Käme `BRK.B` unübersetzt herein, hätte die Rangliste ein Symbol, für
    // das Yahoo keine Kurse liefert — und der Orderpfad ein zweites, das er
    // nicht kennt.
    const [a] = universumFilter([gut({ symbol: 'BRK.B', name: 'Berkshire Hathaway Inc. Class B' })]);
    expect(a?.symbol).toBe('BRK-B');
  });

  it('übersetzt Krypto-Paare und lässt die Börsenprüfung an ihnen vorbei', () => {
    // Krypto handelt an keiner der gelisteten Börsen; Alpaca trägt dort
    // etwas Eigenes ein. Der Börsenfilter zielt auf OTC-Aktien und darf
    // Krypto nicht mitreißen.
    const [a] = universumFilter([
      gut({ symbol: 'BTC/USD', name: 'Bitcoin / US Dollar', class: 'crypto', exchange: 'CRYPTO' }),
    ]);
    expect(a).toMatchObject({ symbol: 'BTC-USD', klasse: 'crypto' });
  });

  it('verwirft Warrants, Rechte und Units — Schreibweisen, die wir nicht beherrschen', () => {
    // Nach der Rückübersetzung sind Anteilsklassen und Krypto sauber. Was
    // dann noch Punkt oder Schrägstrich trägt, schreibt Yahoo nach eigenen
    // Regeln (`-WT`, `-RT`, `-UN`), die kein Zeichentausch herstellt. Ein
    // solches Symbol wäre kein Kandidat mehr, sondern eine sichere Kurslücke.
    for (const s of ['ABC.WS', 'ABC.RT', 'ABC.U', 'XYZ/ABC']) {
      expect(universumFilter([gut({ symbol: s })]), s).toEqual([]);
    }
  });
});

describe('universumFilter — Größenordnung', () => {
  it('trägt eine realistische Mischung korrekt auseinander', () => {
    // Der Fall, wie die Antwort wirklich aussieht: ein paar Börsenpapiere in
    // einem Meer aus OTC und Inaktivem.
    const rohe: AlpacaAssetRoh[] = [
      gut({ symbol: 'AAPL' }),
      gut({ symbol: 'MSFT', exchange: 'NASDAQ' }),
      gut({ symbol: 'BRK.B', exchange: 'NYSE' }),
      gut({ symbol: 'BTC/USD', class: 'crypto', exchange: 'CRYPTO' }),
      ...Array.from({ length: 50 }, (_, i) => gut({ symbol: `OTC${i}`, exchange: 'OTC' })),
      ...Array.from({ length: 20 }, (_, i) => gut({ symbol: `TOT${i}`, status: 'inactive' })),
      ...Array.from({ length: 10 }, (_, i) => gut({ symbol: `NT${i}`, tradable: false })),
    ];
    expect(universumFilter(rohe).map((e) => e.symbol)).toEqual([
      'AAPL',
      'BRK-B',
      'BTC-USD',
      'MSFT',
    ]);
  });

  it('kommt mit einer leeren Antwort klar, ohne zu werfen', () => {
    expect(universumFilter([])).toEqual([]);
  });
});
