/**
 * Handelbarkeit und Korrelations-Cluster.
 *
 * Beide Regeln kamen aus Live-Daten vom 28.07., nicht aus der Theorie: Der
 * Scan beobachtete an dem Tag 40 Symbole, davon 25 nicht kaufbare Indizes
 * und 12 überwiegend gleichlaufende Devisenkreuze. Die Tests halten fest,
 * dass beides nicht zurückkommen kann.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY } from '../src/strategy.js';
import {
  MARKET_PULSE,
  MAX_PER_CLUSTER,
  allSymbols,
  clusterHasRoom,
  correlationCluster,
  isTradable,
  tradableSymbols,
} from '../src/universe.js';

/** Die 40 Symbole, die der Scan am 28.07. tatsächlich beobachtet hat. */
const LIVE_28_07 = [
  'DX-Y.NYB', 'EURGBP=X', 'EURJPY=X', 'AAPL', 'AUDUSD=X', 'EURCHF=X', 'EURUSD=X',
  'NZDUSD=X', 'QQQ', 'TSLA', 'USDCAD=X', 'USDCHF=X', 'USDJPY=X', '^AEX', '^VIX',
  '^NDX', '^GSPC', '^DJI', '^IXIC', '^RUT', '^GDAXI', '^FTSE', '^FCHI', '^STOXX50E',
  '^IBEX', '^SSMI', 'FTSEMIB.MI', '^N225', '^HSI', '000001.SS', '^BSESN', '^KS11',
  '^AXJO', '^TWII', '^STI', '^BVSP', '^GSPTSE', '^MXX', 'GBPUSD=X', 'GBPJPY=X',
];

describe('isTradable', () => {
  it('Indizes sind Zahlen, keine Instrumente', () => {
    for (const s of ['^GSPC', '^NDX', '^N225', '^VIX', '^TNX']) {
      expect(isTradable(s), s).toBe(false);
    }
  });

  it('ETFs auf dieselben Indizes sind handelbar', () => {
    for (const s of ['SPY', 'QQQ', 'EWJ', 'EWG', 'IWM', 'VTI']) {
      expect(isTradable(s), s).toBe(true);
    }
  });

  it('Devisen und Futures sind über den Alpaca-Weg nicht erreichbar', () => {
    for (const s of ['EURUSD=X', 'DX-Y.NYB', 'GC=F', 'CL=F', 'ES=F']) {
      expect(isTradable(s), s).toBe(false);
    }
  });

  it('US-Aktien, Krypto und Bond-ETFs sind handelbar', () => {
    for (const s of ['AAPL', 'NVDA', 'BTC-USD', 'ETH-USD', 'TLT', 'HYG', 'XLK', 'ARKK']) {
      expect(isTradable(s), s).toBe(true);
    }
  });

  it('Auslandsbörsen nicht — SAP.DE kauft man nicht bei einem US-Broker', () => {
    for (const s of ['SAP.DE', '7203.T', '0700.HK', 'FTSEMIB.MI', '000001.SS']) {
      expect(isTradable(s), s).toBe(false);
    }
  });

  it('von den 40 live beobachteten Symbolen waren nur 3 kaufbar', () => {
    // Das ist der Befund in einer Zeile: 37 von 40 Positionen hätten real
    // gar nicht eröffnet werden können.
    const handelbar = LIVE_28_07.filter(isTradable);
    expect(handelbar).toEqual(['AAPL', 'QQQ', 'TSLA']);
  });

  it('das handelbare Universum ist trotzdem breit genug', () => {
    const t = tradableSymbols();
    expect(t.length).toBeGreaterThan(50);
    expect(t.length).toBeLessThan(allSymbols().length);
  });
});

describe('correlationCluster', () => {
  it('globale Aktienindizes fallen gemeinsam — ein Block', () => {
    for (const s of ['^GDAXI', '^N225', '^HSI', '^FTSE', '^BVSP']) {
      expect(correlationCluster(s), s).toBe('aktien_intl');
    }
  });

  it('alles mit USD ist dieselbe Dollar-Wette', () => {
    for (const s of ['EURUSD=X', 'USDJPY=X', 'AUDUSD=X', 'DX-Y.NYB']) {
      expect(correlationCluster(s), s).toBe('fx_usd');
    }
    // Kreuze OHNE Dollar sind eine andere Wette
    expect(correlationCluster('EURGBP=X')).toBe('fx_kreuz');
    expect(correlationCluster('EURJPY=X')).toBe('fx_kreuz');
  });

  it('der VIX bekommt einen eigenen Block — er läuft GEGEN Aktien', () => {
    // Ihn zu den Aktien zu zählen wäre der teuerste Fehler dieser Tabelle:
    // Die Gegenposition wäre dann durch den Aktien-Deckel blockiert,
    // ausgerechnet die eine, die im Crash trägt.
    expect(correlationCluster('^VIX')).toBe('volatilitaet');
  });

  it('Gold-ETF gehört zu den Metallen, nicht zu den Aktien', () => {
    expect(correlationCluster('GLD')).toBe('rohstoff_metall');
    expect(correlationCluster('GC=F')).toBe('rohstoff_metall');
  });

  it('Energie-nahe Aktien-ETFs laufen mit dem Ölpreis', () => {
    for (const s of ['XLE', 'USO', 'ICLN', 'TAN', 'CL=F']) {
      expect(correlationCluster(s), s).toBe('rohstoff_energie');
    }
  });

  it('Krypto und Zinsen sind eigene Blöcke', () => {
    expect(correlationCluster('BTC-USD')).toBe('krypto');
    expect(correlationCluster('TLT')).toBe('zinsen');
    expect(correlationCluster('^TNX')).toBe('zinsen');
  });

  it('die 40 Live-Symbole waren in Wahrheit zwei Wetten', () => {
    /*
     * Der Befund vom 28.07., der das Positionslimit erklärt: Vierzig
     * Positionen waren ungefähr ZWEI Wetten — Aktien und Dollar.
     *
     * Gezählt wird über ALLE Aktien-Blöcke, nicht über zwei namentlich
     * genannte. Die frühere Fassung zählte `aktien_intl` und
     * `aktien_us_breit`; mit der Alpaca-Ausrichtung (10.08.) sind
     * `FTSEMIB.MI` und `000001.SS` aus dem Katalog verschwunden und rutschen
     * seither in `aktien_intl_einzel` — dieselbe Wette, anderer Block. Ein
     * Test, der die Blocknamen aufzählt, prüft die Katalog-Mitgliedschaft
     * statt den Befund.
     */
    const bloecke = new Map<string, number>();
    for (const s of LIVE_28_07) {
      const c = correlationCluster(s);
      bloecke.set(c, (bloecke.get(c) ?? 0) + 1);
    }
    let aktien = 0;
    for (const [block, n] of bloecke) if (block.startsWith('aktien_')) aktien += n;
    const dollar = bloecke.get('fx_usd') ?? 0;
    expect(aktien + dollar).toBeGreaterThanOrEqual(32);
  });
});

describe('clusterHasRoom', () => {
  it('leeres Depot hat immer Platz', () => {
    expect(clusterHasRoom([], '^GDAXI')).toBe(true);
  });

  it('deckelt bei drei Positionen desselben Blocks', () => {
    const offen = ['^GDAXI', '^N225', '^HSI']; // alle aktien_intl
    expect(clusterHasRoom(offen, '^FTSE')).toBe(false);
  });

  it('ein anderer Block bleibt offen', () => {
    const offen = ['^GDAXI', '^N225', '^HSI'];
    expect(clusterHasRoom(offen, 'BTC-USD')).toBe(true);
    expect(clusterHasRoom(offen, 'TLT')).toBe(true);
  });

  it('zwei desselben Blocks sind noch erlaubt', () => {
    expect(clusterHasRoom(['^GDAXI', '^N225'], '^FTSE')).toBe(true);
  });

  it('der Deckel ist einstellbar', () => {
    expect(clusterHasRoom(['^GDAXI'], '^N225', 1)).toBe(false);
    expect(clusterHasRoom(['^GDAXI'], '^N225', MAX_PER_CLUSTER)).toBe(true);
  });

  it('genau der Fall, der live passiert ist, wird jetzt verhindert', () => {
    // Sieben USD-Paare gleichzeitig — eine Wette, siebenfache Gebühren.
    const offen = ['EURUSD=X', 'USDJPY=X', 'AUDUSD=X'];
    expect(clusterHasRoom(offen, 'USDCHF=X')).toBe(false);
  });
});

describe('Voreinstellungen enthalten nichts Unkaufbares', () => {
  it('jedes Symbol der Default-Watchlist ist handelbar', () => {
    // Bis 28.07. stand `^NDX` darin — der Nasdaq-100-INDEX. Der Filter hätte
    // ihn stumm aussortiert, aber er stand als Vorschlag in jedem neuen
    // Konto. Ein Vorschlag, der nichts bewirkt, ist schlimmer als keiner.
    for (const sym of DEFAULT_STRATEGY.watchlist) {
      expect(isTradable(sym), sym).toBe(true);
    }
  });

  it('und keins doppelt sich fachlich mit einem anderen', () => {
    // QQQ IST der Nasdaq-100 als ETF — `^NDX` daneben wäre dieselbe Wette
    // zweimal, und der Korrelations-Deckel zählte sie als zwei.
    expect(new Set(DEFAULT_STRATEGY.watchlist).size).toBe(DEFAULT_STRATEGY.watchlist.length);
  });

  it('das Markt-Puls-Set darf dagegen Indizes enthalten — es wird nur ANGEZEIGT', () => {
    // Bewusster Gegentest: MARKET_PULSE ist eine Anzeige, kein Handelsvorrat.
    // Hier sind ^GSPC und ^VIX genau richtig.
    expect(MARKET_PULSE.some((s) => !isTradable(s))).toBe(true);
  });
});

/**
 * Die Rohstoff-ETFs nach dem Alpaca-Umbau (10.08.).
 *
 * Sie ersetzen die Futures, die Alpaca nicht handelt. Ohne ausdrückliche
 * Zuordnung landeten sie über `classify` in `etf_thematic` und damit im Block
 * `aktien_sektor` — das Positionslimit hielte GLD, SLV und PPLT dann für drei
 * Aktienwetten. Sie sind aber eine Metallwette und fallen im Drawdown
 * gemeinsam, also genau dann, wenn Streuung zählt.
 */
describe('Rohstoff-ETFs statt Futures', () => {
  it('Metall-ETFs gehören zum Metall', () => {
    for (const s of ['GLD', 'SLV', 'PPLT', 'CPER']) {
      expect(correlationCluster(s), s).toBe('rohstoff_metall');
    }
  });

  it('Energie-ETFs gehören zur Energie', () => {
    for (const s of ['USO', 'BNO', 'UNG', 'PDBC']) {
      expect(correlationCluster(s), s).toBe('rohstoff_energie');
    }
  });

  it('und sie sind — anders als die Futures — handelbar', () => {
    for (const s of ['GLD', 'SLV', 'PPLT', 'CPER', 'USO', 'BNO', 'UNG', 'DBA', 'PDBC']) {
      expect(isTradable(s), s).toBe(true);
    }
  });

  it('die alten Futures bleiben richtig eingeordnet — für Altbestände', () => {
    expect(correlationCluster('GC=F')).toBe('rohstoff_metall');
    expect(correlationCluster('CL=F')).toBe('rohstoff_energie');
  });
});
