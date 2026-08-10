/**
 * Der Lauf selbst — bisher waren nur seine reinen Helfer geprüft.
 *
 * Anlass ist ein Engpass, der keiner sein musste: Der Lauf ist täglich und
 * nahm 12 Symbole. Bei 164 Katalog-Symbolen hätte die katalogweite Kante
 * VIERZEHN Nächte gebraucht — und jeder Versions-Sprung der Rechnung setzt die
 * Zählung zurück (V1→V2→V3 allein am 10.08.). Der Beleg wäre nie fertig
 * geworden, ohne dass irgendwo ein Fehler stünde.
 *
 * Statt eines Symbol-Deckels steht jetzt ein Zeitdeckel. Diese Datei prüft
 * beides an einem Firestore-Doppel: dass ein Lauf alles Offene abarbeitet, und
 * dass das Budget vorher sauber abbricht statt in den Function-Timeout zu
 * laufen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Zustand des Doppels — bewusst außerhalb, damit `vi.mock` ihn sieht. */
interface Zustand {
  market: Map<string, Record<string, unknown>>;
  ohlc: Map<string, Array<Record<string, { close: number }>>>;
  meta: Map<string, Record<string, unknown>>;
  commits: number;
}

const z: Zustand = { market: new Map(), ohlc: new Map(), meta: new Map(), commits: 0 };

interface Ref {
  __pfad: string;
}

function bauDb(): unknown {
  return {
    collection(name: string) {
      if (name !== 'market') throw new Error(`unerwartete Sammlung ${name}`);
      return {
        get: async () => ({
          docs: [...z.market.entries()].map(([id, data]) => ({
            id,
            get: (f: string) => data[f],
          })),
        }),
        doc: (sym: string) => ({
          __pfad: `market/${sym}`,
          collection: () => ({
            get: async () => {
              const jahre = z.ohlc.get(sym) ?? [];
              return {
                empty: jahre.length === 0,
                docs: jahre.map((days) => ({ get: (f: string) => (f === 'days' ? days : undefined) })),
              };
            },
          }),
        }),
      };
    },
    doc: (pfad: string) => ({
      __pfad: pfad,
      get: async () => ({ get: (f: string) => (z.meta.get(pfad) ?? {})[f] }),
    }),
    batch() {
      const ops: Array<{ ref: Ref; data: Record<string, unknown>; merge: boolean }> = [];
      return {
        set(ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          ops.push({ ref, data, merge: opts?.merge === true });
        },
        async commit() {
          for (const o of ops) {
            const p = o.ref.__pfad;
            if (p.startsWith('market/')) {
              const sym = p.slice('market/'.length);
              z.market.set(sym, { ...(z.market.get(sym) ?? {}), ...o.data });
            } else {
              z.meta.set(p, o.merge ? { ...(z.meta.get(p) ?? {}), ...o.data } : o.data);
            }
          }
          z.commits += 1;
        },
      };
    },
  };
}

vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => bauDb() }));

const { DEEP_BACKFILL_V } = await import('../src/core/marketData.js');
const { runTagRueckblick, TAG_RUECKBLICK_V } = await import('../src/scheduled/tagRueckblick.js');
const { allSymbols } = await import('../../shared/src/index.js');

const HEUTE = new Date('2026-08-10T22:30:00Z');

/**
 * 500 aufeinanderfolgende Tage mit Wellenbewegung.
 *
 * Lückenlos, damit das Lücken-Gate nicht zuschlägt — geprüft wird hier die
 * Rotation, nicht die Zeitlogik (die steht in shared/test/tagRueckblick).
 */
function jahresChunks(versatz: number): Array<Record<string, { close: number }>> {
  const tage: Record<string, { close: number }> = {};
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 500; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    tage[d] = { close: 100 + 20 * Math.sin((i + versatz) / 14) + i * 0.05 };
  }
  return [tage];
}

function setze(symbole: string[]): void {
  z.market.clear();
  z.ohlc.clear();
  z.meta.clear();
  z.commits = 0;
  symbole.forEach((s, i) => {
    z.market.set(s, { deepBackfillV: DEEP_BACKFILL_V });
    z.ohlc.set(s, jahresChunks(i * 7));
  });
}

/** Uhr, die bei jedem Blick um `schritt` ms springt. */
function uhrMit(schritt: number): () => number {
  let t = 0;
  return () => {
    const jetzt = t;
    t += schritt;
    return jetzt;
  };
}

describe('runTagRueckblick — ein Lauf, der ganze Katalog', () => {
  beforeEach(() => setze(allSymbols().slice(0, 40)));

  it('bewertet ALLE offenen Symbole in EINEM Lauf, nicht 12', async () => {
    // Genau der Punkt der Änderung: 40 offen ⇒ 40 fertig. Vorher wären es 12
    // gewesen und der Rest hätte drei weitere Nächte gebraucht.
    const r = await runTagRueckblick(HEUTE, () => 0);
    expect(r.symbole).toBe(40);
    expect(r.offen).toBe(0);
    const markiert = [...z.market.values()].filter((m) => m['tagRueckblickV'] === TAG_RUECKBLICK_V);
    expect(markiert).toHaveLength(40);
  });

  it('ein zweiter Lauf findet nichts mehr zu tun — keine Doppelzählung', async () => {
    await runTagRueckblick(HEUTE, () => 0);
    const nachEins = z.meta.get('meta/tagRueckblick')!;
    const zwei = await runTagRueckblick(HEUTE, () => 0);
    expect(zwei.symbole).toBe(0);
    // Wichtiger als der Zähler: Die Summe darf sich nicht bewegt haben.
    expect(z.meta.get('meta/tagRueckblick')).toEqual(nachEins);
  });

  it('trägt eine Stichprobe zusammen, statt still bei null zu bleiben', async () => {
    const r = await runTagRueckblick(HEUTE, () => 0);
    expect(r.bewertet).toBeGreaterThan(0);
    const st = z.meta.get('meta/tagRueckblick')! as { gesamt: { n: number }; version: number };
    expect(st.gesamt.n).toBe(r.bewertet);
    expect(st.version).toBe(TAG_RUECKBLICK_V);
  });
});

describe('Zeitbudget', () => {
  beforeEach(() => setze(allSymbols().slice(0, 40)));

  it('bricht ab, bevor der Function-Timeout greift', async () => {
    // 100 s je Symbol: nach dem vierten steht die Uhr bei 400 s — die Prüfung
    // vor dem fünften greift. Vier Symbole fertig, der Rest bleibt offen.
    const r = await runTagRueckblick(HEUTE, uhrMit(100_000));
    expect(r.symbole).toBe(4);
    expect(r.offen).toBe(36);
  });

  it('der nächste Lauf macht dort weiter, wo abgebrochen wurde', async () => {
    await runTagRueckblick(HEUTE, uhrMit(100_000));
    const ersteVier = [...z.market.entries()]
      .filter(([, m]) => m['tagRueckblickV'] === TAG_RUECKBLICK_V)
      .map(([s]) => s);
    const zwei = await runTagRueckblick(HEUTE, uhrMit(100_000));
    const jetzt = [...z.market.entries()]
      .filter(([, m]) => m['tagRueckblickV'] === TAG_RUECKBLICK_V)
      .map(([s]) => s);
    expect(zwei.symbole).toBe(4);
    // Acht verschiedene Symbole — kein einziges zweimal.
    expect(new Set(jetzt).size).toBe(8);
    for (const s of ersteVier) expect(jetzt).toContain(s);
  });

  it('das laufende Symbol wird fertig gerechnet — Marker und Meldung bleiben paarig', async () => {
    // Die Budget-Prüfung steht VOR dem Symbol. Stünde sie mittendrin, wäre ein
    // Symbol in der Datenbank markiert, das der Lauf nicht als erledigt meldet:
    // Der Beitrag steckt dann in der Summe, das Symbol kommt nie wieder dran,
    // und die Differenz ist hinterher an keiner Zahl mehr zu sehen.
    //
    // 250 s Schritt, damit der Fall überhaupt eintreten KANN: Die Uhr steht
    // beim Blick vor dem Symbol noch unter dem Budget und danach darüber. Mit
    // kleineren Schritten greift immer der Deckel am Schleifenkopf, und eine
    // Prüfung mitten im Rumpf bliebe unentdeckt — genau das ist mir beim
    // ersten Entwurf dieses Tests passiert.
    const r = await runTagRueckblick(HEUTE, uhrMit(250_000));
    const markiert = [...z.market.values()].filter(
      (m) => m['tagRueckblickV'] === TAG_RUECKBLICK_V,
    ).length;
    expect(r.symbole).toBe(1);
    expect(markiert).toBe(r.symbole);
    expect(z.commits).toBe(r.symbole);
  });
});

describe('Versionswechsel', () => {
  beforeEach(() => setze(allSymbols().slice(0, 6)));

  it('verwirft ein Aggregat aus einer ANDEREN Rechnung, statt es fortzuschreiben', async () => {
    // Altbestand einer früheren Version — inklusive einer Klasse, die der neue
    // Lauf gar nicht anfasst. Sie darf nicht überleben.
    z.meta.set('meta/tagRueckblick', {
      version: TAG_RUECKBLICK_V - 1,
      gesamt: { n: 9999, summePct: 1234, treffer: 5000 },
      klassen: { erfundene_klasse: { n: 9999, summePct: 1234, treffer: 5000 } },
      cursor: 0,
    });
    const r = await runTagRueckblick(HEUTE, () => 0);
    const st = z.meta.get('meta/tagRueckblick')! as {
      gesamt: { n: number };
      klassen: Record<string, unknown>;
    };
    expect(st.gesamt.n).toBe(r.bewertet);
    expect(st.klassen['erfundene_klasse']).toBeUndefined();
  });
});
