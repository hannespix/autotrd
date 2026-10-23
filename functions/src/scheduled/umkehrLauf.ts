/**
 * KURZFRIST-UMKEHR (RSI-2) — Tagesläufe der aktiven Engine (Task 34,
 * Owner-Entscheidung 20.10.: „Alle auf RSI-2", Krypto inklusive).
 *
 * Drei Läufe, damit jede Klasse dieselbe Zeitlogik hat wie die Rückrechnung
 * (Signal am Schluss t, Kauf zur Eröffnung t+1, erste Ausstiegsprüfung am
 * Schluss t+1):
 *
 *  - ABENDLAUF 16:45 ET (Mo–Fr), Aktien/ETFs: Tageskerzen holen, Signale
 *    auf den ABGESCHLOSSENEN Kerzen rechnen, je Konto einen Plan schreiben
 *    (`users/{uid}/meta/umkehrPlan`). Kein Handel. Beim ersten Lauf stellt
 *    er die Paper-Konten auf den neuen Modus um (Owner-Entscheidung).
 *  - MORGENLAUF 09:35 ET (Mo–Fr): den Plan zur Eröffnung ausführen — erst
 *    Verkäufe, dann Käufe in die freien Plätze. Nur bei offener Börse, jeder
 *    Plan genau EINMAL.
 *  - KRYPTOLAUF 00:10 UTC (täglich): Die Krypto-Tageskerze ist ein UTC-Tag.
 *    Direkt nach ihrem Schluss rechnen und sofort handeln — Krypto handelt
 *    rund um die Uhr. Ein Abend-/Morgen-Paar wie bei Aktien läge 1,5 Tage
 *    neben der Rückrechnung und am Wochenende gar nicht (Red-Team H1).
 *
 * Was NICHT hier passiert: die Notbremse (−15 %, Krypto −25 %) prüft der
 * Minuten-Puls (`umkehrRisk`), Fill-Nachbuchungen macht der 5-Minuten-Scan
 * weiter — er eröffnet für diese Wallets nur nichts mehr.
 *
 * Die Regel selbst ist pur in shared/src/umkehr.ts und dort gegen die
 * Python-Rückrechnung gepinnt (Parität Tag für Tag).
 */
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  abgeschlosseneKerzen,
  bucketKey,
  classify,
  clusterHasRoom,
  handelstageSeit,
  isStrategy,
  klemmeGewicht,
  positionValue,
  tradableSymbols,
  umkehrAusstieg,
  umkehrAuswahl,
  umkehrBesitz,
  umkehrEinstieg,
  umkehrParameterFuer,
  umkehrPositionsWert,
  type Position,
  type Strategy,
  type UmkehrAusstiegGrund,
} from '../../../shared/src/index.js';
import { executeTrade, kapitalDeckel, resolveBrokerMode } from '../core/broker.js';
import { kontoTore, symbolSperreAusVermerk } from '../core/kontoTore.js';
import { mayTrade } from '../core/access.js';
import { clampStrategyRisk, corePct } from '../core/rulesTrading.js';
import { getMarketSnapshot, getSparkBatch, mitGrenze, type DailyBar } from '../core/marketData.js';
import { boersenOffen } from '../core/marktUhr.js';

/** Klassen, die die Umkehr handelt — die handelbaren Katalog-Klassen. */
export const UMKEHR_KLASSEN = ['etf_regions', 'etf_sectors', 'etf_thematic', 'rates_bonds', 'stocks_us', 'crypto'] as const;

/**
 * Bewusst NICHT gehandelt (Red-Team M5): Geldmarkt-/Kurzläufer-Anleihen
 * (BIL, SHY) und breite Anleihe-Körbe (AGG, LQD, TIP) schwanken so wenig,
 * dass ihr RSI-2 bei Kleinstbewegungen auf nahe 0 fällt — sie gewännen die
 * Rangliste „tiefster RSI zuerst" und belegten Plätze mit fast null
 * Erwartung, aber voller Gebühr. Rohstoff-Futures-ETFs (USO, UNG) tragen
 * Roll-Verluste, die keine Tageskerze zeigt. Keiner davon war in der
 * Rückrechnung.
 */
export const UMKEHR_AUSGESCHLOSSEN: ReadonlySet<string> = new Set(['BIL', 'SHY', 'AGG', 'LQD', 'TIP', 'USO', 'UNG']);

/** Ab diesem Alter gilt ein Plan als zu alt (lange Feiertage + Wochenende). */
export const PLAN_MAX_ALTER_TAGE = 4;

/** Bargeld-Puffer: Ein Kauf nutzt höchstens diesen Anteil des freien Bargelds (Kursabweichung bis zum Fill). */
export const BARGELD_ANTEIL = 0.98;

const istKrypto = (s: string): boolean => classify(s) === 'crypto';

export function umkehrUniversum(teil: 'alle' | 'krypto' | 'boerse' = 'alle'): string[] {
  const alle = [...new Set(UMKEHR_KLASSEN.flatMap((k) => tradableSymbols(k)))].filter((s) => !UMKEHR_AUSGESCHLOSSEN.has(s));
  const t = teil === 'krypto' ? alle.filter(istKrypto) : teil === 'boerse' ? alle.filter((s) => !istKrypto(s)) : alle;
  return t.sort();
}

const tagIn = (zeitzone: string, ms: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zeitzone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** ET-Tag (Börse) bzw. UTC-Tag (Krypto-Kerzen bei Yahoo) eines Zeitpunkts. */
export function kerzenTag(klasse: string, ms: number): string {
  return tagIn(klasse === 'crypto' ? 'UTC' : 'America/New_York', ms);
}

/** Ist die US-Sitzung des ET-Tages vorbei (ab 16:00 ET)? */
export function sitzungVorbei(jetztMs: number): boolean {
  const teile = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(jetztMs));
  const h = Number(teile.find((t) => t.type === 'hour')?.value);
  const m = Number(teile.find((t) => t.type === 'minute')?.value);
  return h * 60 + m >= 16 * 60;
}

/**
 * Welche Kerzen gelten als abgeschlossen? Aktien/ETFs: die heutige erst
 * nach 16:00 ET — der planmäßige Abendlauf (16:45) behält sie, ein
 * Anstoß beim Deploy während der Sitzung schneidet sie ab. Krypto: Die
 * Kerze ist ein UTC-Tag; die laufende fällt immer weg (der Kryptolauf um
 * 00:10 UTC rechnet also auf dem gerade geschlossenen Tag).
 */
export function kerzenFuerSignal(klasse: string, bars: readonly DailyBar[], jetztMs: number): DailyBar[] {
  return klasse === 'crypto'
    ? abgeschlosseneKerzen(bars, kerzenTag('crypto', jetztMs), false)
    : abgeschlosseneKerzen(bars, kerzenTag('stocks_us', jetztMs), sitzungVorbei(jetztMs));
}

/**
 * Schlusskurse für die Regel: dividendenbereinigt, wie die Rückrechnung
 * (Red-Team M4) — aber nur, wenn JEDE Kerze den bereinigten Wert trägt.
 * Eine gemischte Reihe wäre an der Nahtstelle ein Kurssprung.
 */
export function regelSchluesse(bars: readonly DailyBar[]): number[] {
  return bars.length > 0 && bars.every((b) => typeof b.adjClose === 'number')
    ? bars.map((b) => b.adjClose!)
    : bars.map((b) => b.close);
}

export interface PlanKauf { symbol: string; rsi: number; schluss: number }
export interface PlanVerkauf { symbol: string; grund: UmkehrAusstiegGrund }
export interface UmkehrPlan {
  /** Letzter Kerzentag (ET) der Aktien-Daten — die Kennung des Plans. */
  tag: string;
  erstelltAt: string;
  kaufen: PlanKauf[];
  verkaufen: PlanVerkauf[];
  ausgefuehrtAm?: string | null;
}

/**
 * Plan eines Kontos aus den Signalen (pur): Verkäufe für eigene
 * Umkehr-Positionen mit Ausstiegssignal, Käufe in die freien Plätze —
 * nie ein Symbol, das das Konto schon hält (Sockel, Altbestand, Umkehr),
 * nie in eine abgeschaltete Klasse (`erlaubt`) und nie mehr als
 * MAX_PER_CLUSTER Positionen eines Korrelationsblocks über das GANZE Depot
 * (Red-Team M6: im Ausverkauf feuern QQQ, XLK, SMH, NVDA … gemeinsam).
 */
export function kontoPlan(
  positionen: ReadonlyMap<string, Position>,
  signale: ReadonlyArray<PlanKauf>,
  ausstiege: ReadonlyMap<string, UmkehrAusstiegGrund>,
  maxPositionen: number,
  erlaubt: (symbol: string) => boolean = () => true,
): { kaufen: PlanKauf[]; verkaufen: PlanVerkauf[] } {
  const eigene = [...positionen.entries()].filter(([, p]) => umkehrBesitz(p));
  const verkaufen: PlanVerkauf[] = [];
  for (const [sym] of eigene) {
    const grund = ausstiege.get(sym);
    if (grund) verkaufen.push({ symbol: sym, grund });
  }
  const verkauft = new Set(verkaufen.map((v) => v.symbol));
  let frei = maxPositionen - (eigene.length - verkaufen.length);
  const offen = signale.filter((s) => !positionen.has(s.symbol) && erlaubt(s.symbol));
  const reihe = umkehrAuswahl(offen.map((s) => ({ symbol: s.symbol, rsi: s.rsi })), offen.length);
  // Klumpen-Limit innerhalb der UMKEHR (Red-Team-Nachprüfung): Sockel und
  // Altbestand mitzuzählen hätte bei drei Sockel-Aktien jede Umkehr-Aktie
  // gesperrt. Doppelte Symbole verhindert `positionen.has` oben ohnehin.
  const depot = eigene.map(([s]) => s).filter((s) => !verkauft.has(s));
  const kaufen: PlanKauf[] = [];
  for (const k of reihe) {
    if (frei <= 0) break;
    if (!clusterHasRoom(depot, k.symbol)) continue;
    kaufen.push(offen.find((s) => s.symbol === k.symbol)!);
    depot.push(k.symbol);
    frei -= 1;
  }
  return { kaufen, verkaufen };
}

/** Stückzahl: ganze Stücke bei Aktien/ETFs, Krypto auf 6 Stellen. */
export function umkehrStueck(wert: number, preis: number, klasse: string): number {
  if (!(wert > 0) || !(preis > 0)) return 0;
  const roh = wert / preis;
  return klasse === 'crypto' ? Math.floor(roh * 1e6) / 1e6 : Math.floor(roh);
}

export interface KaufAuftrag { symbol: string; qty: number; preis: number }

/**
 * Kaufaufträge aus dem Plan (pur): je Platz der Zielwert, aber nie mehr
 * als das freie Bargeld (Red-Team M2: Mit fester Stückzahl gibt es beim
 * Broker keinen Kapital-Deckel — die Order füllte auf Kredit). Das Bargeld
 * wird je Auftrag verbraucht, als füllten alle.
 */
export function kaufAuftraege(
  kaufen: ReadonlyArray<PlanKauf>,
  preis: (symbol: string) => number | null,
  bargeld: number,
  zielWert: number,
  freiePlaetze: number,
): KaufAuftrag[] {
  return kaufAuftraegeMitGrund(kaufen, preis, bargeld, zielWert, freiePlaetze).auftraege;
}

/**
 * Wie `kaufAuftraege`, zählt aber, WARUM ein Kandidat leer ausging
 * (23.10.: 6× „kein Bargeld oder Platz" bei 4 Käufen — der Sammelzähler
 * konnte nicht sagen, ob Altbestand das Kapital bindet).
 */
export function kaufAuftraegeMitGrund(
  kaufen: ReadonlyArray<PlanKauf>,
  preis: (symbol: string) => number | null,
  bargeld: number,
  zielWert: number,
  freiePlaetze: number,
): { auftraege: KaufAuftrag[]; keinKurs: number; keinPlatz: number; keinBargeld: number } {
  const auftraege: KaufAuftrag[] = [];
  let keinKurs = 0;
  let keinPlatz = 0;
  let keinBargeld = 0;
  let rest = Number.isFinite(bargeld) ? bargeld : 0;
  for (const k of kaufen) {
    if (auftraege.length >= freiePlaetze) {
      keinPlatz += 1;
      continue;
    }
    const px = preis(k.symbol);
    if (px === null || !(px > 0)) {
      keinKurs += 1;
      continue;
    }
    const qty = umkehrStueck(Math.min(zielWert, rest * BARGELD_ANTEIL), px, classify(k.symbol));
    if (!(qty > 0)) {
      keinBargeld += 1;
      continue;
    }
    auftraege.push({ symbol: k.symbol, qty, preis: px });
    rest -= qty * px;
  }
  return { auftraege, keinKurs, keinPlatz, keinBargeld };
}

/** Median (für die anonymen Kapital-Kennzahlen); leere Liste ⇒ null. */
export function median(werte: readonly number[]): number | null {
  const w = werte.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (w.length === 0) return null;
  const m = Math.floor(w.length / 2);
  return w.length % 2 === 1 ? w[m]! : (w[m - 1]! + w[m]!) / 2;
}

export function planFrisch(plan: UmkehrPlan | undefined, now: Date): plan is UmkehrPlan {
  if (!plan || typeof plan.tag !== 'string' || typeof plan.erstelltAt !== 'string') return false;
  const alter = now.getTime() - Date.parse(plan.erstelltAt);
  return Number.isFinite(alter) && alter >= 0 && alter <= PLAN_MAX_ALTER_TAGE * 86_400_000;
}

/** Konten, die die Umkehr handeln (Paper, freigeschaltet, laufend). */
async function umkehrKonten(): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const db = getFirestore();
  const snap = await db.collection('users').where('settings.strategy.engine.mode', '==', 'umkehr').get();
  return snap.docs.filter((d) => {
    const roh = d.get('settings.strategy') as Strategy | undefined;
    return !!roh && isStrategy(roh) && roh.engine.running === true && resolveBrokerMode(roh) === 'paper' && mayTrade(d.data());
  });
}

/**
 * Einmalige Umstellung (Owner 20.10.: „Alle auf RSI-2"). Nur PAPER-Konten
 * im Konfluenz-Modus: Ein Echtgeld-Konto bekommt eine neue Strategie nie
 * still. Der Merker verhindert, dass ein späteres bewusstes Zurückschalten
 * überschrieben wird; bricht der Lauf mittendrin ab, holt der nächste den
 * Rest nach (der Merker steht erst am Ende).
 */
export async function umstellungEinmal(now: Date): Promise<number> {
  const db = getFirestore();
  const merker = db.doc('meta/umkehrUmstellung');
  if ((await merker.get()).get('fertig') === true) return 0;
  const users = await db.collection('users').get();
  let n = 0;
  for (const u of users.docs) {
    const roh = u.get('settings.strategy') as Strategy | undefined;
    if (!roh || !isStrategy(roh)) continue;
    if ((roh.engine.mode ?? 'confluence') !== 'confluence') continue;
    // Den EINGESTELLTEN Modus prüfen, nicht den wirksamen: Ohne
    // ALLOW_LIVE löst `resolveBrokerMode` auch ein Live-Konto zu 'paper' auf
    // (Red-Team-Nachprüfung) — umgestellt würde es trotzdem.
    if (roh.broker.mode === 'live' || resolveBrokerMode(roh) !== 'paper') continue;
    await u.ref.update({ 'settings.strategy.engine.mode': 'umkehr' });
    n += 1;
  }
  await merker.set({ fertig: true, at: now.toISOString(), umgestellt: n }, { merge: true });
  logger.info(`Umkehr-Umstellung: ${n} Paper-Konto/Konten auf RSI-2 umgestellt`);
  return n;
}

/** Klasse vom Auto-Regler bzw. Owner abgeschaltet? Dann kauft auch die Umkehr dort nicht. */
const klasseErlaubt = (clamped: Strategy) => (symbol: string): boolean =>
  klemmeGewicht(clamped.engine.classWeights?.[classify(symbol)]) > 0;

async function ladeKerzen(symbole: readonly string[], now: Date): Promise<Map<string, DailyBar[]>> {
  const kerzen = new Map<string, DailyBar[]>();
  const ergebnisse = await mitGrenze(symbole.map((s) => () => getMarketSnapshot(s, '1y')), 8);
  ergebnisse.forEach((r, i) => {
    if (r.status === 'fulfilled') kerzen.set(symbole[i]!, kerzenFuerSignal(classify(symbole[i]!), r.value.bars, now.getTime()));
  });
  return kerzen;
}

function signaleAus(kerzen: ReadonlyMap<string, DailyBar[]>, symbole: readonly string[]): PlanKauf[] {
  const out: PlanKauf[] = [];
  for (const s of symbole) {
    const k = kerzen.get(s);
    if (!k) continue;
    const e = umkehrEinstieg(regelSchluesse(k), umkehrParameterFuer(classify(s)));
    if (e.signal && e.rsi !== null && e.schluss !== null) out.push({ symbol: s, rsi: Math.round(e.rsi * 100) / 100, schluss: e.schluss });
  }
  return out;
}

/** Ausstiegssignale der eigenen Umkehr-Positionen einer Teilmenge (Börse oder Krypto). */
function ausstiegeAus(pos: ReadonlyMap<string, Position>, kerzen: ReadonlyMap<string, DailyBar[]>, teil: (s: string) => boolean): Map<string, UmkehrAusstiegGrund> {
  const out = new Map<string, UmkehrAusstiegGrund>();
  for (const [sym, p] of pos) {
    if (!umkehrBesitz(p) || !teil(sym)) continue;
    const bars = kerzen.get(sym);
    if (!bars) continue; // ohne Kurse kein Urteil — die Notbremse bleibt scharf
    const klasse = classify(sym);
    const tage = handelstageSeit(kerzenTag(klasse, Date.parse(p.openedAt)), bars.map((b) => b.date));
    const g = umkehrAusstieg(regelSchluesse(bars), tage, umkehrParameterFuer(klasse));
    if (g) out.set(sym, g);
  }
  return out;
}

export class KeineKurse extends Error {
  constructor() {
    super('keine Kurse');
  }
}

/**
 * Einen Plan für ein Konto ausführen: erst Verkäufe (nie durch Einstiegs-
 * Tore blockiert; ohne frischen Kurs übersprungen — Red-Team M3: ein
 * Verkauf zum Einstand wäre ein erfundener Kurs), dann Käufe in die
 * freien Plätze, gedeckelt durch das Bargeld NACH den Verkäufen.
 */
async function fuehreAus(
  k: FirebaseFirestore.QueryDocumentSnapshot,
  clamped: Strategy,
  einstiegGesperrt: boolean,
  verkaufen: ReadonlyArray<PlanVerkauf>,
  kaufen: ReadonlyArray<PlanKauf>,
  laufId: string,
  now: Date,
): Promise<{ kaeufe: number; verkaeufe: number; ohne: OhneKauf; anteile?: KapitalAnteile }> {
  let kaeufe = 0;
  let verkaeufe = 0;
  const ohne = leerOhneKauf();
  const posSnap = await k.ref.collection('positions').get();
  const alle = new Map(posSnap.docs.map((d) => [d.id, d.data() as Position]));
  const quotes = await getSparkBatch([...new Set([...alle.keys(), ...kaufen.map((x) => x.symbol), ...verkaufen.map((x) => x.symbol)])]);
  const preis = (s: string): number | null => {
    const q = quotes.get(s);
    return q && q.price > 0 ? q.price : null;
  };
  // Kursquelle ausgefallen (leere Antwort statt Fehler): nichts handeln und
  // das dem Aufrufer sagen — sonst gälte der Plan als erledigt.
  if (quotes.size === 0 && (verkaufen.length > 0 || kaufen.length > 0)) throw new KeineKurse();

  // 1) Verkäufe
  for (const v of verkaufen) {
    const p = alle.get(v.symbol);
    if (!p || !umkehrBesitz(p)) continue;
    const px = preis(v.symbol);
    if (px === null) continue;
    const r = await executeTrade(
      { uid: k.id, symbol: v.symbol, side: 'sell', price: px, source: 'engine', riskExit: v.grund, assetClass: classify(v.symbol) },
      clamped,
      laufId,
    );
    if (r.executed) {
      verkaeufe += 1;
      if (r.trade?.teilSchluss !== true) alle.delete(v.symbol);
    }
  }

  // 2) Käufe
  if (einstiegGesperrt) ohne.gesperrt += kaufen.length;
  if (einstiegGesperrt || kaufen.length === 0) return { kaeufe, verkaeufe, ohne };
  // (Anteile erst ab hier: Ohne Kaufabsicht misst die Kennzahl nichts, was blockiert.)
  // Kontostand FRISCH nach den Verkäufen — der Snapshot von oben kennt die Erlöse nicht.
  const frisch = await k.ref.get();
  const buchCash = (frisch.get('wallet.paperBalance') as number | undefined) ?? 0;
  // Broker-Konten: das sichere Bargeld (kleiner aus Buch und Broker-Abgleich).
  const bargeld = kapitalDeckel(frisch.get('risk.abgleich'), buchCash, now.toISOString());
  let equity = buchCash;
  let altbestand = 0;
  let sockel = 0;
  for (const [sym, p] of alle) {
    const wert = positionValue(p, preis(sym));
    equity += wert;
    if (p.core === true) sockel += wert;
    else if (!umkehrBesitz(p)) altbestand += wert;
  }
  const anteile: KapitalAnteile | undefined =
    equity > 0 ? { bargeld: (bargeld / equity) * 100, altbestand: (altbestand / equity) * 100, sockel: (sockel / equity) * 100 } : undefined;
  const belegt = [...alle.values()].filter((p) => umkehrBesitz(p)).length;
  const frei = umkehrParameterFuer(null).maxPositionen - belegt;
  const kandidaten = kaufen.filter((x) => !alle.has(x.symbol) && !symbolSperreAusVermerk(k.get('risk.abgleich'), x.symbol, now));
  ohne.gehalten += kaufen.length - kandidaten.length;
  const wahl = kaufAuftraegeMitGrund(
    kandidaten,
    preis,
    bargeld,
    umkehrPositionsWert(equity, corePct(clamped)),
    frei,
  );
  const auftraege = wahl.auftraege;
  ohne.keinKurs += wahl.keinKurs;
  ohne.keinPlatz += wahl.keinPlatz;
  ohne.keinBargeld += wahl.keinBargeld;
  for (const a of auftraege) {
    const klasse = classify(a.symbol);
    const r = await executeTrade(
      {
        uid: k.id,
        symbol: a.symbol,
        side: 'buy',
        price: a.preis,
        qty: a.qty,
        source: 'engine',
        assetClass: klasse,
        quelle: 'umkehr',
        bucket: bucketKey({ assetClass: klasse, timeframe: 'daily', signature: 'umkehr', side: 'long' }),
        signalContext: { typ: 'umkehr' },
      },
      clamped,
      laufId,
    );
    if (r.executed) kaeufe += 1;
    else ohne.abgelehnt += 1;
  }
  ohne.bargeldOderPlatz += kandidaten.length - auftraege.length;
  return { kaeufe, verkaeufe, ohne, ...(anteile ? { anteile } : {}) };
}

/**
 * Warum geplante Käufe NICHT ausgeführt wurden — öffentlich, nur Anzahlen
 * (21.10.: erster Morgenlauf, 2 Signale × 7 Konten, aber 5 Käufe; ohne
 * Zähler ist „kein Bargeld" von „gesperrt" nicht zu unterscheiden).
 */
export interface OhneKauf {
  /** Einstiegs-Tor zu (Tages-Notbremse, Abgleich-Sperre). */
  gesperrt: number;
  /** Symbol inzwischen gehalten oder einzeln gesperrt. */
  gehalten: number;
  /** Kein Kurs, zu wenig Bargeld für ein Stück oder kein freier Platz (Summe der drei unten). */
  bargeldOderPlatz: number;
  /** Aufgeschlüsselt (23.10.): ohne Kurs, ohne freien Platz, Bargeld reicht nicht für ein Stück. */
  keinKurs: number;
  keinPlatz: number;
  keinBargeld: number;
  /** Ausführung abgelehnt (Buchung/Broker). */
  abgelehnt: number;
}
export const leerOhneKauf = (): OhneKauf => ({ gesperrt: 0, gehalten: 0, bargeldOderPlatz: 0, keinKurs: 0, keinPlatz: 0, keinBargeld: 0, abgelehnt: 0 });
const summiereOhne = (a: OhneKauf, b: OhneKauf): void => {
  a.gesperrt += b.gesperrt;
  a.gehalten += b.gehalten;
  a.bargeldOderPlatz += b.bargeldOderPlatz;
  a.keinKurs += b.keinKurs;
  a.keinPlatz += b.keinPlatz;
  a.keinBargeld += b.keinBargeld;
  a.abgelehnt += b.abgelehnt;
};

/**
 * Wofür das Kapital eines Kontos zur Eröffnung gebunden ist, in % des
 * Kontowerts (nur Konten mit Kaufabsicht). Öffentlich nur als MEDIAN über
 * alle Konten — keine Kontodaten (meta/** ist öffentlich lesbar).
 */
export interface KapitalAnteile {
  bargeld: number;
  /** Positionen außerhalb von Umkehr und Sockel (z. B. aus der Konfluenz-Zeit). */
  altbestand: number;
  sockel: number;
}

/**
 * Ist die jüngste Krypto-Kerze der gerade abgeschlossene UTC-Tag? Am
 * 21.10. lieferte Yahoo um 00:10 UTC die Kerze des Vortags noch nicht —
 * der Lauf rechnete auf vorgestern. Dann lieber nicht handeln und den
 * nächsten Versuch (02:10, 04:10 UTC) abwarten.
 */
export function kryptoKerzeFrisch(tag: string, nowMs: number): boolean {
  return tag === kerzenTag('crypto', nowMs - 86_400_000);
}

/**
 * Darf ein Kryptoversuch den öffentlichen Stand überschreiben? Ab dem
 * ersten frischen Versuch eines Tages sind alle Konten gestempelt; die
 * späteren Versuche desselben Tages bearbeiten keins mehr und würden das
 * Ergebnis des handelnden Laufs mit Nullen überdecken.
 */
export function kryptoStandErsetzen(alt: { tag?: unknown; veraltet?: unknown } | undefined, tag: string, bearbeitet: number): boolean {
  return bearbeitet > 0 || !(alt?.tag === tag && alt?.veraltet === false);
}

/**
 * Öffentlichen Stand eines Laufs ERSETZEN statt verschmelzen: Mit
 * `merge: true` blieben Felder eines früheren Laufs stehen (22.10.: das
 * „2 Käufe" vom Vortag stand neben „veraltet"). `mergeFields` tauscht den
 * Teilbaum komplett und lässt die anderen Läufe unberührt.
 */
function standSchreiben(teil: 'abend' | 'morgen' | 'krypto', wert: Record<string, unknown>): Promise<unknown> {
  return getFirestore().doc('meta/umkehr').set({ [teil]: wert }, { mergeFields: [teil] });
}

function toreFuer(k: FirebaseFirestore.QueryDocumentSnapshot, now: Date): { clamped: Strategy; handel: string | null; einstieg: string | null } {
  const roh = k.get('settings.strategy') as Strategy;
  const clamped = clampStrategyRisk(structuredClone(roh));
  const t = kontoTore(k, clamped, now);
  // PDT gilt nicht: Die Umkehr hält über Nacht, ein Kauf plant keinen Daytrade.
  return { clamped, handel: t.handel, einstieg: t.einstieg === 'pdt_schutz' ? null : t.einstieg };
}

/* ── Abendlauf (Börse) ──────────────────────────────────────────────────── */

export async function runUmkehrAbend(now = new Date()): Promise<{ konten: number; signale: number; symbole: number; fehlend: number }> {
  await umstellungEinmal(now).catch((err: unknown) => logger.warn('Umkehr-Umstellung gescheitert', err));
  const konten = await umkehrKonten();
  const boerse = (s: string): boolean => !istKrypto(s);

  const gehalten = new Map<string, Map<string, Position>>();
  const extra = new Set<string>();
  for (const k of konten) {
    const ps = await k.ref.collection('positions').get();
    const m = new Map(ps.docs.map((d) => [d.id, d.data() as Position]));
    gehalten.set(k.id, m);
    for (const [sym, p] of m) if (umkehrBesitz(p) && boerse(sym)) extra.add(sym);
  }
  const universum = umkehrUniversum('boerse');
  const symbole = [...new Set([...universum, ...extra])];
  const kerzen = await ladeKerzen(symbole, now);
  const fehlend = symbole.length - kerzen.size;
  const signale = signaleAus(kerzen, universum);
  // Plan-Kennung: letzter Aktien-Kerzentag (SPY) — an Feiertagen der Vortag.
  const tag = kerzen.get('SPY')?.at(-1)?.date ?? kerzenTag('stocks_us', now.getTime());

  let geplant = 0;
  for (const k of konten) {
    try {
      const planRef = k.ref.collection('meta').doc('umkehrPlan');
      const alt = (await planRef.get()).data() as UmkehrPlan | undefined;
      // Derselbe Kerzentag ist schon gehandelt (Deploy-Anstoß vor 16:00 ET
      // rechnet auf gestrigen Kerzen): nicht mit ausgefuehrtAm = null
      // überschreiben, sonst handelte der nächste Morgen ihn ein zweites Mal.
      if (alt?.tag === tag && alt.ausgefuehrtAm) continue;
      const { clamped } = toreFuer(k, now);
      const pos = gehalten.get(k.id) ?? new Map<string, Position>();
      const plan = kontoPlan(pos, signale, ausstiegeAus(pos, kerzen, boerse), umkehrParameterFuer(null).maxPositionen, klasseErlaubt(clamped));
      const voll: UmkehrPlan = { tag, erstelltAt: now.toISOString(), ...plan, ausgefuehrtAm: null };
      await planRef.set(voll);
      geplant += 1;
    } catch (err) {
      logger.warn(`Umkehr-Abendlauf: Konto ${k.id} übersprungen`, err);
    }
  }

  // Öffentlicher Stand: Signale sind Marktinformation (Katalog-Symbole),
  // keine Kontodaten — Anzahlen und die Kandidatenliste, keine Positionen.
  await standSchreiben('abend', {
    at: now.toISOString(),
    tag,
    konten: geplant,
    symbole: symbole.length,
    fehlend,
    signale: [...signale].sort((a, b) => a.rsi - b.rsi).slice(0, 30).map((s) => ({ symbol: s.symbol, rsi: s.rsi })),
    signaleN: signale.length,
  });
  logger.info(`Umkehr-Abendlauf: ${signale.length} Signal(e), ${geplant} Konto/Konten geplant, ${fehlend} ohne Kurse`);
  return { konten: geplant, signale: signale.length, symbole: symbole.length, fehlend };
}

/* ── Morgenlauf (Börse) ─────────────────────────────────────────────────── */

/** Letzter abgeschlossener Aktien-Kerzentag (SPY) zum Zeitpunkt `now`. */
async function letzterHandelstag(now: Date): Promise<string | null> {
  const snap = await getMarketSnapshot('SPY', '1mo');
  return kerzenFuerSignal('etf_regions', snap.bars, now.getTime()).at(-1)?.date ?? null;
}

/** Muss der Morgen den Abendplan nachholen? (pur) */
export function planNachholenNoetig(abendTag: string | null | undefined, letzterTag: string | null): boolean {
  return letzterTag !== null && abendTag !== letzterTag;
}

/** Abendplan nachholen, wenn er für den letzten abgeschlossenen Handelstag fehlt. */
async function abendNachholen(now: Date): Promise<boolean> {
  const abendTag = (await getFirestore().doc('meta/umkehr').get()).get('abend.tag') as string | undefined;
  const letzter = await letzterHandelstag(now);
  if (!planNachholenNoetig(abendTag, letzter)) return false;
  logger.warn(`Umkehr-Morgenlauf: Abendplan fehlt für ${letzter} (vorhanden: ${abendTag ?? 'keiner'}) — wird jetzt gerechnet`);
  await runUmkehrAbend(now);
  return true;
}

export async function runUmkehrMorgen(now = new Date()): Promise<{ konten: number; kaeufe: number; verkaeufe: number; grund?: string }> {
  if ((await boersenOffen(now.getTime())) === false) {
    logger.info('Umkehr-Morgenlauf: Börse zu (Feiertag) — Plan bleibt bis morgen');
    return { konten: 0, kaeufe: 0, verkaeufe: 0, grund: 'boerse_zu' };
  }
  const heute = kerzenTag('stocks_us', now.getTime());
  /* Nachholen (21.10.): Der planmäßige Abendlauf 16:45 ET hinterließ keine
   * Spur — der Morgen hätte den Plan vom Vortag (schon ausgeführt) gesehen
   * und nichts gehandelt. Deshalb prüft der Morgen selbst, ob ein Plan für
   * den letzten ABGESCHLOSSENEN Handelstag existiert, und rechnet ihn sonst
   * jetzt: Um 09:35 ET ist die gestrige Kerze sicher final, die heutige
   * schneidet `kerzenFuerSignal` ab — Signal am Schluss t, Kauf zur
   * Eröffnung t+1, genau wie die Rückrechnung. */
  const nachgeholt = await abendNachholen(now).catch((err: unknown) => {
    logger.warn('Umkehr-Morgenlauf: Plan-Nachholen gescheitert', err);
    return false;
  });
  let kaeufe = 0;
  let verkaeufe = 0;
  let bearbeitet = 0;
  const ohne = leerOhneKauf();
  const anteile: KapitalAnteile[] = [];
  for (const k of await umkehrKonten()) {
    try {
      const planRef = k.ref.collection('meta').doc('umkehrPlan');
      const plan = (await planRef.get()).data() as UmkehrPlan | undefined;
      if (!planFrisch(plan, now)) continue;
      // Jeder Plan genau EINMAL (Red-Team M1): Fällt ein Abendlauf aus, darf
      // der gestrige Plan nicht ein zweites Mal kaufen — auf einem Signal,
      // das 2–4 Tage alt ist, oder in eine gerade gebremste Position zurück.
      if (plan.ausgefuehrtAm) continue;
      const tore = toreFuer(k, now);
      if (tore.handel) {
        logger.info(`Umkehr-Morgenlauf ${k.id}: übersprungen — ${tore.handel}`);
        continue;
      }
      // Stempel VOR dem Handel: Bricht der Lauf mitten im Konto ab, kauft
      // ein Neustart nicht doppelt (Doppelkauf-Sperre und Order-Kennung
      // decken den Rest).
      await planRef.set({ ausgefuehrtAm: heute, ausgefuehrtAt: now.toISOString(), einstiegGesperrt: tore.einstieg ?? null }, { merge: true });
      const r = await fuehreAus(k, tore.clamped, tore.einstieg !== null, plan.verkaufen, plan.kaufen, `umk-${plan.tag}`, now);
      kaeufe += r.kaeufe;
      verkaeufe += r.verkaeufe;
      summiereOhne(ohne, r.ohne);
      if (r.anteile) anteile.push(r.anteile);
      bearbeitet += 1;
    } catch (err) {
      if (err instanceof KeineKurse) {
        // Nichts gehandelt — Stempel zurück, der nächste Lauf darf den Plan noch ausführen.
        await k.ref.collection('meta').doc('umkehrPlan').set({ ausgefuehrtAm: null }, { merge: true }).catch(() => undefined);
      }
      logger.warn(`Umkehr-Morgenlauf: Konto ${k.id} übersprungen`, err);
    }
  }
  const rund = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);
  await standSchreiben('morgen', {
    at: now.toISOString(),
    konten: bearbeitet,
    kaeufe,
    verkaeufe,
    ohneKauf: ohne,
    planNachgeholt: nachgeholt,
    // Anonym: nur Mediane über die Konten mit Kaufabsicht (23.10.).
    kapital: {
      n: anteile.length,
      bargeldMedianPct: rund(median(anteile.map((a) => a.bargeld))),
      altbestandMedianPct: rund(median(anteile.map((a) => a.altbestand))),
      sockelMedianPct: rund(median(anteile.map((a) => a.sockel))),
    },
  });
  logger.info(`Umkehr-Morgenlauf: ${bearbeitet} Konto/Konten, ${kaeufe} Kauf/Käufe, ${verkaeufe} Verkauf/Verkäufe`);
  return { konten: bearbeitet, kaeufe, verkaeufe };
}

/* ── Kryptolauf (täglich, direkt nach Schluss der UTC-Kerze) ─────────────── */

export async function runUmkehrKrypto(now = new Date()): Promise<{ konten: number; signale: number; kaeufe: number; verkaeufe: number }> {
  const db = getFirestore();
  const konten = await umkehrKonten();
  const krypto = (s: string): boolean => istKrypto(s);
  const gehalten = new Map<string, Map<string, Position>>();
  const extra = new Set<string>();
  for (const k of konten) {
    const ps = await k.ref.collection('positions').get();
    const m = new Map(ps.docs.map((d) => [d.id, d.data() as Position]));
    gehalten.set(k.id, m);
    for (const [sym, p] of m) if (umkehrBesitz(p) && krypto(sym)) extra.add(sym);
  }
  const universum = umkehrUniversum('krypto');
  const kerzen = await ladeKerzen([...new Set([...universum, ...extra])], now);
  const signale = signaleAus(kerzen, universum);
  // Kennung: der gerade geschlossene UTC-Tag (letzte abgeschlossene Kerze).
  const tag = kerzen.get('BTC-USD')?.at(-1)?.date ?? '';
  if (!kryptoKerzeFrisch(tag, now.getTime())) {
    const soll = kerzenTag('crypto', now.getTime() - 86_400_000);
    logger.info(`Umkehr-Kryptolauf: jüngste Kerze ${tag || 'fehlt'} statt ${soll} — kein Handel, nächster Versuch`);
    await standSchreiben('krypto', { at: now.toISOString(), tag, soll, veraltet: true });
    return { konten: 0, signale: 0, kaeufe: 0, verkaeufe: 0 };
  }

  let kaeufe = 0;
  let verkaeufe = 0;
  let bearbeitet = 0;
  const ohne = leerOhneKauf();
  for (const k of konten) {
    try {
      const stand = k.ref.collection('meta').doc('umkehrKrypto');
      if ((await stand.get()).get('tag') === tag) continue; // je UTC-Tag genau einmal
      const tore = toreFuer(k, now);
      if (tore.handel) continue;
      await stand.set({ tag, at: now.toISOString() });
      const pos = gehalten.get(k.id) ?? new Map<string, Position>();
      const plan = kontoPlan(pos, signale, ausstiegeAus(pos, kerzen, krypto), umkehrParameterFuer('crypto').maxPositionen, klasseErlaubt(tore.clamped));
      const r = await fuehreAus(k, tore.clamped, tore.einstieg !== null, plan.verkaufen, plan.kaufen, `umk-${tag}`, now);
      kaeufe += r.kaeufe;
      verkaeufe += r.verkaeufe;
      summiereOhne(ohne, r.ohne);
      bearbeitet += 1;
    } catch (err) {
      if (err instanceof KeineKurse) {
        await k.ref.collection('meta').doc('umkehrKrypto').set({ tag: null }, { merge: true }).catch(() => undefined);
      }
      logger.warn(`Umkehr-Kryptolauf: Konto ${k.id} übersprungen`, err);
    }
  }
  const alt = (await db.doc('meta/umkehr').get()).get('krypto') as { tag?: unknown; veraltet?: unknown } | undefined;
  if (kryptoStandErsetzen(alt, tag, bearbeitet)) {
    await standSchreiben('krypto', {
      at: now.toISOString(),
      tag,
      konten: bearbeitet,
      kaeufe,
      verkaeufe,
      ohneKauf: ohne,
      veraltet: false,
      signale: signale.map((s) => ({ symbol: s.symbol, rsi: s.rsi })),
    });
  }
  logger.info(`Umkehr-Kryptolauf: ${signale.length} Signal(e), ${kaeufe} Kauf/Käufe, ${verkaeufe} Verkauf/Verkäufe`);
  return { konten: bearbeitet, signale: signale.length, kaeufe, verkaeufe };
}

/* Optionen je Lauf ausgeschrieben (nicht per Spread): Der Tresor-Wächter
 * liest je onSchedule-Block, ob BROKER_MASTER_KEY gebunden ist.
 *
 * Speicher (22.10., gemessen): Der Abendlauf brach am 21. und 22.10.
 * planmäßig und bei Deploy-Anstößen mit „Memory limit of 512 MiB exceeded
 * with 517–595 MiB used" ab — gelegentlich lief er knapp durch. Abend und
 * Morgen (der den Abend nachholt) bekommen 1 GiB; der Kryptolauf lädt nur
 * ~13 Coins und blieb darunter. */
export const umkehrAbend = onSchedule(
  { schedule: '45 16 * * 1-5', timeZone: 'America/New_York', retryCount: 0, timeoutSeconds: 540, memory: '1GiB', secrets: ['BROKER_MASTER_KEY'] },
  async () => {
    await runUmkehrAbend();
  },
);

export const umkehrMorgen = onSchedule(
  { schedule: '35 9 * * 1-5', timeZone: 'America/New_York', retryCount: 0, timeoutSeconds: 540, memory: '1GiB', secrets: ['BROKER_MASTER_KEY'] },
  async () => {
    await runUmkehrMorgen();
  },
);

export const umkehrKrypto = onSchedule(
  // Versuche alle zwei Stunden bis 14:10 UTC: Yahoo lieferte die
  // Vortageskerze am 22.10. selbst um 04:10 UTC noch nicht, mittags schon.
  // Gehandelt wird beim ersten frischen Versuch, je UTC-Tag nur einmal.
  { schedule: '10 0-14/2 * * *', timeZone: 'UTC', retryCount: 0, timeoutSeconds: 540, memory: '512MiB', secrets: ['BROKER_MASTER_KEY'] },
  async () => {
    await runUmkehrKrypto();
  },
);
