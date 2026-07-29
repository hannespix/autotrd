/**
 * News-Punkte im Chart: Zeit-Abbildung + Veto-Pfeil.
 *
 * Der Mapper ist die einzige Stelle, an der News-Zeitstempel auf Bar-Zeiten
 * treffen — genau dort saßen früher die Sync-Fehler (Punkt neben dem Bar,
 * Punkt-Stapel am linken Rand). Die Tests decken beide Zeit-Domänen ab.
 */

import { describe, expect, it } from 'vitest';
import { NEWS_BEAR, NEWS_BULL, NEWS_VETO_COLOR, newsChartMarkers, newsForDay } from '../src/newsMarkers.js';
import type { NewsHeadline, NewsSnapshot } from '@autotrd/shared';

const NOW = 1_753_770_000;
const DAY = (off: number): string => new Date((NOW + off) * 1000).toISOString().slice(0, 10);

const head = (ageSec: number, sentiment: number, magnitude = 0.5): NewsHeadline => ({
  title: 't',
  source: 's',
  url: 'https://example.com',
  ts: '',
  published: NOW - ageSec,
  sentiment,
  magnitude,
  eventTypes: [],
});

const snap = (top: NewsHeadline[], hardEvent: NewsSnapshot['hardEvent'] = null): Pick<NewsSnapshot, 'top' | 'hardEvent'> => ({
  top,
  hardEvent,
});

describe('newsChartMarkers', () => {
  const dailyTimes = [DAY(-3 * 86400), DAY(-2 * 86400), DAY(-86400), DAY(0)];

  it('leer bei fehlendem Snapshot oder leeren Bars', () => {
    expect(newsChartMarkers(null, dailyTimes, NOW)).toEqual([]);
    expect(newsChartMarkers(snap([head(100, 1)]), [], NOW)).toEqual([]);
  });

  it('Tages-Sicht: Schlagzeile landet am Tages-Bar, Farbe folgt dem Sentiment', () => {
    const m = newsChartMarkers(snap([head(3600, 0.5)]), dailyTimes, NOW);
    expect(m).toHaveLength(1);
    expect(m[0]!.time).toBe(DAY(0));
    expect(m[0]!.color).toBe(NEWS_BULL);
    expect(newsChartMarkers(snap([head(3600, -0.5)]), dailyTimes, NOW)[0]!.color).toBe(NEWS_BEAR);
  });

  it('Intraday-Sicht: erster Bar AB Veröffentlichung — nie davor', () => {
    const times = [NOW - 900, NOW - 600, NOW - 300];
    const m = newsChartMarkers(snap([head(650, 0)]), times, NOW); // publ. zwischen Bar 1 und 2
    expect(m[0]!.time).toBe(NOW - 600);
  });

  it('nach Handelsschluss: letzter Bar; VOR dem Fenster: gar keiner', () => {
    const times = [NOW - 900, NOW - 600];
    expect(newsChartMarkers(snap([head(100, 0)]), times, NOW)[0]!.time).toBe(NOW - 600);
    expect(newsChartMarkers(snap([head(5000, 0)]), times, NOW)).toEqual([]);
  });

  it('mehrere Schlagzeilen am selben Bar werden EIN Punkt — stärkste Wortwahl färbt', () => {
    const m = newsChartMarkers(
      snap([head(3600, 0.9, 0.2), head(7200, -0.9, 0.8)]),
      dailyTimes,
      NOW,
    );
    expect(m).toHaveLength(1);
    expect(m[0]!.color).toBe(NEWS_BEAR);
  });

  it('aktives Veto ⇒ gelber Pfeil; abgelaufenes Veto ⇒ keiner', () => {
    const ev = { type: 'earnings', magnitude: 0.8, published: NOW - 3600, title: 'x' };
    const aktiv = newsChartMarkers(snap([], ev), dailyTimes, NOW);
    expect(aktiv).toHaveLength(1);
    expect(aktiv[0]!.color).toBe(NEWS_VETO_COLOR);
    expect(aktiv[0]!.text).toBe('Veto');
    const alt = { ...ev, published: NOW - 13 * 3600 };
    expect(newsChartMarkers(snap([], alt), dailyTimes, NOW)).toEqual([]);
  });

  it('Marker sind aufsteigend sortiert (LWC-Anforderung)', () => {
    const m = newsChartMarkers(
      snap([head(3600, 0.5), head(2 * 86400 + 3600, -0.5)]),
      dailyTimes,
      NOW,
    );
    expect(m.map((x) => x.time)).toEqual([...m.map((x) => x.time)].sort());
  });
});

describe('newsForDay (Crosshair-Overlay)', () => {
  it('liefert nur die Schlagzeilen DES Tages, neueste zuerst', () => {
    const s = snap([head(3600, 0.5), head(7200, -0.2), head(2 * 86400, 0.9)]);
    const d = newsForDay(s, DAY(0), NOW);
    expect(d).not.toBeNull();
    expect(d!.items.map((i) => i.published)).toEqual([NOW - 3600, NOW - 7200]);
    expect(d!.veto).toBe(false);
  });

  it('Tag ohne Schlagzeilen und ohne Veto ⇒ null — das Overlay bleibt zu', () => {
    expect(newsForDay(snap([head(3600, 0.5)]), DAY(-2 * 86400), NOW)).toBeNull();
    expect(newsForDay(null, DAY(0), NOW)).toBeNull();
    expect(newsForDay(snap([head(3600, 0.5)]), null, NOW)).toBeNull();
  });

  it('aktives Veto markiert genau den Ereignis-Tag', () => {
    const ev = { type: 'legal', magnitude: 0.8, published: NOW - 3600, title: 'x' };
    expect(newsForDay(snap([], ev), DAY(0), NOW)!.veto).toBe(true);
    // abgelaufen ⇒ Tag ist wieder frei (und ohne Items ⇒ null)
    const alt = { ...ev, published: NOW - 13 * 3600 };
    expect(newsForDay(snap([], alt), utcDayOf(alt.published), NOW)).toBeNull();
  });

  it('Tages-Sentiment ist magnitude-gewichtet', () => {
    const stark = head(3600, -0.8, 1);
    const schwach = head(7200, 0.8, 0.1);
    const d = newsForDay(snap([stark, schwach]), DAY(0), NOW);
    expect(d!.sentiment).toBeLessThan(0);
  });
});

const utcDayOf = (published: number): string => new Date(published * 1000).toISOString().slice(0, 10);
