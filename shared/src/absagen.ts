/**
 * „Warum NICHT gekauft" — abgewiesene Einstiegssignale je Konto (Task 21,
 * Phase 2; Owner 09.10.: „die Entscheidungsgründe fürs Kaufen und NICHT
 * Kaufen … festhalten").
 *
 * Der Scan sieht ein Kauf- oder Leerverkaufssignal, aber ein Tor lässt den
 * Einstieg nicht zu (Positions-Deckel, Cooldown, Kostenhürde, Markt-Ampel,
 * News-/KI-Veto, Steckbrief …). Bisher stand das nur als Summe im
 * Herzschlag. Hier wird es je Konto, Handelstag und Symbol festgehalten —
 * REIN BEOBACHTEND: Die Handelsentscheidung ist schon gefallen, wenn
 * `absageMerken` läuft, und nichts hier fließt in sie zurück.
 *
 * Gespeichert werden nur feste Codes und Zahlen (keine Freitexte: Broker-
 * und Ausnahme-Meldungen können Kontodetails enthalten). Kein „was wäre
 * gewesen": dafür bräuchte es spätere Kurse.
 */

export const ABSAGE_V = 1;
/** So viele Handelstage bleiben gespeichert (Aufräumen in snapshotEquity). */
export const ABSAGE_TAGE = 14;

export const ABSAGE_GRUENDE = [
  'pos_limit',
  'cooldown_aktiv',
  'sockel_besitz',
  'live_verriegelt',
  'breaker_aktiv',
  'abgleich_drift',
  'fremdbestand',
  'pdt_schutz',
  'nicht_handelbar',
  'regime_stress',
  'regime_gegen_trend',
  'cluster_voll',
  'news_veto',
  'ki_veto',
  'klasse_aus',
  'unter_kosten',
  'filter_blockiert',
  /** Alle Tore passiert, aber die Ausführung scheiterte (Größe, Bargeld, Broker) — fester Code, nie der Freitext-Grund. */
  'ausfuehrung_abgelehnt',
] as const;
export type AbsageGrund = (typeof ABSAGE_GRUENDE)[number];

/** Die Zahlen, die zur Entscheidung gehörten — IMMER vollständig (fehlend = null), siehe absagenFeld. */
export interface AbsageZahlen {
  /** Erwarteter Gewinn der Bewegung nach Einfangquote, in % (costGate.edgePct). */
  erwartetPct: number | null;
  /** Roundtrip-Kosten in % (costGate.costPct). */
  kostenPct: number | null;
  /** Was die Bewegung mindestens bringen muss, in % (costGate.needPct). */
  noetigPct: number | null;
  /** Steckbrief: t-Wert und Zahl der Trades. */
  steckbriefT: number | null;
  steckbriefN: number | null;
  /** Positions-Deckel: offen / erlaubt. */
  offen: number | null;
  limit: number | null;
  /** Wartezeit nach dem letzten Trade in Minuten. */
  cooldownMin: number | null;
  /** Markt-Ampel beim Signal (trend | seitwaerts | stress). */
  regime: string | null;
}

const LEER: AbsageZahlen = {
  erwartetPct: null, kostenPct: null, noetigPct: null, steckbriefT: null, steckbriefN: null,
  offen: null, limit: null, cooldownMin: null, regime: null,
};

export interface AbsageMerk {
  symbol: string;
  seite: 'long' | 'short';
  grund: AbsageGrund;
  /** Regelwerk (Studio) oder Anzeichen-System. */
  weg: 'regelbaum' | 'konfluenz';
  z: AbsageZahlen;
}

const SYMBOL = /^(?!\.{1,2}$)[A-Za-z0-9.^=-]{1,24}$/;
const rund = (x: unknown, stellen = 2): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** stellen) / 10 ** stellen : null;

/** Vollständige Zahlen-Form aus einer Teilangabe — nur bekannte Felder, Zahlen gerundet. */
export function absageZahlen(teil: Partial<AbsageZahlen> = {}): AbsageZahlen {
  return {
    erwartetPct: rund(teil.erwartetPct),
    kostenPct: rund(teil.kostenPct),
    noetigPct: rund(teil.noetigPct),
    steckbriefT: rund(teil.steckbriefT),
    steckbriefN: rund(teil.steckbriefN, 0),
    offen: rund(teil.offen, 0),
    limit: rund(teil.limit, 0),
    cooldownMin: rund(teil.cooldownMin, 0),
    regime: typeof teil.regime === 'string' && /^[a-z_]{1,20}$/.test(teil.regime) ? teil.regime : null,
  };
}

/**
 * Eine Absage für diesen Scan vormerken. Je Symbol zählt der ERSTE Grund
 * des Scans — er ist der, an dem der Einstieg tatsächlich scheiterte.
 */
export function absageMerken(
  sammler: Map<string, AbsageMerk>,
  symbol: string,
  seite: 'long' | 'short',
  grund: AbsageGrund,
  weg: 'regelbaum' | 'konfluenz',
  z: Partial<AbsageZahlen> = {},
): void {
  if (!SYMBOL.test(symbol) || !(ABSAGE_GRUENDE as readonly string[]).includes(grund)) return;
  if (sammler.has(symbol)) return;
  sammler.set(symbol, { symbol, seite, grund, weg, z: absageZahlen(z) });
}

/**
 * Das merge-Feld für `users/{uid}/absagen/{tag}` — ein Schreibvorgang je
 * Konto und Scan. `z` steht IMMER vollständig darin: `set(merge)` mischt
 * verschachtelte Felder, sonst stünden alte Kostenzahlen neben einem
 * neuen Grund. `inc` ist FieldValue.increment (Server) bzw. ein Double.
 */
export function absagenFeld(
  sammler: ReadonlyMap<string, AbsageMerk>,
  tag: string,
  jetztIso: string,
  inc: (n: number) => unknown,
): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const a of sammler.values()) {
    s[a.symbol] = {
      grund: a.grund,
      seite: a.seite,
      weg: a.weg,
      zuletzt: jetztIso,
      n: inc(1),
      je: { [a.grund]: inc(1) },
      z: { ...LEER, ...a.z },
    };
  }
  return { v: ABSAGE_V, tag, at: jetztIso, s };
}

/** Ein gespeicherter Tageseintrag — beim Lesen erneut gegen die Whitelist geprüft. */
export interface AbsageEintrag {
  symbol: string;
  grund: AbsageGrund;
  seite: 'long' | 'short';
  weg: 'regelbaum' | 'konfluenz';
  zuletzt: string;
  /** In wie vielen Scans dieses Tages abgelehnt. */
  n: number;
  /** Anzahl je Grund (derselbe Wert kann an verschiedenen Toren gescheitert sein). */
  je: Partial<Record<AbsageGrund, number>>;
  z: AbsageZahlen;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function absageGespeichert(symbol: string, roh: unknown): AbsageEintrag | null {
  if (!SYMBOL.test(symbol) || !roh || typeof roh !== 'object') return null;
  const r = roh as Record<string, unknown>;
  const grund = r['grund'];
  if (typeof grund !== 'string' || !(ABSAGE_GRUENDE as readonly string[]).includes(grund)) return null;
  const zuletzt = r['zuletzt'];
  if (typeof zuletzt !== 'string' || !ISO.test(zuletzt)) return null;
  const n = typeof r['n'] === 'number' && Number.isFinite(r['n']) && r['n'] > 0 ? Math.round(r['n'] as number) : 1;
  const je: Partial<Record<AbsageGrund, number>> = {};
  const jeRoh = r['je'];
  if (jeRoh && typeof jeRoh === 'object') {
    for (const g of ABSAGE_GRUENDE) {
      const v = (jeRoh as Record<string, unknown>)[g];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) je[g] = Math.round(v);
    }
  }
  return {
    symbol,
    grund: grund as AbsageGrund,
    seite: r['seite'] === 'short' ? 'short' : 'long',
    weg: r['weg'] === 'regelbaum' ? 'regelbaum' : 'konfluenz',
    zuletzt,
    n,
    je,
    z: absageZahlen((r['z'] ?? {}) as Partial<AbsageZahlen>),
  };
}

/** Alle Einträge eines Tages-Docs, jüngste Absage zuerst. */
export function absagenAusTag(doc: unknown): AbsageEintrag[] {
  const s = doc && typeof doc === 'object' ? (doc as Record<string, unknown>)['s'] : null;
  if (!s || typeof s !== 'object') return [];
  return Object.entries(s as Record<string, unknown>)
    .map(([sym, roh]) => absageGespeichert(sym, roh))
    .filter((e): e is AbsageEintrag => e !== null)
    .sort((a, b) => (a.zuletzt < b.zuletzt ? 1 : a.zuletzt > b.zuletzt ? -1 : 0));
}
