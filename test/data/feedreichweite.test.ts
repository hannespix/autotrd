/**
 * Wächter für die Feed-Sondierung.
 *
 * Die Lehre aus drei Fehlschlägen in zwei Tagen (13./14.09.): Eine Fälschung,
 * die gefälliger ist als die Wirklichkeit, lässt jeden Wächter grün laufen.
 * Der Doppel hier ist deshalb absichtlich unbequem:
 *
 *  - `sip` OHNE Abo WIRFT (403), er liefert keine leere Liste. Genau daran
 *    hängt die Unterscheidung „kein Abo" gegen „keine Historie".
 *  - Jeder Feed hat seinen EIGENEN Datenanfang. Ein Doppel, der `req.feed`
 *    ignoriert (wie `test/fakes/fakeAlpaca.ts`), könnte nicht zeigen, dass
 *    die Sondierung den Feed überhaupt durchreicht.
 */
import { describe, expect, it } from 'vitest';
import { FEEDS, SONDIERUNGSJAHRE, feedReichweite, sondiereFeed } from '../../src/data/feedreichweite.ts';
import type { Bar, Ms } from '../../src/core/types.ts';
import type { BarsRequest } from '../../src/alpaca/types.ts';

const TAG = 86_400_000;

/** Bars ab `abJahr`, eine je Tag — je Feed ein anderer Anfang. */
function doppel(a: { abJahr: Partial<Record<string, number>>; wirft?: Partial<Record<string, string>> }) {
  const gefragt: BarsRequest[] = [];
  return {
    gefragt,
    async getBars(req: BarsRequest): Promise<Map<string, Bar[]>> {
      gefragt.push({ ...req, symbols: [...req.symbols] });
      const feed = req.feed ?? 'iex';
      const fehler = a.wirft?.[feed];
      if (fehler !== undefined) throw new Error(fehler);
      const ab = a.abJahr[feed];
      const out = new Map<string, Bar[]>();
      const bars: Bar[] = [];
      if (ab !== undefined) {
        const anfang = Date.UTC(ab, 0, 1);
        for (let t: Ms = Math.max(anfang, req.start); t <= (req.end ?? req.start); t += TAG) {
          bars.push({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });
        }
      }
      for (const s of req.symbols) out.set(s, bars);
      return out;
    },
  };
}

describe('Feed-Reichweite', () => {
  it('findet das früheste sondierte Jahr mit Bars', async () => {
    const d = doppel({ abJahr: { iex: 2020 } });
    const b = await sondiereFeed({ client: d, symbol: 'SPY', feed: 'iex', adjustment: 'all' });
    expect(b.erreichbar).toBe(true);
    expect(b.abJahr).toBe(2020);
    expect(b.proben.filter((p) => p.bars === 0).map((p) => p.jahr)).toEqual([2016, 2018]);
  });

  it('reicht den Feed an jede Abfrage durch — sonst sondiert man fünfmal denselben', async () => {
    const d = doppel({ abJahr: { iex: 2020, sip: 2016 } });
    await feedReichweite({ client: d, symbol: 'SPY', adjustment: 'all' });
    const feeds = new Set(d.gefragt.map((r) => r.feed));
    expect([...feeds].sort(), `angefragte Feeds: ${[...feeds].join(', ')}`).toEqual([...FEEDS].sort());
    for (const r of d.gefragt) expect(r.timeframe, 'Sondierung muss Tagesbars fragen').toBe('1Day');
  });

  it('ein Feed OHNE Abo wirft — das ist „nicht erreichbar", nicht „keine Historie"', async () => {
    const d = doppel({ abJahr: { iex: 2020 }, wirft: { sip: 'Alpaca-Fehler 403: subscription does not permit querying recent SIP data' } });
    const [iex, sip] = await feedReichweite({ client: d, symbol: 'SPY', adjustment: 'all' });
    expect(iex?.erreichbar).toBe(true);
    expect(sip?.erreichbar).toBe(false);
    expect(sip?.fehler).toContain('403');
    expect(sip?.abJahr, 'ohne Abo gibt es kein Jahr — auch nicht null-als-2016').toBeNull();
  });

  it('hört beim ersten Fehler auf: vier weitere 403 belegen nichts', async () => {
    const d = doppel({ abJahr: {}, wirft: { sip: '403' } });
    await sondiereFeed({ client: d, symbol: 'SPY', feed: 'sip', adjustment: 'all' });
    expect(d.gefragt.length, 'ein Fehlschlag muss genügen').toBe(1);
  });

  it('erreichbar, aber in keinem sondierten Jahr Bars ⇒ abJahr null (und NICHT das erste Jahr)', async () => {
    const d = doppel({ abJahr: {} });
    const b = await sondiereFeed({ client: d, symbol: 'SPY', feed: 'iex', adjustment: 'all' });
    expect(b.erreichbar).toBe(true);
    expect(b.abJahr).toBeNull();
    expect(b.proben.length).toBe(SONDIERUNGSJAHRE.length);
  });

  it('das Sondierungsfenster überspringt den Neujahrs-Feiertagsblock nicht', async () => {
    // Ein Feed mit Historie ab dem Jahr X muss im Fenster für X Bars liefern.
    // Ein zu kurzes Fenster (nur die erste Januarwoche) könnte leer sein und
    // sähe dann aus wie „keine Historie".
    const d = doppel({ abJahr: { iex: 2016 } });
    const b = await sondiereFeed({ client: d, symbol: 'SPY', feed: 'iex', adjustment: 'all', jahre: [2016] });
    expect(b.proben[0]!.bars, 'Fenster zu kurz — ein Feiertagsblock würde als „keine Daten" gelesen').toBeGreaterThan(20);
  });

  it('doctor ruft die Sondierung wirklich auf', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../../src/cli.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code, 'cmdDoctor sondiert die Feeds nicht').toContain('feedReichweite(');
  });
});
