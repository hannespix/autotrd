/**
 * News-Gate: Aggregation + Einstiegs-Veto.
 *
 * Die gefährlichste Fehlform dieses Moduls ist ein Veto, das nie abläuft
 * oder auf Routine-Berichterstattung feuert — dann steht die Engine still
 * und die Telemetrie zeigt nur „keine Trades", was exakt wie ein ruhiger
 * Markt aussieht. Die Tests decken deshalb vor allem die NICHT-Block-Fälle.
 */

import { describe, expect, it } from 'vitest';
import {
  NEWS_VETO_MIN_MAGNITUDE,
  NEWS_VETO_WINDOW_SEC,
  buildNewsSnapshot,
  newsVeto,
  type ScoredNewsItem,
} from '../src/newsGate.js';
import { scoreText } from '../src/sentiment.js';

const NOW = 1_753_770_000; // fester Bezugspunkt — Tests sind uhrunabhängig

const item = (title: string, ageSec: number, over: Partial<ScoredNewsItem> = {}): ScoredNewsItem => ({
  title,
  source: 'Test',
  url: 'https://example.com/a',
  ts: new Date((NOW - ageSec) * 1000).toISOString(),
  published: NOW - ageSec,
  sent: scoreText(title),
  ...over,
});

describe('buildNewsSnapshot', () => {
  it('leere Liste ⇒ neutraler Snapshot ohne Hard-Event', () => {
    const s = buildNewsSnapshot([], NOW);
    expect(s.n).toBe(0);
    expect(s.sentiment).toBe(0);
    expect(s.hardEvent).toBeNull();
    expect(s.top).toEqual([]);
  });

  it('Items ohne Zeitstempel zählen nicht — undatiert kann kein Veto begründen', () => {
    const s = buildNewsSnapshot(
      [item('Company misses earnings estimates, shares plunge', 3600, { published: 0, ts: '' })],
      NOW,
    );
    expect(s.n).toBe(0);
    expect(s.hardEvent).toBeNull();
  });

  it('veraltete Items (> 24 h) fallen aus dem Aggregat', () => {
    const s = buildNewsSnapshot(
      [item('Company misses earnings estimates, shares plunge', 25 * 3600)],
      NOW,
    );
    expect(s.n).toBe(0);
    expect(s.hardEvent).toBeNull();
  });

  it('ein scharfes Earnings-Item wird zum Hard-Event', () => {
    const s = buildNewsSnapshot(
      [item('ACME misses earnings estimates, shares plunge', 2 * 3600)],
      NOW,
    );
    expect(s.hardEvent).not.toBeNull();
    expect(s.hardEvent!.type).toBe('earnings');
    expect(s.hardEvent!.magnitude).toBeGreaterThanOrEqual(NEWS_VETO_MIN_MAGNITUDE);
  });

  it('Routine-Berichterstattung OHNE wertende Wörter wird KEIN Hard-Event', () => {
    // „earnings" als Event-Muster allein reicht nicht — sonst stünde AAPL
    // (über das ständig geschrieben wird) dauerhaft unter Veto.
    const s = buildNewsSnapshot(
      [item('What to expect from the company quarterly earnings call', 2 * 3600)],
      NOW,
    );
    expect(s.eventTypes).toContain('earnings');
    expect(s.hardEvent).toBeNull();
  });

  it('weiche Eventtypen (analyst/macro) werden nie zum Hard-Event', () => {
    const s = buildNewsSnapshot(
      [item('Analyst upgrades price target after strong rally momentum', 3600)],
      NOW,
    );
    expect(s.hardEvent).toBeNull();
  });

  it('Event-Wörter NUR in der Zusammenfassung machen kein Hard-Event', () => {
    // Der Live-Fund vom 29.07.: Ein Kommentar über 52-Wochen-Hochs erwähnte
    // im Fließtext revenue/earnings — mit scharfer Wortwahl im Titel wäre
    // AAPL dauerhaft gesperrt gewesen. Ereignisse stehen in Schlagzeilen.
    const kommentar = item('Shares surge and jump to record all-time high', 3600);
    kommentar.sent = scoreText(
      'Shares surge and jump to record all-time high . strong quarterly earnings and revenue beat expectations',
    );
    kommentar.titleEvents = scoreText('Shares surge and jump to record all-time high').eventTypes;
    const s = buildNewsSnapshot([kommentar], NOW);
    expect(s.magnitude).toBeGreaterThan(0.5); // Wortwahl ist stark …
    expect(s.hardEvent).toBeNull(); // … aber ohne Ereignis im Titel kein Veto
    // Gegenprobe: steht das Ereignis im TITEL, greift es
    const echt = item('ACME misses earnings estimates, shares plunge', 3600);
    echt.titleEvents = scoreText(echt.title).eventTypes;
    expect(buildNewsSnapshot([echt], NOW).hardEvent).not.toBeNull();
  });

  it('das schärfste Event gewinnt, nicht das neueste', () => {
    const s = buildNewsSnapshot(
      [
        item('CEO steps down amid probe, shares fall', 1 * 3600),
        item('ACME misses earnings, stock plunges after downgrade and lawsuit fears', 5 * 3600),
      ],
      NOW,
    );
    expect(s.hardEvent!.type).toBe('earnings');
    expect(s.hardEvent!.published).toBe(NOW - 5 * 3600);
  });

  it('Sentiment-Schnitt trägt das Vorzeichen der Mehrheit', () => {
    const bull = buildNewsSnapshot(
      [item('Shares surge after record profit, guidance raised', 3600)],
      NOW,
    );
    const bear = buildNewsSnapshot(
      [item('Stock plunges on bankruptcy fears and layoffs warning', 3600)],
      NOW,
    );
    expect(bull.sentiment).toBeGreaterThan(0);
    expect(bear.sentiment).toBeLessThan(0);
  });

  it('top ist auf 5 frischeste begrenzt', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`Story number ${i} gains`, (i + 1) * 600));
    const s = buildNewsSnapshot(items, NOW);
    expect(s.top).toHaveLength(5);
    expect(s.top[0]!.published).toBeGreaterThan(s.top[4]!.published);
  });
});

describe('newsVeto', () => {
  const hardSnap = buildNewsSnapshot(
    [item('ACME misses earnings estimates, shares plunge', 2 * 3600)],
    NOW,
  );

  it('frisches Hard-Event blockt — mit Ereignistyp als Begründung', () => {
    expect(newsVeto(hardSnap, NOW)).toEqual({ blocked: true, type: 'earnings' });
  });

  it('kein Snapshot / kein Hard-Event ⇒ normal handeln (fails open)', () => {
    expect(newsVeto(null, NOW).blocked).toBe(false);
    expect(newsVeto(undefined, NOW).blocked).toBe(false);
    expect(newsVeto(buildNewsSnapshot([], NOW), NOW).blocked).toBe(false);
  });

  it('das Veto LÄUFT AB — nach dem Fenster ist das Symbol wieder frei', () => {
    // Der wichtigste Test des Moduls: Ein Veto ohne Ablauf wäre eine
    // Dauerabschaltung, die in der Telemetrie wie ein ruhiger Markt aussieht.
    const after = NOW + NEWS_VETO_WINDOW_SEC + 1;
    expect(newsVeto(hardSnap, after).blocked).toBe(false);
  });

  it('exakt an der Fenstergrenze blockt es noch', () => {
    const ev = hardSnap.hardEvent!;
    expect(newsVeto(hardSnap, ev.published + NEWS_VETO_WINDOW_SEC).blocked).toBe(true);
  });

  it('ein manipulierter Snapshot unter der Magnitude-Schwelle blockt nicht', () => {
    // Defensiv: buildNewsSnapshot erzeugt so etwas nicht, aber der Snapshot
    // liegt in Firestore — die Prüfung gehört auch in den Leser.
    const s = { hardEvent: { type: 'earnings', magnitude: 0.2, published: NOW - 100, title: 'x' } };
    expect(newsVeto(s, NOW).blocked).toBe(false);
  });
});
