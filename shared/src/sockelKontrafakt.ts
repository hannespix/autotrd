/**
 * Gegenrechnung „Was hätte der Sockel OHNE Prozent-Marken gebracht?"
 * (Task 30, Loop #138, Red-Team 14.10.) — reine Messung, kein Schalter.
 *
 * Anlass: Der Minuten-Puls schließt Sockel-Positionen an Prozent-Stop,
 * Ziel und Trailing, obwohl Doku und Scan sagen, der Sockel habe keine
 * Stops (Task 29). 44 Sockel-Schlüsse in 7 Tagen, 0 davon am Rebalance.
 * Ob die Marken Geld SPAREN (sie fangen Abstürze ab) oder KOSTEN (sie
 * schneiden Rauschen und Gewinner ab), entscheidet diese Rechnung — mit
 * einer Regel, die VOR den Daten feststeht (`sockelEntscheidung`).
 *
 * ── Lookahead (CLAUDE.md §5, heilig) ──────────────────────────────────────
 * Verglichen wird der tatsächliche Ausstiegskurs mit dem Kurs, den die
 * Position beim NÄCHSTEN Sockel-Lauf T gehabt hätte. Bewertet wird nur,
 * wenn T strikt VOR dem Lauftag liegt (`T < heute`, dasselbe Gate wie
 * evalForecasts) — beide Endpunkte sind dann realisiert.
 *
 * ── Was die Rechnung annimmt ──────────────────────────────────────────────
 * - „Halten" heißt: bis T, mit einer Notbremse bei Einstand × (1 − 25 %).
 *   Berührt das Tagestief zwischen Ausstiegstag (einschließlich, das ist
 *   die vorsichtige Wahl) und T dieses Niveau, gilt es als Ausstieg.
 * - Kosten: Wurde der Wert bei T zurückgekauft, hat das Ausstoppen einen
 *   kompletten Roundtrip gekostet, den Halten gespart hätte. Sonst sind
 *   die Kosten in beiden Welten gleich (verkauft wird so oder so).
 * - Je Symbol und Woche EIN Wert: Alle Konten halten dieselben Sockel-
 *   Werte, sieben gespiegelte Konto-Trades sind eine Entscheidung, nicht
 *   sieben.
 */

import { classify } from './universe.js';
import { roundtripFeeRateForClass } from './strategy.js';

/** Ausstiegsgründe, die von den PROZENT-Marken stammen (Puls oder Broker-Order). */
export const SOCKEL_MARKEN_EXITS: readonly string[] = [
  'stop_loss',
  'trailing_stop',
  'take_profit',
  'trailing_stop_broker',
  'fill_sync',
];

/** Notbremse der Variante (b): 25 % unter Einstand (= RISK_LIMITS.emergencyStopPct). */
export const SOCKEL_NOTBREMSE_PCT = 25;

/** Ohne Folge-Lauf: Messpunkt = Ausstieg + so viele Kalendertage. */
export const SOCKEL_ERSATZ_TAGE = 7;

/** Ab so vielen Symbol-Wochen darf die Regel entscheiden. */
export const SOCKEL_MIN_WOCHEN = 20;

/** Ein Trade-Dokument, soweit die Rechnung es braucht. */
export interface SockelTradeRoh {
  symbol: string;
  side: 'buy' | 'sell';
  /** Ausführungszeit (ISO). */
  at: string;
  price: number;
  entryPrice?: number | null | undefined;
  riskExit?: string | null | undefined;
  /** Einstiegsweg (tradeQuelle) — 'sockel' für den Kern-Satelliten. */
  quelle?: string | null | undefined;
}

export interface SockelAusstieg {
  symbol: string;
  /** ET-Tag des Ausstiegs. */
  exitTag: string;
  exitPreis: number;
  einstand: number;
  /** ET-Tag des Messpunkts (nächster Sockel-Lauf, ersatzweise +7 Tage). */
  tagT: string;
  /** Wurde der Wert am Messpunkt vom Sockel zurückgekauft? */
  rueckkauf: boolean;
}

/** Kalendertag in New York — dieselbe Zeitzone wie die Tageskerzen. */
export function etTagVon(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

const istSockelLauf = (t: SockelTradeRoh): boolean =>
  t.quelle === 'sockel'
  && (t.side === 'buy' || t.riskExit === 'core_rebalance' || t.riskExit === 'core_aufloesung');

/**
 * Die Sockel-Ausstiege eines Kontos an Prozent-Marken, mit ihrem Messpunkt.
 * Pur; `trades` ist die Trade-Liste EINES Kontos in beliebiger Reihenfolge.
 */
export function sockelAusstiege(trades: readonly SockelTradeRoh[]): SockelAusstieg[] {
  const sortiert = [...trades]
    .filter((t) => typeof t.at === 'string' && Number.isFinite(Date.parse(t.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: SockelAusstieg[] = [];
  for (let i = 0; i < sortiert.length; i += 1) {
    const t = sortiert[i]!;
    if (t.quelle !== 'sockel' || t.side !== 'sell') continue;
    if (!t.riskExit || !SOCKEL_MARKEN_EXITS.includes(t.riskExit)) continue;
    const einstand = t.entryPrice;
    if (!(typeof einstand === 'number' && einstand > 0) || !(t.price > 0)) continue;
    const exitTag = etTagVon(t.at);
    if (!exitTag) continue;
    // Nächster Sockel-Lauf: erster Rebalance-Kauf/-Verkauf an einem SPÄTEREN Tag.
    let tagT: string | null = null;
    for (let j = i + 1; j < sortiert.length; j += 1) {
      const u = sortiert[j]!;
      const tag = etTagVon(u.at);
      if (tag && tag > exitTag && istSockelLauf(u)) {
        tagT = tag;
        break;
      }
    }
    const ersatz = etTagVon(new Date(Date.parse(t.at) + SOCKEL_ERSATZ_TAGE * 86_400_000).toISOString());
    const messTag = tagT ?? ersatz;
    if (!messTag) continue;
    const rueckkauf = tagT !== null && sortiert.some(
      (u) => u.symbol === t.symbol && u.side === 'buy' && u.quelle === 'sockel' && etTagVon(u.at) === tagT,
    );
    out.push({ symbol: t.symbol, exitTag, exitPreis: t.price, einstand, tagT: messTag, rueckkauf });
  }
  return out;
}

export interface Tageskerze {
  date: string;
  low: number;
  close: number;
}

export type SockelBewertung =
  | { stand: 'offen' }
  | { stand: 'ohne_kurse' }
  | { stand: 'bewertet'; haltenPct: number; deltaPct: number; notbremse: boolean };

const rund = (v: number): number => Math.round(v * 10_000) / 10_000;

/**
 * Ein Ausstieg gegen realisierte Tageskerzen: Was hätte Halten bis T
 * gebracht, verglichen mit dem tatsächlichen Ausstieg? `deltaPct` > 0 heißt:
 * Halten (ohne Prozent-Marken, mit Notbremse) wäre besser gewesen.
 */
export function bewerteSockelAusstieg(
  a: SockelAusstieg,
  kerzen: readonly Tageskerze[],
  heute: string,
): SockelBewertung {
  // Lookahead-Gate: Der Messtag muss abgeschlossen sein.
  if (!(a.tagT < heute)) return { stand: 'offen' };
  const pfad = kerzen
    .filter((k) => k.date >= a.exitTag && k.date <= a.tagT && k.close > 0 && k.low > 0)
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  // Messkerze: die letzte bis einschließlich T (Feiertag ⇒ Tag davor),
  // aber nach dem Ausstiegstag — sonst gäbe es nichts zu vergleichen.
  const ende = pfad.length > 0 ? pfad[pfad.length - 1]! : null;
  if (!ende || !(ende.date > a.exitTag)) return { stand: 'ohne_kurse' };
  const bremse = a.einstand * (1 - SOCKEL_NOTBREMSE_PCT / 100);
  const notbremse = pfad.some((k) => k.low <= bremse);
  const haltenPreis = notbremse ? bremse : ende.close;
  const haltenPct = (haltenPreis / a.exitPreis - 1) * 100;
  const kostenPct = a.rueckkauf ? roundtripFeeRateForClass(classify(a.symbol)) * 100 : 0;
  return { stand: 'bewertet', haltenPct: rund(haltenPct), deltaPct: rund(haltenPct + kostenPct), notbremse };
}

/** ISO-Kalenderwoche als „JJJJ-Www" — der Gruppenschlüssel je Symbol. */
export function isoWoche(tag: string): string {
  const d = new Date(`${tag}T12:00:00Z`);
  const wochentag = (d.getUTCDay() + 6) % 7; // Mo = 0
  d.setUTCDate(d.getUTCDate() - wochentag + 3); // Donnerstag derselben Woche
  const jahr = d.getUTCFullYear();
  const erster = new Date(Date.UTC(jahr, 0, 4));
  const woche = 1 + Math.round(((d.getTime() - erster.getTime()) / 86_400_000 - 3 + ((erster.getUTCDay() + 6) % 7)) / 7);
  return `${jahr}-W${String(woche).padStart(2, '0')}`;
}

export type SockelEntscheidung = 'zu_wenig' | 'ohne_marken' | 'marken_behalten' | 'unentschieden';

/**
 * Die Regel, VOR den Daten festgelegt (Red-Team 14.10.):
 *   n < 20 Symbol-Wochen            ⇒ zu_wenig (keine Aussage)
 *   80-%-Intervall ganz über 0      ⇒ ohne_marken  (Option b)
 *   80-%-Intervall ganz unter 0     ⇒ marken_behalten (a oder c)
 *   schließt 0 ein                  ⇒ unentschieden (dann Mechanismus +
 *                                     Doku-Absicht: b mit Notbremse)
 * Kein Nachjustieren mit denselben Daten.
 */
export function sockelEntscheidung(n: number, ki80: readonly [number, number] | null): SockelEntscheidung {
  if (n < SOCKEL_MIN_WOCHEN || !ki80) return 'zu_wenig';
  if (ki80[0] > 0) return 'ohne_marken';
  if (ki80[1] < 0) return 'marken_behalten';
  return 'unentschieden';
}

/**
 * Bootstrap-Intervall (10./90. Perzentil des Mittelwerts) mit festem
 * Startwert — dieselben Daten geben jeden Tag dasselbe Intervall, und ein
 * Test kann es pinnen.
 */
export function bootstrap80(werte: readonly number[], ziehungen = 2000): [number, number] | null {
  if (werte.length < 2) return null;
  let s = 0x2545f491;
  const zufall = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4_294_967_296;
  };
  const mittel: number[] = [];
  for (let z = 0; z < ziehungen; z += 1) {
    let summe = 0;
    for (let i = 0; i < werte.length; i += 1) summe += werte[Math.floor(zufall() * werte.length)]!;
    mittel.push(summe / werte.length);
  }
  mittel.sort((a, b) => a - b);
  return [rund(mittel[Math.floor(0.1 * ziehungen)]!), rund(mittel[Math.floor(0.9 * ziehungen) - 1]!)];
}

export interface SockelKontrafaktStand {
  /** Unabhängige Fälle (Symbol × Woche). */
  n: number;
  /** Bewertete Konto-Trades (je Konto gespiegelt — nur zur Einordnung). */
  nTrades: number;
  /** Davon mit Notbremse im Pfad. */
  notbremse: number;
  /** Noch nicht bewertbar (Messtag nicht vorbei). */
  offen: number;
  /** Keine passenden Kerzen. */
  ohneKurse: number;
  /** Mittel über die Symbol-Wochen: Halten minus Ausstoppen, in %. */
  mittelPct: number | null;
  ki80: [number, number] | null;
  entscheidung: SockelEntscheidung;
}

export function sockelKontrafaktStand(
  faelle: ReadonlyArray<{ a: SockelAusstieg; b: SockelBewertung }>,
): SockelKontrafaktStand {
  const gruppen = new Map<string, number[]>();
  let nTrades = 0;
  let notbremse = 0;
  let offen = 0;
  let ohneKurse = 0;
  for (const { a, b } of faelle) {
    if (b.stand === 'offen') { offen += 1; continue; }
    if (b.stand === 'ohne_kurse') { ohneKurse += 1; continue; }
    nTrades += 1;
    if (b.notbremse) notbremse += 1;
    const key = `${a.symbol}|${isoWoche(a.exitTag)}`;
    const g = gruppen.get(key) ?? [];
    g.push(b.deltaPct);
    gruppen.set(key, g);
  }
  const werte = [...gruppen.values()].map((g) => g.reduce((s, v) => s + v, 0) / g.length);
  const ki80 = bootstrap80(werte);
  return {
    n: werte.length,
    nTrades,
    notbremse,
    offen,
    ohneKurse,
    mittelPct: werte.length > 0 ? rund(werte.reduce((s, v) => s + v, 0) / werte.length) : null,
    ki80,
    entscheidung: sockelEntscheidung(werte.length, ki80),
  };
}
