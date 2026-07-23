/**
 * Tests der puren KI-Staffel-Anteile: JSON-Extraktion, regelbasierter
 * Fallback (Stufe 0) und die Token-Zählung des Kosten-Guards.
 */
import { describe, expect, it } from 'vitest';
import { extractJson, ruleBasedDaySummary, usageTokens } from '../src/core/ai.js';
import type { NewsItem } from '../src/core/news.js';

function item(title: string, sentiment: number, magnitude: number): NewsItem {
  return {
    title,
    source: 'Test',
    url: 'https://example.com',
    ts: '2026-07-22T12:00:00.000Z',
    published: 1_784_000_000,
    summary: '',
    kind: 'news',
    sent: { sentiment, label: 'neutral', magnitude, eventTypes: [], hits: [] },
  };
}

describe('extractJson', () => {
  it('zieht das JSON auch aus Prosa-Antworten', () => {
    expect(extractJson('Klar: {"a": 1} fertig.')).toEqual({ a: 1 });
  });
  it('kaputtes/fehlendes JSON → null', () => {
    expect(extractJson('{"a": ')).toBeNull();
    expect(extractJson('gar nichts')).toBeNull();
    expect(extractJson(null)).toBeNull();
    expect(extractJson(undefined)).toBeNull();
  });
});

describe('ruleBasedDaySummary — Stufe-0-Fallback', () => {
  it('wählt die Schlagzeile mit höchstem |Sentiment| + Magnitude', () => {
    const res = ruleBasedDaySummary([
      item('leise Notiz', 0.1, 0.1),
      item('Kurssturz nach Zahlen', -0.8, 0.9),
      item('mittlere Meldung', 0.4, 0.3),
    ]);
    expect(res.headline).toBe('Kurssturz nach Zahlen');
    expect(res.summary).toContain('negativ');
    expect(res.summary).toContain('Kurssturz nach Zahlen');
  });

  it('positives Top-Item wird als positiv gelabelt', () => {
    const res = ruleBasedDaySummary([item('Rally nach Earnings-Beat', 0.7, 0.6)]);
    expect(res.summary).toContain('positiv');
  });

  it('leere Liste → neutraler Text ohne Headline', () => {
    const res = ruleBasedDaySummary([]);
    expect(res.headline).toBeNull();
    expect(res.summary).toContain('Keine Schlagzeilen');
  });
});

describe('usageTokens — Kosten-Guard-Zählung', () => {
  it('summiert Input + Output + Cache-Aufbau voll, Cache-Reads mit 10 %', () => {
    expect(
      usageTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 200,
      }),
    ).toBe(100 + 50 + 30 + 20);
  });
  it('fehlende Felder/undefined → 0', () => {
    expect(usageTokens(undefined)).toBe(0);
    expect(usageTokens({})).toBe(0);
    expect(usageTokens({ input_tokens: 10, cache_read_input_tokens: null })).toBe(10);
  });
});
