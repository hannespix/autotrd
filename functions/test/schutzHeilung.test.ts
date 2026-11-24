/**
 * Fehlender Schutz-Stop kommt zurück (Task 45, 24.11.).
 *
 * Befund: Am 24.11. stornierte der Morgenlauf vor elf Verkäufen den
 * Schutz-Stop, die Verkäufe scheiterten — und die Positionen lagen danach
 * ohne Netz beim Broker. Für Umkehr-Positionen legte niemand einen Stop neu
 * an: Der Scan führt sie nicht, der Puls kümmert sich nur um den Sockel.
 *
 * Gepinnt wird: Die Heilung legt nur an, wo wirklich nichts mehr steht; sie
 * fasst einen gefüllten oder eben erst gestorbenen Stop nicht an (dort kann
 * gerade ein Exit laufen); und sie hält den Lauf nie auf.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Position } from '../../shared/src/index.js';

const holt = vi.fn();
const setzt = vi.fn(async () => undefined);
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: () => ({ get: holt, set: setzt }),
    collection: () => ({
      doc: () => ({
        get: holt,
        set: setzt,
        collection: () => ({ doc: () => ({ get: holt, set: setzt }) }),
      }),
    }),
  }),
  FieldPath: class {},
  FieldValue: { increment: () => 0, delete: () => 0 },
  Timestamp: { now: () => 0 },
}));

const { SCHUTZ_HEIL_RUHE_MS, heileSchutz, schutzHeilBefund } = await import('../src/core/schutzStop.js');
const { SCHUTZ_RUNDE_ABSTAND, SCHUTZ_RUNDE_MAX, umkehrSchutzPruefbar } = await import('../src/scheduled/umkehrLauf.js');

const VERBINDUNG = { mode: 'paper' as const, schluessel: { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' } };
const RISK = { stopLossPct: 15, takeProfitPct: 0, trailingStopPct: 0, atrStopMult: 0, atrTakeMult: 0, maxHoldDays: 0 };
const JETZT = Date.parse('2026-11-25T15:00:00Z');
const vor = (min: number): string => new Date(JETZT - min * 60_000).toISOString();
const stand = (status: string, mehr: Record<string, unknown> = {}) =>
  ({ id: 'o1', status, filledQty: 0, filledAvgPreis: 0, geaendertAm: vor(60), ...mehr });

const folge = (
  ...schritte: Array<{ ok?: boolean; status?: number; body?: unknown }>
): ReturnType<typeof vi.fn> => {
  let i = 0;
  return vi.fn(async () => {
    const s = schritte[Math.min(i++, schritte.length - 1)]!;
    return {
      ok: s.ok ?? true,
      status: s.status ?? 200,
      text: async () => (s.body === undefined ? '' : JSON.stringify(s.body)),
    } as unknown as Response;
  });
};
const methoden = (f: ReturnType<typeof vi.fn>): string[] =>
  f.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? 'GET');
const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const POS = {
  symbol: 'XLB', qty: 7, avgEntry: 50, side: 'long', broker: true, quelle: 'umkehr',
  openedAt: '2026-11-18T14:35:00Z',
} as unknown as Position;

beforeEach(() => {
  holt.mockReset();
  setzt.mockClear();
});

describe('schutzHeilBefund (pur)', () => {
  it('kein Link oder Order unbekannt → anlegen', () => {
    expect(schutzHeilBefund('kein_link', JETZT)).toBe('anlegen');
    expect(schutzHeilBefund(null, JETZT)).toBe('anlegen');
  });

  it('tot ohne Fill und lange genug tot → anlegen', () => {
    for (const s of ['canceled', 'expired', 'rejected']) {
      expect(schutzHeilBefund(stand(s), JETZT), s).toBe('anlegen');
    }
    expect(SCHUTZ_HEIL_RUHE_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(schutzHeilBefund(stand('canceled', { geaendertAm: new Date(JETZT - SCHUTZ_HEIL_RUHE_MS).toISOString() }), JETZT)).toBe('anlegen');
  });

  it('EBEN ERST gestorben → zu frisch: dort kann gerade ein Exit laufen', () => {
    expect(schutzHeilBefund(stand('canceled', { geaendertAm: vor(1) }), JETZT)).toBe('zu_frisch');
    expect(schutzHeilBefund(stand('canceled', { geaendertAm: new Date(JETZT - SCHUTZ_HEIL_RUHE_MS + 1).toISOString() }), JETZT)).toBe('zu_frisch');
    // ohne Zeitangabe gilt sie als frisch — nie auf Verdacht eine Verkaufs-Order
    expect(schutzHeilBefund(stand('canceled', { geaendertAm: '' }), JETZT)).toBe('zu_frisch');
    expect(schutzHeilBefund(stand('canceled', { geaendertAm: undefined }), JETZT)).toBe('zu_frisch');
  });

  it('gefüllt (ganz oder teilweise) → nicht anfassen, egal in welchem Zustand', () => {
    expect(schutzHeilBefund(stand('filled', { filledQty: 7, filledAvgPreis: 42.4 }), JETZT)).toBe('gefuellt');
    expect(schutzHeilBefund(stand('canceled', { filledQty: 3, filledAvgPreis: 42.4 }), JETZT)).toBe('gefuellt');
    expect(schutzHeilBefund(stand('partially_filled', { filledQty: 3, filledAvgPreis: 42.4 }), JETZT)).toBe('gefuellt');
  });

  it('lebt — oder steht in einem Zustand, den wir nicht als tot kennen → steht', () => {
    for (const s of ['new', 'accepted', 'held', 'pending_cancel', 'pending_new', 'replaced', 'suspended', 'done_for_day', '']) {
      expect(schutzHeilBefund(stand(s), JETZT), s).toBe('steht');
    }
  });
});

describe('heileSchutz', () => {
  it('toter Link (Storno vom Vortag) → neue Stop-Order an der Notbremse, Link geschrieben', async () => {
    holt.mockResolvedValue({ exists: true, data: () => ({ ...POS, schutz: { orderId: 'alt1', stopPreis: 42.5, qty: 7 } }) });
    const f = folge(
      { body: { id: 'alt1', status: 'canceled', filled_qty: '0', updated_at: '2026-11-24T14:35:22Z' } }, // Heilung fragt
      { ok: false, status: 422, body: { message: 'order is not cancelable' } }, // schutzAnlegen: DELETE
      { body: { id: 'alt1', status: 'canceled', filled_qty: '0' } }, // … sieht nach
      { body: { id: 'neu1', status: 'accepted', client_order_id: 'x' } },
    );
    const pos = { ...POS, schutz: { orderId: 'alt1', stopPreis: 42.5, qty: 7 } } as unknown as Position;
    const b = await heileSchutz(VERBINDUNG, 'u1', 'XLB', pos, RISK, 'etf_sectors', 'umk-2026-11-24-heil-1435', f as never);
    expect(b).toBe('anlegen');
    expect(methoden(f)).toContain('POST');
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    const koerper = JSON.parse(String((post?.[1] as { body?: string }).body)) as { side: string; type: string; stop_price: string | number; qty: string | number };
    expect(koerper.side).toBe('sell');
    expect(koerper.type).toBe('stop');
    expect(Number(koerper.stop_price)).toBe(42.5); // 50 × (1 − 15 %)
    expect(Number(koerper.qty)).toBe(7);
    // (daneben schreibt der Asset-Cache — gesucht ist der Schreibvorgang mit dem neuen Link)
    const links = (setzt.mock.calls as unknown as Array<[{ schutz?: { orderId: string } }]>)
      .map((c) => c[0]?.schutz?.orderId)
      .filter(Boolean);
    expect(links).toEqual(['neu1']);
  });

  it('der Stop LEBT → eine Nachfrage, sonst nichts (kein Storno, keine neue Order)', async () => {
    const f = folge({ body: { id: 'alt1', status: 'new', filled_qty: '0', updated_at: '2026-11-20T14:35:00Z' } });
    const pos = { ...POS, schutz: { orderId: 'alt1', stopPreis: 42.5, qty: 7 } } as unknown as Position;
    expect(await heileSchutz(VERBINDUNG, 'u1', 'XLB', pos, RISK, 'etf_sectors', 'l', f as never)).toBe('steht');
    expect(methoden(f)).toEqual(['GET']);
    expect(holt).not.toHaveBeenCalled();
    expect(setzt).not.toHaveBeenCalled();
  });

  it('der Stop hat GEFÜLLT → nicht anfassen: weder neue Order noch Link gelöst', async () => {
    const f = folge({ body: { id: 'alt1', status: 'filled', filled_qty: '7', filled_avg_price: '42.4', updated_at: '2026-11-24T16:00:00Z' } });
    const pos = { ...POS, schutz: { orderId: 'alt1', stopPreis: 42.5, qty: 7 } } as unknown as Position;
    expect(await heileSchutz(VERBINDUNG, 'u1', 'XLB', pos, RISK, 'etf_sectors', 'l', f as never)).toBe('gefuellt');
    expect(methoden(f)).toEqual(['GET']);
    expect(setzt).not.toHaveBeenCalled();
  });

  it('eben erst storniert → nichts (ein laufender Exit hätte ihn storniert)', async () => {
    const f = folge({ body: { id: 'alt1', status: 'canceled', filled_qty: '0', updated_at: new Date().toISOString() } });
    const pos = { ...POS, schutz: { orderId: 'alt1', stopPreis: 42.5, qty: 7 } } as unknown as Position;
    expect(await heileSchutz(VERBINDUNG, 'u1', 'XLB', pos, RISK, 'etf_sectors', 'l', f as never)).toBe('zu_frisch');
    expect(methoden(f)).toEqual(['GET']);
  });

  it('Nachfrage scheitert → unklar, nichts gesendet, kein Wurf', async () => {
    const f = folge({ ok: false, status: 500, body: 'kaputt' });
    const pos = { ...POS, schutz: { orderId: 'alt1', stopPreis: 42.5, qty: 7 } } as unknown as Position;
    await expect(heileSchutz(VERBINDUNG, 'u1', 'XLB', pos, RISK, 'etf_sectors', 'l', f as never)).resolves.toBe('unklar');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('Papier-Position (kein Broker) → gar keine Anfrage', async () => {
    const f = folge({ body: {} });
    const pos = { ...POS, broker: false } as unknown as Position;
    expect(await heileSchutz(VERBINDUNG, 'u1', 'XLB', pos, RISK, 'etf_sectors', 'l', f as never)).toBe('kein_broker');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('umkehrSchutzPruefbar: welche Positionen die Schutz-Runde anfasst', () => {
  const p = { broker: true, side: 'long', avgEntry: 50, quelle: 'umkehr', qty: 7 } as never;

  it('Umkehr-Long am Broker mit Abstand zur Notbremse → ja', () => {
    expect(umkehrSchutzPruefbar(p, 51, 'etf_sectors')).toBe(true);
    expect(umkehrSchutzPruefbar(p, 44, 'etf_sectors')).toBe(true); // 42,5 × 1,03 = 43,78
  });

  it('Kurs AN der Notbremse → nein: der Puls kann sie in derselben Sekunde verkaufen', () => {
    expect(SCHUTZ_RUNDE_ABSTAND).toBeGreaterThanOrEqual(1.02);
    expect(umkehrSchutzPruefbar(p, 43.7, 'etf_sectors')).toBe(false);
    expect(umkehrSchutzPruefbar(p, 42.5, 'etf_sectors')).toBe(false);
    expect(umkehrSchutzPruefbar(p, 40, 'etf_sectors')).toBe(false);
  });

  it('ohne Kurs, Papier, Short, Sockel, fremder Besitzer → nein', () => {
    expect(umkehrSchutzPruefbar(p, null, 'etf_sectors')).toBe(false);
    expect(umkehrSchutzPruefbar({ ...(p as object), broker: false } as never, 51, 'etf_sectors')).toBe(false);
    expect(umkehrSchutzPruefbar({ ...(p as object), side: 'short' } as never, 51, 'etf_sectors')).toBe(false);
    expect(umkehrSchutzPruefbar({ ...(p as object), core: true } as never, 51, 'etf_sectors')).toBe(false);
    expect(umkehrSchutzPruefbar({ ...(p as object), quelle: 'scan' } as never, 51, 'etf_sectors')).toBe(false);
    expect(umkehrSchutzPruefbar({ ...(p as object), qty: 0 } as never, 51, 'etf_sectors')).toBe(false);
  });

  it('die Runde ist je Konto gedeckelt (eine Nachfrage je Position)', () => {
    expect(SCHUTZ_RUNDE_MAX).toBeLessThanOrEqual(15);
  });
});

describe('Quelltext-Wächter', () => {
  const lauf = lies('scheduled', 'umkehrLauf.ts');
  const schutz = lies('core', 'schutzStop.ts');

  it('die Schutz-Runde läuft auf BEIDEN Ausgängen von fuehreAus und fängt jeden Fehler', () => {
    expect(lauf.split('await schutzRunde();').length - 1).toBe(2);
    const f = lauf.slice(lauf.indexOf('const schutzRunde = async (): Promise<void> => {'), lauf.indexOf('// 2) Käufe'));
    expect(f).toContain('} catch (err) {');
    expect(f).toContain('.filter(([sym, p]) => umkehrSchutzPruefbar(p, preis(sym), classify(sym)))');
    expect(f).toContain('.slice(0, SCHUTZ_RUNDE_MAX);');
    // sie kommt NACH Verkäufen und Nachholrunde: verkaufte Positionen sind dann aus `alle` gelöscht
    expect(lauf.indexOf('const schutzRunde = async')).toBeGreaterThan(lauf.indexOf('if (nachholen.length > 0) {'));
  });

  it('heileSchutz bucht nichts und löst keinen Link — es ruft nur schutzAnlegen', () => {
    const f = schutz.slice(schutz.indexOf('export async function heileSchutz'), schutz.indexOf('export type SchutzAufhebung'));
    expect(f).toContain("if (befund !== 'anlegen') return befund;");
    expect(f).not.toContain('posRef(');
    expect(f).not.toContain('executePaperTrade');
    expect(f).not.toContain('alpacaOrderStornieren');
  });

  it('schutzAnlegen liest die Position nach dem Warten neu (M-5)', () => {
    const f = schutz.slice(schutz.indexOf('export async function schutzAnlegen'), schutz.indexOf('export const SCHUTZ_HEIL_RUHE_MS'));
    expect(f).toContain('if (!(await posRef(uid, symbol).get()).exists) return;');
  });
});
