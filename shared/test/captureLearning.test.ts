/**
 * Gelernte Einfangquote — die Zahl, an der hängt, wie viel Kapital eine
 * Anlageklasse bekommt.
 *
 * Geprüft wird nicht nur, dass gerechnet wird, sondern vor allem die
 * Schutzrichtungen: nie anheben, nie negativ, nie ohne Evidenz, nie auf
 * exakt null.
 */
import { describe, expect, it } from 'vitest';

import {
  QUOTE_MIN_N,
  QUOTE_UNTERGRENZE,
  einfangquote,
  gemesseneEinfangquote,
  wirksameEinfangquote,
} from '../src/captureLearning.js';
import { CLASS_CAPTURE, DEFAULT_CAPTURE, captureForClass } from '../src/costGate.js';
import {
  addiereSchatten,
  bewerteSchattenSignal,
  leseSchattenSignal,
  werteSchattenAus,
} from '../src/classShadow.js';

/** Auswertung mit gewünschter Quote bauen — n Signale, Zähler/Nenner exakt. */
const mess = (n: number, roh: number, erwartet: number) => ({
  nErwartet: n,
  rohBeiErwartetPct: roh,
  erwartetPct: erwartet,
});

describe('gemesseneEinfangquote', () => {
  it('bildet den Bruch aus eingefangener und erwarteter Bewegung', () => {
    expect(gemesseneEinfangquote(mess(QUOTE_MIN_N, 0.05, 0.2))).toBe(0.25);
  });

  it('liefert null unter der Evidenzschwelle', () => {
    expect(gemesseneEinfangquote(mess(QUOTE_MIN_N - 1, 0.05, 0.2))).toBeNull();
    expect(gemesseneEinfangquote(mess(QUOTE_MIN_N, 0.05, 0.2))).not.toBeNull();
  });

  it('liefert null ohne Nenner — kein erfundener Wert aus fehlender Messung', () => {
    expect(gemesseneEinfangquote(mess(QUOTE_MIN_N, 0.05, 0))).toBeNull();
    expect(
      gemesseneEinfangquote({ nErwartet: QUOTE_MIN_N, rohBeiErwartetPct: 0.05, erwartetPct: null }),
    ).toBeNull();
    expect(gemesseneEinfangquote(undefined)).toBeNull();
  });

  it('kappt eine negative Messung auf 0 statt sie durchzureichen', () => {
    // Ein Signal, das im Mittel in die falsche Richtung zeigt, hat keine
    // negative Einfangquote — es hat keine. Ein negativer Faktor würde in
    // costGate die Vergleichsrichtung umdrehen.
    expect(gemesseneEinfangquote(mess(QUOTE_MIN_N, -0.08, 0.2))).toBe(0);
  });
});

describe('wirksameEinfangquote', () => {
  it('senkt auf die Messung, wenn sie schlechter ist als die Annahme', () => {
    const b = wirksameEinfangquote('etf_thematic', mess(QUOTE_MIN_N, 0.02, 0.2));
    expect(b.annahme).toBe(CLASS_CAPTURE.etf_thematic);
    expect(b.gemessen).toBe(0.1);
    expect(b.quote).toBe(0.1);
    expect(b.herkunft).toBe('gemessen');
  });

  it('hebt NICHT an, wenn die Messung besser ist als die Annahme', () => {
    // Der Kern der Asymmetrie: Eine gute Phase darf sich nicht selbst mehr
    // Kapital freigeben.
    const b = wirksameEinfangquote('crypto', mess(QUOTE_MIN_N, 0.5, 0.5));
    expect(b.gemessen).toBe(1);
    expect(b.quote).toBe(CLASS_CAPTURE.crypto);
    expect(b.herkunft).toBe('annahme');
  });

  it('fällt ohne Evidenz auf die Annahme zurück und sagt das auch', () => {
    const ohne = wirksameEinfangquote('stocks_us');
    expect(ohne.quote).toBe(CLASS_CAPTURE.stocks_us);
    expect(ohne.herkunft).toBe('annahme');

    const wenig = wirksameEinfangquote('stocks_us', mess(10, 0.001, 0.3));
    expect(wenig.quote).toBe(CLASS_CAPTURE.stocks_us);
    expect(wenig.herkunft).toBe('annahme_zu_wenig_daten');
    expect(wenig.n).toBe(10);
  });

  it('nutzt DEFAULT_CAPTURE für unbekannte Klassen', () => {
    expect(wirksameEinfangquote('gibtsnicht').quote).toBe(DEFAULT_CAPTURE);
    expect(wirksameEinfangquote(undefined).quote).toBe(DEFAULT_CAPTURE);
  });

  it('fällt nie auf exakt 0 — eine Klasse muss sich zurückverdienen können', () => {
    const b = wirksameEinfangquote('crypto', mess(QUOTE_MIN_N, -1, 0.5));
    expect(b.gemessen).toBe(0);
    expect(b.quote).toBe(QUOTE_UNTERGRENZE);
    expect(b.quote).toBeGreaterThan(0);
  });

  it('lässt die Untergrenze nur greifen, wenn die Messung darunter liegt', () => {
    const knapp = wirksameEinfangquote('crypto', mess(QUOTE_MIN_N, 0.05, 1));
    expect(knapp.gemessen).toBe(0.05);
    expect(knapp.quote).toBe(0.05); // über der Grenze ⇒ unverändert
  });

  it('einfangquote() ist die Kurzform desselben Ergebnisses', () => {
    const a = mess(QUOTE_MIN_N, 0.02, 0.2);
    expect(einfangquote('etf_thematic', a)).toBe(wirksameEinfangquote('etf_thematic', a).quote);
  });

  it('ist für jede bekannte Klasse ohne Daten identisch mit captureForClass', () => {
    // Ohne Messung darf sich NICHTS ändern — sonst wäre die Einführung
    // selbst schon eine stille Verhaltensänderung.
    for (const klasse of Object.keys(CLASS_CAPTURE)) {
      expect(einfangquote(klasse)).toBe(captureForClass(klasse));
    }
  });
});

describe('Zusammenspiel mit dem Signal-Schatten', () => {
  it('rechnet aus echten Beiträgen eine Quote, die dem Verhältnis entspricht', () => {
    let k = undefined as ReturnType<typeof addiereSchatten> | undefined;
    // 200 Signale: jedes fängt die Hälfte der erwarteten Bewegung ein.
    for (let i = 0; i < QUOTE_MIN_N; i++) {
      k = addiereSchatten(k, { zaehlt: true, rohPct: 0.1, nettoPct: -0.4, erwartetPct: 0.2 });
    }
    const a = werteSchattenAus(k);
    expect(a.nErwartet).toBe(QUOTE_MIN_N);
    expect(gemesseneEinfangquote(a)).toBe(0.5);
  });

  it('zählt Beiträge OHNE Erwartungswert nicht in die Quote', () => {
    // Altbestand: rohPct ja, erwartetPct nein. Solche Signale dürfen den
    // Bruch nicht verwässern — sie stehen nur im Zähler zur Verfügung.
    let k = undefined as ReturnType<typeof addiereSchatten> | undefined;
    for (let i = 0; i < 100; i++) {
      k = addiereSchatten(k, { zaehlt: true, rohPct: 5, nettoPct: 4 }); // ohne Erwartung
    }
    for (let i = 0; i < QUOTE_MIN_N; i++) {
      k = addiereSchatten(k, { zaehlt: true, rohPct: 0.05, nettoPct: -0.4, erwartetPct: 0.5 });
    }
    const a = werteSchattenAus(k);
    expect(a.n).toBe(100 + QUOTE_MIN_N);
    expect(a.nErwartet).toBe(QUOTE_MIN_N);
    // Ohne die Trennung läge der Zähler bei (100×5 + 200×0.05)/200 = 2,55
    // statt 0,05 — Quote 5,1 statt 0,1.
    expect(a.rohBeiErwartetPct).toBe(0.05);
    expect(gemesseneEinfangquote(a)).toBe(0.1);
  });

  it('verliert bestehende Quoten-Summen nicht durch einen Beitrag ohne Erwartung', () => {
    let k = addiereSchatten(undefined, {
      zaehlt: true,
      rohPct: 0.1,
      nettoPct: 0,
      erwartetPct: 0.2,
    });
    k = addiereSchatten(k, { zaehlt: true, rohPct: 9, nettoPct: 9 }); // ohne Erwartung
    expect(k.nErwartet).toBe(1);
    expect(k.summeErwartetPct).toBe(0.2);
    expect(k.summeRohBeiErwartet).toBe(0.1);
  });

  it('ignoriert einen Erwartungswert ≤ 0 als Nenner', () => {
    const k = addiereSchatten(undefined, {
      zaehlt: true,
      rohPct: 0.1,
      nettoPct: 0,
      erwartetPct: 0,
    });
    expect(k.nErwartet).toBeUndefined();
    expect(werteSchattenAus(k).erwartetPct).toBeNull();
  });

  it('lässt ein nicht zählendes Signal (hold) auch die Quote unberührt', () => {
    const k = addiereSchatten(undefined, {
      zaehlt: false,
      rohPct: 1,
      nettoPct: 1,
      erwartetPct: 1,
    });
    expect(k.n).toBe(0);
    expect(k.nErwartet).toBeUndefined();
  });
});

describe('Erwartungswert aus ATR und tatsächlichem Horizont', () => {
  const sig = (extra: Record<string, unknown>) => ({
    direction: 'buy' as const,
    price: 100,
    ...extra,
  });

  it('rechnet über eine Kerze genau den ATR', () => {
    const b = bewerteSchattenSignal(sig({ atrPct: 0.2, barMin: 5, alterMs: 300_000 }), 101, 0);
    expect(b.erwartetPct).toBe(0.2);
  });

  it('skaliert mit der Wurzel der Zeit, nicht linear', () => {
    // Vier Kerzen ⇒ doppelte erwartete Bewegung. Linear wären es vier —
    // damit sähe jede Signalquelle über längere Horizonte schlechter aus,
    // als sie ist, und die Klasse würde zu Unrecht gedrosselt.
    const b = bewerteSchattenSignal(sig({ atrPct: 0.2, barMin: 5, alterMs: 1_200_000 }), 101, 0);
    expect(b.erwartetPct).toBe(0.4);
  });

  it('nimmt das ECHTE Alter, auch wenn ein Scan ausgefallen ist', () => {
    const normal = bewerteSchattenSignal(sig({ atrPct: 0.2, barMin: 5, alterMs: 300_000 }), 101, 0);
    const verspaetet = bewerteSchattenSignal(
      sig({ atrPct: 0.2, barMin: 5, alterMs: 600_000 }),
      101,
      0,
    );
    expect(verspaetet.erwartetPct).toBeGreaterThan(normal.erwartetPct as number);
  });

  it('lässt den Erwartungswert weg, wenn eine Zutat fehlt oder unsinnig ist', () => {
    for (const fall of [
      { barMin: 5, alterMs: 300_000 }, // kein ATR
      { atrPct: 0.2, alterMs: 300_000 }, // keine Kerzenlänge
      { atrPct: 0.2, barMin: 5 }, // kein Horizont
      { atrPct: 0, barMin: 5, alterMs: 300_000 },
      { atrPct: 0.2, barMin: 0, alterMs: 300_000 },
      { atrPct: 0.2, barMin: 5, alterMs: 0 },
      { atrPct: Number.NaN, barMin: 5, alterMs: 300_000 },
    ]) {
      expect(bewerteSchattenSignal(sig(fall), 101, 0).erwartetPct).toBeUndefined();
    }
  });

  it('leseSchattenSignal übernimmt ATR und Kerzenlänge und setzt das Alter', () => {
    const jetzt = Date.parse('2026-08-11T20:05:00.000Z');
    const s = leseSchattenSignal(
      {
        direction: 'buy',
        price: 100,
        at: '2026-08-11T20:00:00.000Z',
        atrPct: 0.3,
        barMin: 5,
      },
      jetzt,
    );
    expect(s?.atrPct).toBe(0.3);
    expect(s?.barMin).toBe(5);
    expect(s?.alterMs).toBe(300_000);
  });

  it('leseSchattenSignal übernimmt kaputte ATR-Felder nicht', () => {
    const jetzt = Date.parse('2026-08-11T20:05:00.000Z');
    const s = leseSchattenSignal(
      { direction: 'buy', price: 100, at: '2026-08-11T20:00:00.000Z', atrPct: 'viel', barMin: 5 },
      jetzt,
    );
    expect(s).not.toBeNull();
    expect(s?.atrPct).toBeUndefined();
    expect(s?.alterMs).toBeUndefined();
  });
});
