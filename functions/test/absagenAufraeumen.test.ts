/** Task 21: Absage-Tagesdocs älter als ABSAGE_TAGE werden geräumt. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ FieldPath: { documentId: () => '__id__' } }));
const { absagenAufraeumen, absagenGrenze } = await import('../src/core/absagen.js');

describe('absagenAufraeumen', () => {
  it('Grenze = heute − 14 Tage (lexikografisch wie die Doc-IDs)', () => {
    expect(absagenGrenze(new Date('2026-10-20T12:00:00Z'))).toBe('2026-10-06');
  });

  it('löscht nur Docs VOR der Grenze, höchstens 30 je Lauf', async () => {
    const ids = ['2026-09-30', '2026-10-05', '2026-10-06', '2026-10-19'];
    const geloescht: string[] = [];
    let filter: [string, string, string] | null = null;
    let limit = 0;
    const query = {
      where: (f: string, op: string, w: string) => { filter = [f, op, w]; return query; },
      limit: (n: number) => { limit = n; return query; },
      get: async () => {
        const docs = ids.filter((id) => id < filter![2]).map((id) => ({ ref: { id } }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
    const userRef = {
      collection: (name: string) => { expect(name).toBe('absagen'); return query; },
      firestore: { batch: () => ({ delete: (r: { id: string }) => geloescht.push(r.id), commit: async () => undefined }) },
    };
    const n = await absagenAufraeumen(userRef as never, new Date('2026-10-20T12:00:00Z'));
    expect(filter).toEqual(['__id__', '<', '2026-10-06']);
    expect(limit).toBe(30);
    expect(n).toBe(2);
    expect(geloescht).toEqual(['2026-09-30', '2026-10-05']);
  });
});
