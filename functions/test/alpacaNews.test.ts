/**
 * KI-Kaskade Stufe 1 (05.10.): Alpaca-Nachrichten als append-only Messgrund.
 *
 * Gepinnt wird, was eine spätere Auswertung ehrlich macht:
 *   - jede Meldung wird GENAU EINMAL geschrieben — `firstSeenAt` kann kein
 *     späterer Lauf verschieben (sonst Lookahead durch die Hintertür);
 *   - `firstSeenAt` ist die Ankunft IHRER Seite, nicht `publishedAt`;
 *   - der Cursor rückt nur nach erfolgreichem Commit und nie rückwärts;
 *   - nur Symbole, die wir handeln könnten, in unserer Schreibweise;
 *   - Schlüssel tauchen in keinem Fehlertext auf.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── Kleines Firestore-Double ──────────────────────────────────────────── */

const DELETE = Symbol('delete');
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
  FieldValue: { increment: (n: number) => ({ inc: n }), delete: () => DELETE },
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
const { normalisiereNachricht, kuerze, abrufStart, naechsterCursor, SYMBOLE_MAX } = news;

/* ── Fetch-Double ─────────────────────────────────────────────────────── */

type Seite = { news: unknown[]; next_page_token?: string | null };
const antwort = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fetchMit(seiten: Seite[] | ((i: number) => Seite), kurse: 'ok' | 'fehler' = 'ok') {
  const aufrufe: string[] = [];
  let seite = 0;
  const impl = vi.fn(async (url: string) => {
    aufrufe.push(url);
    if (url.includes('/v1beta1/news')) {
      const s = typeof seiten === 'function' ? seiten(seite) : seiten[seite]!;
      seite += 1;
      return antwort(s);
    }
    if (kurse === 'fehler') return antwort({ message: 'forbidden' }, 403);
    if (url.includes('/v2/stocks/trades/latest')) {
      return antwort({ trades: { AAPL: { p: 190.5, t: '2026-10-05T14:00:00Z' }, 'BRK.B': { p: 410, t: '2026-10-05T13:59:00Z' } } });
    }
    if (url.includes('/crypto/us/latest/trades')) {
      return antwort({ trades: { 'BTC/USD': { p: 62000, t: '2026-10-05T14:00:01Z' } } });
    }
    return antwort({}, 404);
  });
  return { impl, aufrufe };
}

const meldung = (id: number, created: string, symbols: string[], headline = `Meldung ${id}`) => ({
  id,
  headline,
  summary: 'Kurz.',
  url: `https://example.org/${id}`,
  source: 'benzinga',
  symbols,
  created_at: created,
  updated_at: created,
});

/* ── Pure Teile ───────────────────────────────────────────────────────── */

describe('normalisiereNachricht', () => {
  const bekannt = (s: string) => ['AAPL', 'BRK-B', 'BTC-USD', 'CCG'].includes(s);

  it('übersetzt Alpaca-Schreibweise und behält nur bekannte Symbole', () => {
    const n = normalisiereNachricht(meldung(7, '2026-10-05T13:31:00Z', ['BRK.B', 'BTCUSD', 'ZZZZ', 'AAPL', 'AAPL']), bekannt);
    expect(n?.id).toBe('alp-7');
    expect(n?.symbole).toEqual(['BRK-B', 'BTC-USD', 'AAPL']);
    expect(n?.symboleGenannt).toBe(5);
    expect(n?.publishedAt).toBe('2026-10-05T13:31:00.000Z');
  });

  it('verwirft ohne ID, ohne Schlagzeile, ohne Datum oder ohne bekanntes Symbol', () => {
    expect(normalisiereNachricht({ ...meldung(1, '2026-10-05T13:31:00Z', ['AAPL']), id: undefined }, bekannt)).toBeNull();
    expect(normalisiereNachricht(meldung(1, '2026-10-05T13:31:00Z', ['AAPL'], '   '), bekannt)).toBeNull();
    expect(normalisiereNachricht(meldung(1, 'kein datum', ['AAPL']), bekannt)).toBeNull();
    expect(normalisiereNachricht(meldung(1, '2026-10-05T13:31:00Z', ['ZZZZ']), bekannt)).toBeNull();
    expect(normalisiereNachricht(null, bekannt)).toBeNull();
  });

  it('lässt keine fremden Zeichen in die Dokument-ID', () => {
    expect(normalisiereNachricht({ ...meldung(1, '2026-10-05T13:31:00Z', ['AAPL']), id: '../x' }, bekannt)).toBeNull();
  });

  it('kappt Sammelmeldungen bei SYMBOLE_MAX', () => {
    const viele = Array.from({ length: 60 }, (_, i) => `S${i}`);
    const n = normalisiereNachricht(meldung(2, '2026-10-05T13:31:00Z', viele), () => true);
    expect(n?.symbole).toHaveLength(SYMBOLE_MAX);
    expect(n?.symboleGenannt).toBe(60);
  });

  it('kürzt lange Texte mit Auslassungszeichen', () => {
    expect(kuerze('a '.repeat(400), 300).length).toBeLessThanOrEqual(300);
    expect(kuerze('  kurz   so  ', 300)).toBe('kurz so');
  });
});

describe('Cursor', () => {
  const jetzt = Date.parse('2026-10-05T14:00:00Z');

  it('Start = Cursor minus 30 min; ohne oder mit Zukunfts-Cursor 2 h zurück', () => {
    expect(abrufStart('2026-10-05T13:55:00.000Z', jetzt)).toBe('2026-10-05T13:25:00.000Z');
    expect(abrufStart(null, jetzt)).toBe('2026-10-05T12:00:00.000Z');
    expect(abrufStart('2026-10-06T00:00:00Z', jetzt)).toBe('2026-10-05T12:00:00.000Z');
    expect(abrufStart('Unsinn', jetzt)).toBe('2026-10-05T12:00:00.000Z');
  });

  it('vollständig → Abrufzeit; abgeschnitten → jüngste gelesene; nie rückwärts', () => {
    expect(naechsterCursor('2026-10-05T13:55:00Z', '2026-10-05T14:00:00Z', false, null)).toBe('2026-10-05T14:00:00Z');
    expect(naechsterCursor('2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z', true, '2026-10-05T13:20:00Z')).toBe('2026-10-05T13:20:00Z');
    expect(naechsterCursor('2026-10-05T13:30:00Z', '2026-10-05T14:00:00Z', true, '2026-10-05T13:20:00Z')).toBe('2026-10-05T13:30:00Z');
  });
});

describe('verzoegerungMedianS', () => {
  it('Median zwischen Veröffentlichung und erstem Sehen', () => {
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

/* ── Lauf ─────────────────────────────────────────────────────────────── */

describe('runNachrichtenSammeln', () => {
  const uhr = (() => {
    let t = Date.parse('2026-10-05T14:00:00Z');
    return { jetzt: () => new Date(t), weiter: (s: number) => { t += s * 1000; }, setze: (iso: string) => { t = Date.parse(iso); } };
  })();

  beforeEach(() => {
    store.clear();
    commitFehler = null;
    uhr.setze('2026-10-05T14:00:00Z');
    process.env.ALPACA_API_KEY = 'PKTESTSCHLUESSEL123';
    process.env.ALPACA_SECRET_KEY = 'GEHEIMNIS-0123456789';
  });
  afterEach(() => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
  });

  it('erster Lauf: 2 h zurück, aufsteigend, nur bekannte Symbole, Kurs beim Sehen, Cursor = Abrufzeit', async () => {
    const { impl, aufrufe } = fetchMit([
      { news: [meldung(1, '2026-10-05T13:31:00Z', ['AAPL']), meldung(2, '2026-10-05T13:40:00Z', ['ZZZZ']), meldung(3, '2026-10-05T13:50:00Z', ['BRK.B', 'BTCUSD'])] },
    ]);
    const r = await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(r).toMatchObject({ grund: null, gelesen: 3, brauchbar: 2, neu: 2, seiten: 1, abgeschnitten: false });

    const url = new URL(aufrufe[0]!);
    expect(url.searchParams.get('start')).toBe('2026-10-05T12:00:00.000Z');
    expect(url.searchParams.get('sort')).toBe('asc');

    const eins = store.get('marktNachrichten/alp-1')!;
    expect(eins['firstSeenAt']).toBe('2026-10-05T14:00:00.000Z');
    expect(eins['publishedAt']).toBe('2026-10-05T13:31:00.000Z');
    expect(eins['kurseGesehen']).toEqual({ AAPL: { p: 190.5, t: '2026-10-05T14:00:00.000Z' } });
    expect(store.get('marktNachrichten/alp-3')!['kurseGesehen']).toEqual({
      'BRK-B': { p: 410, t: '2026-10-05T13:59:00.000Z' },
      'BTC-USD': { p: 62000, t: '2026-10-05T14:00:01.000Z' },
    });
    expect(store.has('marktNachrichten/alp-2')).toBe(false);

    const stand = store.get('meta/nachrichtenStand')!;
    expect(stand['cursor']).toBe('2026-10-05T14:00:00.000Z');
    expect(stand).toMatchObject({ grund: null, neu: 2, neuGesamt: 2, fehlerFolge: 0 });
    // Der Stand ist öffentlich lesbar — nichts Persönliches, keine Schlüssel.
    expect(JSON.stringify(stand)).not.toMatch(/PKTEST|GEHEIMNIS/);
  });

  it('eine schon gespeicherte Meldung bleibt UNVERÄNDERT — firstSeenAt wandert nie', async () => {
    store.set('marktNachrichten/alp-1', { id: 'alp-1', firstSeenAt: '2026-10-05T13:32:00.000Z', schlagzeile: 'alt' });
    store.set('meta/nachrichtenStand', { cursor: '2026-10-05T13:55:00.000Z' });
    const { impl, aufrufe } = fetchMit([
      { news: [meldung(1, '2026-10-05T13:31:00Z', ['AAPL'], 'neu formuliert'), meldung(4, '2026-10-05T13:58:00Z', ['CCG'])] },
    ]);
    const r = await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(r.neu).toBe(1);
    expect(store.get('marktNachrichten/alp-1')).toEqual({ id: 'alp-1', firstSeenAt: '2026-10-05T13:32:00.000Z', schlagzeile: 'alt' });
    expect(store.get('marktNachrichten/alp-4')!['firstSeenAt']).toBe('2026-10-05T14:00:00.000Z');
    expect(new URL(aufrufe[0]!).searchParams.get('start')).toBe('2026-10-05T13:25:00.000Z');
  });

  it('firstSeenAt ist die Ankunft der EIGENEN Seite', async () => {
    let i = 0;
    const { impl } = fetchMit(() => {
      i += 1;
      uhr.weiter(7);
      return i === 1
        ? { news: [meldung(10, '2026-10-05T13:10:00Z', ['AAPL'])], next_page_token: 'p2' }
        : { news: [meldung(11, '2026-10-05T13:20:00Z', ['AAPL'])], next_page_token: null };
    });
    await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(store.get('marktNachrichten/alp-10')!['firstSeenAt']).toBe('2026-10-05T14:00:07.000Z');
    expect(store.get('marktNachrichten/alp-11')!['firstSeenAt']).toBe('2026-10-05T14:00:14.000Z');
  });

  it('Seitendeckel: abgeschnitten, Cursor nur bis zur jüngsten gelesenen Meldung', async () => {
    let n = 0;
    const { impl } = fetchMit(() => {
      n += 1;
      const t = new Date(Date.parse('2026-10-05T12:00:00Z') + n * 60_000).toISOString();
      return { news: [meldung(100 + n, t, ['AAPL'])], next_page_token: `p${n + 1}` };
    });
    const r = await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(r).toMatchObject({ seiten: 10, abgeschnitten: true, neu: 10 });
    expect(store.get('meta/nachrichtenStand')!['cursor']).toBe('2026-10-05T12:10:00.000Z');
  });

  it('scheitert der Commit, rückt der Cursor NICHT — die Meldungen kommen im nächsten Lauf wieder', async () => {
    store.set('meta/nachrichtenStand', { cursor: '2026-10-05T13:55:00.000Z', fehlerFolge: 2 });
    commitFehler = new Error('ALREADY_EXISTS race');
    const { impl } = fetchMit([{ news: [meldung(5, '2026-10-05T13:58:00Z', ['AAPL'])] }]);
    const r = await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(r.grund).toBe('fehler');
    const stand = store.get('meta/nachrichtenStand')!;
    expect(stand['cursor']).toBe('2026-10-05T13:55:00.000Z');
    expect(stand['fehlerFolge']).toBe(3);
  });

  it('fehlende Kurse kosten die Meldung nicht', async () => {
    const { impl } = fetchMit([{ news: [meldung(6, '2026-10-05T13:58:00Z', ['AAPL'])] }], 'fehler');
    const r = await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(r.neu).toBe(1);
    expect(store.get('marktNachrichten/alp-6')!['kurseGesehen']).toEqual({});
    expect(store.get('meta/nachrichtenStand')!['kurseFehler']).toBe(1);
  });

  it('ohne Schlüssel: kein Abruf, Grund steht im Stand', async () => {
    delete process.env.ALPACA_API_KEY;
    const { impl } = fetchMit([]);
    const r = await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(r.grund).toBe('keine_schluessel');
    expect(impl).not.toHaveBeenCalled();
    expect(store.get('meta/nachrichtenStand')!['grund']).toBe('keine_schluessel');
  });

  it('ein Fehlertext mit Schlüsseln landet bereinigt im öffentlichen Stand', async () => {
    const impl = vi.fn(async () =>
      new Response('bad key PKTESTSCHLUESSEL123 / GEHEIMNIS-0123456789', { status: 401 }),
    );
    const r = await lauf.runNachrichtenSammeln(impl, uhr.jetzt);
    expect(r.grund).toBe('fehler');
    const fehler = String(store.get('meta/nachrichtenStand')!['fehler']);
    expect(fehler).toContain('HTTP 401');
    expect(fehler).not.toMatch(/PKTEST|GEHEIMNIS/);
  });
});

/* ── Quelltext-Wächter ────────────────────────────────────────────────── */

describe('Quelltext-Wächter nachrichtenSammeln', () => {
  const wurzel = join(import.meta.dirname, '..', '..');
  const src = readFileSync(join(wurzel, 'functions', 'src', 'scheduled', 'nachrichtenSammeln.ts'), 'utf8');

  it('Meldungen nur per create — nie set/update auf marktNachrichten', () => {
    expect(src).toContain('batch.create(db.doc(`marktNachrichten/${c.n.id}`)');
    expect(src).not.toMatch(/\.(set|update)\(\s*db\.doc\(`marktNachrichten/);
  });

  it('der Cursor wird erst NACH den Commits geschrieben', () => {
    const commit = src.indexOf('await batch.commit();');
    const cursor = src.indexOf('cursor: naechsterCursor(');
    expect(commit).toBeGreaterThan(-1);
    expect(cursor).toBeGreaterThan(commit);
  });

  it('der Zeitplan bindet beide Plattform-Schlüssel', () => {
    const ab = src.indexOf('export const nachrichtenSammeln = onSchedule(');
    const block = src.slice(ab, src.indexOf('async', ab));
    expect(block).toContain("secrets: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY']");
  });

  it('marktNachrichten bleibt server-only — keine Regel öffnet die Sammlung', () => {
    const regeln = readFileSync(join(wurzel, 'firestore.rules'), 'utf8');
    expect(regeln).not.toContain('marktNachrichten');
    expect(regeln).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  });
});
