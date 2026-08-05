/**
 * autotrd — Handelszeiten je Asset-Klasse (Depot-Vision, 2026-07-24).
 *
 * Das Tool handelt nicht nur US-Daytrading: Krypto läuft 24/7, Devisen und
 * Rohstoff-Futures quasi 24/5, Aktien/ETFs/Indizes zu US-Börsenzeiten.
 * Diese pure Funktion ersetzt das alte globale US-Gate im Scan: gescannt
 * und gehandelt wird je Symbol, dessen Klasse gerade offen ist.
 *
 * Vereinfachungen (bewusst, Datengranularität ist der Tages-Bar):
 *  - stocks_global (ADRs/US-Listings) und rates_bonds/ETFs → US-Zeiten.
 *  - commodities: tägliche Settlement-Pause (17–18 ET) wird ignoriert.
 * Alle Berechnungen DST-korrekt über Intl in America/New_York.
 */

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

interface EtParts {
  weekday: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  /** Stunde*100 + Minute, z. B. 09:30 → 930 */
  hm: number;
}

function etParts(now: Date): EtParts {
  const parts = ET_FMT.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday') as EtParts['weekday'],
    hm: (parseInt(get('hour'), 10) % 24) * 100 + parseInt(get('minute'), 10),
  };
}

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

/** Mo–Fr 09:30 ≤ t < 16:00 ET (klassisches US-Kassamarkt-Fenster). */
function usEquityOpen(p: EtParts): boolean {
  return WEEKDAYS.has(p.weekday) && p.hm >= 930 && p.hm < 1600;
}

/** ~24/5: zu von Fr 17:00 ET bis So 17:00 ET (Devisen/Futures-Wochenende). */
function nearly247Open(p: EtParts): boolean {
  if (p.weekday === 'Sat') return false;
  if (p.weekday === 'Fri' && p.hm >= 1700) return false;
  if (p.weekday === 'Sun' && p.hm < 1700) return false;
  return true;
}

/**
 * Ist die Asset-Klasse (Katalog-Schlüssel aus universe.ts) gerade handelbar?
 * Unbekannte Klassen fallen konservativ auf US-Börsenzeiten zurück.
 */
export function marketOpenForClass(assetClass: string, now: Date): boolean {
  const p = etParts(now);
  switch (assetClass) {
    case 'crypto':
      return true;
    case 'forex':
    case 'commodities':
      return nearly247Open(p);
    default:
      return usEquityOpen(p);
  }
}

/**
 * Nutzt die Klasse das US-Kassamarkt-Fenster? Genau diese Klassen kann die
 * BÖRSEN-UHR des Brokers (Alpaca `/v2/clock`) übersteuern — Krypto, Devisen
 * und Rohstoff-Futures haben eigene Uhren, für die Alpacas Antwort nichts
 * aussagt.
 */
export function usSessionClass(assetClass: string): boolean {
  return assetClass !== 'crypto' && assetClass !== 'forex' && assetClass !== 'commodities';
}

/**
 * Eine Ablesung der Broker-Uhr (Alpaca `/v2/clock`), wie sie in
 * `meta/alpacaClock` persistiert wird.
 *
 * Warum überhaupt: `usEquityOpen` kennt weder FEIERTAGE noch HALBTAGE
 * (Thanksgiving-Freitag, Heiligabend: Schluss 13:00 ET). Ohne die Uhr
 * scannt die Engine an Feiertagen ins Leere und — schlimmer — hält an
 * Halbtagen über einen Schluss, den sie nicht kommen sah.
 */
export interface BoersenUhr {
  isOpen: boolean;
  /** Nächste Öffnung laut Broker, ISO. Bei offenem Markt: die von MORGEN. */
  nextOpen: string;
  /** Nächster Schluss laut Broker, ISO. Bei geschlossenem Markt: der Schluss
   *  der KOMMENDEN Session (Alpaca liefert immer den nächsten in der Zukunft). */
  nextClose: string;
  /** Zeitpunkt der Ablesung, ISO. */
  at: string;
}

/**
 * Zustand JETZT aus einer (möglicherweise minutenalten) Ablesung ableiten.
 *
 * Die Ablesung enthält die nächsten Grenzpunkte — damit lässt sich der
 * Zustand exakt fortschreiben, bis das WISSEN endet:
 *
 *   offen:        jetzt < nextClose            → weiter offen
 *                 nextClose ≤ jetzt < nextOpen → inzwischen geschlossen
 *                 jetzt ≥ nextOpen             → null (nächster Schluss unbekannt)
 *   geschlossen:  jetzt < nextOpen             → weiter geschlossen
 *                 nextOpen ≤ jetzt < nextClose → inzwischen offen
 *                 jetzt ≥ nextClose            → null
 *
 * `null` heißt ausdrücklich „die Uhr weiß es nicht (mehr)" — der Aufrufer
 * fällt dann auf die eigene Kalenderrechnung zurück, statt zu raten. Eine
 * Ablesung älter als 24 h gilt grundsätzlich als verbraucht.
 */
export function boersenOffenLautUhr(
  uhr: BoersenUhr | null | undefined,
  nowMs: number,
): boolean | null {
  if (!uhr) return null;
  const at = Date.parse(uhr.at);
  if (!Number.isFinite(at) || nowMs - at > 24 * 3_600_000) return null;
  const nextOpen = Date.parse(uhr.nextOpen);
  const nextClose = Date.parse(uhr.nextClose);
  if (!Number.isFinite(nextOpen) || !Number.isFinite(nextClose)) return null;
  if (uhr.isOpen) {
    if (nowMs < nextClose) return true;
    if (nowMs < nextOpen) return false;
    return null;
  }
  if (nowMs < nextOpen) return false;
  if (nowMs < nextClose) return true;
  return null;
}
