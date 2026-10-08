/**
 * Task 19, Teil 2a — Verhalten des Profil-Laufs mit Firestore-Double und
 * Fake-Fetch (Red-Team 08.10.): symbolbezogenes 403 darf den Cursor nicht
 * parken (H1), das Zeitbudget sichert Cursor und Stand (M1), der
 * Yahoo-Anker aus demselben Dokument entwertet unplausible metric-Werte (H2),
 * Kalendertag und „nach Schluss" rechnen in New York (M3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Daten = Record<string, unknown>;
const store = new Map<string, Daten>();
const holen = (pfad: string, feld: string): unknown =>
  feld.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Daten)[k] : undefined), store.get(pfad));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: (pfad: string) => ({
      get: async () => ({ exists: store.has(pfad), get: (f: string) => holen(pfad, f) }),
      set: async (d: Daten) => store.set(pfad, { ...(store.get(pfad) ?? {}), ...d }),
    }),
  }),
}));
vi.mock('firebase-functions/v2', () => ({ logger: { info: () => undefined, warn: () => undefined } }));
vi.mock('firebase-functions/v2/https', () => ({ onRequest: () => () => undefined }));
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: () => () => undefined }));

const { PROFIL_ZEITBUDGET_MS, profilKandidaten, runProfilSync } = await import('../src/scheduled/profilSync.js');

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const nein = (status: number) => ({ ok: false, status, json: async () => ({}) });
const AM_ABEND = new Date('2026-10-08T21:45:00Z'); // 17:45 ET

/** Fake-Finnhub: `stoerer` → Status je Symbol; sonst ein kleines, gültiges Profil. */
function fakeFetch(stoerer: Record<string, number> = {}, metric: Daten = { marketCapitalization: 1200, beta: 1.1, epsTTM: 2, '52WeekHigh': 100 }) {
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    const sym = /symbol=([^&]+)/.exec(url)?.[1] ?? '';
    if (stoerer[sym]) return nein(stoerer[sym]!);
    if (url.includes('/stock/profile2')) return ok({ name: `Firma ${sym}`, finnhubIndustry: 'Test', currency: 'USD', marketCapitalization: 999 });
    if (url.includes('/stock/metric')) return ok({ metric });
    return ok({ earningsCalendar: [{ date: '2026-10-08', hour: 'amc' }, { date: '2026-10-30', hour: 'bmo' }] });
  };
  return { f, urls };
}

beforeEach(() => {
  store.clear();
  process.env.FINNHUB_API_KEY = 'test-schluessel';
});

describe('Cursor und Abbruchgründe (H1)', () => {
  const kand = profilKandidaten();

  it('symbolbezogenes 403 mitten im Lauf: zählen, weitergehen — der Rest wird geschrieben, der Cursor rotiert', async () => {
    const { f } = fakeFetch({ [kand[5]!]: 403 });
    const r1 = await runProfilSync(AM_ABEND, f, 0);
    expect(r1).toMatchObject({ grund: null, geschrieben: kand.length - 1, fehler: 1, cursor: 0 });
    expect(store.has(`market/${kand[5]}`)).toBe(false);
    expect(store.has(`market/${kand[kand.length - 1]}`)).toBe(true);
    const r2 = await runProfilSync(new Date(AM_ABEND.getTime() + 86_400_000), f, 0);
    expect(r2.geschrieben).toBe(kand.length - 1); // und nicht 0 (vorher: Cursor parkte auf Nr. 5)
  });

  it('403 am ERSTEN Symbol oder 401 irgendwo = Schlüsselproblem: Abbruch mit Grund, Cursor bleibt davor stehen', async () => {
    const r1 = await runProfilSync(AM_ABEND, fakeFetch({ [kand[0]!]: 403 }).f, 0);
    expect(r1).toMatchObject({ grund: 'kein_zugriff', geschrieben: 0, cursor: 0 });
    store.clear();
    const r2 = await runProfilSync(AM_ABEND, fakeFetch({ [kand[3]!]: 401 }).f, 0);
    expect(r2).toMatchObject({ grund: 'kein_zugriff', geschrieben: 3, cursor: 3 });
    expect(store.get('meta/profilStand')).toMatchObject({ grund: 'kein_zugriff', cursor: 3, v: 2 });
  });

  it('429 bricht ab und setzt beim selben Symbol wieder an (die Drossel ist nicht symbolbezogen)', async () => {
    const r = await runProfilSync(AM_ABEND, fakeFetch({ [kand[2]!]: 429 }).f, 0);
    expect(r).toMatchObject({ grund: 'rate_limit', geschrieben: 2, cursor: 2 });
  });
});

describe('Zeitbudget (M1)', () => {
  it('hört vor dem Function-Timeout auf, schreibt Cursor + Stand, der nächste Lauf setzt dort fort', async () => {
    const kand = profilKandidaten();
    let t = 0;
    const uhr = (): number => (t += 100_000); // jede Abfrage 100 s später
    const { f, urls } = fakeFetch();
    const r1 = await runProfilSync(AM_ABEND, f, 0, uhr);
    // beginn=100 s; Prüfungen bei 200…500 s ≤ 450 s → 4 Symbole, die 5. Prüfung (600 s) bricht ab … rechnerisch:
    expect(r1.grund).toBe('zeit');
    expect(r1.geschrieben).toBeGreaterThan(0);
    expect(r1.geschrieben).toBeLessThan(kand.length);
    expect(r1.cursor).toBe(r1.geschrieben);
    expect(store.get('meta/profilStand')).toMatchObject({ grund: 'zeit', cursor: r1.cursor, geschrieben: r1.geschrieben });
    expect(PROFIL_ZEITBUDGET_MS).toBeLessThan(540_000);
    const vorher = urls.length;
    const r2 = await runProfilSync(AM_ABEND, f, 0);
    expect(urls[vorher]).toContain(`symbol=${encodeURIComponent(kand[r1.cursor]!)}`);
    expect(r2.geschrieben + r1.geschrieben).toBeGreaterThanOrEqual(kand.length);
  });
});

describe('Plausibilität und Zeit (H2, M3)', () => {
  it('Yahoo-52W-Hoch im selben Dokument entwertet abweichende metric-Werte; Marktkap fällt auf profile2 zurück', async () => {
    const kand = profilKandidaten();
    store.set(`market/${kand[0]}`, { kennzahlen: { w52Hoch: 18.16 } });
    await runProfilSync(AM_ABEND, fakeFetch({}, { marketCapitalization: 14.4, epsTTM: -26.1, '52WeekHigh': 43.05, beta: 0.26 }).f, 0);
    expect(store.get(`market/${kand[0]}`)).toMatchObject({ kennzahlen: { w52Hoch: 18.16 }, profil: { metricVerdacht: true, epsTtm: null, w52Hoch: null, marktkapMio: 999, beta: 0.26 } });
    expect(store.get(`market/${kand[1]}`)).toMatchObject({ profil: { metricVerdacht: false, epsTtm: -26.1, marktkapMio: 14.4 } });
  });

  it('17:45 ET: heutiger Termin (amc) ist vorbei → nächster; 22:30 ET ist noch derselbe Kalendertag (nicht UTC-morgen)', async () => {
    const kand = profilKandidaten();
    const { f, urls } = fakeFetch();
    await runProfilSync(AM_ABEND, f, 0);
    expect(store.get(`market/${kand[0]}`)).toMatchObject({ profil: { gewinntermin: '2026-10-30' } });
    expect(urls.find((u) => u.includes('calendar/earnings'))).toContain('from=2026-10-08&');
    store.clear();
    await runProfilSync(new Date('2026-10-09T02:30:00Z'), f, 0); // 22:30 ET am 08.10.
    expect(urls[urls.length - 1]).toContain('from=2026-10-08&');
    store.clear();
    await runProfilSync(new Date('2026-10-08T14:00:00Z'), f, 0); // 10:00 ET: heutiger Termin zählt noch
    expect(store.get(`market/${kand[0]}`)).toMatchObject({ profil: { gewinntermin: '2026-10-08' } });
  });

  it('Schlüssel steht nie im Stand-Dokument oder in market/*', async () => {
    await runProfilSync(AM_ABEND, fakeFetch().f, 0);
    expect(JSON.stringify([...store.values()])).not.toContain('test-schluessel');
  });
});
