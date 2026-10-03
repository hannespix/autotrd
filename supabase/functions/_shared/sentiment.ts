/**
 * Lexikon-Sentiment — Port von reference/scripts/sentiment.py.
 * Regelbasierte Stufe 0 der KI-Staffel (ARCHITECTURE §6): schnell, gratis,
 * filtert 90 % — LLM-Eskalation kommt obendrauf (M6-Teil 2).
 * Pure Funktionen, identisch nutzbar in Functions und Frontend.
 */

const BULL: Record<string, number> = {
  beat: 2, beats: 2, surge: 3, surges: 3, soar: 3, soars: 3, jump: 2,
  jumps: 2, rally: 2, rallies: 2, record: 2, upgrade: 3, upgraded: 3,
  outperform: 2, buy: 1, strong: 2, growth: 1, profit: 1, gains: 2,
  gain: 1, raises: 2, raised: 2, boost: 2, boosts: 2, bullish: 3,
  breakout: 2, top: 1, tops: 2, wins: 2, win: 1, approval: 2,
  approved: 2, expansion: 1, buyback: 2, dividend: 1, partnership: 1,
  milestone: 1, optimism: 2, rebound: 2, momentum: 1, 'all-time high': 3,
};
const BEAR: Record<string, number> = {
  miss: 2, misses: 2, plunge: 3, plunges: 3, crash: 3, crashes: 3,
  slump: 2, slumps: 2, fall: 1, falls: 2, drop: 2, drops: 2, sink: 2,
  sinks: 2, downgrade: 3, downgraded: 3, underperform: 2, sell: 1,
  weak: 2, loss: 2, losses: 2, cuts: 2, cut: 1, warning: 2, warns: 2,
  bearish: 3, lawsuit: 2, sued: 2, probe: 2, investigation: 2, fraud: 3,
  recall: 2, layoffs: 2, bankruptcy: 3, default: 3, slowdown: 2,
  decline: 2, declines: 2, tumble: 3, tumbles: 3, selloff: 3, fears: 2,
  concern: 1, concerns: 1, halt: 2, halted: 2, delay: 1, delays: 1,
};

const EVENT_PATTERNS: Array<[RegExp, string, number]> = [
  [/\bearnings?\b|\bq[1-4]\b|\bquarter(ly)?\b|\bresults\b|\beps\b|\brevenue\b/, 'earnings', 3],
  [/\bupgrade[ds]?\b|\bdowngrade[ds]?\b|\bprice target\b|\banalyst\b|\brating\b/, 'analyst', 2],
  [/\bmerger\b|\bacqui|\bbuyout\b|\btakeover\b|\bdeal\b|\bstake\b/, 'm&a', 3],
  [/\blawsuit\b|\bsued?\b|\bprobe\b|\binvestigat|\bsec\b|\bregulat|\bantitrust\b|\bfine\b/, 'legal', 2],
  [/\bguidance\b|\boutlook\b|\bforecast\b|\bwarns?\b|\bwarning\b/, 'guidance', 3],
  [/\bceo\b|\bcfo\b|\bexecutive\b|\bresign|\bappoint|\bfires?\b|\bsteps down\b/, 'leadership', 2],
  [/\bproduct\b|\blaunch\b|\bunveil|\brelease[ds]?\b|\bpartnership\b|\bcontract\b/, 'product', 1],
  [/\bfda\b|\bapproval\b|\btrial\b|\bpatent\b/, 'regulatory', 2],
  [/\bdividend\b|\bbuyback\b|\bsplit\b|\bspin-?off\b/, 'capital', 1],
  [/\bfed\b|\brate[s]?\b|\binflation\b|\bcpi\b|\btariff|\bgdp\b|\bjobs report\b/, 'macro', 2],
];

const WORD = /[a-z][a-z'&-]+/g;

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export interface SentimentScore {
  sentiment: number; // -1..1
  label: 'bullish' | 'bearish' | 'neutral';
  magnitude: number; // 0..1
  eventTypes: string[];
  hits: string[];
}

/** Port von score_text — identische Gewichte, Schwellen und Rundungen. */
export function scoreText(text: string): SentimentScore {
  const t = (text || '').toLowerCase();
  const words = t.match(WORD) ?? [];
  let pos = 0;
  let neg = 0;
  const hits: string[] = [];
  for (const w of words) {
    if (BULL[w] !== undefined) {
      pos += BULL[w];
      hits.push('+' + w);
    } else if (BEAR[w] !== undefined) {
      neg += BEAR[w];
      hits.push('-' + w);
    }
  }
  if (t.includes('all-time high')) {
    pos += 3;
    hits.push('+all-time high');
  }

  const eventTypes: string[] = [];
  for (const [pat, label] of EVENT_PATTERNS) {
    if (pat.test(t)) eventTypes.push(label);
  }

  const total = pos + neg;
  const raw = total ? (pos - neg) / total : 0;
  const magnitude = Math.min(1, total / 6);
  const label = raw > 0.15 ? 'bullish' : raw < -0.15 ? 'bearish' : 'neutral';
  return {
    sentiment: round3(raw),
    label,
    magnitude: round3(magnitude),
    eventTypes,
    hits: hits.slice(0, 8),
  };
}

export interface ScoredItem {
  kind?: string;
  ups?: number;
  sent: SentimentScore;
}

export interface SentimentAggregate {
  overall: number;
  label: 'bullish' | 'bearish' | 'neutral';
  n: number;
  bullish: number;
  bearish: number;
  neutral: number;
  topEvents: Array<{ type: string; count: number }>;
}

/** Port von aggregate — Magnitude-Gewichtung + Social-Nudge. */
export function aggregateSentiment(items: ScoredItem[]): SentimentAggregate {
  if (items.length === 0) {
    return { overall: 0, label: 'neutral', n: 0, bullish: 0, bearish: 0, neutral: 0, topEvents: [] };
  }
  let num = 0;
  let den = 0;
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  const evCounter = new Map<string, number>();
  for (const it of items) {
    const s = it.sent;
    let w = 0.4 + s.magnitude;
    if (it.kind === 'social') w += Math.min(0.5, (it.ups ?? 0) / 500);
    num += s.sentiment * w;
    den += w;
    counts[s.label] += 1;
    for (const et of s.eventTypes) evCounter.set(et, (evCounter.get(et) ?? 0) + 1);
  }
  const overall = den ? num / den : 0;
  const topEvents = [...evCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));
  return {
    overall: round3(overall),
    label: overall > 0.12 ? 'bullish' : overall < -0.12 ? 'bearish' : 'neutral',
    n: items.length,
    bullish: counts.bullish,
    bearish: counts.bearish,
    neutral: counts.neutral,
    topEvents,
  };
}
