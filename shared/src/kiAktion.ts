/**
 * KI-Kaskade Stufe 2b (05.10.): aus KI-Urteilen werden Handlungen — mit
 * FESTEN Regeln. Die KI hat nur geurteilt (Stufe 2a, `kiUrteile`); was
 * daraus folgt, entscheidet dieses Modul, pur und prüfbar.
 *
 * ── Die Regeln (Owner-Entscheidung 05.10., Empfehlung angenommen) ─────────
 *
 *   Positiv, eindeutig, gegengeprüft, nicht eingepreist
 *       → Kaufstimme mit vollem Konfluenz-Gewicht (reicht allein), aber in
 *         PROBEGRÖSSE: Ein Einstieg, der nur wegen der KI zustande kommt,
 *         handelt halb so groß. Stufe 3 skaliert später 0,25×–2× nach
 *         gemessener Wirkung — bis dahin ist die Hälfte die ehrliche Wette.
 *   Negativ, eindeutig, gegengeprüft
 *       → sperrt neue Long-Einstiege (richtungsbewusstes Veto);
 *       → gehaltene Long-Position: noch nicht stark gefallen (< 1,5 ATR seit
 *         dem ersten Sehen) → VERKAUFEN; schon gefallen → Stop nachziehen,
 *         statt am Tief zu verkaufen.
 *   Unklar (gegen die Position, aber ohne bestandene Gegenprobe)
 *       → nur Stop nachziehen.
 *   Spiegelbildlich für Shorts.
 *
 * ── Was hier nie passiert ─────────────────────────────────────────────────
 *
 *   - Kein Ausstieg wird ERSCHWERT: Die KI kann Ausstiege nur auslösen oder
 *     den Stop in Schutzrichtung verschieben, nie lockern.
 *   - Keine Schutzregel wird umgangen: Einstiege laufen weiter durch alle
 *     Tore des Scans (Kosten, Regime, Cluster, PDT, Abgleich …). Nur das
 *     BLINDE Lexikon-Veto weicht, wenn die gegengeprüfte KI ausdrücklich in
 *     Handelsrichtung urteilt — das Lexikon kennt keine Richtung, die KI
 *     schon.
 *   - Kein Lookahead: Entscheidungen nutzen nur Urteile, deren `decidedAt`
 *     vor dem Scan liegt, und den Kurs beim ersten Sehen als Bezug.
 */

import type { SignalDirection } from './strategy.js';

/** So lange wirkt ein Urteil (ab `decidedAt`). Danach ist die Nachricht alt. */
export const KI_GUELTIG_STUNDEN = 6;
/** Größe eines Einstiegs, der NUR wegen der KI zustande kommt. */
export const KI_PROBE_FAKTOR = 0.5;
/** Ab so vielen ATR Bewegung seit dem ersten Sehen gilt die Nachricht als eingepreist. */
export const KI_EINGEPREIST_ATR = 1.5;
/** Abstand des nachgezogenen Stops in ATR. */
export const KI_STOP_ATR = 0.5;
/** Ab dieser Stärke zieht auch ein unklares Gegen-Urteil den Stop nach. */
export const KI_UNKLAR_MIN_STAERKE = 0.5;

export interface KiSignal {
  newsId: string;
  symbol: string;
  richtung: 'positiv' | 'negativ' | 'neutral';
  handlungsfaehig: boolean;
  staerke: number;
  eingepreist: 'nein' | 'teilweise' | 'ja' | 'unklar' | null;
  decidedAt: string;
  /** Kurs beim ersten Sehen der Meldung (Bezug für „schon gelaufen?"). */
  kursGesehen: number | null;
}

const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Aus rohen `kiUrteile`-Dokumenten je Symbol das jüngste gültige Urteil —
 * pur. Gültig heißt: `decidedAt` vor `jetztMs` (kein Blick in die Zukunft)
 * und nicht älter als `KI_GUELTIG_STUNDEN`. Das jüngste gewinnt, auch wenn
 * es schwächer ist: Eine neuere Lage löst eine ältere ab.
 */
export function kiSignaleAus(urteile: readonly unknown[], jetztMs: number): Map<string, KiSignal> {
  const out = new Map<string, KiSignal>();
  for (const roh of urteile) {
    const u = (roh ?? {}) as Record<string, unknown>;
    const symbol = typeof u['symbol'] === 'string' ? u['symbol'] : '';
    const richtung = u['richtung'];
    const decided = Date.parse(String(u['decidedAt'] ?? ''));
    if (!symbol || !Number.isFinite(decided)) continue;
    if (richtung !== 'positiv' && richtung !== 'negativ' && richtung !== 'neutral') continue;
    if (decided > jetztMs || jetztMs - decided > KI_GUELTIG_STUNDEN * 3_600_000) continue;
    const bisher = out.get(symbol);
    if (bisher && Date.parse(bisher.decidedAt) >= decided) continue;
    const pruefung = (u['pruefung'] ?? {}) as Record<string, unknown>;
    const gesehen = ((pruefung['kurskontext'] ?? {}) as Record<string, unknown>)['gesehen'] as Record<string, unknown> | null | undefined;
    const ein = u['eingepreist'];
    out.set(symbol, {
      newsId: String(u['newsId'] ?? ''),
      symbol,
      richtung,
      handlungsfaehig: u['handlungsfaehig'] === true,
      staerke: zahl(u['staerke']) ?? 0,
      eingepreist: ein === 'nein' || ein === 'teilweise' || ein === 'ja' || ein === 'unklar' ? ein : null,
      decidedAt: new Date(decided).toISOString(),
      kursGesehen: zahl(gesehen?.['p']) !== null && (zahl(gesehen?.['p']) as number) > 0 ? (zahl(gesehen?.['p']) as number) : null,
    });
  }
  return out;
}

/** Trägt das Urteil eine Handlung — gegengeprüft und nicht schon eingepreist? */
function traegt(s: KiSignal | undefined): s is KiSignal {
  return !!s && s.handlungsfaehig && s.richtung !== 'neutral' && s.eingepreist !== 'ja';
}

/**
 * Einstiegsstimme der KI — nur OHNE offene Position (Ausstiege laufen über
 * `kiPositionsAktion`, damit kein Urteil doppelt wirkt). Gewicht = die
 * geforderte Konfluenz: Die KI kann allein einen Einstieg tragen, der dann
 * aber in Probegröße handelt (`kiGroessenFaktor`).
 */
export function kiStimme(
  s: KiSignal | undefined,
  requiredConfluence: number,
  hatPosition: boolean,
): { dir: 'buy' | 'sell'; weight: number } | null {
  if (hatPosition || !traegt(s)) return null;
  const weight = Math.max(1, Math.ceil(requiredConfluence));
  return { dir: s.richtung === 'positiv' ? 'buy' : 'sell', weight };
}

/**
 * Lexikon-Rückfall (Owner 05.10.): Ist das KI-Budget des Tages erschöpft,
 * zählt das Lexikon-Sentiment mit HALBEM Gewicht der KI-Stimme — nie allein
 * genug für einen Einstieg, nie Grund für einen Ausstieg, und es hebt kein
 * Veto auf. Nur, wenn für das Symbol kein gültiges KI-Urteil vorliegt.
 */
export function lexikonStimme(
  sentSign: -1 | 0 | 1 | null | undefined,
  requiredConfluence: number,
  hatPosition: boolean,
  kiSignal: KiSignal | undefined,
  budgetErschoepft: boolean,
): { dir: 'buy' | 'sell'; weight: number } | null {
  if (!budgetErschoepft || hatPosition || kiSignal || !sentSign) return null;
  const halb = Math.floor(Math.max(1, Math.ceil(requiredConfluence)) / 2);
  if (halb < 1) return null;
  return { dir: sentSign > 0 ? 'buy' : 'sell', weight: Math.min(halb, Math.max(1, Math.ceil(requiredConfluence)) - 1) };
}

/**
 * Konfluenz mit mehreren Zusatzstimmen neu entscheiden — dieselbe Regel wie
 * die Engine (votes ≥ required ∧ votes > Gegenseite), pure.
 */
export function mitStimmen(
  sig: { direction: SignalDirection; buyVotes: number; sellVotes: number; requiredConfluence: number },
  stimmen: ReadonlyArray<{ dir: 'buy' | 'sell'; weight: number } | null>,
): { direction: SignalDirection; buy: number; sell: number } {
  const da = stimmen.filter((s): s is { dir: 'buy' | 'sell'; weight: number } => s !== null);
  if (da.length === 0) return { direction: sig.direction, buy: sig.buyVotes, sell: sig.sellVotes };
  const buy = sig.buyVotes + da.reduce((n, s) => n + (s.dir === 'buy' ? s.weight : 0), 0);
  const sell = sig.sellVotes + da.reduce((n, s) => n + (s.dir === 'sell' ? s.weight : 0), 0);
  if (buy >= sig.requiredConfluence && buy > sell) return { direction: 'buy', buy, sell };
  if (sell >= sig.requiredConfluence && sell > buy) return { direction: 'sell', buy, sell };
  return { direction: 'hold', buy, sell };
}

/**
 * Größenfaktor eines Einstiegs: Probegröße, wenn die Richtung OHNE die KI
 * nicht zustande gekommen wäre. Bestätigt die KI nur, was die Technik ohnehin
 * sagt, bleibt die Größe unverändert.
 */
export function kiGroessenFaktor(richtungOhneKi: SignalDirection, richtungMitKi: SignalDirection): number {
  return richtungMitKi !== 'hold' && richtungOhneKi !== richtungMitKi ? KI_PROBE_FAKTOR : 1;
}

/**
 * Richtungsbewusstes Veto: Ein gegengeprüftes Urteil GEGEN die Einstiegs-
 * richtung sperrt den Einstieg — auch wenn es schon eingepreist ist (dann
 * trägt es keinen Ausstieg mehr, aber ein Einstieg gegen frische schlechte
 * Nachrichten bleibt falsch).
 */
export function kiVeto(s: KiSignal | undefined, seite: 'long' | 'short'): boolean {
  if (!s || !s.handlungsfaehig) return false;
  return seite === 'long' ? s.richtung === 'negativ' : s.richtung === 'positiv';
}

/**
 * Hebt die KI das blinde Lexikon-Veto auf? Nur, wenn sie gegengeprüft in
 * Handelsrichtung urteilt — dann weiß sie, was das Lexikon nicht weiß: in
 * welche Richtung das harte Ereignis wirkt.
 */
export function kiUebersteuertNewsVeto(s: KiSignal | undefined, seite: 'long' | 'short'): boolean {
  if (!s || !s.handlungsfaehig) return false;
  return seite === 'long' ? s.richtung === 'positiv' : s.richtung === 'negativ';
}

export type KiPositionsAktion =
  | { art: 'verkauf'; grund: 'ki_news' }
  | { art: 'stop'; stop: number; grund: 'ki_eingepreist' | 'ki_unklar' };

/**
 * Der nachgezogene KI-Stop an der Position (`Position.kiStop`).
 *
 * BEWUSST ein eigenes Feld statt `stopLoss` zu überschreiben: Ein
 * gespeichertes `stopLoss`-Level ERSETZT in `riskExitReason` den Prozent-
 * bzw. ATR-Stop. Stünde der KI-Stop dort, könnte er einen engeren
 * Prozent-Stop still LOCKERN (Kurs knapp über dem 4-%-Stop, KI-Stop 0,5 ATR
 * darunter). Als zusätzliche Marke kann er Ausstiege nur früher auslösen —
 * nie später, egal wie die übrigen Stops stehen.
 */
export interface KiStop {
  level: number;
  grund: 'ki_eingepreist' | 'ki_unklar';
  newsId: string;
  gesetztAt: string;
}

/**
 * Was ein Urteil GEGEN eine gehaltene Position auslöst — pur.
 *
 * Gegengeprüft und noch nicht gelaufen → raus (Owner-Empfehlung 05.10.:
 * „eindeutig negativ und noch nicht eingepreist → sofort verkaufen").
 * Gegengeprüft, aber schon ≥ 1,5 ATR gelaufen oder als eingepreist bewertet
 * → nicht am Tief verkaufen, sondern den Stop auf 0,5 ATR nachziehen.
 * Unklar (stark, aber ohne bestandene Gegenprobe) → nur Stop nachziehen.
 *
 * Der KI-Stop bewegt sich NUR in Schutzrichtung (Long: nach oben, Short:
 * nach unten) und liegt immer auf der sicheren Seite des aktuellen Kurses.
 *
 * Nur Positionen, die VOR dem Urteil eröffnet wurden: Wer danach einstieg,
 * kannte die Lage schon (die Engine über das KI-Veto, ein Mensch per Hand)
 * — ihm die Entscheidung mit derselben Nachricht wieder abzunehmen, wäre
 * ein Urteil über eine Kenntnis, die beim Einstieg schon eingepreist war.
 */
export function kiPositionsAktion(
  s: KiSignal | undefined,
  pos: { side?: 'long' | 'short' | undefined; openedAt?: string | undefined; kiStop?: { level: number } | null | undefined },
  preis: number,
  atrPct: number | null | undefined,
): KiPositionsAktion | null {
  if (!s || !(preis > 0)) return null;
  const eroeffnet = Date.parse(String(pos.openedAt ?? ''));
  if (Number.isFinite(eroeffnet) && eroeffnet >= Date.parse(s.decidedAt)) return null;
  const short = pos.side === 'short';
  const gegen = short ? s.richtung === 'positiv' : s.richtung === 'negativ';
  if (!gegen) return null;
  const atr = typeof atrPct === 'number' && Number.isFinite(atrPct) && atrPct > 0 ? atrPct : null;

  const stopAktion = (grund: 'ki_eingepreist' | 'ki_unklar'): KiPositionsAktion | null => {
    if (atr === null) return null;
    const neu = short ? preis * (1 + (KI_STOP_ATR * atr) / 100) : preis * (1 - (KI_STOP_ATR * atr) / 100);
    const alt = pos.kiStop?.level;
    const enger = typeof alt !== 'number' || !Number.isFinite(alt) || !(alt > 0) ? true : short ? neu < alt : neu > alt;
    return enger ? { art: 'stop', stop: Math.round(neu * 1e6) / 1e6, grund } : null;
  };

  if (s.handlungsfaehig) {
    // Wie weit ist der Kurs seit dem ersten Sehen schon in Nachrichten-Richtung gelaufen?
    const gelaufenPct = s.kursGesehen !== null
      ? (short ? (preis - s.kursGesehen) / s.kursGesehen : (s.kursGesehen - preis) / s.kursGesehen) * 100
      : null;
    const eingepreist = s.eingepreist === 'ja'
      || (gelaufenPct !== null && atr !== null && gelaufenPct >= KI_EINGEPREIST_ATR * atr);
    return eingepreist ? stopAktion('ki_eingepreist') : { art: 'verkauf', grund: 'ki_news' };
  }
  return s.staerke >= KI_UNKLAR_MIN_STAERKE ? stopAktion('ki_unklar') : null;
}
