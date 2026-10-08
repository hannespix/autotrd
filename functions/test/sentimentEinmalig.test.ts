/**
 * Red-Team-Befund 05.10.: Der Sentiment-Schatten zählte jeden Fall je
 * Lookback — Tag dreimal (10/20/30), intraday zweimal (24/48). Alle
 * Geschwister tragen dieselbe Nachrichtenlage, denselben Basiskurs und
 * denselben End-Kurs; `n` war also aufgebläht, ohne dass eine einzige
 * zusätzliche Beobachtung dahinterstand.
 *
 * Gezählt wird jetzt nur das Dokument des kleinsten Lookbacks. Die Regel
 * hängt am Dokument, nicht an einem Merker im Speicher, weil der Tageslauf
 * unsortiert in 200er-Portionen liest und Geschwister in verschiedenen
 * Läufen landen können — genau das prüft der Verhaltenstest unten gegen
 * `evaluateDue` selbst, nicht gegen eine nachgebaute Aufrufstelle.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ── Firestore-Double (nur was evaluateDue braucht) ───────────────────── */

type Daten = Record<string, unknown>;
const store = new Map<string, Daten>();
/** Welche offenen Prognose-Dokumente die nächste Abfrage liefert. */
let abfrage: (pfad: string, d: Daten) => boolean = () => true;

const inc = (n: number) => ({ __inc: n });
function mischen(alt: Daten | undefined, neu: Daten): Daten {
  const out: Daten = { ...(alt ?? {}) };
  for (const [k, v] of Object.entries(neu)) {
    if (v && typeof v === 'object' && '__inc' in (v as object)) {
      out[k] = Number(out[k] ?? 0) + (v as { __inc: number }).__inc;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mischen(out[k] as Daten | undefined, v as Daten);
    } else out[k] = v;
  }
  return out;
}

const ref = (pfad: string) => {
  const teile = pfad.split('/');
  return {
    path: pfad,
    id: teile[teile.length - 1]!,
    parent: { parent: { id: teile[teile.length - 3] } },
    get: async () => ({ exists: store.has(pfad), get: (f: string) => store.get(pfad)?.[f] }),
    set: async (d: Daten, opt?: { merge?: boolean }) => {
      store.set(pfad, opt?.merge ? mischen(store.get(pfad), d) : mischen(undefined, d));
    },
  };
};

const orderByAufrufe: string[] = [];

class FieldPathDouble {
  readonly teile: string[];
  constructor(...teile: string[]) {
    this.teile = teile;
  }
}

/** Variadisches update(FieldPath, Wert, …) → verschachteltes Objekt für `mischen`. */
function variadischZuDaten(args: unknown[]): Daten {
  const out: Daten = {};
  for (let i = 0; i + 1 < args.length; i += 2) {
    const fp = args[i] as FieldPathDouble;
    let ziel = out;
    for (const t of fp.teile.slice(0, -1)) ziel = (ziel[t] ??= {}) as Daten;
    ziel[fp.teile[fp.teile.length - 1]!] = args[i + 1];
  }
  return out;
}

vi.mock('firebase-admin/firestore', () => ({
  FieldPath: FieldPathDouble,
  FieldValue: { increment: inc, delete: () => undefined },
  getFirestore: () => ({
    doc: ref,
    collectionGroup: () => {
      // `orderBy` gehört dazu (Messkorrektur H1): Ohne das Double liefe der
      // Lauf hier still auf dem unsortierten Rückfallpfad (Red-Team B8).
      const abfrageObjekt = {
        orderBy: (feld: string) => {
          orderByAufrufe.push(feld);
          return abfrageObjekt;
        },
        limit: () => ({
          get: async () => ({
            docs: [...store.entries()]
              .filter(([p, d]) => p.includes('/forecasts/') && d['evaluated'] === false && abfrage(p, d))
              .map(([p, d]) => ({ ref: ref(p), data: () => d })),
          }),
        }),
      };
      return { where: () => abfrageObjekt };
    },
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        update: (r: { path: string }, erstes: unknown, ...rest: unknown[]) => {
          // Variadische Form (FieldPath, Wert, …): das Kombi-Aggregat — seit
          // der Messkorrektur (H2) nötig, weil `scored` daraus FÄLLE zählt.
          const daten = erstes instanceof FieldPathDouble ? variadischZuDaten([erstes, ...rest]) : (erstes as Daten);
          ops.push(() => store.set(r.path, mischen(store.get(r.path), daten)));
        },
        commit: async () => ops.forEach((o) => o()),
      };
    },
  }),
}));

const ACTUALS: Record<string, number> = {
  '2026-09-01': 100, '2026-09-02': 101, '2026-09-03': 102, '2026-09-04': 103,
  '2026-09-08': 104, '2026-09-09': 105, '2026-09-10': 106,
};
vi.mock('../src/core/marketData.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/marketData.js')>()),
  getMarketSnapshot: vi.fn(async () => ({
    bars: Object.entries(ACTUALS).map(([date, close]) => ({ date, close, open: close, high: close, low: close, volume: 1 })),
  })),
}));

const { evaluateDue, tallySent, vertrittSentimentFall } = await import('../src/scheduled/evalForecasts.js');
const { INTRADAY_LOOKBACK_GRID, LOOKBACK_GRID } = await import('../../shared/src/index.js');

/** Drei Lookback-Geschwister eines Falls, wie forecaster.ts sie schreibt. */
function geschwister(symbol: string, sentSign: number): void {
  const points = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10'].map((time, i) => ({
    time,
    value: 100 + i,
  }));
  for (const lb of LOOKBACK_GRID) {
    store.set(`market/${symbol}/forecasts/2026-09-01_${lb}`, {
      baseDate: '2026-09-01', baseClose: 100, lookback: lb, horizonDays: 6, dailyVol: 0.01,
      points, predictedPct: 5, madeAt: '2026-09-01T20:00:00Z', evaluated: false, sentSign,
    });
  }
}
const einmalig = () => (store.get('meta/sentimentStats')?.['einmalig'] ?? {}) as Daten;

/* ── Pure Regel ───────────────────────────────────────────────────────── */

describe('vertrittSentimentFall', () => {
  it('genau ein Lookback je Gitter vertritt den Fall', () => {
    expect(LOOKBACK_GRID.filter((lb) => vertrittSentimentFall(lb, LOOKBACK_GRID))).toEqual([10]);
    expect(INTRADAY_LOOKBACK_GRID.filter((lb) => vertrittSentimentFall(lb, INTRADAY_LOOKBACK_GRID))).toEqual([24]);
  });

  it('fremder Lookback und leeres Gitter zählen nicht', () => {
    expect(vertrittSentimentFall(15, LOOKBACK_GRID)).toBe(false);
    expect(vertrittSentimentFall(10, [])).toBe(false);
  });

  it('tallySent ignoriert sentSign 0 und fehlende End-Kurse', () => {
    const d = { pos: { n: 0, hits: 0 }, neg: { n: 0, hits: 0 } };
    tallySent(d, 0, 100, 103);
    tallySent(d, 1, 100, undefined);
    expect(d.pos.n + d.neg.n).toBe(0);
  });
});

/* ── Verhalten von evaluateDue ────────────────────────────────────────── */

describe('evaluateDue zählt jeden Fall einmal', () => {
  beforeEach(() => {
    store.clear();
    abfrage = () => true;
  });

  it('drei Geschwister in einem Lauf: n = 1, Treffer nur am Vertreter', async () => {
    geschwister('AAPL', 1);
    orderByAufrufe.length = 0;
    const r = await evaluateDue();
    expect(r.scored).toBe(3); // Lauf-Zähler: bewertete DOKUMENTE
    // Messkorrektur: die Schlange ist sortiert (H1), die Statistik zählt FÄLLE (H2)
    expect(orderByAufrufe).toEqual(['baseDate']);
    expect(store.get('meta/forecastStats')?.['scored']).toBe(1);
    expect(r.expired).toBe(0);
    expect(einmalig()['daily']).toEqual({ pos: { n: 1, hits: 1 }, neg: { n: 0, hits: 0 } });
    expect(store.get('market/AAPL/forecasts/2026-09-01_10')?.['sentHit']).toBe(true);
    expect(store.get('market/AAPL/forecasts/2026-09-01_20')).not.toHaveProperty('sentHit');
    expect(store.get('market/AAPL/forecasts/2026-09-01_30')).not.toHaveProperty('sentHit');
  });

  it('Geschwister auf zwei Läufe verteilt: zusammen trotzdem n = 1', async () => {
    geschwister('MSFT', -1);
    abfrage = (p) => !p.endsWith('_10');
    await evaluateDue();
    abfrage = () => true;
    await evaluateDue();
    expect(einmalig()['daily']).toEqual({ pos: { n: 0, hits: 0 }, neg: { n: 1, hits: 0 } });
  });

  it('der Vertreter zuerst, der Rest später: kein zweiter Zähler', async () => {
    geschwister('NVDA', 1);
    abfrage = (p) => p.endsWith('_10');
    await evaluateDue();
    abfrage = () => true;
    await evaluateDue();
    expect((einmalig()['daily'] as Daten)['pos']).toEqual({ n: 1, hits: 1 });
  });

  it('schreibt unter einmalig mit Fassung, Altfelder bleiben unberührt', async () => {
    store.set('meta/sentimentStats', { daily: { pos: { n: 99, hits: 50 } } });
    geschwister('AMD', 1);
    await evaluateDue();
    const d = store.get('meta/sentimentStats')!;
    expect(d['daily']).toEqual({ pos: { n: 99, hits: 50 } });
    expect(einmalig()['v']).toBe(1);
    expect(String(d['altbestand'])).toContain('nicht auswerten');
  });
});

/* ── Quelltext-Wächter ────────────────────────────────────────────────── */

describe('Quelltext-Wächter: jede Zählstelle hängt am Vertreter des RICHTIGEN Gitters', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/scheduled/evalForecasts.ts'), 'utf8');
  const abschnitt = (start: string, ende: string): string => {
    const a = src.indexOf(start);
    const b = src.indexOf(ende, a);
    expect(a, start).toBeGreaterThan(-1);
    expect(b, ende).toBeGreaterThan(a);
    return src.slice(a, b);
  };
  const tag = abschnitt('export async function evaluateDue(', "await writeSentStats('daily'");
  const intraday = abschnitt('export async function evaluateIntradayDue(', "await writeSentStats('intraday'");

  it('es gibt genau zwei Aufrufe — einen je Pfad', () => {
    const alle = src.match(/\btallySent\(/g) ?? [];
    expect(alle.length - 1, 'Aufrufe ohne die Definition').toBe(2);
    expect(tag.match(/\btallySent\(/g)).toHaveLength(1);
    expect(intraday.match(/\btallySent\(/g)).toHaveLength(1);
  });

  it('Tag nutzt das Tages-Gitter, intraday das Intraday-Gitter', () => {
    expect(tag).toContain('const sentVertreter = vertrittSentimentFall(doc.lookback, LOOKBACK_GRID);');
    expect(intraday).toContain('const sentVertreter = vertrittSentimentFall(doc.lookback, INTRADAY_LOOKBACK_GRID);');
  });

  it('jeder Aufruf steht direkt im Vertreter-Zweig', () => {
    for (const teil of [tag, intraday]) {
      expect(teil).toMatch(/if \(sentVertreter\) \{\s*tallySent\(/);
    }
  });
});
