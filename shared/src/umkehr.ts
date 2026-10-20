/**
 * KURZFRIST-UMKEHR (RSI-2) — die Tagesstrategie der aktiven Engine
 * (Owner-Entscheidung 20.10., Task 34).
 *
 * Warum diese und keine andere: Die 5-Minuten-Konfluenz hatte über 68.789
 * nachverfolgte Signale brutto keinen Vorsprung (Trefferquote 47,5 %, roh
 * ≈ 0 %); nach Kosten blieb ein sicherer Verlust. Eine Rückrechnung auf
 * Tageskerzen 2001–2026 (35 Symbole, Ausführung zur Eröffnung des Folgetags,
 * Kosten abgezogen, Regeln nur auf 2001–2019 gewählt) fand genau EINE
 * Strategie mit Vorsprung gegenüber zufälligen Einstiegen in beiden
 * Zeiträumen: diese. 2020–2026: +0,40 % je Trade, 65 % Treffer,
 * Gewinnfaktor 1,54, ~4 Trades je Woche auf 33 Symbolen. Trendfolge-
 * Ausbrüche und Momentum-Rotation waren nicht besser als Zufall bzw. SPY.
 *
 * Die Regel ist bewusst die aus der Literatur (Connors), nicht nachjustiert:
 *  - KAUF, wenn der Wert über seinem 200-Tage-Schnitt notiert (intakter
 *    Aufwärtstrend) UND der RSI über 2 Tage unter 10 liegt (kurzer, starker
 *    Rücksetzer). Ausführung zur nächsten Eröffnung.
 *  - VERKAUF, wenn der Schlusskurs wieder über dem 5-Tage-Schnitt liegt
 *    (Erholung da) oder spätestens nach 10 Handelstagen.
 *  - Keine Prozent-Marken (kein 2-%-Stop, kein Ziel, kein Trailing): Sie
 *    würden genau die Rücksetzer verkaufen, von denen die Regel lebt. Nur
 *    eine NOTBREMSE bei −15 % ab Einstand — sie griff in der Rückrechnung
 *    bei unter 1 % der Trades und änderte die Erwartung nicht.
 *
 * Pur: keine Lesevorgänge, keine Uhr. Die Läufe (functions/…/umkehrLauf)
 * holen Kerzen und rufen diese Funktionen.
 */
import { sma, wilderRsi } from './indicators.js';
import type { RiskConfig } from './strategy.js';

export const UMKEHR = {
  rsiFenster: 2,
  rsiSchwelle: 10,
  trendFenster: 200,
  ausstiegFenster: 5,
  /** Handelstage inklusive Einstiegstag (wie in der Rückrechnung). */
  maxTage: 10,
  notbremsePct: 15,
  /** Gleichzeitig offene Positionen — je Position 1/maxPositionen des aktiven Kapitals. */
  maxPositionen: 10,
} as const;

export interface UmkehrParameter {
  rsiFenster: number;
  rsiSchwelle: number;
  trendFenster: number;
  ausstiegFenster: number;
  maxTage: number;
  notbremsePct: number;
  maxPositionen: number;
}

/**
 * Krypto (Owner-Wahl 20.10.: RSI-2 auch auf Krypto). Die Rückrechnung auf
 * 9 Coins (Kosten 0,25 % je Seite) fand mit den ETF-Werten 2022–2026 einen
 * VERLUST (Schwelle 10: −0,6 % je Trade). Knapp positiv blieb nur die
 * strenge Variante — Schwelle 5, Trend über SMA200, Notbremse −25 %
 * (−15 % griff bei Krypto in 5–13 % der Trades und schnitt Erholungen ab):
 * +0,5 bis +0,8 % je Trade, ~25 Trades/Jahr, aber innerhalb der Spanne
 * zufälliger Einstiege. Erwartung eher null — die Messung je Klasse
 * (quellen7t) entscheidet, ob das bleibt.
 */
export const UMKEHR_KRYPTO: UmkehrParameter = { ...UMKEHR, rsiSchwelle: 5, notbremsePct: 25 };

/** Parameter je Anlageklasse. */
export function umkehrParameterFuer(klasse: string | null | undefined): UmkehrParameter {
  return klasse === 'crypto' ? UMKEHR_KRYPTO : UMKEHR;
}

export interface UmkehrEinstieg {
  signal: boolean;
  rsi: number | null;
  trend: number | null;
  schluss: number | null;
}

const letzter = (s: ReadonlyArray<number | null>): number | null => {
  const v = s[s.length - 1];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * Kaufsignal auf den Schlusskursen bis einschließlich des letzten
 * ABGESCHLOSSENEN Tages. Wer eine laufende (unfertige) Tageskerze
 * mitgibt, bekommt ein Signal auf einem Kurs, den es am Schluss nicht gibt
 * — die Läufe schneiden sie vorher ab (`abgeschlosseneKerzen`).
 */
export function umkehrEinstieg(schluesse: readonly number[], p: UmkehrParameter = UMKEHR): UmkehrEinstieg {
  const c = schluesse.filter((x) => Number.isFinite(x) && x > 0);
  if (c.length < p.trendFenster || c.length !== schluesse.length) {
    return { signal: false, rsi: null, trend: null, schluss: c.length > 0 ? c[c.length - 1]! : null };
  }
  const rsi = letzter(wilderRsi([...c], p.rsiFenster));
  const trend = letzter(sma([...c], p.trendFenster));
  const schluss = c[c.length - 1]!;
  const signal = rsi !== null && trend !== null && schluss > trend && rsi < p.rsiSchwelle;
  return { signal, rsi, trend, schluss };
}

export type UmkehrAusstiegGrund = 'umkehr_erholt' | 'umkehr_frist';

/**
 * Verkaufssignal für eine offene Umkehr-Position. `gehalteneTage` zählt
 * die Handelstage INKLUSIVE des Einstiegstags bis einschließlich des
 * letzten abgeschlossenen Tages (Einstieg heute zur Eröffnung ⇒ am Abend 1).
 */
export function umkehrAusstieg(
  schluesse: readonly number[],
  gehalteneTage: number,
  p: UmkehrParameter = UMKEHR,
): UmkehrAusstiegGrund | null {
  const c = schluesse.filter((x) => Number.isFinite(x) && x > 0);
  if (c.length === 0 || c.length !== schluesse.length) return null;
  const s = letzter(sma([...c], p.ausstiegFenster));
  if (s !== null && c[c.length - 1]! > s) return 'umkehr_erholt';
  if (Number.isFinite(gehalteneTage) && gehalteneTage >= p.maxTage) return 'umkehr_frist';
  return null;
}

/**
 * Handelstage seit dem Einstieg: Anzahl der Kerzen-Daten (YYYY-MM-DD, ET)
 * ab dem Einstiegstag. Kerzen sind die einzige Uhr, die Feiertage und
 * Wochenenden richtig kennt (Krypto: jeder Kalendertag ist eine Kerze).
 */
export function handelstageSeit(einstiegsTag: string, kerzenTage: readonly string[]): number {
  let n = 0;
  for (const t of kerzenTage) if (t >= einstiegsTag) n += 1;
  return n;
}

export interface UmkehrKandidat {
  symbol: string;
  rsi: number;
}

/**
 * Welche Signale gekauft werden, wenn mehr Signale als freie Plätze da
 * sind: der tiefste RSI zuerst (der stärkste Rücksetzer), bei Gleichstand
 * alphabetisch — deterministisch, damit zwei Läufe dasselbe wählen.
 */
export function umkehrAuswahl(kandidaten: readonly UmkehrKandidat[], frei: number): UmkehrKandidat[] {
  if (!(frei > 0)) return [];
  return [...kandidaten]
    .filter((k) => Number.isFinite(k.rsi))
    .sort((a, b) => a.rsi - b.rsi || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .slice(0, Math.floor(frei));
}

/** Risiko-Hülle einer Umkehr-Position: nur die Notbremse. */
export function umkehrRisk(p: UmkehrParameter = UMKEHR): RiskConfig {
  return { stopLossPct: p.notbremsePct, takeProfitPct: 0, trailingStopPct: 0, atrStopMult: 0, atrTakeMult: 0, maxHoldDays: 0 };
}

/** Notbremse-Level ab Einstand (Long-only-Strategie). */
export function umkehrNotbremseLevel(avgEntry: number, p: UmkehrParameter = UMKEHR): number {
  return avgEntry * (1 - p.notbremsePct / 100);
}

/** Zielwert je Position: aktives Kapital (nach Sockel) geteilt durch die Plätze. */
export function umkehrPositionsWert(equity: number, corePct: number, p: UmkehrParameter = UMKEHR): number {
  if (!(equity > 0)) return 0;
  const sockel = Number.isFinite(corePct) ? Math.min(Math.max(corePct, 0), 100) : 0;
  return (equity * (1 - sockel / 100)) / p.maxPositionen;
}

/**
 * Nur abgeschlossene Tageskerzen: Eine Kerze mit dem heutigen Datum (ET)
 * ist während der Sitzung noch offen — ihr „Schluss" ist ein Zwischenkurs.
 * Wer abends nach 16:00 ET rechnet, darf die heutige Kerze behalten;
 * `heuteAbgeschlossen` sagt, ob die Sitzung vorbei ist.
 */
export function abgeschlosseneKerzen<T extends { date: string }>(kerzen: readonly T[], heute: string, heuteAbgeschlossen: boolean): T[] {
  return kerzen.filter((k) => k.date < heute || (heuteAbgeschlossen && k.date === heute));
}

/**
 * BESITZGRENZE (Task 34): Gehört diese Position der Kurzfrist-Umkehr? Dann
 * führt sie der Tageslauf, nicht der 5-Minuten-Scan, und der Puls prüft
 * nur die Notbremse. Sockel geht vor (`core`).
 *
 * Das Einstiegs-Etikett `quelle` ist sonst reine Messung (Task 18: „keine
 * Regel liest es"). Hier ist es bewusst die Besitzmarke, weil es — anders
 * als ein eigenes Flag — schon über alle Nachbuchungswege (Lauf-Kennung
 * `umk-…`, fillSync, adoptBroker) erhalten bleibt. Gelesen wird es NUR über
 * diese Funktion; der Quelltext-Wächter hält das fest.
 */
export function umkehrBesitz(p: { core?: boolean | undefined; quelle?: string | null | undefined }): boolean {
  return p.core !== true && p.quelle === 'umkehr';
}
