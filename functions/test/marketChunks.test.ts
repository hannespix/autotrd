/** Jahres-Chunking der tiefen Tages-Historie (Chart-Audit 2). */
import { describe, expect, it } from 'vitest';
import { chunkBarsByYear } from '../src/core/marketData.js';

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close, volume: 1 });

describe('chunkBarsByYear', () => {
  it('bündelt Bars je Jahr als Tages-Map ohne date-Feld', () => {
    const out = chunkBarsByYear([bar('2024-12-30', 10), bar('2025-01-02', 11), bar('2025-01-03', 12)]);
    expect([...out.keys()]).toEqual(['2024', '2025']);
    expect(out.get('2025')?.['2025-01-02']).toEqual({ open: 11, high: 11, low: 11, close: 11, volume: 1 });
    expect(Object.keys(out.get('2025') ?? {})).toHaveLength(2);
    expect((out.get('2024')?.['2024-12-30'] as Record<string, unknown>)['date']).toBeUndefined();
  });

  it('leere Eingabe → leere Map', () => {
    expect(chunkBarsByYear([]).size).toBe(0);
  });
});
