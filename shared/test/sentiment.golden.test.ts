/**
 * Golden-Parity Sentiment: TS-Port vs. Python-Referenz (sentiment.py).
 * Identische Scores, Labels, Event-Tags und Aggregation.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregateSentiment, scoreText } from '../src/sentiment.js';

const fx = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../reference/golden/sentiment.json'),
    'utf8',
  ),
) as {
  cases: Array<{
    text: string;
    sentiment: number;
    label: string;
    magnitude: number;
    event_types: string[];
    hits: string[];
  }>;
  aggregate: {
    overall: number;
    label: string;
    n: number;
    bullish: number;
    bearish: number;
    neutral: number;
    top_events: Array<{ type: string; count: number }>;
  };
};

describe('Sentiment-Golden-Parity', () => {
  it('scoreText matcht alle Python-Fälle exakt', () => {
    for (const c of fx.cases) {
      const r = scoreText(c.text);
      const label = c.text.slice(0, 40) || '(leer)';
      expect(r.sentiment, `${label}: sentiment`).toBeCloseTo(c.sentiment, 9);
      expect(r.label, `${label}: label`).toBe(c.label);
      expect(r.magnitude, `${label}: magnitude`).toBeCloseTo(c.magnitude, 9);
      expect(r.eventTypes, `${label}: events`).toEqual(c.event_types);
      expect(r.hits, `${label}: hits`).toEqual(c.hits);
    }
  });

  it('aggregateSentiment matcht die Python-Aggregation', () => {
    const items = [
      { kind: 'news', sent: scoreText(fx.cases[0]!.text) },
      { kind: 'social', ups: 400, sent: scoreText(fx.cases[1]!.text) },
      { kind: 'news', sent: scoreText(fx.cases[3]!.text) },
    ];
    const a = aggregateSentiment(items);
    expect(a.overall).toBeCloseTo(fx.aggregate.overall, 9);
    expect(a.label).toBe(fx.aggregate.label);
    expect(a.n).toBe(fx.aggregate.n);
    expect({ bullish: a.bullish, bearish: a.bearish, neutral: a.neutral }).toEqual({
      bullish: fx.aggregate.bullish,
      bearish: fx.aggregate.bearish,
      neutral: fx.aggregate.neutral,
    });
    expect(a.topEvents).toEqual(fx.aggregate.top_events.map(({ type, count }) => ({ type, count })));
  });
});
