/**
 * Qualitätsfilter für die Momentum-Rangliste (Befund 05.10.).
 *
 * Seit Task 123 (13.08.) rankt der Momentum-Lauf Katalog ∪ Alpaca-Universum
 * (~12.800 Papiere). Das Universum filtert nur „aktiv, handelbar, kein OTC".
 * Am 05.10. kaufte der Sockel deshalb auf allen Konten BVC, BWET, CCG, DUKR,
 * MGRT, SNDK, MULL, MUU — Kleinwerte und gehebelte ETFs. In dünnen Titeln
 * füllen Orders in Stücken; beim CCG-Einstieg entstand daraus eine Drift von
 * 1.380 Stück zwischen Buch und Broker.
 *
 * Der Neubau (ea6f2e0) hatte dafür einen kuratierten Pool ohne gehebelte und
 * inverse ETFs, mindestens 5 $ Kurs und 2 Mio. $ Tagesumsatz. Übernommen ist
 * nur die Idee, nicht der enge Pool: Wer hier herausfällt, wird durch den
 * Nächstbesten ERSETZT — das Ziel bleibt bei `topN` Positionen, die
 * Aktivität sinkt nicht.
 *
 * Katalog-Symbole sind handverlesen und laufen ungeprüft durch; geprüft
 * werden nur Universums-Kandidaten.
 */

/** Mindestkurs: darunter Penny-Stock-Spreads und Kursrundung als Kosten. */
export const MOMENTUM_MIN_PREIS = 5;
/**
 * Mindest-Tagesumsatz in $ (Median der letzten ~20 Handelstage).
 *
 * Bewusst über den 2 Mio. $ des Neubaus: Dessen Korb war ein fester Pool aus
 * bekannten Namen; hier kommt der Kandidat aus 12.800 Papieren, und gerade
 * die Spitze einer Momentum-Rangliste ist voll mit frisch gelaufenen
 * Kleinwerten. 5 Mio. $ hält eine Sockel-Order von einigen tausend Dollar
 * deutlich unter 0,1 % des Tagesumsatzes.
 */
export const MOMENTUM_MIN_DOLLAR_UMSATZ = 5_000_000;
/** So viele Universums-Kandidaten werden höchstens auf Umsatz geprüft (je ein Abruf). */
export const MOMENTUM_QUALITAET_FENSTER = 40;

/**
 * Gehebeltes oder inverses Produkt? Erkannt am Namen, wie Alpaca ihn führt
 * („Direxion Daily Semiconductor Bull 3X Shares", „ProShares UltraPro QQQ",
 * „T-Rex 2X Long MU Daily Target ETF"). Solche Produkte verlieren durch das
 * tägliche Rebalancing über Wochen Substanz (Volatility Decay) — für einen
 * Sockel, der Wochen hält, sind sie das falsche Werkzeug.
 */
export function istHebelProdukt(name: string): boolean {
  // „Short" allein reicht NICHT: „Vanguard Short-Term Bond ETF" ist ein
  // gewöhnlicher Anleihen-ETF. Inverse Produkte tragen zusätzlich einen der
  // anderen Marker oder heißen „ProShares Short …" bzw. „UltraShort".
  return /(\b[1-9](\.\d+)?x\b|-[1-9]x\b|\bultra(pro|short)?\b|\bleveraged\b|\binverse\b|\bbear\b|\bbull\b|\bdaily target\b|^proshares short\b)/i.test(
    name,
  );
}

export type QualitaetsGrund = 'hebel' | 'preis' | 'umsatz' | 'keine_daten';

export interface QualitaetsDaten {
  imKatalog: boolean;
  name: string;
  letzterKurs: number | null;
  /** Median von Schlusskurs × Volumen der letzten ~20 Tage; null = unbekannt. */
  medianDollarUmsatz: number | null;
}

/** Urteil über EINEN Kandidaten — `null` heißt zugelassen. */
export function qualitaetsMangel(d: QualitaetsDaten): QualitaetsGrund | null {
  if (d.imKatalog) return null;
  if (istHebelProdukt(d.name)) return 'hebel';
  if (!(d.letzterKurs !== null && d.letzterKurs >= MOMENTUM_MIN_PREIS)) return 'preis';
  if (d.medianDollarUmsatz === null) return 'keine_daten';
  if (d.medianDollarUmsatz < MOMENTUM_MIN_DOLLAR_UMSATZ) return 'umsatz';
  return null;
}

/** Median von Kurs × Volumen; `null`, wenn weniger als 10 brauchbare Tage. */
export function medianDollarUmsatz(bars: ReadonlyArray<{ close: number; volume: number }>): number | null {
  const werte = bars
    .slice(-20)
    .map((b) => b.close * b.volume)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (werte.length < 10) return null;
  const mitte = Math.floor(werte.length / 2);
  return werte.length % 2 === 1 ? werte[mitte]! : (werte[mitte - 1]! + werte[mitte]!) / 2;
}

export interface QualitaetsAuswahl<T extends { symbol: string }> {
  /** Die Rangliste OHNE die verworfenen Kandidaten, Reihenfolge unverändert. */
  zugelassen: T[];
  verworfen: Array<{ symbol: string; grund: QualitaetsGrund }>;
}

/**
 * Rangliste filtern. `mangel` liefert je Symbol das Urteil; Symbole, für die
 * er nicht gefragt wird (hinter dem Fenster), bleiben unverändert drin — das
 * Fenster begrenzt nur die Abrufe, nicht die Liste.
 */
export function filtereRangliste<T extends { symbol: string }>(
  ranked: readonly T[],
  mangel: (symbol: string) => QualitaetsGrund | null,
): QualitaetsAuswahl<T> {
  const zugelassen: T[] = [];
  const verworfen: Array<{ symbol: string; grund: QualitaetsGrund }> = [];
  for (const r of ranked) {
    const grund = mangel(r.symbol);
    if (grund === null) zugelassen.push(r);
    else verworfen.push({ symbol: r.symbol, grund });
  }
  return { zugelassen, verworfen };
}
