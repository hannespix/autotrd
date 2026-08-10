/**
 * Die Zeitlogik der rückblickenden Tages-Auswertung.
 *
 * Diese Datei ist der eigentliche Gegenstand des Umbaus. Der Code, den sie
 * prüft, rechnet Vergangenheit in Belege um — und genau dabei ist in diesem
 * Projekt schon einmal ein HIGH-Bug entstanden (Lookahead-Leck in
 * `forecast_eval`). Ein Lookahead-Fehler ist besonders tückisch, weil er sich
 * nicht als Absturz zeigt, sondern als überraschend gute Zahl.
 *
 * Deshalb ist der wichtigste Test hier nicht „rechnet richtig", sondern
 * „hat die Zukunft nicht gesehen": `sichtFenster` protokolliert mit, was die
 * Signalfunktion tatsächlich zu sehen bekam.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_LUECKE_TAGE,
  type SignalFn,
  type TagesKurs,
  maxLuecke,
  tageZwischen,
  werteTagRueckblick,
} from '../src/tagRueckblick.js';

/** Werktags-Reihe ab `start`, Kurs steigt je Schritt um `schritt`. */
function reihe(n: number, start = '2026-01-01', kurs = 100, schritt = 1): TagesKurs[] {
  const out: TagesKurs[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const wt = d.getUTCDay();
    if (wt !== 0 && wt !== 6) out.push({ date: d.toISOString().slice(0, 10), close: kurs + out.length * schritt });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const immerKauf: SignalFn = () => 'buy';
const immerHalten: SignalFn = () => 'hold';

describe('Regel 1 — das Signal sieht ausschließlich die Vergangenheit', () => {
  it('bekommt genau die Kurse BIS EINSCHLIESSLICH Basistag, nie den Folgetag', () => {
    const r = reihe(12);
    const gesehen: Array<{ letzterClose: number; preis: number; anzahl: number }> = [];
    const spion: SignalFn = (closes, preis) => {
      gesehen.push({ letzterClose: closes[closes.length - 1]!, preis, anzahl: closes.length });
      return 'buy';
    };
    werteTagRueckblick(r, spion, 0, '2099-01-01', 3);

    expect(gesehen.length).toBeGreaterThan(0);
    for (const g of gesehen) {
      // Der zuletzt sichtbare Kurs IST der Basistagskurs — nicht der danach.
      // Das ist die eigentliche Lookahead-Garantie: Egal wie lang das Fenster
      // ist, sein ENDE darf nie über den Basistag hinausreichen.
      expect(g.letzterClose).toBe(g.preis);
      const basisIndex = r.findIndex((t) => t.close === g.preis);
      expect(g.anzahl).toBe(Math.min(basisIndex + 1, 250));
    }
  });

  it('das Fenster wächst je Basistag um einen Kurs — bis zur Fenstergrenze', () => {
    const laengen: number[] = [];
    werteTagRueckblick(reihe(10), (closes) => { laengen.push(closes.length); return 'hold'; }, 0, '2099-01-01', 3);
    for (let i = 1; i < laengen.length; i++) expect(laengen[i]).toBe(laengen[i - 1]! + 1);
  });

  it('ab der Fenstergrenze ROLLT es mit, statt weiterzuwachsen', () => {
    // Sonst würde eine andere Signalquelle gemessen als die gehandelte: Der
    // Live-Scan rechnet auf `period: '1y'` ≈ 250 Tagen, nicht auf Jahrzehnten.
    const r = reihe(30);
    const fenster: Array<{ n: number; erster: number; letzter: number }> = [];
    werteTagRueckblick(r, (closes) => {
      fenster.push({ n: closes.length, erster: closes[0]!, letzter: closes[closes.length - 1]! });
      return 'hold';
    }, 0, '2099-01-01', 1, 5);

    for (const f of fenster) expect(f.n).toBeLessThanOrEqual(5);
    // Sobald es rollt, wandert auch der ANFANG mit — ein bloß gekapptes Ende
    // wäre kein rollendes Fenster.
    const spaet = fenster.slice(10);
    for (let i = 1; i < spaet.length; i++) {
      expect(spaet[i]!.erster).toBeGreaterThan(spaet[i - 1]!.erster);
      expect(spaet[i]!.letzter).toBeGreaterThan(spaet[i - 1]!.letzter);
    }
  });
});

describe('Gate 2 — nur vollständig realisierte Bewertungstage', () => {
  it('bewertet einen Tag NICHT, dessen Folgetag heute ist', () => {
    // Die heutige Kerze ist offen. Sie zu werten hieße, einen halben
    // Handelstag als ganzen zu zählen — systematisch in Trendrichtung.
    const r = reihe(5);
    const heute = r[4]!.date;
    const e = werteTagRueckblick(r, immerKauf, 0, heute, 1);
    // Basistage 0..2 sind bewertbar (Folgetage 1..3 liegen vor heute),
    // Basistag 3 hat den Folgetag „heute" und fällt raus.
    expect(e.bewertet).toBe(3);
    expect(e.ausfaelle.nichtRealisiert).toBe(1);
  });

  it('bewertet auch keinen Folgetag NACH heute', () => {
    const r = reihe(5);
    const e = werteTagRueckblick(r, immerKauf, 0, r[2]!.date, 1);
    expect(e.bewertet).toBe(1); // nur Basistag 0 → Folgetag 1 liegt vor heute
    expect(e.ausfaelle.nichtRealisiert).toBe(3);
  });

  it('mit einem Heute VOR der ganzen Reihe wird nichts bewertet', () => {
    const e = werteTagRueckblick(reihe(20), immerKauf, 0, '2025-01-01', 1);
    expect(e.bewertet).toBe(0);
    expect(e.klasse.n).toBe(0);
  });
});

describe('Gate 3 — Datenlöcher gelten nicht als Haltedauer', () => {
  it('überspringt eine Lücke, die größer ist als das lange Wochenende', () => {
    const r: TagesKurs[] = [
      { date: '2026-01-05', close: 100 },
      { date: '2026-01-06', close: 101 },
      { date: '2026-04-01', close: 300 }, // knapp drei Monate später
      { date: '2026-04-02', close: 301 },
    ];
    const e = werteTagRueckblick(r, immerKauf, 0, '2099-01-01', 1);
    expect(e.ausfaelle.luecke).toBe(1);
    // Ohne das Gate wären +197 % als Tagesbewegung in die Statistik gelaufen.
    expect(e.bewertet).toBe(2);
    expect(e.klasse.summeRohPct).toBeLessThan(2);
  });

  it('lässt ein langes Wochenende durch (Freitag → Dienstag = 4 Tage)', () => {
    const r: TagesKurs[] = [
      { date: '2026-01-02', close: 100 }, // Freitag
      { date: '2026-01-06', close: 101 }, // Dienstag (Montag Feiertag)
    ];
    expect(tageZwischen('2026-01-02', '2026-01-06')).toBe(MAX_LUECKE_TAGE);
    const e = werteTagRueckblick(r, immerKauf, 0, '2099-01-01', 1);
    expect(e.bewertet).toBe(1);
    expect(e.ausfaelle.luecke).toBe(0);
  });
});

describe('Rechnung', () => {
  it('rechnet die Bewegung vorzeichenrichtig und zieht die Kosten ab', () => {
    const r: TagesKurs[] = [{ date: '2026-01-05', close: 100 }, { date: '2026-01-06', close: 110 }];
    const e = werteTagRueckblick(r, immerKauf, 0.01, '2099-01-01', 1);
    expect(e.klasse.n).toBe(1);
    expect(e.klasse.summeRohPct).toBeCloseTo(10, 4);
    expect(e.klasse.summePct).toBeCloseTo(9, 4); // 10 % minus 1 % Roundtrip
    expect(e.klasse.treffer).toBe(1);
  });

  it('bei `sell` ist ein fallender Kurs ein Treffer', () => {
    // Derselbe Fehler, der im Broker beim Short-P&L lauert: Wer das
    // Vorzeichen vergisst, misst jede funktionierende Short-Quelle als Verlust.
    const r: TagesKurs[] = [{ date: '2026-01-05', close: 100 }, { date: '2026-01-06', close: 90 }];
    const e = werteTagRueckblick(r, () => 'sell', 0, '2099-01-01', 1);
    expect(e.klasse.summeRohPct).toBeCloseTo(10, 4);
    expect(e.klasse.treffer).toBe(1);
  });

  it('`hold` zählt nicht — es gibt nichts zu halten', () => {
    const e = werteTagRueckblick(reihe(10), immerHalten, 0, '2099-01-01', 1);
    expect(e.bewertet).toBe(0);
    expect(e.ausfaelle.hold).toBe(9);
  });
});

describe('Trennung nach Richtung — Drift oder Kante?', () => {
  // Der Anlass: Der erste Katalog-Lauf gab 51,9 % Trefferquote bei +0,60 %
  // Nettokante. Die Richtung stimmt also kaum öfter als beim Münzwurf; der
  // Ertrag kommt aus der Asymmetrie der Bewegungen. In einem steigenden Markt
  // erzeugt reine Aufwärtsdrift bei Kaufsignalen genau dieses Bild. Ohne die
  // Trennung ist der Unterschied aus KEINER Stichprobengröße herauszulesen.

  it('bucht Kaufsignale nach buy und Verkaufssignale nach sell', () => {
    const r: TagesKurs[] = [
      { date: '2026-01-05', close: 100 },
      { date: '2026-01-06', close: 110 }, // +10 % → buy trifft
      { date: '2026-01-07', close: 99 }, // −10 % → sell trifft
    ];
    const e = werteTagRueckblick(r, (_c, p) => (p === 100 ? 'buy' : 'sell'), 0, '2099-01-01', 1);
    expect(e.nachRichtung.buy.n).toBe(1);
    expect(e.nachRichtung.sell.n).toBe(1);
    expect(e.nachRichtung.buy.summeRohPct).toBeCloseTo(10, 4);
    expect(e.nachRichtung.sell.summeRohPct).toBeCloseTo(10, 4); // vorzeichenrichtig
  });

  it('die beiden Richtungen ergeben zusammen die Gesamtzahl', () => {
    // Ginge etwas verloren, sähe die Aufteilung plausibel aus und wäre falsch.
    const r = reihe(60);
    const e = werteTagRueckblick(r, (_c, p) => (p % 3 === 0 ? 'buy' : p % 3 === 1 ? 'sell' : 'hold'), 0.002, '2099-01-01', 5);
    expect(e.nachRichtung.buy.n + e.nachRichtung.sell.n).toBe(e.klasse.n);
    expect(e.nachRichtung.buy.treffer + e.nachRichtung.sell.treffer).toBe(e.klasse.treffer);
    expect((e.nachRichtung.buy.summePct + e.nachRichtung.sell.summePct)).toBeCloseTo(e.klasse.summePct, 3);
  });

  it('eine reine Aufwärtsreihe zeigt genau das Muster, das der Verdacht meint', () => {
    // Steigende Kurse, IMMER buy: die Kante ist voll auf der Kaufseite und
    // `sell` bleibt leer. Genau so sähe Drift aus — und genau daran soll man
    // sie künftig erkennen können.
    const e = werteTagRueckblick(reihe(40), immerKauf, 0, '2099-01-01', 5);
    expect(e.nachRichtung.buy.n).toBeGreaterThan(0);
    expect(e.nachRichtung.sell.n).toBe(0);
    expect((e.nachRichtung.buy.summeRohPct ?? 0)).toBeGreaterThan(0);
  });

  it('ohne bewertete Signale sind beide Seiten leer statt undefined', () => {
    const e = werteTagRueckblick(reihe(10), immerHalten, 0, '2099-01-01', 1);
    expect(e.nachRichtung).toEqual({
      buy: { n: 0, summePct: 0, treffer: 0 },
      sell: { n: 0, summePct: 0, treffer: 0 },
    });
  });
});

describe('Vorlauf', () => {
  it('bewertet nichts, bevor die Indikatoren genug Kurse haben', () => {
    const e = werteTagRueckblick(reihe(10), immerKauf, 0, '2099-01-01', 8);
    // Basistage mit weniger als 8 sichtbaren Kursen fallen raus.
    expect(e.ausfaelle.zuWenigVorlauf).toBe(7);
    expect(e.bewertet).toBe(2);
  });

  it('mit der Voreinstellung (200) liefert eine kurze Reihe gar nichts', () => {
    const e = werteTagRueckblick(reihe(50), immerKauf, 0, '2099-01-01');
    expect(e.bewertet).toBe(0);
    expect(e.ausfaelle.zuWenigVorlauf).toBe(49);
  });
});

describe('Robustheit', () => {
  it('wehrt eine falsch sortierte Reihe ab, statt still Unsinn zu rechnen', () => {
    // Absteigend sortiert hieße: Das „Fenster bis Basistag" enthielte die
    // Zukunft. Der Fehler wäre unsichtbar und die Zahlen großartig.
    const r: TagesKurs[] = [{ date: '2026-01-06', close: 110 }, { date: '2026-01-05', close: 100 }];
    expect(() => werteTagRueckblick(r, immerKauf, 0, '2099-01-01', 1)).toThrow(/sortiert/);
  });

  it('wehrt ein doppeltes Datum ab', () => {
    const r: TagesKurs[] = [{ date: '2026-01-05', close: 100 }, { date: '2026-01-05', close: 101 }];
    expect(() => werteTagRueckblick(r, immerKauf, 0, '2099-01-01', 1)).toThrow(/sortiert/);
  });

  it('überspringt kaputte Kurse, statt NaN in die Summe zu tragen', () => {
    const r: TagesKurs[] = [
      { date: '2026-01-05', close: 0 },
      { date: '2026-01-06', close: 100 },
      { date: '2026-01-07', close: 110 },
    ];
    const e = werteTagRueckblick(r, immerKauf, 0, '2099-01-01', 1);
    expect(e.ausfaelle.kaputt).toBe(1);
    expect(e.bewertet).toBe(1);
    expect(Number.isFinite(e.klasse.summePct)).toBe(true);
  });

  it('eine leere Reihe stürzt nicht ab', () => {
    const e = werteTagRueckblick([], immerKauf, 0, '2099-01-01');
    expect(e).toMatchObject({ bewertet: 0, klasse: { n: 0, summePct: 0, treffer: 0 } });
  });

  it('jeder Tag der Reihe ist entweder bewertet oder als Ausfall gebucht', () => {
    // Ein Loch in dieser Bilanz hieße: Basistage verschwinden lautlos, und
    // niemand sähe, dass die Stichprobe kleiner ist als gedacht.
    const r = reihe(40);
    const e = werteTagRueckblick(r, (_c, p) => (p % 2 === 0 ? 'buy' : 'hold'), 0.005, r[35]!.date, 5);
    const summe = Object.values(e.ausfaelle).reduce((a, b) => a + b, 0) + e.bewertet;
    expect(summe).toBe(r.length);
  });
});

describe('Mehrere Halte-Horizonte in einem Durchlauf', () => {
  it('für einen Tag ist die Lücken-Schranke UNVERÄNDERT', () => {
    // Der wichtigste Test dieses Umbaus. Wäre maxLuecke(1) auch nur um eins
    // anders, hätte er still die Bedeutung der bereits gemessenen Tages-Kante
    // verschoben — und alle Vergleiche mit den Zahlen von gestern wären falsch.
    expect(maxLuecke(1)).toBe(MAX_LUECKE_TAGE);
  });

  it('die Schranke wächst mit dem Horizont, sonst fiele jeder lange durch', () => {
    // 10 Handelstage sind rund 14 Kalendertage — mit einer Schranke von 4
    // käme kein einziger Zehn-Tages-Wert je durch.
    expect(maxLuecke(5)).toBeGreaterThan(MAX_LUECKE_TAGE);
    expect(maxLuecke(10)).toBeGreaterThanOrEqual(14);
    for (let h = 2; h <= 10; h++) expect(maxLuecke(h)).toBeGreaterThan(maxLuecke(h - 1));
  });

  it('die Spitzenfelder sind exakt der Ein-Tages-Horizont', () => {
    const r = reihe(60);
    const e = werteTagRueckblick(r, (_c, p) => (p % 2 === 0 ? 'buy' : 'hold'), 0.001, '2099-01-01', 5);
    expect(e.horizonte[1]!.klasse).toEqual(e.klasse);
    expect(e.horizonte[1]!.bewertet).toBe(e.bewertet);
    expect(e.horizonte[1]!.nachRichtung).toEqual(e.nachRichtung);
    expect(e.horizonte[1]!.hold).toBe(e.ausfaelle.hold);
  });

  it('das teure Signal wird je Basistag GENAU EINMAL gerechnet', () => {
    // Das ist der ganze Grund für den Umbau: Die Indikator-Rechnung hängt am
    // Basistag, nicht an der Haltedauer. Würde sie je Horizont wiederholt,
    // kostete die Kurve das Fünffache statt fast nichts.
    const r = reihe(60);
    let aufrufe = 0;
    const e = werteTagRueckblick(r, () => { aufrufe += 1; return 'buy'; }, 0, '2099-01-01', 5);
    // Ein Aufruf je Basistag, an dem mindestens ein Horizont auswertbar war.
    expect(aufrufe).toBeLessThanOrEqual(r.length);
    expect(e.horizonte[1]!.bewertet).toBeLessThanOrEqual(aufrufe);
    expect(e.horizonte[10]!.bewertet).toBeLessThanOrEqual(aufrufe);
  });

  it('ein längerer Horizont fängt die größere Bewegung ein', () => {
    // Stetig steigende Reihe: Fünf Tage halten muss mehr bringen als einer.
    const r = reihe(60, '2026-01-01', 100, 1);
    const e = werteTagRueckblick(r, immerKauf, 0, '2099-01-01', 5);
    const roh = (h: number): number => {
      const k = e.horizonte[h]!.klasse;
      return (k.summeRohPct ?? 0) / Math.max(1, k.nRoh ?? 0);
    };
    expect(roh(5)).toBeGreaterThan(roh(1));
    expect(roh(10)).toBeGreaterThan(roh(5));
  });

  it('Gate 2 greift je Horizont einzeln', () => {
    // Der Bewertungstag von h=10 kann noch in der Zukunft liegen, während der
    // von h=1 längst realisiert ist. Ein gemeinsames Gate würde entweder den
    // kurzen Horizont unnötig verwerfen oder den langen zu früh bewerten.
    const r = reihe(30);
    const heute = r[20]!.date;
    const e = werteTagRueckblick(r, immerKauf, 0, heute, 1);
    expect(e.horizonte[1]!.bewertet).toBeGreaterThan(e.horizonte[10]!.bewertet);
    // Beide Zähler für sich sind hier ZUFÄLLIG gleich (10): Beim langen
    // Horizont fallen die späten Basistage schon mangels Folgetag heraus,
    // bevor Gate 2 sie sehen kann. Was zählt, ist der Verlust insgesamt.
    const verloren = (h: number): number =>
      e.horizonte[h]!.nichtRealisiert + e.horizonte[h]!.keinFolgetag;
    expect(verloren(10)).toBeGreaterThan(verloren(1));
  });

  it('am Reihenende fehlen langen Horizonten mehr Folgetage als kurzen', () => {
    const e = werteTagRueckblick(reihe(30), immerKauf, 0, '2099-01-01', 1);
    expect(e.horizonte[10]!.keinFolgetag).toBeGreaterThan(e.horizonte[1]!.keinFolgetag);
  });

  it('jeder Horizont führt eine vollständige Bilanz', () => {
    // Wie beim Ein-Tages-Horizont: Ausfälle plus Bewertete müssen die
    // Reihenlänge ergeben, sonst verschwinden Basistage lautlos.
    const r = reihe(50);
    const e = werteTagRueckblick(r, (_c, p) => (p % 4 === 0 ? 'buy' : p % 4 === 1 ? 'sell' : 'hold'), 0.001, r[45]!.date, 5);
    for (const h of [1, 2, 3, 5, 10]) {
      const x = e.horizonte[h]!;
      const summe = x.bewertet + x.hold + x.keinFolgetag + x.nichtRealisiert + x.luecke + x.kaputt
        + e.ausfaelle.zuWenigVorlauf;
      expect(summe, `Horizont ${h}`).toBe(r.length);
    }
  });

  it('ein eigenes Horizont-Gitter wird respektiert', () => {
    const e = werteTagRueckblick(reihe(40), immerKauf, 0, '2099-01-01', 5, 250, [1, 4]);
    expect(Object.keys(e.horizonte).map(Number).sort((a, b) => a - b)).toEqual([1, 4]);
  });
});

describe('tageZwischen', () => {
  it('zählt Kalendertage', () => {
    expect(tageZwischen('2026-01-05', '2026-01-06')).toBe(1);
    expect(tageZwischen('2026-02-27', '2026-03-02')).toBe(3);
  });

  it('liefert Unendlich bei unlesbarem Datum — der Lücken-Gate sperrt dann', () => {
    // Lieber aussortieren als raten: Ein unlesbares Datum ist keine Lücke von
    // null Tagen.
    expect(tageZwischen('kaputt', '2026-01-06')).toBe(Number.POSITIVE_INFINITY);
  });
});
