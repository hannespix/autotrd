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
