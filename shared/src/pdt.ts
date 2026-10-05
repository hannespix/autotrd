/**
 * PDT-Regel (Pattern Day Trader) — Einstiegs-Bremse für kleine Broker-Konten.
 *
 * Gilt nur für US-Aktien-Daytrades: Krypto und der Wochen-Sockel sind
 * ausgenommen (die Aufrufer entscheiden das, Prüfbefund 05.10.).
 *
 * FINRA: Ein Margin-Konto unter 25.000 $ Equity darf in fünf Handelstagen
 * höchstens drei Daytrades machen (Kauf und Verkauf desselben Papiers am
 * selben Tag). Der vierte markiert das Konto als Pattern Day Trader — bei
 * Alpaca folgen 90 Tage ohne Daytrades. Alpacas eigener Schutz lehnt die
 * Order ab, die der vierte wäre — und das kann ein AUSSTIEG sein.
 *
 * Bis 05.10. wurde `pattern_day_trader` nur angezeigt; der Handelspfad prüfte
 * nichts (Red-Team-Befund). Der Scan kaufte auf einem 2.000-$-Konto einen
 * Kleinwert und verkaufte ihn fünf Minuten später wieder.
 *
 * Die Bremse sperrt nur EINSTIEGE, und erst ab drei Daytrades: Bis dahin
 * bleibt jeder neue Einstieg samt Ausstieg am selben Tag erlaubt. Exits
 * sperrt sie nie (Grundregel: Exits nie erschweren).
 */

export const PDT_EQUITY_GRENZE = 25_000;
export const PDT_MAX_DAYTRADES = 3;
/** Älter als das ist ein Stand nicht mehr belastbar — dann bremst nichts. */
export const PDT_STAND_MAX_STD = 24;

export interface PdtStand {
  /** `daytrade_count` des Brokers: Daytrades der letzten fünf Handelstage. */
  daytrades: number;
  /** Equity zum VORTAGESSCHLUSS (`last_equity`) — daran misst der Broker die
   *  25.000-$-Grenze, nicht am Intraday-Stand. */
  equity: number;
  /** `pattern_day_trader` des Brokers. */
  markiert: boolean;
  /** Zeitpunkt der Ablesung (ISO). */
  at: string;
}

/**
 * Sollen neue Einstiege gesperrt werden? Ohne frischen, lesbaren Stand: nein
 * — ein fehlender Abgleich darf den Handel nicht still lahmlegen.
 *
 * `heuteEroeffnet`: heute eröffnete, noch offene Broker-Positionen (ohne
 * Krypto). Jeder Ausstieg aus ihnen am selben Tag wäre ein weiterer Daytrade
 * — wer nur die schon GEMACHTEN zählt, lässt bei Zähler 2 noch mehrere neue
 * Positionen zu, deren Stops dann der Broker ablehnt (Prüfbefund 05.10.).
 */
export function pdtEinstiegGesperrt(stand: unknown, jetzt: Date, heuteEroeffnet = 0): boolean {
  if (typeof stand !== 'object' || stand === null) return false;
  const s = stand as Partial<PdtStand>;
  if (typeof s.at !== 'string' || typeof s.equity !== 'number' || !(s.equity > 0)) return false;
  const alter = jetzt.getTime() - Date.parse(s.at);
  if (!Number.isFinite(alter) || alter > PDT_STAND_MAX_STD * 3_600_000) return false;
  if (s.equity >= PDT_EQUITY_GRENZE) return false;
  if (s.markiert === true) return true;
  return typeof s.daytrades === 'number' && s.daytrades + Math.max(0, heuteEroeffnet) >= PDT_MAX_DAYTRADES;
}
