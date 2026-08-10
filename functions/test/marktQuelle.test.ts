/**
 * EINE Quelle für Kursdaten — der Riegel gegen eine gespaltene Messgrundlage.
 *
 * Der Fehler, den dieser Test verhindert, ist lautlos und springt genau dann
 * los, wenn es am meisten schadet:
 *
 *   `market/{sym}/ohlcDaily` — die Reihe hinter dem Chart UND hinter der
 *   Tages-Rückschau — kommt aus `getDeepDailyBars`. Die Signal-Bars des
 *   Live-Scans kommen aus `getMarketSnapshot`. Bis 10.08. wählte
 *   `getMarketSnapshot` je nach Umgebung einen ANDEREN Anbieter (Alpaca,
 *   `feed=iex`) — für 55 von 164 Katalog-Symbolen, sobald Betreiber-Schlüssel
 *   gesetzt sind. Also genau dann, wenn Echtgeld näher rückt.
 *
 * Die Rückschau hätte dann Signale auf Yahoo-Bars gemessen, während die
 * Engine Signale auf IEX-Bars handelt — ohne Fehler, ohne Log, ohne Hinweis.
 * Eine Kante, die an anderen Zahlen gemessen wird als sie entsteht, ist keine
 * Kante, sondern eine Zahl.
 *
 * Der Test setzt deshalb die Alpaca-Schlüssel absichtlich und prüft, dass es
 * NICHTS ändert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeepDailyBars, getMarketSnapshot } from '../src/core/marketData.js';

const YAHOO_HOST = 'query1.finance.yahoo.com';

/** Eine knappe, aber gültige Yahoo-Antwort — zwei Tage, ein Symbol. */
function yahooAntwort(): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: 102,
            previousClose: 100,
            exchangeTimezoneName: 'America/New_York',
          },
          timestamp: [1_722_355_200, 1_722_441_600],
          indicators: {
            quote: [
              {
                open: [99, 101],
                high: [101, 103],
                low: [98, 100],
                close: [100, 102],
                volume: [1_000, 2_000],
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

describe('Kursquelle ist eine einzige', () => {
  const gerufen: string[] = [];
  let alterKey: string | undefined;
  let alterSecret: string | undefined;

  beforeEach(() => {
    gerufen.length = 0;
    alterKey = process.env.ALPACA_API_KEY;
    alterSecret = process.env.ALPACA_SECRET_KEY;
    // Der scharfe Fall: Schlüssel DA. Früher hätte das den Anbieter gewechselt.
    process.env.ALPACA_API_KEY = 'PK_TESTSCHLUESSEL_NICHT_ECHT';
    process.env.ALPACA_SECRET_KEY = 'GEHEIM_TESTWERT_NICHT_ECHT';
    vi.stubGlobal('fetch', async (url: string) => {
      gerufen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => yahooAntwort(),
      } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (alterKey === undefined) delete process.env.ALPACA_API_KEY;
    else process.env.ALPACA_API_KEY = alterKey;
    if (alterSecret === undefined) delete process.env.ALPACA_SECRET_KEY;
    else process.env.ALPACA_SECRET_KEY = alterSecret;
  });

  it('holt Signal-Bars auch MIT Alpaca-Schlüsseln von Yahoo', async () => {
    // AAPL ist reine Großbuchstabe — genau das Muster, das früher zu Alpaca
    // geroutet wurde (`/^[A-Z]+$/`).
    const snap = await getMarketSnapshot('AAPL', '1y');
    expect(gerufen).toHaveLength(1);
    expect(new URL(gerufen[0]!).host).toBe(YAHOO_HOST);
    expect(snap.source).toBe('yahoo');
  });

  it('kein Aufruf geht an einen zweiten Anbieter — auch nicht als Fallback', async () => {
    // Der stille Zwilling des Hauptfehlers: Ein Anbieter, der nur BEI FEHLERN
    // wechselt, liefert für dasselbe Symbol mal die eine, mal die andere
    // Reihe. Dann ist nicht einmal die Historie in sich konsistent.
    for (const sym of ['AAPL', 'SPY', '^NDX', 'BTC-USD', 'EURUSD=X']) {
      await getMarketSnapshot(sym);
    }
    expect(gerufen).toHaveLength(5);
    for (const u of gerufen) expect(new URL(u).host).toBe(YAHOO_HOST);
  });

  it('Tiefen-Historie und Signal-Bars teilen den Host', async () => {
    // Das ist die eigentliche Invariante: Was gemessen wird (ohlcDaily) und
    // was gehandelt wird (Snapshot) muss aus derselben Quelle stammen.
    await getMarketSnapshot('AAPL');
    await getDeepDailyBars('AAPL');
    expect(gerufen).toHaveLength(2);
    expect(new URL(gerufen[0]!).host).toBe(new URL(gerufen[1]!).host);
  });

  it('die Tiefen-Historie fordert weiterhin Tagesauflösung über 50y an', async () => {
    // Regression zum Befund 09.08.: `range=max` beantwortet Yahoo in
    // Monatskerzen. Steht hier hier wieder `max`, ist die ganze Rückschau
    // wertlos — deshalb neben dem Host auch die Parameter festnageln.
    await getDeepDailyBars('SPY');
    const p = new URL(gerufen[0]!).searchParams;
    expect(p.get('range')).toBe('50y');
    expect(p.get('interval')).toBe('1d');
  });
});
