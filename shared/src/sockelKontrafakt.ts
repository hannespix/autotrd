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
 * Verglichen wird der tatsächliche Ausstieg mit dem Wert, den die Position
 * beim ersten Sockel-Lauf NACH dem Ausstieg gehabt hätte (Tag T).
 * Bewertet wird nur, wenn T strikt VOR dem Lauftag liegt (`T < heute`,
 * dasselbe Gate wie evalForecasts) — beide Endpunkte sind realisiert.
 *
 * ── Zweite Fassung nach dem Red-Team der Messung (15.10.) ─────────────────
 * Die erste Fassung hatte kein Lookahead-Leck, schob die Zahl aber
 * einseitig Richtung „ohne Marken". Korrigiert:
 *   F1  Notbremse füllt bei einer Kurslücke zum Eröffnungskurs, nicht zum
 *       Bremskurs; lag der echte Ausstieg schon unter der Bremse, sind
 *       beide Welten draußen (Delta 0).
 *   F2  Der Lauf ist der erste NACH dem Ausstiegs-ZEITPUNKT — auch am
 *       selben Tag (Konten ohne Broker laufen 18:00 ET). Rückkauf = erster
 *       Sockel-Kauf des Symbols in genau diesem Lauf, gemessen an seinem
 *       eigenen Preis (R2).
 *   V1  Brutto gegen Brutto: Ausstieg = Broker-Fill bzw. Rohkurs, nicht
 *       der Netto-Effektivpreis; Gebühren nur, wo sie sich nicht aufheben.
 *   V2  Robustheit: zweite Rechnung mit Reibung je Bein; entschieden wird
 *       nur, wenn beide Rechnungen dasselbe sagen.
 *   V3  Block-Bootstrap über Kalenderwochen (alle Sockel-Werte einer Woche
 *       teilen den Marktschock) und mindestens 8 verschiedene Wochen.
 *   V4  Die Entscheidung wird einmal eingefroren (Aufrufer: write-once).
 *   V5  Nur Ausstiege ab `SOCKEL_MESSUNG_AB` — die 44 Fälle, die die
 *       Hypothese ausgelöst haben, zählen nicht.
 *   V6  `fill_sync` getrennt: Er stempelt auch nachgebuchte Rebalance-
 *       Verkäufe und ist deshalb kein sicherer Marken-Ausstieg.
 *   V7  Fehlen Kerzen nahe am Ausstieg, ist der Fall `ohne_kurse`; zu
 *       viele solcher Fälle sperren die Entscheidung (Survivorship).
 *   R4  T = früherer von „nächster Lauf" und „Ausstieg + 7 Tage" — ein
 *       einmal bewerteter Fall springt später nicht auf ein anderes T.
 *
 * Je Symbol und Woche EIN Wert: Alle Konten halten dieselben Sockel-Werte,
 * sieben gespiegelte Konto-Trades sind eine Entscheidung, nicht sieben.
 */

import { classify } from './universe.js';
import { roundtripFeeRateForClass } from './strategy.js';

/** Ausstiegsgründe, die sicher von den PROZENT-Marken stammen (Puls oder Broker-Order). */
export const SOCKEL_MARKEN_EXITS: readonly string[] = [
  'stop_loss',
  'trailing_stop',
  'take_profit',
  'trailing_stop_broker',
];

/** Nachgebuchte Verkäufe — Marke ODER Rebalance, nicht unterscheidbar (V6). */
export const SOCKEL_UNKLAR_EXITS: readonly string[] = ['fill_sync'];

/** Notbremse der Variante (b): 25 % unter Einstand (= RISK_LIMITS.emergencyStopPct). */
export const SOCKEL_NOTBREMSE_PCT = 25;

/** Ohne früheren Lauf: Messpunkt = Ausstieg + so viele Kalendertage. */
export const SOCKEL_ERSATZ_TAGE = 7;

/** Ab so vielen Symbol-Wochen … */
export const SOCKEL_MIN_WOCHEN = 20;
/** … aus so vielen verschiedenen Kalenderwochen darf die Regel entscheiden. */
export const SOCKEL_MIN_KALENDERWOCHEN = 8;

/** Erst Ausstiege ab diesem ET-Tag (V5: die auslösenden Fälle zählen nicht). */
export const SOCKEL_MESSUNG_AB = '2026-10-16';

/** Robustheits-Reibung je Bein in % (V2) — Kleinwerte: gemessen Ø 83 bp Einstieg. */
export const SOCKEL_REIBUNG_PCT = 0.5;

/** Mehr als dieser Anteil ohne Kurse sperrt die Entscheidung (V7). */
export const SOCKEL_MAX_OHNE_KURSE = 0.1;

/** Erste Pfad-Kerze höchstens so viele Kalendertage nach dem Ausstieg (V7). */
export const SOCKEL_MAX_KERZEN_LUECKE_TAGE = 3;

/** Ein Trade-Dokument, soweit die Rechnung es braucht. */
export interface SockelTradeRoh {
  symbol: string;
  side: 'buy' | 'sell';
  /** Ausführungszeit (ISO). */
  at: string;
  /** Effektivpreis inkl. Gebühr/Slippage (`price`). */
  price: number;
  /** Rohkurs der Entscheidung (`rawPrice`). */
  rawPrice?: number | null | undefined;
  /** Echter Broker-Fill (`brokerFillPrice`). */
  brokerFillPrice?: number | null | undefined;
  entryPrice?: number | null | undefined;
  riskExit?: string | null | undefined;
  /** Einstiegsweg (tradeQuelle) — 'sockel' für den Kern-Satelliten. */
  quelle?: string | null | undefined;
}

export interface SockelAusstieg {
  symbol: string;
  /** Ausstiegszeit (ISO) und ihr ET-Tag. */
  exitAt: string;
  exitTag: string;
  /** Brutto-Ausstiegskurs (Broker-Fill, sonst Rohkurs, sonst Effektivpreis). */
  exitPreis: number;
  einstand: number;
  /** ET-Tag des Messpunkts. */
  tagT: string;
  /** Brutto-Preis des Rückkaufs im Lauf T — sonst null (dann Schlusskurs T). */
  rueckkaufPreis: number | null;
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

const brutto = (t: SockelTradeRoh): number => {
  for (const p of [t.brokerFillPrice, t.rawPrice, t.price]) if (typeof p === 'number' && p > 0) return p;
  return 0;
};

const istSockelLauf = (t: SockelTradeRoh): boolean =>
  t.quelle === 'sockel'
  && (t.side === 'buy' || t.riskExit === 'core_rebalance' || t.riskExit === 'core_aufloesung');

const tagePlus = (iso: string, tage: number): string | null =>
  etTagVon(new Date(Date.parse(iso) + tage * 86_400_000).toISOString());

/**
 * Sockel-Ausstiege eines Kontos mit ihrem Messpunkt. Pur; `trades` ist die
 * Trade-Liste EINES Kontos in beliebiger Reihenfolge. `unklar` sind
 * nachgebuchte Verkäufe (V6) — gezählt, nicht bewertet.
 */
export function sockelAusstiege(
  trades: readonly SockelTradeRoh[],
  ab = SOCKEL_MESSUNG_AB,
): { faelle: SockelAusstieg[]; unklar: number } {
  const sortiert = [...trades]
    .filter((t) => typeof t.at === 'string' && Number.isFinite(Date.parse(t.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const faelle: SockelAusstieg[] = [];
  let unklar = 0;
  for (let i = 0; i < sortiert.length; i += 1) {
    const t = sortiert[i]!;
    if (t.quelle !== 'sockel' || t.side !== 'sell' || !t.riskExit) continue;
    const exitTag = etTagVon(t.at);
    if (!exitTag || exitTag < ab) continue;
    if (SOCKEL_UNKLAR_EXITS.includes(t.riskExit)) { unklar += 1; continue; }
    if (!SOCKEL_MARKEN_EXITS.includes(t.riskExit)) continue;
    const einstand = t.entryPrice;
    const exitPreis = brutto(t);
    if (!(typeof einstand === 'number' && einstand > 0) || !(exitPreis > 0)) continue;
    const ersatz = tagePlus(t.at, SOCKEL_ERSATZ_TAGE);
    if (!ersatz) continue;
    // Erster Lauf NACH dem Ausstiegs-Zeitpunkt (F2) — Läufe davor sind durch
    // j > i ausgeschlossen, ein Lauf am selben Abend zählt.
    let lauf: SockelTradeRoh | null = null;
    let laufIdx = -1;
    for (let j = i + 1; j < sortiert.length; j += 1) {
      const u = sortiert[j]!;
      if (Date.parse(u.at) > Date.parse(t.at) && istSockelLauf(u)) { lauf = u; laufIdx = j; break; }
    }
    const laufTag = lauf ? etTagVon(lauf.at) : null;
    // R4: der frühere Messpunkt — kein Springen, wenn später ein Lauf kommt.
    if (laufTag && laufTag <= ersatz) {
      // Rückkauf = erster Sockel-Kauf des Symbols IN diesem Lauf (gleicher ET-Tag).
      let rueckkaufPreis: number | null = null;
      for (let j = laufIdx; j < sortiert.length; j += 1) {
        const u = sortiert[j]!;
        if (etTagVon(u.at) !== laufTag) break;
        if (u.symbol === t.symbol && u.side === 'buy' && u.quelle === 'sockel') {
          const p = brutto(u);
          rueckkaufPreis = p > 0 ? p : null;
          break;
        }
      }
      faelle.push({ symbol: t.symbol, exitAt: t.at, exitTag, exitPreis, einstand, tagT: laufTag, rueckkaufPreis });
    } else {
      faelle.push({ symbol: t.symbol, exitAt: t.at, exitTag, exitPreis, einstand, tagT: ersatz, rueckkaufPreis: null });
    }
  }
  return { faelle, unklar };
}

export interface Tageskerze {
  date: string;
  open: number;
  low: number;
  close: number;
}

export type SockelBewertung =
  | { stand: 'offen' }
  | { stand: 'ohne_kurse' }
  | { stand: 'bewertet'; deltaPct: number; deltaRobustPct: number; notbremse: boolean };

const rund = (v: number): number => Math.round(v * 10_000) / 10_000;

const tageZwischen = (a: string, b: string): number =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/**
 * Ein Ausstieg gegen realisierte Tageskerzen. `deltaPct` > 0 heißt: Halten
 * (ohne Prozent-Marken, mit Notbremse) wäre besser gewesen als der echte
 * Ausstieg. `deltaRobustPct` rechnet zusätzlich Reibung je Bein (V2) —
 * immer zuungunsten der Seite, die sie im echten Leben zahlen würde.
 */
export function bewerteSockelAusstieg(
  a: SockelAusstieg,
  kerzen: readonly Tageskerze[],
  heute: string,
): SockelBewertung {
  // Lookahead-Gate: Der Messtag muss abgeschlossen sein.
  if (!(a.tagT < heute)) return { stand: 'offen' };
  const bremse = a.einstand * (1 - SOCKEL_NOTBREMSE_PCT / 100);
  const f = (roundtripFeeRateForClass(classify(a.symbol)) / 2) * 100; // Gebühr je Seite in %
  const r = SOCKEL_REIBUNG_PCT;
  // F1: Der echte Ausstieg lag schon an/unter der Bremse — beide Welten sind draußen.
  if (a.exitPreis <= bremse) return { stand: 'bewertet', deltaPct: 0, deltaRobustPct: 0, notbremse: true };

  const pfad = kerzen
    .filter((k) => k.date >= a.exitTag && k.date <= a.tagT && k.close > 0 && k.low > 0 && k.open > 0)
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  // V7: Ohne Kerze nahe am Ausstieg fehlt genau der Absturz, um den es geht.
  if (pfad.length === 0 || tageZwischen(a.exitTag, pfad[0]!.date) > SOCKEL_MAX_KERZEN_LUECKE_TAGE) {
    return { stand: 'ohne_kurse' };
  }
  // Notbremse im Pfad — am Ausstiegstag nur, wenn sie NACH dem Stop greifen
  // konnte: Das Tagestief liegt dann unter dem Ausstieg UND unter der Bremse.
  for (const k of pfad) {
    if (k.low <= bremse) {
      const fill = Math.min(bremse, k.open);
      // Beide Welten verkaufen einmal (Gebühren heben sich auf); danach sind
      // beide draußen bzw. kaufen am Lauf gleich zurück.
      const d = (fill / a.exitPreis - 1) * 100;
      return { stand: 'bewertet', deltaPct: rund(d), deltaRobustPct: rund(d - r), notbremse: true };
    }
  }
  if (a.rueckkaufPreis !== null) {
    // Ausgestoppt UND zurückgekauft: Halten spart Verkauf + Kauf (Gebühr) und
    // im Robust-Fall die Reibung des Rückkaufs.
    const d = (a.rueckkaufPreis / a.exitPreis - 1) * 100 + 2 * f;
    return { stand: 'bewertet', deltaPct: rund(d), deltaRobustPct: rund(d + r), notbremse: false };
  }
  const ende = pfad[pfad.length - 1]!;
  if (!(ende.date > a.exitTag) && a.tagT > a.exitTag) return { stand: 'ohne_kurse' };
  // Kein Rückkauf: Beide Welten verkaufen genau einmal — der echte zum
  // Ausstieg, die Halten-Welt zum Schluss von T. Robust: Die Halten-Welt
  // zahlt ihre Verkaufs-Reibung noch (der echte Fill enthält sie schon).
  const d = (ende.close / a.exitPreis - 1) * 100;
  return { stand: 'bewertet', deltaPct: rund(d), deltaRobustPct: rund(d - r), notbremse: false };
}

/** ISO-Kalenderwoche als „JJJJ-Www". */
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

const einordnen = (ki80: readonly [number, number]): Exclude<SockelEntscheidung, 'zu_wenig'> =>
  ki80[0] > 0 ? 'ohne_marken' : ki80[1] < 0 ? 'marken_behalten' : 'unentschieden';

/**
 * Die Regel, VOR den Daten festgelegt (Red-Team 14./15.10.):
 *   < 20 Symbol-Wochen oder < 8 Kalenderwochen, oder > 10 % ohne Kurse
 *                                   ⇒ zu_wenig
 *   80-%-Intervall ganz über 0      ⇒ ohne_marken  (Option b)
 *   80-%-Intervall ganz unter 0     ⇒ marken_behalten (a oder c)
 *   sonst                           ⇒ unentschieden
 * Mit und ohne Reibung muss dasselbe herauskommen, sonst unentschieden.
 * Der Aufrufer friert das erste Urteil ein (kein laufendes Nachprüfen).
 */
export function sockelEntscheidung(
  n: number,
  kalenderwochen: number,
  ohneKursAnteil: number,
  ki80: readonly [number, number] | null,
  ki80Robust: readonly [number, number] | null,
): SockelEntscheidung {
  if (n < SOCKEL_MIN_WOCHEN || kalenderwochen < SOCKEL_MIN_KALENDERWOCHEN) return 'zu_wenig';
  if (ohneKursAnteil > SOCKEL_MAX_OHNE_KURSE || !ki80 || !ki80Robust) return 'zu_wenig';
  const a = einordnen(ki80);
  return a === einordnen(ki80Robust) ? a : 'unentschieden';
}

/**
 * Block-Bootstrap (V3): Gezogen werden KALENDERWOCHEN mit allen ihren
 * Symbol-Wochen — ein Marktschock trifft alle Werte einer Woche, sie sind
 * keine unabhängigen Fälle. 10./90. Perzentil des Mittelwerts, fester
 * Startwert: dieselben Daten geben jeden Tag dasselbe Intervall.
 */
export function blockBootstrap80(bloecke: ReadonlyArray<readonly number[]>, ziehungen = 2000): [number, number] | null {
  const voll = bloecke.filter((b) => b.length > 0);
  if (voll.length < 2) return null;
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
    let anzahl = 0;
    for (let i = 0; i < voll.length; i += 1) {
      const b = voll[Math.floor(zufall() * voll.length)]!;
      for (const v of b) summe += v;
      anzahl += b.length;
    }
    mittel.push(summe / anzahl);
  }
  mittel.sort((a, b) => a - b);
  return [rund(mittel[Math.floor(0.1 * ziehungen)]!), rund(mittel[Math.floor(0.9 * ziehungen) - 1]!)];
}

export interface SockelKontrafaktStand {
  /** Ab welchem Ausstiegstag gezählt wird (V5). */
  ab: string;
  /** Unabhängige Fälle (Symbol × Woche) und Kalenderwochen. */
  n: number;
  kalenderwochen: number;
  /** Bewertete Konto-Trades (je Konto gespiegelt — nur zur Einordnung). */
  nTrades: number;
  notbremse: number;
  offen: number;
  ohneKurse: number;
  /** Nachgebuchte Verkäufe (fill_sync) — gezählt, nicht bewertet (V6). */
  unklar: number;
  /** Mittel über die Symbol-Wochen: Halten minus Ausstieg, in % — ohne / mit Reibung. */
  mittelPct: number | null;
  mittelRobustPct: number | null;
  ki80: [number, number] | null;
  ki80Robust: [number, number] | null;
  /** Vorläufig — das verbindliche Urteil friert der Aufrufer EINMAL ein. */
  entscheidung: SockelEntscheidung;
}

export function sockelKontrafaktStand(
  faelle: ReadonlyArray<{ a: SockelAusstieg; b: SockelBewertung }>,
  unklar = 0,
  ab = SOCKEL_MESSUNG_AB,
): SockelKontrafaktStand {
  const gruppen = new Map<string, { woche: string; d: number[]; dr: number[] }>();
  let nTrades = 0;
  let notbremse = 0;
  let offen = 0;
  let ohneKurse = 0;
  for (const { a, b } of faelle) {
    if (b.stand === 'offen') { offen += 1; continue; }
    if (b.stand === 'ohne_kurse') { ohneKurse += 1; continue; }
    nTrades += 1;
    if (b.notbremse) notbremse += 1;
    const woche = isoWoche(a.exitTag);
    const key = `${a.symbol}|${woche}`;
    const g = gruppen.get(key) ?? { woche, d: [], dr: [] };
    g.d.push(b.deltaPct);
    g.dr.push(b.deltaRobustPct);
    gruppen.set(key, g);
  }
  const mittel = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const proWoche = new Map<string, { d: number[]; dr: number[] }>();
  for (const g of gruppen.values()) {
    const w = proWoche.get(g.woche) ?? { d: [], dr: [] };
    w.d.push(mittel(g.d));
    w.dr.push(mittel(g.dr));
    proWoche.set(g.woche, w);
  }
  const alle = [...proWoche.values()];
  const werte = alle.flatMap((w) => w.d);
  const werteR = alle.flatMap((w) => w.dr);
  const ki80 = blockBootstrap80(alle.map((w) => w.d));
  const ki80Robust = blockBootstrap80(alle.map((w) => w.dr));
  const ohneKursAnteil = nTrades + ohneKurse > 0 ? ohneKurse / (nTrades + ohneKurse) : 0;
  return {
    ab,
    n: werte.length,
    kalenderwochen: alle.length,
    nTrades,
    notbremse,
    offen,
    ohneKurse,
    unklar,
    mittelPct: werte.length > 0 ? rund(mittel(werte)) : null,
    mittelRobustPct: werteR.length > 0 ? rund(mittel(werteR)) : null,
    ki80,
    ki80Robust,
    entscheidung: sockelEntscheidung(werte.length, alle.length, ohneKursAnteil, ki80, ki80Robust),
  };
}
