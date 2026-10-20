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
  const out: KaufAuftrag[] = [];
  let rest = Number.isFinite(bargeld) ? bargeld : 0;
  for (const k of kaufen) {
    if (out.length >= freiePlaetze) break;
    const px = preis(k.symbol);
    if (px === null || !(px > 0)) continue;
    const qty = umkehrStueck(Math.min(zielWert, rest * BARGELD_ANTEIL), px, classify(k.symbol));
    if (!(qty > 0)) continue;
    out.push({ symbol: k.symbol, qty, preis: px });
    rest -= qty * px;
  }
  return out;
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
): Promise<{ kaeufe: number; verkaeufe: number }> {
  let kaeufe = 0;
  let verkaeufe = 0;
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
  if (einstiegGesperrt || kaufen.length === 0) return { kaeufe, verkaeufe };
  // Kontostand FRISCH nach den Verkäufen — der Snapshot von oben kennt die Erlöse nicht.
  const frisch = await k.ref.get();
  const buchCash = (frisch.get('wallet.paperBalance') as number | undefined) ?? 0;
  // Broker-Konten: das sichere Bargeld (kleiner aus Buch und Broker-Abgleich).
  const bargeld = kapitalDeckel(frisch.get('risk.abgleich'), buchCash, now.toISOString());
  let equity = buchCash;
  for (const [sym, p] of alle) equity += positionValue(p, preis(sym));
  const belegt = [...alle.values()].filter((p) => umkehrBesitz(p)).length;
  const frei = umkehrParameterFuer(null).maxPositionen - belegt;
  const auftraege = kaufAuftraege(
    kaufen.filter((x) => !alle.has(x.symbol) && !symbolSperreAusVermerk(k.get('risk.abgleich'), x.symbol, now)),
    preis,
    bargeld,
    umkehrPositionsWert(equity, corePct(clamped)),
    frei,
  );
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
  }
  return { kaeufe, verkaeufe };
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
  const db = getFirestore();
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
  await db.doc('meta/umkehr').set(
    {
      abend: {
        at: now.toISOString(),
        tag,
        konten: geplant,
        symbole: symbole.length,
        fehlend,
        signale: [...signale].sort((a, b) => a.rsi - b.rsi).slice(0, 30).map((s) => ({ symbol: s.symbol, rsi: s.rsi })),
        signaleN: signale.length,
      },
    },
    { merge: true },
  );
  logger.info(`Umkehr-Abendlauf: ${signale.length} Signal(e), ${geplant} Konto/Konten geplant, ${fehlend} ohne Kurse`);
  return { konten: geplant, signale: signale.length, symbole: symbole.length, fehlend };
}

/* ── Morgenlauf (Börse) ─────────────────────────────────────────────────── */

export async function runUmkehrMorgen(now = new Date()): Promise<{ konten: number; kaeufe: number; verkaeufe: number; grund?: string }> {
  const db = getFirestore();
  if ((await boersenOffen(now.getTime())) === false) {
    logger.info('Umkehr-Morgenlauf: Börse zu (Feiertag) — Plan bleibt bis morgen');
    return { konten: 0, kaeufe: 0, verkaeufe: 0, grund: 'boerse_zu' };
  }
  const heute = kerzenTag('stocks_us', now.getTime());
  let kaeufe = 0;
  let verkaeufe = 0;
  let bearbeitet = 0;
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
      bearbeitet += 1;
    } catch (err) {
      if (err instanceof KeineKurse) {
        // Nichts gehandelt — Stempel zurück, der nächste Lauf darf den Plan noch ausführen.
        await k.ref.collection('meta').doc('umkehrPlan').set({ ausgefuehrtAm: null }, { merge: true }).catch(() => undefined);
      }
      logger.warn(`Umkehr-Morgenlauf: Konto ${k.id} übersprungen`, err);
    }
  }
  await db.doc('meta/umkehr').set({ morgen: { at: now.toISOString(), konten: bearbeitet, kaeufe, verkaeufe } }, { merge: true });
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
  const tag = kerzen.get('BTC-USD')?.at(-1)?.date ?? kerzenTag('crypto', now.getTime() - 86_400_000);

  let kaeufe = 0;
  let verkaeufe = 0;
  let bearbeitet = 0;
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
      bearbeitet += 1;
    } catch (err) {
      if (err instanceof KeineKurse) {
        await k.ref.collection('meta').doc('umkehrKrypto').set({ tag: null }, { merge: true }).catch(() => undefined);
      }
      logger.warn(`Umkehr-Kryptolauf: Konto ${k.id} übersprungen`, err);
    }
  }
  await db.doc('meta/umkehr').set(
    {
      krypto: {
        at: now.toISOString(),
        tag,
        konten: bearbeitet,
        kaeufe,
        verkaeufe,
        signale: signale.map((s) => ({ symbol: s.symbol, rsi: s.rsi })),
      },
    },
    { merge: true },
  );
  logger.info(`Umkehr-Kryptolauf: ${signale.length} Signal(e), ${kaeufe} Kauf/Käufe, ${verkaeufe} Verkauf/Verkäufe`);
  return { konten: bearbeitet, signale: signale.length, kaeufe, verkaeufe };
}

/* Optionen je Lauf ausgeschrieben (nicht per Spread): Der Tresor-Wächter
 * liest je onSchedule-Block, ob BROKER_MASTER_KEY gebunden ist. */
export const umkehrAbend = onSchedule(
  { schedule: '45 16 * * 1-5', timeZone: 'America/New_York', retryCount: 0, timeoutSeconds: 540, memory: '512MiB', secrets: ['BROKER_MASTER_KEY'] },
  async () => {
    await runUmkehrAbend();
  },
);

export const umkehrMorgen = onSchedule(
  { schedule: '35 9 * * 1-5', timeZone: 'America/New_York', retryCount: 0, timeoutSeconds: 540, memory: '512MiB', secrets: ['BROKER_MASTER_KEY'] },
  async () => {
    await runUmkehrMorgen();
  },
);

export const umkehrKrypto = onSchedule(
  { schedule: '10 0 * * *', timeZone: 'UTC', retryCount: 0, timeoutSeconds: 540, memory: '512MiB', secrets: ['BROKER_MASTER_KEY'] },
  async () => {
    await runUmkehrKrypto();
  },
);
