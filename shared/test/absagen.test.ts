/** Task 21, Phase 2: „Warum NICHT gekauft" — Sammeln, Schreibfeld, Lesen. */
import { describe, expect, it } from 'vitest';
import { ABSAGE_GRUENDE, absageGespeichert, absageMerken, absagenAusTag, absagenFeld, type AbsageMerk } from '../src/absagen.js';

describe('absageMerken', () => {
  it('je Symbol und Scan EIN Eintrag — der erste Grund zählt', () => {
    const m = new Map<string, AbsageMerk>();
    absageMerken(m, 'AAPL', 'long', 'pos_limit', 'konfluenz', { offen: 5, limit: 5 });
    absageMerken(m, 'AAPL', 'long', 'unter_kosten', 'konfluenz', { erwartetPct: 0.4 });
    expect(m.size).toBe(1);
    expect(m.get('AAPL')).toMatchObject({ grund: 'pos_limit', z: { offen: 5, limit: 5, erwartetPct: null } });
  });

  it('verwirft unbekannte Gründe und kaputte Symbole, rundet Zahlen', () => {
    const m = new Map<string, AbsageMerk>();
    absageMerken(m, '..', 'long', 'pos_limit', 'konfluenz');
    absageMerken(m, 'AAPL', 'long', 'erfunden' as never, 'konfluenz');
    absageMerken(m, 'BTC-USD', 'short', 'unter_kosten', 'regelbaum', { erwartetPct: 0.41234, noetigPct: 0.9, regime: 'Stress!' });
    expect([...m.keys()]).toEqual(['BTC-USD']);
    expect(m.get('BTC-USD')!.z).toMatchObject({ erwartetPct: 0.41, noetigPct: 0.9, regime: null });
  });
});

describe('absagenFeld', () => {
  it('z steht IMMER vollständig (merge mischt sonst alte Zahlen unter), Zähler über increment', () => {
    const m = new Map<string, AbsageMerk>();
    absageMerken(m, 'AAPL', 'long', 'cooldown_aktiv', 'konfluenz', { cooldownMin: 30 });
    const f = absagenFeld(m, '2026-10-09', '2026-10-09T15:00:00.000Z', (n) => ({ inc: n }));
    const e = (f['s'] as Record<string, Record<string, unknown>>)['AAPL']!;
    expect(Object.keys(e['z'] as object).sort()).toEqual(['cooldownMin', 'erwartetPct', 'kostenPct', 'limit', 'noetigPct', 'offen', 'regime', 'steckbriefN', 'steckbriefT']);
    expect(e['n']).toEqual({ inc: 1 });
    expect(e['je']).toEqual({ cooldown_aktiv: { inc: 1 } });
    expect(f).toMatchObject({ v: 1, tag: '2026-10-09' });
    expect(JSON.stringify(f)).not.toMatch(/uid|reason|exception/);
  });
});

describe('absageGespeichert / absagenAusTag', () => {
  it('liest nur die Whitelist, jüngste zuerst, Unbekanntes fällt weg', () => {
    const tag = {
      s: {
        AAPL: { grund: 'unter_kosten', seite: 'long', weg: 'konfluenz', zuletzt: '2026-10-09T14:00:00.000Z', n: 7, je: { unter_kosten: 6, pos_limit: 1, erfunden: 3 }, z: { erwartetPct: 0.4, noetigPct: 0.9, geheim: 'x' }, extra: '<script>' },
        MSFT: { grund: 'news_veto', seite: 'long', weg: 'regelbaum', zuletzt: '2026-10-09T15:00:00.000Z', n: 1 },
        KAPUTT: { grund: 'gibtsnicht', zuletzt: '2026-10-09T15:00:00.000Z' },
      },
    };
    const l = absagenAusTag(tag);
    expect(l.map((e) => e.symbol)).toEqual(['MSFT', 'AAPL']);
    expect(l[1]).toMatchObject({ n: 7, je: { unter_kosten: 6, pos_limit: 1 }, z: { erwartetPct: 0.4, noetigPct: 0.9 } });
    expect(JSON.stringify(l)).not.toMatch(/geheim|script|erfunden/);
    expect(absageGespeichert('X', null)).toBeNull();
  });

  it('jeder Grund der Liste ist ein entrySperre-/Bremsen-Code (keine Freitexte)', () => {
    for (const g of ABSAGE_GRUENDE) expect(g).toMatch(/^[a-z_]+$/);
  });
});
