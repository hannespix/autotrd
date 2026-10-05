/**
 * KI-Kaskade Stufe 1 (05.10.): Alpaca-Nachrichten als append-only Messgrund.
 *
 * Gepinnt wird, was eine spätere Auswertung ehrlich macht:
 *   - jede Meldung wird GENAU EINMAL geschrieben — `firstSeenAt` kann kein
 *     späterer Lauf verschieben (sonst Lookahead durch die Hintertür);
 *   - `firstSeenAt` ist die Ankunft IHRER Seite, nicht `publishedAt`;
 *   - der Durchgang läuft auf Alpacas Achse (`updated_at|id`): Ein
 *     abgeschnittener Lauf macht per Token weiter, statt per Zeitsprung
 *     Meldungen zu verlieren oder ewig dieselben Seiten zu lesen
 *     (Red-Team 05.10.) — geprüft für BEIDE möglichen Filter-Achsen von
 *     `start`, weil die Doku sie nicht eindeutig benennt;
 *   - der Cursor rückt nur nach erfolgreichem Commit und nie rückwärts;
 *   - nur Symbole, die wir handeln könnten, in unserer Schreibweise;
 *   - Schlüssel tauchen in keinem Fehlertext auf.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── Kleines Firestore-Double ──────────────────────────────────────────── */

const DELETE = Symbol('delete');
const SERVER_TS = 'SERVER_TS';
const store = new Map<string, Record<string, unknown>>();
let commitFehler: Error | null = null;

function anwenden(alt: Record<string, unknown> | undefined, neu: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(alt ?? {}) };
  for (const [k, v] of Object.entries(neu)) {
    if (v === DELETE) delete out[k];
    else if (v && typeof v === 'object' && 'inc' in (v as object)) out[k] = Number(out[k] ?? 0) + (v as { inc: number }).inc;
    else out[k] = v;
  }
  return out;
}

const docRef = (pfad: string) => ({
  id: pfad.split('/').pop()!,
  path: pfad,
  get: async () => ({
    exists: store.has(pfad),
    id: pfad.split('/').pop()!,
    get: (f: string) => store.get(pfad)?.[f],
  }),
  set: async (data: Record<string, unknown>, opt?: { merge?: boolean }) => {
    store.set(pfad, opt?.merge ? anwenden(store.get(pfad), data) : anwenden(undefined, data));
  },
});

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (n: number) => ({ inc: n }), delete: () => DELETE, serverTimestamp: () => SERVER_TS },
  getFirestore: () => ({
    doc: docRef,
    getAll: async (...refs: Array<{ path: string; id: string }>) =>
      refs.map((r) => ({ exists: store.has(r.path), id: r.id })),
    batch: () => {
      const ops: Array<{ pfad: string; data: Record<string, unknown> }> = [];
      return {
        create: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ pfad: ref.path, data }),
        commit: async () => {
          if (commitFehler) throw commitFehler;
          for (const o of ops) if (store.has(o.pfad)) throw new Error(`ALREADY_EXISTS ${o.pfad}`);
          for (const o of ops) store.set(o.pfad, o.data);
        },
      };
    },
  }),
}));

vi.mock('../src/core/universumLeser.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/universumLeser.js')>()),
  ladeUniversumSymbole: vi.fn(async () => new Set(['CCG', 'BRK-B'])),
}));

const news = await import('../src/core/alpacaNews.js');
const lauf = await import('../src/scheduled/nachrichtenSammeln.js');
const { normalisiereNachricht, kuerze, abrufStart, juengsteAchsenZeit, spaeterer, SYMBOLE_MAX } = news;

/* ── Uhr ──────────────────────────────────────────────────────────────── */

let uhrMs = Date.parse('2026-10-05T14:00:00Z');
const jetzt = () => new Date(uhrMs);
const setzeUhr = (iso: string) => {
  uhrMs = Date.parse(iso);
};

/* ── Alpaca-Simulation ────────────────────────────────────────────────────
 * Sortiert und blättert wie Alpaca: nach (updated_at, id), Token = Position
 * des letzten Eintrags. Neue Meldungen, die während des Blätterns
 * erscheinen, tauchen auf späteren Seiten auf. `achse` wählt, worauf
 * `start` filtert — beide Varianten müssen funktionieren. */

interface Artikel {
  id: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  symbols: string[];
  created_at: string;
  updated_at: string;
}
const alpaca: { artikel: Artikel[]; achse: 'updated_at' | 'created_at'; scheitern: (n: number, url: URL) => boolean } = {
  artikel: [],
  achse: 'updated_at',
  scheitern: () => false,
};
const KURSE: Record<string, { p: number; t: string }> = {
  AAPL: { p: 190.5, t: '2026-10-05T13:59:30Z' },
  'BRK.B': { p: 410, t: '2026-10-05T13:59:00Z' },
  CCG: { p: 7.5, t: '2026-10-05T10:00:00Z' },
  'BTC/USD': { p: 62000, t: '2026-10-05T13:59:58Z' },
};

function artikel(id: number, created: string, symbols: string[], updated = created, headline = `Meldung ${id}`): Artikel {
  return { id, headline, summary: 'Kurz.', url: `https://example.org/${id}`, source: 'benzinga', symbols, created_at: created, updated_at: updated };
}

const antwort = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const aufrufe: URL[] = [];
let newsAufrufe = 0;
const fetchImpl = vi.fn(async (roh: string) => {
  const url = new URL(roh);
  aufrufe.push(url);
  if (url.pathname === '/v1beta1/news') {
    newsAufrufe += 1;
    if (alpaca.scheitern(newsAufrufe, url)) return antwort({ message: 'kaputt' }, 500);
    expect(url.searchParams.get('sort')).toBe('asc');
    const startMs = Date.parse(url.searchParams.get('start')!);
    const schluessel = (a: Artikel): [number, number] => [Date.parse(a.updated_at), a.id];
    const nach = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    const token = url.searchParams.get('page_token');
    const ab: [number, number] | null = token ? (token.split('|').map(Number) as [number, number]) : null;
    const passend = alpaca.artikel
      .filter((a) => Date.parse(a[alpaca.achse]) >= startMs && Date.parse(a.created_at) <= uhrMs)
      .filter((a) => !ab || nach(schluessel(a), ab))
      .sort((a, b) => (nach(schluessel(a), schluessel(b)) ? 1 : -1));
    const seite = passend.slice(0, Number(url.searchParams.get('limit')));
    const letzte = seite[seite.length - 1];
    return antwort({
      news: seite,
      next_page_token: passend.length > seite.length && letzte ? `${Date.parse(letzte.updated_at)}|${letzte.id}` : null,
    });
  }
  if (url.pathname === '/v2/stocks/trades/latest') {
    if (kurseKaputt) return antwort({ message: 'forbidden' }, 403);
    expect(url.searchParams.get('feed')).toBe('iex');
    const angefragt = url.searchParams.get('symbols')!.split(',');
    return antwort({ trades: Object.fromEntries(angefragt.filter((s) => KURSE[s]).map((s) => [s, KURSE[s]])) });
  }
  if (url.pathname === '/v1beta3/crypto/us/latest/trades') {
    if (kurseKaputt) return antwort({ message: 'forbidden' }, 403);
    const angefragt = url.searchParams.get('symbols')!.split(',');
    if (angefragt.some((s) => !/^[A-Z]+\/[A-Z]+$/.test(s))) return antwort({ message: 'invalid symbol' }, 400);
    return antwort({ trades: Object.fromEntries(angefragt.filter((s) => KURSE[s]).map((s) => [s, KURSE[s]])) });
  }
  return antwort({}, 404);
});
let kurseKaputt = false;

const newsUrls = () => aufrufe.filter((u) => u.pathname === '/v1beta1/news');
const gespeichert = () => [...store.keys()].filter((k) => k.startsWith('marktNachrichten/'));
const stand = () => store.get('meta/nachrichtenStand') ?? {};

/* ── Pure Teile ───────────────────────────────────────────────────────── */

describe('normalisiereNachricht', () => {
  const bekannt = (s: string) => ['AAPL', 'BRK-B', 'BTC-USD', 'CCG'].includes(s);

  it('übersetzt Alpaca-Schreibweise und behält nur bekannte Symbole', () => {
    const n = normalisiereNachricht(artikel(7, '2026-10-05T13:31:00Z', ['BRK.B', 'BTCUSD', 'ZZZZ', 'AAPL', 'AAPL']), bekannt);
    expect(n?.id).toBe('alp-7');
    expect(n?.symbole).toEqual(['BRK-B', 'BTC-USD', 'AAPL']);
    expect(n?.symboleGenannt).toBe(5);
    expect(n?.publishedAt).toBe('2026-10-05T13:31:00.000Z');
  });

  it('verwirft ohne ID, ohne Schlagzeile, ohne Datum oder ohne bekanntes Symbol', () => {
    const a = artikel(1, '2026-10-05T13:31:00Z', ['AAPL']);
    expect(normalisiereNachricht({ ...a, id: undefined }, bekannt)).toBeNull();
    expect(normalisiereNachricht({ ...a, headline: ' <b> </b> ' }, bekannt)).toBeNull();
    expect(normalisiereNachricht({ ...a, created_at: 'kein datum' }, bekannt)).toBeNull();
    expect(normalisiereNachricht({ ...a, symbols: ['ZZZZ'] }, bekannt)).toBeNull();
    expect(normalisiereNachricht(null, bekannt)).toBeNull();
  });

  it('lässt keine fremden Zeichen in die Dokument-ID', () => {
    expect(normalisiereNachricht({ ...artikel(1, '2026-10-05T13:31:00Z', ['AAPL']), id: '../x' }, bekannt)).toBeNull();
  });

  it('nur http(s)-Links, HTML aus Texten entfernt', () => {
    const n = normalisiereNachricht(
      { ...artikel(3, '2026-10-05T13:31:00Z', ['AAPL']), url: 'javascript:alert(1)', headline: '<p>Apple <b>steigt</b></p>' },
      bekannt,
    );
    expect(n?.url).toBe('');
    expect(n?.schlagzeile).toBe('Apple steigt');
  });

  it('kappt Sammelmeldungen bei SYMBOLE_MAX', () => {
    const viele = Array.from({ length: 60 }, (_, i) => `S${i}`);
    const n = normalisiereNachricht(artikel(2, '2026-10-05T13:31:00Z', viele), () => true);
    expect(n?.symbole).toHaveLength(SYMBOLE_MAX);
    expect(n?.symboleGenannt).toBe(60);
  });

  it('kürzt lange Texte', () => {
    expect(kuerze('a '.repeat(400), 300).length).toBeLessThanOrEqual(300);
    expect(kuerze('  kurz   so  ', 300)).toBe('kurz so');
  });
});

describe('Cursor-Bausteine', () => {
  const t = Date.parse('2026-10-05T14:00:00Z');

  it('Start = Cursor minus 30 min; ohne, kaputter oder Zukunfts-Cursor: 2 h zurück', () => {
    expect(abrufStart('2026-10-05T13:55:00.000Z', t)).toBe('2026-10-05T13:25:00.000Z');
    expect(abrufStart(null, t)).toBe('2026-10-05T12:00:00.000Z');
    expect(abrufStart('2026-10-06T00:00:00Z', t)).toBe('2026-10-05T12:00:00.000Z');
    expect(abrufStart('Unsinn', t)).toBe('2026-10-05T12:00:00.000Z');
  });

  it('jüngste Achsen-Zeit nimmt updated_at und deckelt auf die eigene Uhr', () => {
    expect(juengsteAchsenZeit([artikel(1, '2026-10-05T10:00:00Z', [], '2026-10-05T13:00:00Z')], t)).toBe('2026-10-05T13:00:00.000Z');
    expect(juengsteAchsenZeit([artikel(1, '2026-10-05T10:00:00Z', [], '2027-01-01T00:00:00Z')], t)).toBe('2026-10-05T14:00:00.000Z');
    expect(juengsteAchsenZeit([], t)).toBeNull();
  });

  it('spaeterer: nie rückwärts, null zählt nicht', () => {
    expect(spaeterer('2026-10-05T13:00:00Z', '2026-10-05T12:00:00Z')).toBe('2026-10-05T13:00:00Z');
    expect(spaeterer(null, '2026-10-05T12:00:00Z')).toBe('2026-10-05T12:00:00Z');
    expect(spaeterer('2026-10-05T12:00:00Z', null)).toBe('2026-10-05T12:00:00Z');
  });

  it('leseFortsetzung akzeptiert nur die eigene Form', () => {
    expect(lauf.leseFortsetzung({ start: '2026-10-05T12:00:00Z', token: 'x', bis: null })).toEqual({ start: '2026-10-05T12:00:00Z', token: 'x', bis: null });
    expect(lauf.leseFortsetzung({ start: 'Unsinn', token: 'x' })).toBeNull();
    expect(lauf.leseFortsetzung({ start: '2026-10-05T12:00:00Z', token: '' })).toBeNull();
    expect(lauf.leseFortsetzung(undefined)).toBeNull();
  });
});

describe('Datensatz', () => {
  it('Nachzügler ab 2 h Verzögerung; Kursalter relativ zur Kursabfrage', () => {
    const n = normalisiereNachricht(artikel(9, '2026-10-05T11:00:00Z', ['AAPL']), () => true)!;
    const d = lauf.nachrichtenDatensatz(n, '2026-10-05T14:00:00.000Z', { AAPL: { p: 1, t: '2026-10-05T13:59:00.000Z' } }, '2026-10-05T14:00:05.000Z');
    expect(d['nachzuegler']).toBe(true);
    expect(d['kurseGesehen']).toEqual({ AAPL: { p: 1, t: '2026-10-05T13:59:00.000Z', alterS: 65 } });
    const frisch = lauf.nachrichtenDatensatz(n, '2026-10-05T12:30:00.000Z', {}, null);
    expect(frisch['nachzuegler']).toBe(false);
  });

  it('verzoegerungMedianS', () => {
    expect(lauf.verzoegerungMedianS([])).toBeNull();
    expect(
      lauf.verzoegerungMedianS([
        { publishedAt: '2026-10-05T13:00:00Z', firstSeenAt: '2026-10-05T13:01:00Z' },
        { publishedAt: '2026-10-05T13:00:00Z', firstSeenAt: '2026-10-05T13:03:00Z' },
        { publishedAt: '2026-10-05T13:00:00Z', firstSeenAt: '2026-10-05T13:10:00Z' },
      ]),
    ).toBe(180);
  });
});

describe('holeLetzteKurse', () => {
  beforeEach(() => {
    aufrufe.length = 0;
    kurseKaputt = false;
  });

  it('fragt genau die Symbole in Alpaca-Schreibweise, Krypto nur gegen USD', async () => {
    const { kurse, fehler } = await news.holeLetzteKurse(
      { keyId: 'k', secret: 's' },
      ['AAPL', 'BRK-B', 'BTC-USD', 'BTC-EUR'],
      (s) => s.includes('-USD') || s.includes('-EUR'),
      fetchImpl,
    );
    expect(fehler).toEqual([]);
    const aktien = aufrufe.find((u) => u.pathname === '/v2/stocks/trades/latest')!;
    const krypto = aufrufe.find((u) => u.pathname === '/v1beta3/crypto/us/latest/trades')!;
    expect(aktien.searchParams.get('symbols')).toBe('AAPL,BRK.B');
    expect(krypto.searchParams.get('symbols')).toBe('BTC/USD');
    expect(Object.keys(kurse).sort()).toEqual(['AAPL', 'BRK-B', 'BTC-USD']);
  });

  it('stückelt Aktien in Hunderter-Abfragen', async () => {
    const viele = Array.from({ length: 230 }, (_, i) => `S${i}`);
    await news.holeLetzteKurse({ keyId: 'k', secret: 's' }, viele, () => false, fetchImpl);
    const anzahlen = aufrufe.map((u) => u.searchParams.get('symbols')!.split(',').length);
    expect(anzahlen).toEqual([100, 100, 30]);
  });
});

/* ── Lauf ─────────────────────────────────────────────────────────────── */

describe('runNachrichtenSammeln', () => {
  beforeEach(() => {
    store.clear();
    commitFehler = null;
    kurseKaputt = false;
    aufrufe.length = 0;
    newsAufrufe = 0;
    alpaca.artikel = [];
    alpaca.achse = 'updated_at';
    alpaca.scheitern = () => false;
    setzeUhr('2026-10-05T14:00:00Z');
    process.env.ALPACA_API_KEY = 'PKTESTSCHLUESSEL123';
    process.env.ALPACA_SECRET_KEY = 'GEHEIMNIS-0123456789';
  });
  afterEach(() => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
  });

  const run = () => lauf.runNachrichtenSammeln(fetchImpl, jetzt);

  it('erster Lauf: 2 h zurück, nur bekannte Symbole, Kurs beim Sehen, Cursor = jüngste GELESENE Meldung', async () => {
    alpaca.artikel = [
      artikel(1, '2026-10-05T13:31:00Z', ['AAPL']),
      artikel(2, '2026-10-05T13:40:00Z', ['ZZZZ']),
      artikel(3, '2026-10-05T13:50:00Z', ['BRK.B', 'BTCUSD']),
    ];
    const r = await run();
    expect(r).toMatchObject({ grund: null, gelesen: 3, brauchbar: 2, neu: 2, seiten: 1, abgeschnitten: false });
    expect(newsUrls()[0]!.searchParams.get('start')).toBe('2026-10-05T12:00:00.000Z');

    const eins = store.get('marktNachrichten/alp-1')!;
    expect(eins).toMatchObject({
      firstSeenAt: '2026-10-05T14:00:00.000Z',
      publishedAt: '2026-10-05T13:31:00.000Z',
      gespeichertAt: SERVER_TS,
      kurseAbgefragtAt: '2026-10-05T14:00:00.000Z',
      nachzuegler: false,
    });
    expect(eins['kurseGesehen']).toEqual({ AAPL: { p: 190.5, t: '2026-10-05T13:59:30.000Z', alterS: 30 } });
    expect(Object.keys(store.get('marktNachrichten/alp-3')!['kurseGesehen'] as object).sort()).toEqual(['BRK-B', 'BTC-USD']);
    expect(store.has('marktNachrichten/alp-2')).toBe(false);

    expect(stand()).toMatchObject({ cursor: '2026-10-05T13:50:00.000Z', grund: null, neu: 2, neuGesamt: 2, fehlerFolge: 0 });
    expect(stand()).not.toHaveProperty('fortsetzung');
    // Der Stand ist öffentlich lesbar — keine Schlüssel.
    expect(JSON.stringify(stand())).not.toMatch(/PKTEST|GEHEIMNIS/);
  });

  it('eine schon gespeicherte Meldung bleibt UNVERÄNDERT — firstSeenAt wandert nie', async () => {
    store.set('marktNachrichten/alp-1', { id: 'alp-1', firstSeenAt: '2026-10-05T13:32:00.000Z', schlagzeile: 'alt' });
    store.set('meta/nachrichtenStand', { cursor: '2026-10-05T13:55:00.000Z' });
    alpaca.artikel = [
      artikel(1, '2026-10-05T13:31:00Z', ['AAPL'], '2026-10-05T13:58:00Z', 'neu formuliert'),
      artikel(4, '2026-10-05T13:58:30Z', ['CCG']),
    ];
    const r = await run();
    expect(r.neu).toBe(1);
    expect(store.get('marktNachrichten/alp-1')).toEqual({ id: 'alp-1', firstSeenAt: '2026-10-05T13:32:00.000Z', schlagzeile: 'alt' });
    expect(store.get('marktNachrichten/alp-4')!['firstSeenAt']).toBe('2026-10-05T14:00:00.000Z');
    expect(newsUrls()[0]!.searchParams.get('start')).toBe('2026-10-05T13:25:00.000Z');
  });

  it('firstSeenAt ist die Ankunft der EIGENEN Seite', async () => {
    alpaca.artikel = Array.from({ length: 60 }, (_, i) =>
      artikel(10 + i, new Date(Date.parse('2026-10-05T13:00:00Z') + i * 30_000).toISOString(), ['AAPL']),
    );
    const echt = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (u: string) => {
      if (u.includes('/v1beta1/news')) uhrMs += 7_000;
      return echt(u);
    });
    try {
      await run();
    } finally {
      fetchImpl.mockImplementation(echt);
    }
    expect(store.get('marktNachrichten/alp-10')!['firstSeenAt']).toBe('2026-10-05T14:00:07.000Z');
    expect(store.get('marktNachrichten/alp-69')!['firstSeenAt']).toBe('2026-10-05T14:00:14.000Z');
  });

  for (const achse of ['updated_at', 'created_at'] as const) {
    it(`Rückstand von 1.200 Meldungen (start filtert ${achse}): Fortsetzung per Token, jede genau einmal`, async () => {
      alpaca.achse = achse;
      alpaca.artikel = Array.from({ length: 1200 }, (_, i) =>
        artikel(1000 + i, new Date(Date.parse('2026-10-05T12:05:00Z') + i * 5_000).toISOString(), ['AAPL']),
      );
      const r1 = await run();
      expect(r1).toMatchObject({ seiten: 10, abgeschnitten: true, neu: 500 });
      const f1 = stand()['fortsetzung'] as { start: string; token: string };
      expect(f1.start).toBe('2026-10-05T12:00:00.000Z');
      expect(stand()).not.toHaveProperty('cursor');

      setzeUhr('2026-10-05T14:05:00Z');
      aufrufe.length = 0;
      const r2 = await run();
      // DIESELBE Abfrage, ab dem Token — nicht neu ab einem Zeitpunkt.
      expect(newsUrls()[0]!.searchParams.get('start')).toBe(f1.start);
      expect(newsUrls()[0]!.searchParams.get('page_token')).toBe(f1.token);
      expect(r2).toMatchObject({ abgeschnitten: true, neu: 500 });

      setzeUhr('2026-10-05T14:10:00Z');
      const r3 = await run();
      expect(r3).toMatchObject({ abgeschnitten: false, neu: 200 });
      expect(gespeichert()).toHaveLength(1200);
      expect(stand()).not.toHaveProperty('fortsetzung');
      expect(stand()['cursor']).toBe(alpaca.artikel[1199]!.updated_at);
    });

    it(`Massen-Aktualisierung alter Artikel (start filtert ${achse}): kein Stillstand, Altes nicht gespeichert`, async () => {
      alpaca.achse = achse;
      store.set('meta/nachrichtenStand', { cursor: '2026-10-05T14:00:00.000Z' });
      // 600 Artikel von 2024, alle zwischen 13:40 und 13:50 neu aktualisiert …
      const alt = Array.from({ length: 600 }, (_, i) =>
        artikel(5000 + i, '2024-03-01T10:00:00Z', ['AAPL'], new Date(Date.parse('2026-10-05T13:40:00Z') + i * 1_000).toISOString()),
      );
      // … und dazwischen zwölf echte neue Meldungen der nächsten Stunde.
      const frisch = Array.from({ length: 12 }, (_, i) =>
        artikel(9000 + i, new Date(Date.parse('2026-10-05T14:01:00Z') + i * 5 * 60_000).toISOString(), ['AAPL']),
      );
      alpaca.artikel = [...alt, ...frisch];
      let zuAlt = 0;
      for (let i = 1; i <= 12; i += 1) {
        setzeUhr(new Date(Date.parse('2026-10-05T14:00:00Z') + i * 5 * 60_000).toISOString());
        zuAlt += (await run()).zuAlt;
      }
      const ids = gespeichert().map((k) => Number(k.split('-')[1]));
      expect(ids.filter((id) => id >= 9000).sort()).toEqual(frisch.map((a) => a.id));
      expect(ids.filter((id) => id < 9000)).toEqual([]);
      if (achse === 'updated_at') expect(zuAlt).toBeGreaterThanOrEqual(600);
    });
  }

  it('eine früh erstellte, spät aktualisierte Meldung im Rückstand geht nicht verloren', async () => {
    alpaca.artikel = [
      ...Array.from({ length: 700 }, (_, i) =>
        artikel(100 + i, new Date(Date.parse('2026-10-05T12:30:00Z') + i * 5_000).toISOString(), ['AAPL']),
      ),
      artikel(77, '2026-10-05T13:45:00Z', ['CCG'], '2026-10-05T13:59:00Z'),
    ];
    await run();
    setzeUhr('2026-10-05T14:05:00Z');
    await run();
    expect(store.has('marktNachrichten/alp-77')).toBe(true);
    expect(gespeichert()).toHaveLength(701);
  });

  it('Seite 3 scheitert: Seiten 1–2 sind gespeichert, der nächste Lauf holt Seite 3 per Token', async () => {
    alpaca.artikel = Array.from({ length: 140 }, (_, i) =>
      artikel(200 + i, new Date(Date.parse('2026-10-05T13:00:00Z') + i * 10_000).toISOString(), ['AAPL']),
    );
    alpaca.scheitern = (n) => n === 3;
    const r1 = await run();
    expect(r1).toMatchObject({ grund: null, neu: 100, abgeschnitten: true });
    expect(String(stand()['fehler'])).toContain('HTTP 500');
    alpaca.scheitern = () => false;
    setzeUhr('2026-10-05T14:05:00Z');
    const r2 = await run();
    expect(r2).toMatchObject({ neu: 40, abgeschnitten: false });
    expect(gespeichert()).toHaveLength(140);
    expect(stand()).not.toHaveProperty('fehler');
  });

  it('scheitert die Fortsetzung schon an der ersten Seite: verworfen, Cursor steht, nächster Lauf liest neu', async () => {
    store.set('meta/nachrichtenStand', {
      cursor: '2026-10-05T13:00:00.000Z',
      fehlerFolge: 1,
      fortsetzung: { start: '2026-10-05T12:30:00.000Z', token: 'tot', bis: null },
    });
    alpaca.scheitern = () => true;
    const r = await run();
    expect(r.grund).toBe('fehler');
    expect(stand()).not.toHaveProperty('fortsetzung');
    expect(stand()).toMatchObject({ cursor: '2026-10-05T13:00:00.000Z', fehlerFolge: 2 });
  });

  it('scheitert der Commit, rücken weder Cursor noch Fortsetzung — die Meldungen kommen wieder', async () => {
    store.set('meta/nachrichtenStand', { cursor: '2026-10-05T13:55:00.000Z', fehlerFolge: 2 });
    alpaca.artikel = [artikel(5, '2026-10-05T13:58:00Z', ['AAPL'])];
    commitFehler = new Error('ALREADY_EXISTS race');
    const r = await run();
    expect(r.grund).toBe('fehler');
    expect(stand()).toMatchObject({ cursor: '2026-10-05T13:55:00.000Z', fehlerFolge: 3 });
    commitFehler = null;
    await run();
    expect(store.has('marktNachrichten/alp-5')).toBe(true);
  });

  it('Blätter-Frist: nach 45 s abgeschnitten, Rest per Token', async () => {
    alpaca.artikel = Array.from({ length: 500 }, (_, i) =>
      artikel(3000 + i, new Date(Date.parse('2026-10-05T12:10:00Z') + i * 5_000).toISOString(), ['AAPL']),
    );
    const echt = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (u: string) => {
      if (u.includes('/v1beta1/news')) uhrMs += 10_000;
      return echt(u);
    });
    try {
      const r = await run();
      expect(r).toMatchObject({ seiten: 5, abgeschnitten: true });
    } finally {
      fetchImpl.mockImplementation(echt);
    }
  });

  it('ein Zeitstempel aus der Zukunft nagelt den Cursor nicht fest', async () => {
    alpaca.artikel = [artikel(8, '2026-10-05T13:50:00Z', ['AAPL'], '2027-01-01T00:00:00Z')];
    await run();
    expect(Date.parse(String(stand()['cursor']))).toBeLessThanOrEqual(uhrMs);
  });

  it('fehlende Kurse kosten die Meldung nicht', async () => {
    kurseKaputt = true;
    alpaca.artikel = [artikel(6, '2026-10-05T13:58:00Z', ['AAPL'])];
    const r = await run();
    expect(r.neu).toBe(1);
    expect(store.get('marktNachrichten/alp-6')!['kurseGesehen']).toEqual({});
    expect(stand()['kurseFehler']).toBe(1);
  });

  it('ohne Schlüssel: kein Abruf, Grund steht im Stand', async () => {
    delete process.env.ALPACA_API_KEY;
    const r = await run();
    expect(r.grund).toBe('keine_schluessel');
    expect(aufrufe).toHaveLength(0);
    expect(stand()['grund']).toBe('keine_schluessel');
  });

  it('ein Fehlertext mit Schlüsseln landet bereinigt und gekürzt im öffentlichen Stand', async () => {
    const kaputt = vi.fn(async () =>
      new Response(`bad key PKTESTSCHLUESSEL123 / GEHEIMNIS-0123456789 ${'x'.repeat(400)}`, { status: 401 }),
    );
    const r = await lauf.runNachrichtenSammeln(kaputt, jetzt);
    expect(r.grund).toBe('fehler');
    const fehler = String(stand()['fehler']);
    expect(fehler).toContain('HTTP 401');
    expect(fehler).not.toMatch(/PKTEST|GEHEIMNIS/);
    expect(fehler.length).toBeLessThanOrEqual(160);
  });
});

/* ── Quelltext-Wächter ────────────────────────────────────────────────── */

describe('Quelltext-Wächter nachrichtenSammeln', () => {
  const wurzel = join(import.meta.dirname, '..', '..');
  const src = readFileSync(join(wurzel, 'functions', 'src', 'scheduled', 'nachrichtenSammeln.ts'), 'utf8');

  it('Meldungen nur per create — jedes andere Schreiben trifft nur den Stand', () => {
    expect(src).toContain('batch.create(db.doc(`marktNachrichten/${c.n.id}`)');
    expect(src).not.toMatch(/batch\.(set|update)\(/);
    // `brauchbar` ist eine Map im Speicher — kein Firestore-Schreiben.
    expect(src).toContain('const brauchbar = new Map<');
    const schreiben = [...src.matchAll(/(\w+)\s*\.(set|update)\(/g)].map((m) => m[1]);
    expect(new Set(schreiben)).toEqual(new Set(['standRef', 'brauchbar']));
  });

  it('Cursor und Fortsetzung werden erst NACH den Commits geschrieben', () => {
    const commit = src.indexOf('await batch.commit();');
    expect(commit).toBeGreaterThan(-1);
    expect(src.indexOf('cursor: spaeterer(')).toBeGreaterThan(commit);
    expect(src.indexOf('fortsetzung: { start: abfrage.start')).toBeGreaterThan(commit);
  });

  it('der Zeitplan bindet beide Plattform-Schlüssel und lässt der Blätter-Frist Luft', () => {
    const ab = src.indexOf('export const nachrichtenSammeln = onSchedule(');
    const block = src.slice(ab, src.indexOf('async', ab));
    expect(block).toContain("secrets: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY']");
    const timeout = Number(/timeoutSeconds: (\d+)/.exec(block)?.[1]);
    expect(news.NACHRICHTEN_BLAETTER_FRIST_MS).toBeLessThanOrEqual((timeout * 1000) / 3);
  });

  it('marktNachrichten bleibt server-only — keine Regel öffnet die Sammlung', () => {
    const regeln = readFileSync(join(wurzel, 'firestore.rules'), 'utf8');
    expect(regeln).not.toContain('marktNachrichten');
    expect(regeln).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  });
});
