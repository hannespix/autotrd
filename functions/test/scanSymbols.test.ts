/**
 * Welche Symbole der Scan beobachtet (Owner-Frage 28.07.: „warum gibt's noch
 * die Watchliste?").
 *
 * Die Rangfolge ist sicherheitsrelevant, und ihr Bruch ist unsichtbar: Fällt
 * ein Symbol aus der Auswahl, verschwindet es einfach — es gibt keine
 * Fehlermeldung, keinen roten Lauf, nichts. Bei einer OFFENEN POSITION heißt
 * das, dass Stop-Loss, Take-Profit und Signal-Verkauf nicht mehr greifen: Das
 * Geld hängt in einem Papier, das niemand mehr anschaut. Deshalb steht der
 * Positions-Vorrang hier fest verdrahtet, mit Test.
 */

import { describe, expect, it } from 'vitest';
import { aktiveKlassenAusGewichten, selectScanSymbols } from '../src/scheduled/scanMarket.js';

const auswahl = (args: Partial<Parameters<typeof selectScanSymbols>[0]>): string[] =>
  selectScanSymbols({ positions: [], ranking: [], defaults: [], max: 40, ...args });

describe('selectScanSymbols', () => {
  it('nimmt die Rangliste des Momentum-Laufs, nicht eine gespeicherte Liste', () => {
    expect(auswahl({ ranking: ['BTC-USD', 'AAPL'], defaults: ['QQQ'] })).toEqual([
      'BTC-USD',
      'AAPL',
      'QQQ',
    ]);
  });

  it('offene Positionen stehen VOR dem Ranking', () => {
    const out = auswahl({ positions: ['SOL-USD'], ranking: ['BTC-USD'] });
    expect(out[0]).toBe('SOL-USD');
  });

  it('offene Positionen überleben das Limit — auch wenn das Ranking voll ist', () => {
    // Der eigentliche Sicherheitstest: Ein volles Ranking darf eine offene
    // Position nicht verdrängen, sonst verliert sie ihren Stop-Loss.
    const ranking = Array.from({ length: 50 }, (_, i) => `R${i}`);
    const out = auswahl({ positions: ['SOL-USD', 'ETH-USD'], ranking, max: 10 });
    expect(out).toContain('SOL-USD');
    expect(out).toContain('ETH-USD');
    expect(out.length).toBe(10); // 2 Positionen + 8 aus dem Ranking
  });

  it('viele Positionen dürfen das Limit sprengen — Verkaufen geht vor Sparen', () => {
    const positions = Array.from({ length: 15 }, (_, i) => `P${i}`);
    const out = auswahl({ positions, ranking: ['BTC-USD'], max: 10 });
    expect(out.length).toBe(15);
    expect(out).not.toContain('BTC-USD'); // das Limit greift erst danach
  });

  it('Defaults sind der Boden, wenn noch kein Ranking existiert', () => {
    // Erster Tag: momentumRun hatte noch keinen Lauf. Ohne Boden stünde der
    // Scan ohne ein einziges Symbol da und täte gar nichts.
    expect(auswahl({ defaults: ['QQQ', 'SPY'] })).toEqual(['QQQ', 'SPY']);
  });

  it('Watchlists laufender Engines stehen VOR dem Ranking (Fund 01.08.)', () => {
    // „Engine fängt bei neuem Konto nicht an zu handeln": Der Scan
    // beobachtete nur Ranking + Defaults — ein Konto mit EIGENER Watchlist
    // konnte nie einen Einstieg eröffnen, weil seine Symbole ohne Daten
    // blieben. Die Watchlist ist eine Entscheidung des Users, das Ranking
    // nur ein Vorschlag — also hat sie Vorrang.
    const out = auswahl({ watchlists: ['NVDA', 'MSFT'], ranking: ['BTC-USD'], max: 3 });
    expect(out).toEqual(['NVDA', 'MSFT', 'BTC-USD']);
    // Handelbarkeits- und Marktzeit-Filter gelten auch hier
    expect(auswahl({ watchlists: ['^GSPC', 'AAPL'] })).toEqual(['AAPL']);
  });

  it('dedupliziert über alle drei Quellen', () => {
    const out = auswahl({
      positions: ['AAPL'],
      ranking: ['AAPL', 'BTC-USD'],
      defaults: ['AAPL', 'QQQ'],
    });
    expect(out).toEqual(['AAPL', 'BTC-USD', 'QQQ']);
  });

  it('leere Symbolnamen fallen raus, statt eine Zeile zu belegen', () => {
    expect(auswahl({ ranking: ['', 'AAPL', ''] })).toEqual(['AAPL']);
  });
});

/**
 * Marktzeit-Bewusstsein (Audit-Befund A1, 28.07.).
 *
 * Der Befund war live messbar und kostete ~70 % der Betriebszeit: Die
 * Auswahl nahm die globalen Top-N, `runScan` warf danach alles weg, dessen
 * Klasse geschlossen war — und übrig blieb nichts. Diese Tests halten fest,
 * dass die Marktzeit BEIM Füllen wirkt, nicht dahinter.
 */
describe('selectScanSymbols: Marktzeit', () => {
  // Krypto handelt rund um die Uhr, Aktien nicht — genau die Konstellation
  // vom 28.07., 12:35 UTC.
  const nurKrypto = (s: string): boolean => s.endsWith('-USD');

  it('füllt das Kontingent mit OFFENEN Symbolen statt es zu verschwenden', () => {
    const out = auswahl({
      ranking: ['AAPL', 'TSLA', 'BTC-USD', 'QQQ', 'ETH-USD'],
      max: 3,
      isOpen: nurKrypto,
    });
    expect(out, 'geschlossene Aktien dürfen keinen Platz belegen').toEqual([
      'BTC-USD',
      'ETH-USD',
    ]);
  });

  it('der Katalog ist der letzte Boden, wenn Ranking und Defaults zu sind', () => {
    // Der Live-Fall: kein Ranking, Defaults nur US-Aktien, Nacht in New York.
    // Ohne diesen Boden stand der Scan mit null Symbolen da.
    const out = auswahl({
      ranking: [],
      defaults: ['QQQ', 'AAPL', 'TSLA', '^NDX'],
      catalog: ['MSFT', 'BTC-USD', 'SOL-USD'],
      max: 10,
      isOpen: nurKrypto,
    });
    expect(out).toEqual(['BTC-USD', 'SOL-USD']);
  });

  it('Ranking schlägt Katalog — der Boden greift nur, wo Lücken sind', () => {
    const out = auswahl({
      ranking: ['ETH-USD'],
      catalog: ['BTC-USD', 'SOL-USD'],
      max: 2,
      isOpen: nurKrypto,
    });
    expect(out[0], 'die Rangliste bleibt die Priorität').toBe('ETH-USD');
    expect(out.length).toBe(2);
  });

  it('offene Positionen überleben den Marktzeit-Filter', () => {
    // Bewusst ungefiltert: Aussieben hieße, eine offene Position aus den
    // Augen zu verlieren. Ob gehandelt wird, entscheidet der Handelspfad.
    const out = auswahl({
      positions: ['AAPL'],
      ranking: ['BTC-USD'],
      isOpen: nurKrypto,
    });
    expect(out).toContain('AAPL');
  });

  it('ohne isOpen bleibt alles wie vorher — Marktzeit ist opt-in', () => {
    expect(auswahl({ ranking: ['AAPL', 'BTC-USD'] })).toEqual(['AAPL', 'BTC-USD']);
  });

  /* ── Handelbarkeit (Befund 28.07.) ──────────────────────────────────── */

  it('nicht handelbare Symbole kommen NICHT in die Tiefenanalyse', () => {
    // Am 28.07. waren 25 der 40 tief analysierten Symbole Aktienindizes, die
    // kein Broker verkauft. Wir haben Indikatoren, Prognosen und
    // Intraday-Kerzen für Dinge gerechnet, die nie eine Position werden
    // können — und ihnen die Plätze derer weggenommen, die es könnten.
    const out = auswahl({
      ranking: ['^GSPC', 'AAPL', '^N225', 'BTC-USD', 'EURUSD=X', 'GC=F'],
      max: 10,
    });
    expect(out).toEqual(['AAPL', 'BTC-USD']);
  });

  it('der Katalog-Boden filtert genauso', () => {
    const out = auswahl({ catalog: ['^DJI', '^FTSE', 'SPY'], max: 10 });
    expect(out).toEqual(['SPY']);
  });

  it('offene Positionen bleiben AUCH bei fehlender Handelbarkeit drin', () => {
    // Sonst verlöre eine Altbestands-Position ihren Stop-Loss — und zwar
    // still. Geschlossen werden muss sie in jedem Fall können.
    const out = auswahl({ positions: ['^GSPC'], ranking: ['AAPL'] });
    expect(out).toContain('^GSPC');
  });

  it('der Deckel zählt nur, was auch wirklich aufgenommen wurde', () => {
    // Regressionsschutz: Würde der Filter NACH dem Zählen greifen, käme ein
    // halb leeres Scan-Set heraus — der Scan liefe dann mit 3 statt 10
    // Symbolen, ohne dass irgendetwas fehlschlägt.
    const out = auswahl({
      ranking: ['^GSPC', '^DJI', '^N225', '^FTSE', '^HSI', 'AAPL', 'MSFT', 'NVDA'],
      max: 3,
    });
    expect(out).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });
});

/* ── Kontingent für abgeschaltete Klassen (Live-Fund 05.08.) ────────────────
 *
 * Der Betrieb zeigte: 14 von 40 Tiefenplätzen gingen an Klassen, deren
 * Regler auf 0 stand. Sie bekamen 5-min-Kerzen, Indikatoren und Prognosen —
 * und durften dann nicht handeln.
 *
 * Die naheliegende Sparmaßnahme wäre, sie ganz auszusperren. Das wäre der
 * fünfte Fall desselben Fehlers, den dieses Projekt schon viermal hatte:
 * Eine Sperre, die zugleich die Messung beendet, die sie korrigieren würde.
 * Ohne 5-min-Daten misst der Schatten nichts mehr, und ein Abschalten wäre
 * endgültig — auch wenn die Klasse längst wieder trägt.
 *
 * Deshalb ein Kontingent, und deshalb diese Tests: Sie halten BEIDE Seiten
 * fest — die Bevorzugung der handelnden Klassen UND das Überleben der
 * Messung.
 */
describe('selectScanSymbols — abgeschaltete Klassen', () => {
  /** BTC ist crypto, AAPL ist stocks_us — beides echte Katalog-Symbole. */
  const krypto = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  const aktien = ['AAPL', 'MSFT', 'NVDA', 'TSLA'];

  it('bevorzugt handelnde Klassen, auch wenn die anderen zuerst kommen', () => {
    // Krypto steht in der Watchlist (höchste Priorität), Aktien nur im
    // Ranking. Ohne die Zwei-Durchgang-Logik füllten die vier Krypto-Symbole
    // die vier Plätze — obwohl in ihnen nicht gehandelt werden darf.
    const r = auswahl({
      watchlists: krypto,
      ranking: aktien,
      max: 5,
      klasseAktiv: (s) => !s.endsWith('-USD'),
    });
    expect(r.filter((s) => !s.endsWith('-USD')).length).toBeGreaterThanOrEqual(4);
  });

  it('lässt der abgeschalteten Klasse trotzdem Plätze — sonst stirbt die Messung', () => {
    const r = auswahl({
      watchlists: krypto,
      ranking: aktien,
      max: 10,
      schattenAnteil: 0.2,
      klasseAktiv: (s) => !s.endsWith('-USD'),
    });
    // 20 % von 10 = 2 Plätze für den Schatten. Mehr nicht, aber auch nicht
    // null: Bei null könnte Krypto nie zurückkommen.
    const imSchatten = r.filter((s) => s.endsWith('-USD')).length;
    expect(imSchatten).toBeGreaterThan(0);
    expect(imSchatten).toBeLessThanOrEqual(2);
  });

  it('hält offene Positionen IMMER drin, auch in abgeschalteten Klassen', () => {
    // Eine Position ohne frische Daten verlöre ihren Stop-Loss. Das gilt
    // unabhängig davon, ob die Klasse noch gehandelt werden darf — sonst
    // würde das Abschalten einer Klasse die bestehenden Positionen darin
    // schutzlos stellen.
    const r = auswahl({
      positions: ['BTC-USD'],
      ranking: aktien,
      max: 3,
      klasseAktiv: (s) => !s.endsWith('-USD'),
    });
    expect(r).toContain('BTC-USD');
  });

  it('verhält sich ohne Klassen-Filter exakt wie vorher', () => {
    const ohne = auswahl({ watchlists: krypto, ranking: aktien, max: 6 });
    expect(ohne.length).toBe(6);
    expect(ohne.slice(0, 4)).toEqual(krypto);
  });
});

describe('aktiveKlassenAusGewichten', () => {
  it('fehlender Regler gilt als aktiv — exakt wie klemmeGewicht beim Handeln', () => {
    // Sparse Map: Der Auto-Regler schreibt `{...bestand}` zurück, ältere
    // Konten kennen neue Klassen nicht. Nur explizit 0 schaltet ab.
    const aktiv = aktiveKlassenAusGewichten([{ crypto: 0, rates_bonds: 0 }]);
    expect(aktiv).not.toBeNull();
    expect(aktiv!.has('crypto')).toBe(false);
    expect(aktiv!.has('rates_bonds')).toBe(false);
    // Alle nicht genannten Klassen bleiben aktiv, obwohl kein Eintrag existiert.
    expect(aktiv!.has('stocks_us')).toBe(true);
    expect(aktiv!.has('etf_sectors')).toBe(true);
  });

  it('Oder-Verknüpfung: eine Klasse ist aktiv, sobald IRGENDEIN Konto sie über null hat', () => {
    const aktiv = aktiveKlassenAusGewichten([
      { crypto: 0, stocks_us: 1 },
      { crypto: 0.5, stocks_us: 0 },
    ]);
    expect(aktiv!.has('crypto')).toBe(true);
    expect(aktiv!.has('stocks_us')).toBe(true);
  });

  it('Konto ohne Regler macht den Filter gegenstandslos (null = alles aktiv)', () => {
    expect(aktiveKlassenAusGewichten([{ crypto: 0 }, undefined])).toBeNull();
    expect(aktiveKlassenAusGewichten([{ crypto: 0 }, {}])).toBeNull();
    expect(aktiveKlassenAusGewichten([])).toBeNull();
  });

  it('nur wenn ALLE Regler-Konten eine Klasse explizit auf 0 haben, fällt sie raus', () => {
    // Zweite Klasse war früher `forex`. Seit der Alpaca-Ausrichtung (10.08.)
    // führt der Katalog keine Devisen mehr, und `aktiveKlassenAusGewichten`
    // läuft über `Object.keys(CATALOG)` — eine Klasse, die es nicht gibt,
    // kann auch nicht aktiv sein. Die geprüfte REGEL ist unverändert.
    const aktiv = aktiveKlassenAusGewichten([
      { crypto: 0, stocks_us: 0 },
      { crypto: 0 }, // stocks_us fehlt → für dieses Konto aktiv
    ]);
    expect(aktiv!.has('crypto')).toBe(false);
    expect(aktiv!.has('stocks_us')).toBe(true);
  });
});
