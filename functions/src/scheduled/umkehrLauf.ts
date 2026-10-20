/**
 * KURZFRIST-UMKEHR (RSI-2) — Tagesläufe der aktiven Engine (Task 34,
 * Owner-Entscheidung 20.10.: „Alle auf RSI-2", Krypto inklusive).
 *
 * Zwei Läufe, wie beim Momentum-Sockel (Befund 05.10.: Orders bei
 * geschlossener Börse werden storniert):
 *
 *  - ABENDLAUF 16:45 ET (Mo–Fr): Tageskerzen holen, Signale auf den
 *    ABGESCHLOSSENEN Kerzen rechnen, je Konto einen Plan schreiben
 *    (`users/{uid}/meta/umkehrPlan`: was morgen gekauft und verkauft wird).
 *    Kein Handel. Beim ersten Lauf stellt er die Konten auf den neuen
 *    Modus um (Owner-Entscheidung), danach nie wieder.
 *  - MORGENLAUF 09:35 ET (Mo–Fr): den Plan zur Eröffnung ausführen —
 *    erst Verkäufe, dann Käufe in die freien Plätze. Nur bei offener
 *    Börse; an Feiertagen bleibt der Plan bis zum nächsten Handelstag.
 *
 * Was NICHT hier passiert: die Notbremse (−15 %, Krypto −25 %) prüft der
 * Minuten-Puls (riskPulse, `umkehrRisk`), Fill-Nachbuchungen macht der
 * 5-Minuten-Scan weiter — er eröffnet für diese Wallets nur nichts mehr.
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
  handelstageSeit,
  isStrategy,
  positionValue,
  tradableSymbols,
  umkehrAusstieg,
  umkehrBesitz,
  umkehrAuswahl,
  umkehrEinstieg,
  umkehrParameterFuer,
  umkehrPositionsWert,
  type Position,
  type Strategy,
  type UmkehrAusstiegGrund,
} from '../../../shared/src/index.js';
import { executeTrade, resolveBrokerMode } from '../core/broker.js';
import { kontoTore, symbolSperreAusVermerk } from '../core/kontoTore.js';
import { mayTrade } from '../core/access.js';
import { clampStrategyRisk, corePct } from '../core/rulesTrading.js';
import { getMarketSnapshot, getSparkBatch, mitGrenze, type DailyBar } from '../core/marketData.js';
import { boersenOffen } from '../core/marktUhr.js';

/** Klassen, die die Umkehr handelt — die handelbaren Katalog-Klassen. */
export const UMKEHR_KLASSEN = ['etf_regions', 'etf_sectors', 'etf_thematic', 'rates_bonds', 'stocks_us', 'crypto'] as const;

/** Ab diesem Alter gilt ein Plan als zu alt (lange Feiertage + Wochenende). */
export const PLAN_MAX_ALTER_TAGE = 4;

export function umkehrUniversum(): string[] {
  return [...new Set(UMKEHR_KLASSEN.flatMap((k) => tradableSymbols(k)))].sort();
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
 * Kerze ist ein UTC-Tag und am Abend ET noch offen.
 */
export function kerzenFuerSignal(klasse: string, bars: readonly DailyBar[], jetztMs: number): DailyBar[] {
  return klasse === 'crypto'
    ? abgeschlosseneKerzen(bars, kerzenTag('crypto', jetztMs), false)
    : abgeschlosseneKerzen(bars, kerzenTag('stocks_us', jetztMs), sitzungVorbei(jetztMs));
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
 * nie ein Symbol, das das Konto schon hält (Sockel, Altbestand, Umkehr).
 */
export function kontoPlan(
  positionen: ReadonlyMap<string, Position>,
  signale: ReadonlyArray<PlanKauf>,
  ausstiege: ReadonlyMap<string, UmkehrAusstiegGrund>,
  maxPositionen: number,
): { kaufen: PlanKauf[]; verkaufen: PlanVerkauf[] } {
  const eigene = [...positionen.entries()].filter(([, p]) => umkehrBesitz(p));
  const verkaufen: PlanVerkauf[] = [];
  for (const [sym] of eigene) {
    const grund = ausstiege.get(sym);
    if (grund) verkaufen.push({ symbol: sym, grund });
  }
  const frei = maxPositionen - (eigene.length - verkaufen.length);
  const offen = signale.filter((s) => !positionen.has(s.symbol));
  const gewaehlt = new Set(umkehrAuswahl(offen.map((s) => ({ symbol: s.symbol, rsi: s.rsi })), frei).map((k) => k.symbol));
  const kaufen = offen.filter((s) => gewaehlt.has(s.symbol)).sort((a, b) => a.rsi - b.rsi || (a.symbol < b.symbol ? -1 : 1));
  return { kaufen, verkaufen };
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
 * Einmalige Umstellung (Owner 20.10.: „Alle auf RSI-2"). Stellt jedes
 * Konto mit Konfluenz-Modus um; der Merker verhindert, dass ein späteres
 * bewusstes Zurückschalten im Einstellungs-Dialog überschrieben wird.
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
    const mode = roh.engine.mode ?? 'confluence';
    if (mode !== 'confluence') continue;
    await u.ref.update({ 'settings.strategy.engine.mode': 'umkehr' });
    n += 1;
  }
  await merker.set({ fertig: true, at: now.toISOString(), umgestellt: n }, { merge: true });
  logger.info(`Umkehr-Umstellung: ${n} Konto/Konten auf RSI-2 umgestellt`);
  return n;
}

/* ── Abendlauf ──────────────────────────────────────────────────────────── */

export async function runUmkehrAbend(now = new Date()): Promise<{ konten: number; signale: number; symbole: number; fehlend: number }> {
  const db = getFirestore();
  await umstellungEinmal(now).catch((err: unknown) => logger.warn('Umkehr-Umstellung gescheitert', err));
  const konten = await umkehrKonten();

  // Universum plus alles, was Umkehr-Konten halten (auch wenn es aus dem
  // Katalog gefallen ist — eine offene Position braucht ihr Ausstiegssignal).
  const gehalten = new Map<string, Map<string, Position>>();
  const extra = new Set<string>();
  for (const k of konten) {
    const ps = await k.ref.collection('positions').get();
    const m = new Map(ps.docs.map((d) => [d.id, d.data() as Position]));
    gehalten.set(k.id, m);
    for (const [sym, p] of m) if (umkehrBesitz(p)) extra.add(sym);
  }
  const symbole = [...new Set([...umkehrUniversum(), ...extra])];
  const kerzen = new Map<string, DailyBar[]>();
  const ergebnisse = await mitGrenze(symbole.map((s) => () => getMarketSnapshot(s, '1y')), 8);
  ergebnisse.forEach((r, i) => {
    if (r.status === 'fulfilled') kerzen.set(symbole[i]!, kerzenFuerSignal(classify(symbole[i]!), r.value.bars, now.getTime()));
  });
  const fehlend = symbole.length - kerzen.size;

  const signale: PlanKauf[] = [];
  for (const s of umkehrUniversum()) {
    const k = kerzen.get(s);
    if (!k) continue;
    const e = umkehrEinstieg(k.map((b) => b.close), umkehrParameterFuer(classify(s)));
    if (e.signal && e.rsi !== null && e.schluss !== null) signale.push({ symbol: s, rsi: Math.round(e.rsi * 100) / 100, schluss: e.schluss });
  }
  // Plan-Kennung: letzter Aktien-Kerzentag (SPY) — an Feiertagen der Vortag.
  const tag = kerzen.get('SPY')?.at(-1)?.date ?? kerzenTag('stocks_us', now.getTime());

  let geplant = 0;
  for (const k of konten) {
    try {
      const pos = gehalten.get(k.id) ?? new Map<string, Position>();
      const ausstiege = new Map<string, UmkehrAusstiegGrund>();
      for (const [sym, p] of pos) {
        if (!umkehrBesitz(p)) continue;
        const bars = kerzen.get(sym);
        if (!bars) continue; // ohne Kurse kein Urteil — die Notbremse bleibt scharf
        const klasse = classify(sym);
        const tage = handelstageSeit(kerzenTag(klasse, Date.parse(p.openedAt)), bars.map((b) => b.date));
        const g = umkehrAusstieg(bars.map((b) => b.close), tage, umkehrParameterFuer(klasse));
        if (g) ausstiege.set(sym, g);
      }
      const plan = kontoPlan(pos, signale, ausstiege, umkehrParameterFuer(null).maxPositionen);
      const voll: UmkehrPlan = { tag, erstelltAt: now.toISOString(), ...plan, ausgefuehrtAm: null };
      await k.ref.collection('meta').doc('umkehrPlan').set(voll);
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

/* ── Morgenlauf ─────────────────────────────────────────────────────────── */

export function planFrisch(plan: UmkehrPlan | undefined, now: Date): plan is UmkehrPlan {
  if (!plan || typeof plan.tag !== 'string' || typeof plan.erstelltAt !== 'string') return false;
  const alter = now.getTime() - Date.parse(plan.erstelltAt);
  return Number.isFinite(alter) && alter >= 0 && alter <= PLAN_MAX_ALTER_TAGE * 86_400_000;
}

/** Stückzahl: ganze Stücke bei Aktien/ETFs, Krypto auf 6 Stellen. */
export function umkehrStueck(wert: number, preis: number, klasse: string): number {
  if (!(wert > 0) || !(preis > 0)) return 0;
  const roh = wert / preis;
  return klasse === 'crypto' ? Math.floor(roh * 1e6) / 1e6 : Math.floor(roh);
}

export async function runUmkehrMorgen(now = new Date()): Promise<{ konten: number; kaeufe: number; verkaeufe: number; grund?: string }> {
  const db = getFirestore();
  if ((await boersenOffen(now.getTime())) === false) {
    logger.info('Umkehr-Morgenlauf: Börse zu (Feiertag) — Plan bleibt bis morgen');
    return { konten: 0, kaeufe: 0, verkaeufe: 0, grund: 'boerse_zu' };
  }
  const heute = kerzenTag('stocks_us', now.getTime());
  const konten = await umkehrKonten();
  let kaeufe = 0;
  let verkaeufe = 0;
  let bearbeitet = 0;
  for (const k of konten) {
    try {
      const planRef = k.ref.collection('meta').doc('umkehrPlan');
      const plan = (await planRef.get()).data() as UmkehrPlan | undefined;
      if (!planFrisch(plan, now)) continue;
      if (plan.ausgefuehrtAm === heute) continue; // schon gelaufen (Idempotenz)

      const roh = k.get('settings.strategy') as Strategy;
      const clamped = clampStrategyRisk(structuredClone(roh));
      const toreRoh = kontoTore(k, clamped, now);
      // PDT gilt nicht: Die Umkehr hält über Nacht, ein Kauf plant keinen Daytrade.
      const tore = toreRoh.einstieg === 'pdt_schutz' ? { ...toreRoh, einstieg: null } : toreRoh;
      if (tore.handel) {
        logger.info(`Umkehr-Morgenlauf ${k.id}: übersprungen — ${tore.handel}`);
        continue;
      }
      const laufId = `umk-${plan.tag}`;
      const posSnap = await k.ref.collection('positions').get();
      const alle = new Map(posSnap.docs.map((d) => [d.id, d.data() as Position]));
      const quotes = await getSparkBatch([...new Set([...alle.keys(), ...plan.kaufen.map((x) => x.symbol), ...plan.verkaufen.map((x) => x.symbol)])]);
      const preis = (s: string): number | null => {
        const q = quotes.get(s);
        return q && q.price > 0 ? q.price : null;
      };

      // 1) Verkäufe — nie durch Einstiegs-Tore blockiert.
      for (const v of plan.verkaufen) {
        const p = alle.get(v.symbol);
        if (!p || !umkehrBesitz(p)) continue;
        const px = preis(v.symbol) ?? p.avgEntry;
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

      // 2) Käufe in die freien Plätze.
      if (!tore.einstieg) {
        // Kontostand FRISCH nach den Verkäufen — der Snapshot von oben kennt
        // die Erlöse noch nicht und unterschätzte die Positionsgröße.
        let equity = ((await k.ref.get()).get('wallet.paperBalance') as number | undefined) ?? 0;
        for (const [sym, p] of alle) equity += positionValue(p, preis(sym));
        const wert = umkehrPositionsWert(equity, corePct(clamped));
        let belegt = [...alle.values()].filter((p) => umkehrBesitz(p)).length;
        const max = umkehrParameterFuer(null).maxPositionen;
        for (const kauf of plan.kaufen) {
          if (belegt >= max) break;
          if (alle.has(kauf.symbol)) continue;
          if (symbolSperreAusVermerk(k.get('risk.abgleich'), kauf.symbol, now)) continue;
          const px = preis(kauf.symbol);
          if (px === null) continue;
          const klasse = classify(kauf.symbol);
          const qty = umkehrStueck(wert, px, klasse);
          if (!(qty > 0)) continue;
          const r = await executeTrade(
            {
              uid: k.id,
              symbol: kauf.symbol,
              side: 'buy',
              price: px,
              qty,
              source: 'engine',
              assetClass: klasse,
              quelle: 'umkehr',
              bucket: bucketKey({ assetClass: klasse, timeframe: 'daily', signature: 'umkehr', side: 'long' }),
              signalContext: { typ: 'umkehr' },
            },
            clamped,
            laufId,
          );
          if (r.executed) {
            kaeufe += 1;
            belegt += 1;
          }
        }
      }
      await planRef.set({ ausgefuehrtAm: heute, ausgefuehrtAt: now.toISOString(), einstiegGesperrt: tore.einstieg ?? null }, { merge: true });
      bearbeitet += 1;
    } catch (err) {
      logger.warn(`Umkehr-Morgenlauf: Konto ${k.id} übersprungen`, err);
    }
  }
  await db.doc('meta/umkehr').set({ morgen: { at: now.toISOString(), konten: bearbeitet, kaeufe, verkaeufe } }, { merge: true });
  logger.info(`Umkehr-Morgenlauf: ${bearbeitet} Konto/Konten, ${kaeufe} Kauf/Käufe, ${verkaeufe} Verkauf/Verkäufe`);
  return { konten: bearbeitet, kaeufe, verkaeufe };
}

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
