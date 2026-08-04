/**
 * Tests der steuerlichen Aufbereitung.
 *
 * Der Schwerpunkt liegt bewusst auf den Stellen, an denen eine falsche
 * Rechnung TEUER wird — nicht auf Abdeckung um der Abdeckung willen:
 *
 *   - FIFO-Reihenfolge (falscher Einstand ⇒ falscher Gewinn)
 *   - Short-Vorzeichen (gedreht ⇒ jeder Leerverkaufsgewinn wird zum Verlust)
 *   - Ein-Jahres-Frist taggenau (365-Tage-Näherung ⇒ steuerfreier Verkauf
 *     wird als steuerpflichtig ausgewiesen)
 *   - Topf-Trennung (zusammengeworfen ⇒ zu wenig Steuer)
 *   - Freigrenze als Grenze, nicht als Freibetrag
 *   - Paper/Echtgeld (Papierhandel im Steuerbericht wäre grober Unfug)
 */

import { describe, expect, it } from 'vitest';
import {
  fifoVerrechnen,
  haltetage,
  jahresfristUeberschritten,
  rechtsstandFuer,
  steuerbericht,
  steuertopf,
  veraeusserungenCsv,
  type SteuerTrade,
} from '../src/tax.js';

const t = (
  side: 'buy' | 'sell',
  qty: number,
  price: number,
  executedAt: string,
  extra: Partial<SteuerTrade> = {},
): SteuerTrade => ({
  symbol: 'AAPL',
  side,
  qty,
  price,
  executedAt,
  paper: false,
  assetClass: 'stocks_us',
  ...extra,
});

describe('steuertopf — die Trennung, die das Gesetz verlangt', () => {
  it('ordnet Aktien, ETFs und Krypto verschiedenen Töpfen zu', () => {
    expect(steuertopf('stocks_us', 'long')).toBe('aktien');
    expect(steuertopf('etf_sectors', 'long')).toBe('sonstige');
    expect(steuertopf('crypto', 'long')).toBe('privat');
  });

  it('macht aus JEDEM Leerverkauf ein Termingeschäft — auch bei Krypto', () => {
    // Das ist der Fall, den man leicht übersieht: Die Klasse sagt „privat",
    // aber die Richtung schlägt sie.
    expect(steuertopf('crypto', 'short')).toBe('termin');
    expect(steuertopf('stocks_us', 'short')).toBe('termin');
  });

  it('behandelt unbekannte Klassen als sonstige statt zu raten', () => {
    expect(steuertopf(undefined, 'long')).toBe('sonstige');
    expect(steuertopf('etwas_neues', 'long')).toBe('sonstige');
  });
});

describe('Ein-Jahres-Frist § 23 — taggenau, nicht 365 Tage', () => {
  it('ist am Jahrestag selbst NOCH NICHT überschritten', () => {
    expect(jahresfristUeberschritten('2024-03-01T10:00:00Z', '2025-03-01T10:00:00Z')).toBe(false);
  });

  it('ist einen Tag nach dem Jahrestag überschritten', () => {
    expect(jahresfristUeberschritten('2024-03-01T10:00:00Z', '2025-03-02T10:00:00Z')).toBe(true);
  });

  it('rechnet über ein Schaltjahr richtig — hier bricht die 365-Tage-Näherung', () => {
    // 2024-01-01 → 2025-01-01 sind 366 Tage (2024 ist Schaltjahr). Mit
    // „> 365 Tage" wäre der Verkauf am Jahrestag fälschlich steuerfrei.
    expect(haltetage('2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z')).toBe(366);
    expect(jahresfristUeberschritten('2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z')).toBe(false);
  });
});

describe('fifoVerrechnen — Long', () => {
  it('verrechnet den ÄLTESTEN Bestand zuerst', () => {
    const { veraeusserungen } = fifoVerrechnen([
      t('buy', 10, 100, '2024-01-01T00:00:00Z'),
      t('buy', 10, 200, '2024-02-01T00:00:00Z'),
      t('sell', 10, 300, '2024-06-01T00:00:00Z'),
    ]);
    expect(veraeusserungen).toHaveLength(1);
    // FIFO: der 100er-Kauf geht raus, nicht der 200er.
    expect(veraeusserungen[0]!.anschaffungKurs).toBe(100);
    expect(veraeusserungen[0]!.ergebnis).toBe(2000);
  });

  it('sortiert nach Ausführungszeit, nicht nach Eingabereihenfolge', () => {
    // Dieselben Trades, verdreht eingegeben — FIFO über eine unsortierte
    // Liste wäre kein FIFO.
    const { veraeusserungen } = fifoVerrechnen([
      t('buy', 10, 200, '2024-02-01T00:00:00Z'),
      t('sell', 10, 300, '2024-06-01T00:00:00Z'),
      t('buy', 10, 100, '2024-01-01T00:00:00Z'),
    ]);
    expect(veraeusserungen[0]!.anschaffungKurs).toBe(100);
  });

  it('teilt einen Verkauf über mehrere Lots auf', () => {
    const { veraeusserungen, offen } = fifoVerrechnen([
      t('buy', 10, 100, '2024-01-01T00:00:00Z'),
      t('buy', 10, 200, '2024-02-01T00:00:00Z'),
      t('sell', 15, 300, '2024-06-01T00:00:00Z'),
    ]);
    expect(veraeusserungen).toHaveLength(2);
    expect(veraeusserungen[0]!.menge).toBe(10);
    expect(veraeusserungen[0]!.ergebnis).toBe(2000); // (300−100)×10
    expect(veraeusserungen[1]!.menge).toBe(5);
    expect(veraeusserungen[1]!.ergebnis).toBe(500); // (300−200)×5
    // 5 Stück vom zweiten Lot bleiben liegen.
    expect(offen).toHaveLength(1);
    expect(offen[0]!.menge).toBe(5);
    expect(offen[0]!.anschaffungKurs).toBe(200);
  });

  it('belastet Kommissionen anteilig auf die verkaufte Menge', () => {
    const { veraeusserungen } = fifoVerrechnen([
      t('buy', 10, 100, '2024-01-01T00:00:00Z', { fee: 10 }), // 1 je Stück
      t('sell', 5, 200, '2024-06-01T00:00:00Z', { fee: 5 }), // 1 je Stück
    ]);
    // Roh (200−100)×5 = 500, abzüglich 5×1 Anschaffung + 5×1 Veräußerung.
    expect(veraeusserungen[0]!.kosten).toBe(10);
    expect(veraeusserungen[0]!.ergebnis).toBe(490);
  });
});

describe('fifoVerrechnen — Short', () => {
  it('dreht das Vorzeichen: fallender Kurs ist ein GEWINN', () => {
    const { veraeusserungen } = fifoVerrechnen([
      t('sell', 10, 300, '2024-01-01T00:00:00Z'),
      t('buy', 10, 100, '2024-06-01T00:00:00Z'),
    ]);
    expect(veraeusserungen).toHaveLength(1);
    expect(veraeusserungen[0]!.richtung).toBe('short');
    expect(veraeusserungen[0]!.ergebnis).toBe(2000); // 300 leer verkauft, zu 100 eingedeckt
    expect(veraeusserungen[0]!.topf).toBe('termin');
  });

  it('bucht einen steigenden Kurs beim Short als Verlust', () => {
    const { veraeusserungen } = fifoVerrechnen([
      t('sell', 10, 100, '2024-01-01T00:00:00Z'),
      t('buy', 10, 150, '2024-06-01T00:00:00Z'),
    ]);
    expect(veraeusserungen[0]!.ergebnis).toBe(-500);
  });

  it('schließt zuerst den Long-Bestand, bevor ein Verkauf zum Short wird', () => {
    const { veraeusserungen, offen } = fifoVerrechnen([
      t('buy', 5, 100, '2024-01-01T00:00:00Z'),
      t('sell', 8, 200, '2024-06-01T00:00:00Z'), // 5 schließen, 3 eröffnen short
    ]);
    expect(veraeusserungen).toHaveLength(1);
    expect(veraeusserungen[0]!.richtung).toBe('long');
    expect(veraeusserungen[0]!.menge).toBe(5);
    expect(offen).toHaveLength(1);
    expect(offen[0]!.richtung).toBe('short');
    expect(offen[0]!.menge).toBe(3);
  });

  it('hält Long- und Short-Schlangen desselben Symbols getrennt', () => {
    // Ohne Trennung würde der eindeckende Kauf als neuer Long-Bestand gebucht
    // und der Leerverkaufsgewinn fiele ganz weg.
    const { veraeusserungen } = fifoVerrechnen([
      t('sell', 10, 300, '2024-01-01T00:00:00Z'), // Short auf
      t('buy', 10, 100, '2024-02-01T00:00:00Z'), // Short zu
      t('buy', 10, 100, '2024-03-01T00:00:00Z'), // neuer Long
      t('sell', 10, 150, '2024-04-01T00:00:00Z'), // Long zu
    ]);
    expect(veraeusserungen).toHaveLength(2);
    expect(veraeusserungen[0]!.richtung).toBe('short');
    expect(veraeusserungen[0]!.ergebnis).toBe(2000);
    expect(veraeusserungen[1]!.richtung).toBe('long');
    expect(veraeusserungen[1]!.ergebnis).toBe(500);
  });
});

describe('steuerbericht', () => {
  const krypto = (
    side: 'buy' | 'sell',
    qty: number,
    price: number,
    at: string,
  ): SteuerTrade => t(side, qty, price, at, { symbol: 'BTC-USD', assetClass: 'crypto' });

  it('trennt die Töpfe — Aktienverlust rettet keinen ETF-Gewinn', () => {
    const b = steuerbericht(
      [
        t('buy', 10, 200, '2024-01-01T00:00:00Z'),
        t('sell', 10, 100, '2024-06-01T00:00:00Z'), // Aktien: −1000
        t('buy', 10, 100, '2024-01-01T00:00:00Z', { symbol: 'QQQ', assetClass: 'etf_sectors' }),
        t('sell', 10, 200, '2024-06-01T00:00:00Z', { symbol: 'QQQ', assetClass: 'etf_sectors' }),
      ],
      2024,
      { echtgeld: true },
    );
    expect(b.toepfe.aktien.saldo).toBe(-1000);
    expect(b.toepfe.sonstige.saldo).toBe(1000);
    // Kein Netting über die Topfgrenze — das ist der Kern von § 20 Abs. 6.
    expect(b.toepfe.aktien.saldo + b.toepfe.sonstige.saldo).toBe(0);
    expect(b.toepfe.aktien.n).toBe(1);
  });

  it('weist Krypto nach über einem Jahr als steuerFREI aus, nicht als Gewinn', () => {
    const b = steuerbericht(
      [krypto('buy', 1, 20_000, '2023-01-01T00:00:00Z'), krypto('sell', 1, 50_000, '2024-06-01T00:00:00Z')],
      2024,
      { echtgeld: true },
    );
    expect(b.privatSteuerfrei).toBe(30_000);
    // Der Gewinn darf in KEINEM Topf auftauchen — er ist kein Einkommen.
    expect(b.toepfe.privat.saldo).toBe(0);
    expect(b.toepfe.privat.n).toBe(0);
  });

  it('besteuert Krypto innerhalb eines Jahres', () => {
    const b = steuerbericht(
      [krypto('buy', 1, 20_000, '2024-01-01T00:00:00Z'), krypto('sell', 1, 25_000, '2024-06-01T00:00:00Z')],
      2024,
      { echtgeld: true },
    );
    expect(b.privatSteuerfrei).toBe(0);
    expect(b.toepfe.privat.saldo).toBe(5000);
    expect(b.privatSteuerpflichtig).toBe(5000);
  });

  it('behandelt die § 23-Freigrenze als GRENZE, nicht als Freibetrag', () => {
    // 999 € Gewinn: komplett steuerfrei.
    const knappDrunter = steuerbericht(
      [krypto('buy', 1, 1000, '2024-01-01T00:00:00Z'), krypto('sell', 1, 1999, '2024-06-01T00:00:00Z')],
      2024,
      { echtgeld: true },
    );
    expect(knappDrunter.privatUnterFreigrenze).toBe(true);

    // 1001 € Gewinn: der GANZE Betrag ist steuerpflichtig, nicht nur 1 €.
    const knappDrueber = steuerbericht(
      [krypto('buy', 1, 1000, '2024-01-01T00:00:00Z'), krypto('sell', 1, 2001, '2024-06-01T00:00:00Z')],
      2024,
      { echtgeld: true },
    );
    expect(knappDrueber.privatUnterFreigrenze).toBe(false);
    expect(knappDrueber.privatSteuerpflichtig).toBe(1001);
  });

  it('nennt einen Verlust nie „unter der Freigrenze steuerfrei"', () => {
    const b = steuerbericht(
      [krypto('buy', 1, 2000, '2024-01-01T00:00:00Z'), krypto('sell', 1, 1500, '2024-06-01T00:00:00Z')],
      2024,
      { echtgeld: true },
    );
    // Ein Verlust ist verrechenbar — ihn als „steuerfrei" zu führen, würde
    // ihn dem Nutzer wegnehmen.
    expect(b.privatUnterFreigrenze).toBe(false);
    expect(b.toepfe.privat.saldo).toBe(-500);
  });

  it('schließt Papierhandel aus — und Echtgeld beim Papierbericht', () => {
    const trades = [
      t('buy', 10, 100, '2024-01-01T00:00:00Z', { paper: true }),
      t('sell', 10, 200, '2024-06-01T00:00:00Z', { paper: true }),
    ];
    expect(steuerbericht(trades, 2024, { echtgeld: true }).veraeusserungen).toHaveLength(0);
    expect(steuerbericht(trades, 2024, { echtgeld: false }).veraeusserungen).toHaveLength(1);
  });

  it('nutzt Anschaffungen aus Vorjahren, weist aber nur das Berichtsjahr aus', () => {
    const b = steuerbericht(
      [
        t('buy', 10, 100, '2022-01-01T00:00:00Z'),
        t('sell', 10, 300, '2024-06-01T00:00:00Z'),
      ],
      2024,
      { echtgeld: true },
    );
    // Der Einstand von 2022 zählt — sonst wäre der volle Erlös der Gewinn.
    expect(b.veraeusserungen).toHaveLength(1);
    expect(b.veraeusserungen[0]!.anschaffungKurs).toBe(100);
    expect(b.toepfe.aktien.saldo).toBe(2000);
  });

  it('lässt Veräußerungen anderer Jahre aus dem Bericht heraus', () => {
    const trades = [
      t('buy', 10, 100, '2023-01-01T00:00:00Z'),
      t('sell', 10, 200, '2023-06-01T00:00:00Z'),
    ];
    expect(steuerbericht(trades, 2024, { echtgeld: true }).veraeusserungen).toHaveLength(0);
    expect(steuerbericht(trades, 2023, { echtgeld: true }).veraeusserungen).toHaveLength(1);
  });

  it('meldet offene Krypto-Bestände mit Restlaufzeit bis zur Steuerfreiheit', () => {
    const kauf = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const b = steuerbericht([krypto('buy', 1, 20_000, kauf)], 2026, { echtgeld: true });
    const pos = b.offen.find((o) => o.symbol === 'BTC-USD');
    expect(pos?.tageBisJahresfrist).toBeGreaterThan(250);
    expect(pos?.tageBisJahresfrist).toBeLessThan(280);
  });
});

describe('Rechtsstand', () => {
  it('benutzt den Stand des Berichtsjahres, nicht den aktuellen', () => {
    // Die Freigrenze stieg zum 01.01.2024 von 600 auf 1000 €. Ein Bericht
    // über 2023 muss weiter mit 600 rechnen, auch wenn er heute entsteht.
    expect(rechtsstandFuer(2023).privatFreigrenze).toBe(600);
    expect(rechtsstandFuer(2024).privatFreigrenze).toBe(1000);
  });

  it('erbt für Jahre ohne eigenen Eintrag den jüngsten davorliegenden', () => {
    expect(rechtsstandFuer(2026).privatFreigrenze).toBe(1000);
  });

  it('fällt für Jahre vor der Tabelle auf den ältesten Stand zurück, nie auf 0', () => {
    expect(rechtsstandFuer(2015).privatFreigrenze).toBeGreaterThan(0);
    expect(rechtsstandFuer(2015).abgeltungsteuerSatz).toBe(0.25);
  });
});

describe('CSV-Export', () => {
  it('schreibt deutsche Zahlen mit Komma und trennt mit Semikolon', () => {
    const b = steuerbericht(
      [
        t('buy', 10, 100.5, '2024-01-01T00:00:00Z'),
        t('sell', 10, 200.25, '2024-06-01T00:00:00Z'),
      ],
      2024,
      { echtgeld: true },
    );
    const csv = veraeusserungenCsv(b);
    const [kopf, zeile] = csv.split('\n');
    expect(kopf).toContain('Symbol;Topf;Richtung');
    expect(zeile).toContain('100,50');
    expect(zeile).toContain('997,50'); // (200,25 − 100,50) × 10
    expect(zeile).toContain('2024-01-01');
  });

  it('quotet Felder mit Semikolon, damit die Spalten nicht verrutschen', () => {
    const b = steuerbericht(
      [
        t('buy', 1, 10, '2024-01-01T00:00:00Z', { symbol: 'A;B' }),
        t('sell', 1, 20, '2024-06-01T00:00:00Z', { symbol: 'A;B' }),
      ],
      2024,
      { echtgeld: true },
    );
    expect(veraeusserungenCsv(b)).toContain('"A;B"');
  });

  it('erzeugt für einen leeren Bericht nur die Kopfzeile', () => {
    const b = steuerbericht([], 2024, { echtgeld: true });
    expect(veraeusserungenCsv(b).split('\n')).toHaveLength(1);
  });
});

describe('EUR-Umrechnung je Vorgang (M12b)', () => {
  /** Kauf und Verkauf zu verschiedenen Kursen — der Kern der Sache. */
  const trades = [
    {
      symbol: 'AAPL',
      side: 'buy' as const,
      qty: 10,
      price: 100,
      executedAt: '2026-03-02T15:00:00.000Z',
      assetClass: 'stocks_us',
      currency: 'USD',
      paper: false,
      fxRate: 1.1,
      fxDate: '2026-03-02',
      fxSource: 'ecb',
    },
    {
      symbol: 'AAPL',
      side: 'sell' as const,
      qty: 10,
      price: 100,
      executedAt: '2026-06-02T15:00:00.000Z',
      assetClass: 'stocks_us',
      currency: 'USD',
      paper: false,
      fxRate: 1.05,
      fxDate: '2026-06-02',
      fxSource: 'ecb',
    },
  ];

  it('macht aus einem Dollar-Nullsummengeschäft einen Euro-Gewinn', () => {
    // In USD ±0 (1.000 gekauft, 1.000 verkauft). In EUR: 909,09 gegen
    // 952,38 — ein steuerpflichtiger Währungsgewinn von 43,29 €. Wer erst
    // das Ergebnis umrechnet, erklärt null.
    const v = fifoVerrechnen(trades).veraeusserungen[0]!;
    expect(v.ergebnis).toBe(0);
    expect(v.eurAnschaffung).toBe(909.09);
    expect(v.eurVeraeusserung).toBe(952.38);
    expect(v.eurErgebnis).toBe(43.29);
  });

  it('führt beide Kurse mit, damit die Rechnung prüfbar bleibt', () => {
    const v = fifoVerrechnen(trades).veraeusserungen[0]!;
    expect(v.fx?.anschaffung).toEqual({ date: '2026-03-02', rate: 1.1, source: 'ecb' });
    expect(v.fx?.veraeusserung).toEqual({ date: '2026-06-02', rate: 1.05, source: 'ecb' });
  });

  it('lässt die EUR-Felder LEER, wenn einem Vorgang der Kurs fehlt', () => {
    const ohne = [trades[0]!, { ...trades[1]!, fxRate: undefined }];
    const v = fifoVerrechnen(ohne).veraeusserungen[0]!;
    expect(v.ergebnis).toBe(0); // die USD-Rechnung steht weiter
    expect(v.eurErgebnis).toBeUndefined();
    expect(v.eurAnschaffung).toBeUndefined();
  });

  it('spiegelt das Vorzeichen beim Short', () => {
    // Leerverkauf zu 100 (Kurs 1,10), Eindeckung zu 90 (Kurs 1,10).
    // In USD +100 Gewinn, in EUR 909,09 − 818,18 = 90,91.
    const short = [
      { ...trades[0]!, side: 'sell' as const, executedAt: '2026-03-02T15:00:00.000Z' },
      {
        ...trades[1]!,
        side: 'buy' as const,
        price: 90,
        fxRate: 1.1,
        fxDate: '2026-06-02',
      },
    ];
    const v = fifoVerrechnen(short).veraeusserungen[0]!;
    expect(v.richtung).toBe('short');
    expect(v.ergebnis).toBe(100);
    expect(v.eurErgebnis).toBe(90.91);
  });

  it('kippt die Topf-Summe auf null, sobald ein Vorgang keinen Kurs hat', () => {
    // Eine Teilsumme wäre schlimmer als keine: Sie sähe vollständig aus,
    // wäre zu klein, und niemand könnte ihr ansehen um wie viel.
    const gemischt = [
      ...trades,
      { ...trades[0]!, symbol: 'MSFT', executedAt: '2026-03-03T15:00:00.000Z', fxRate: undefined },
      { ...trades[1]!, symbol: 'MSFT', executedAt: '2026-06-03T15:00:00.000Z', fxRate: undefined },
    ];
    const b = steuerbericht(gemischt, 2026, { echtgeld: true });
    expect(b.toepfe.aktien.saldo).toBe(0); // USD-Rechnung bleibt vollständig
    expect(b.toepfe.aktien.eurSaldo).toBeNull();
    expect(b.fxLuecken).toBe(2);
  });

  it('meldet keine Lücke, wenn alle Kurse da sind', () => {
    const b = steuerbericht(trades, 2026, { echtgeld: true });
    expect(b.fxLuecken).toBe(0);
    expect(b.toepfe.aktien.eurSaldo).toBe(43.29);
  });

  it('schreibt die Euro-Spalten in die CSV', () => {
    const csv = veraeusserungenCsv(steuerbericht(trades, 2026, { echtgeld: true }));
    expect(csv.split('\n')[0]).toContain('Ergebnis EUR');
    expect(csv.split('\n')[1]).toContain('43,29');
    expect(csv.split('\n')[1]).toContain('1,1000 (2026-03-02)');
  });
});
