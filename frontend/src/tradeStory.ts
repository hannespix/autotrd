/**
 * „Anatomie eines Trades" — die pure Logik der Trade-Story (V2 des
 * Teilen-Videos, Owner-Go 20.08.: medienpsychologisch zuerst).
 *
 * Warum ein einzelner Trade: Menschen folgen Geschichten, nicht Ansichten.
 * Ein echter Trade hat alles, was eine Geschichte braucht — einen Anfang
 * (das Signal), eine offene Frage (wie geht er aus?) und eine Auflösung
 * (das Ergebnis, auch wenn es ein Verlust ist: „Der Stop hat gearbeitet"
 * ist im Trading-Feed der seltenste und glaubwürdigste Satz).
 *
 * EHRLICHKEIT: Hier wird NICHTS rekonstruiert. Der Einstieg ist der echte
 * Eröffnungs-Trade aus der Historie (Positionen sind je Symbol einzeln,
 * §broker), der Ausstiegsgrund kommt vom Exit-Trade (riskExit), der
 * Signal-Kontext aus dem eingefrorenen Journal-Doc. Stop-/Ziel-PREISE
 * geschlossener Trades sind nirgends eingefroren — deshalb zeigt die Story
 * keine Stop-Linie, statt eine aus heutigen Einstellungen zu erfinden.
 *
 * Alles hier ist pur (kein DOM, kein Netz) und damit testbar.
 */

import type { HistoryTrade } from '@autotrd/shared';

export interface TradePaar {
  einstieg: HistoryTrade;
  exit: HistoryTrade;
}

/**
 * Exits mit ihren Eröffnungen paaren. Ein Exit ist ein Trade mit
 * realisiertem P&L; seine Eröffnung ist der JÜNGSTE Gegenseiten-Trade
 * desselben Symbols davor, der selbst kein Ergebnis trägt (Long: buy→sell,
 * Short: sell→buy). Exits ohne auffindbare Eröffnung (Historie nicht weit
 * genug geladen, Adopt-Schnitt) fallen ehrlich raus.
 */
export function findeTradePaare(trades: readonly HistoryTrade[]): TradePaar[] {
  const paare: TradePaar[] = [];
  for (const exit of trades) {
    if (typeof exit.pnl !== 'number' || !Number.isFinite(exit.pnl)) continue;
    let einstieg: HistoryTrade | null = null;
    for (const k of trades) {
      if (k.symbol !== exit.symbol) continue;
      if (k.side === exit.side) continue;
      if (typeof k.pnl === 'number' && Number.isFinite(k.pnl)) continue;
      if (k.executedAt >= exit.executedAt) continue;
      if (!einstieg || k.executedAt > einstieg.executedAt) einstieg = k;
    }
    if (einstieg) paare.push({ einstieg, exit });
  }
  return paare;
}

/** Ergebnis des Trades in Prozent des Einsatzes (Einstiegspreis × Menge). */
export function tradeProzent(paar: TradePaar): number {
  const einsatz = paar.einstieg.price * paar.exit.qty;
  if (!(einsatz > 0)) return 0;
  return Math.round(((paar.exit.pnl ?? 0) / einsatz) * 10_000) / 100;
}

/**
 * Den Trade mit der besten Geschichte wählen: die größte Bewegung (|%|)
 * unter den jüngeren Trades — jung, damit die 5-Minuten-Kurse des Tages
 * noch im Store liegen (ohlc5m wächst nach vorn, nicht nach hinten).
 * Gibt es im 21-Tage-Fenster nichts, zählt die größte Bewegung insgesamt.
 */
export function waehleTradeStory(trades: readonly HistoryTrade[], jetzt: Date): TradePaar | null {
  const paare = findeTradePaare(trades);
  if (paare.length === 0) return null;
  const grenze = new Date(jetzt.getTime() - 21 * 86_400_000).toISOString();
  const jung = paare.filter((p) => p.exit.executedAt >= grenze);
  const menge = jung.length > 0 ? jung : paare;
  return [...menge].sort((a, b) => {
    const d = Math.abs(tradeProzent(b)) - Math.abs(tradeProzent(a));
    return d !== 0 ? d : b.exit.executedAt.localeCompare(a.exit.executedAt);
  })[0]!;
}

/** Ein Kurspunkt der Story-Bühne. */
export interface KursPunkt {
  /** Epoch-Millisekunden (UTC). */
  at: number;
  c: number;
}

/**
 * Das Kurs-Fenster der Geschichte: die Haltespanne plus ~35 % Vorlauf und
 * ~20 % Nachlauf — genug Kontext, dass die Kurve „von irgendwo kommt",
 * ohne den Trade zur Fußnote zu machen. Mindest-Polster eine Viertelstunde,
 * damit auch Blitz-Trades eine Bühne haben.
 */
export function kursFenster(kurse: readonly KursPunkt[], einstiegMs: number, exitMs: number): KursPunkt[] {
  const spanne = Math.max(exitMs - einstiegMs, 60_000);
  const vor = einstiegMs - Math.max(spanne * 0.35, 15 * 60_000);
  const nach = exitMs + Math.max(spanne * 0.2, 10 * 60_000);
  return kurse
    .filter((k) => k.at >= vor && k.at <= nach)
    .sort((a, b) => a.at - b.at);
}

export interface AktSzene {
  id: 'scanner' | 'signal' | 'netz' | 'news' | 'lernen' | 'abspann';
  dauerMs: number;
}

/**
 * Die Maschinen-Story (~22 s), Schwerpunkte nach Owner-Ansage
 * („Autotuning und Trading", Nachfrage 20.08.: „was ist mit den KI-News-
 * Analysen?"): Signal, Nachrichten-Filter und Tuning tragen das Video.
 * Jeder Akt hat GENAU EIN bewegtes Blickziel und endet mit Lese-Ruhe —
 * die Lehren aus dem Analyse-Video-Schnitt (zu schnell, zu hektisch).
 */
export function aktPlan(): AktSzene[] {
  return [
    { id: 'scanner', dauerMs: 2800 },
    { id: 'signal', dauerMs: 4800 },
    { id: 'netz', dauerMs: 4600 },
    // Owner-Nachkritik: der News-Akt war zu kurz und zu statisch — jetzt
    // trägt er den vollen Ablauf lesen → bewerten → urteilen (5 s).
    { id: 'news', dauerMs: 5000 },
    { id: 'lernen', dauerMs: 3800 },
    { id: 'abspann', dauerMs: 2200 },
  ];
}

/** Welcher Akt bei `tMs` läuft — und wie weit er ist (0…1). */
export function aktBei(plan: readonly AktSzene[], tMs: number): { akt: AktSzene; p: number } {
  let rest = tMs;
  for (const akt of plan) {
    if (rest < akt.dauerMs) return { akt, p: Math.max(0, rest / akt.dauerMs) };
    rest -= akt.dauerMs;
  }
  const letzter = plan[plan.length - 1]!;
  return { akt: letzter, p: 1 };
}

/** Signal-Kontext aus dem Journal, auf das reduziert, was die Story sagt. */
export interface StoryKontext {
  /** z. B. ['RSI', 'MACD'] — die Stimmen, die den Einstieg trugen. */
  stimmen: string[];
  /** „3/3" o. ä. — nur wenn beide Zahlen bekannt sind. */
  konfluenz: string | null;
}

const STIMMEN_NAME: Record<string, string> = { rsi: 'RSI', macd: 'MACD', bollinger: 'Bollinger' };

/** Aus dem eingefrorenen signalContext des Journals — nichts erfinden. */
export function storyKontext(sc: {
  votes?: Record<string, string>;
  konfluenz?: number;
  minKonfluenz?: number;
} | null | undefined, seite: 'buy' | 'sell'): StoryKontext {
  if (!sc) return { stimmen: [], konfluenz: null };
  const stimmen = Object.entries(sc.votes ?? {})
    .filter(([, richtung]) => richtung === seite)
    .map(([name]) => STIMMEN_NAME[name] ?? name.toUpperCase());
  const konfluenz =
    typeof sc.konfluenz === 'number' && typeof sc.minKonfluenz === 'number'
      ? `${sc.konfluenz}/${sc.minKonfluenz}`
      : null;
  return { stimmen, konfluenz };
}

/**
 * Alles, was die Video-Bühne braucht — eingesammelt und eingefroren.
 *
 * BEWUSST OHNE Ergebniszahlen (Owner 20.08.: Technologie in den
 * Mittelpunkt): Das Video erzählt Mechanik — Scanner, Signal, Netz,
 * Tuning — und behauptet keine Rendite. Genau deshalb braucht es kein
 * Siegel im Bild; der Papier-Hinweis steht als leise Abspann-Zeile.
 * Sobald jemand hier wieder Zahlen einführt, kommt das Siegel mit
 * (Wächter in tradeStoryVideo.test).
 */
export interface TradeStoryDaten {
  symbol: string;
  /** 'buy' = Long-Einstieg, 'sell' = Short-Einstieg. */
  einstiegSeite: 'buy' | 'sell';
  einstiegAt: string;
  einstiegPreis: number;
  exitAt: string;
  exitPreis: number;
  riskExit: string | null;
  kontext: StoryKontext;
  kurse: KursPunkt[];
  /** Echte Katalog-Symbole für die Scanner-Szene (Watchlist + Historie). */
  scannerSymbole: string[];
  echtgeld: boolean;
}
