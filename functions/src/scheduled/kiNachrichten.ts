/**
 * kiNachrichten — KI-Kaskade Stufe 2a (05.10.): frische Meldungen sichten,
 * eindeutige skeptisch gegenprüfen, je Meldung EIN Urteil ablegen.
 *
 * Der pure Teil (Auswahl, Prompts, Schemas, Parser, Kosten, Budget) steht in
 * `shared/src/kiNachrichten.ts` samt Begründung. Hier ist das IO:
 *
 *   1. Teilnehmende Konten bestimmen (Engine an, freigeschaltet,
 *      `signals.kiNachrichten !== false`) — sie definieren Budget und
 *      Relevanz (Watchlist ∪ Bestand).
 *   2. Unentschiedene Meldungen der letzten `KI_MAX_ALTER_MIN` lesen; jede,
 *      die nicht bewertet wird, bekommt trotzdem ein Urteil MIT GRUND.
 *   3. Sichtung (gebündelt, geringe Denktiefe), dann Gegenprobe für die
 *      eindeutig starken (hohe Denktiefe, mit Kurskontext).
 *   4. Urteile append-only nach `kiUrteile/{id}` (create; ein paralleler
 *      Lauf scheitert am Dokument, statt zu überschreiben).
 *
 * ── Was hier NICHT passiert ───────────────────────────────────────────────
 *
 * Keine Order, kein Stop, keine Strategie-Änderung. Die Urteile sind Daten;
 * Stufe 2b liest sie mit festen Regeln. Fällt dieser Lauf aus, handelt das
 * System exakt wie vorher.
 *
 * ── Budget (Owner 05.10.: 2 $ je Konto) ───────────────────────────────────
 *
 * Gemeinsamer Tagestopf `admin/kiBudget` (server-only; Kosten gehören nicht
 * ins öffentliche `meta/*`). Jeder Aufruf startet nur, wenn der Topf auch
 * die konservative Schätzung noch trägt; gebucht wird danach der gemessene
 * Betrag aus `usage`. Beim ersten Mal „reicht nicht" an einem Tag geht eine
 * Nachricht in den Faden jedes Admins — einmal je Tag, transaktional.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  KI_MAX_ALTER_MIN,
  KI_NACHRICHTEN_MODELL,
  KI_NACHRICHTEN_PROMPT_V,
  PRUEFUNG_MAX_JE_LAUF,
  PRUEFUNG_MAX_TOKENS,
  PRUEFUNG_SCHEMA,
  PRUEFUNG_SYSTEM,
  SCHAETZUNG_PRUEFUNG_USD,
  SCHAETZUNG_SICHTUNG_USD,
  SICHTUNG_MAX_PAARE,
  SICHTUNG_MAX_TOKENS,
  SICHTUNG_SCHEMA,
  SICHTUNG_SYSTEM,
  auswahlGrund,
  budgetLimitUsd,
  budgetNachricht,
  budgetReicht,
  budgetTag,
  classify,
  endUrteil,
  isStrategy,
  kostenUsd,
  parsePruefung,
  parseSichtung,
  pruefKandidaten,
  pruefungEingabe,
  sichtungEingabe,
  type KiAuslassGrund,
  type KiMeldung,
  type KiUsage,
  type Kurskontext,
  type PruefUrteil,
  type SichtungsPaar,
  type SichtungsUrteil,
  type Strategy,
  type SymbolUrteil,
} from '../../../shared/src/index.js';
import { mayTrade } from '../core/access.js';
import { envSchluessel, type FetchLike } from '../core/alpacaBroker.js';
import { holeLetzteKurse } from '../core/alpacaNews.js';

/* ── Modell-Aufruf (injizierbar für Tests) ──────────────────────────────── */

export interface KiAnfrage {
  system: string;
  eingabe: string;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
}

export interface KiAntwort {
  /** `refusal` = auch die Rückfall-Kette lehnte ab. */
  stopReason: string | null;
  text: string;
  usage: KiUsage;
  /** Das Modell, das tatsächlich antwortete (Rückfall möglich) — bestimmt den Preis. */
  modell: string;
}

export type KiAufruf = (a: KiAnfrage) => Promise<KiAntwort>;

/**
 * Der echte Aufruf: strukturierte Ausgabe (festes JSON-Schema) und
 * serverseitiger Rückfall bei einer Sicherheits-Ablehnung (`fallbacks:
 * 'default'`, Anthropic wählt je Ablehnungs-Kategorie das Ersatzmodell).
 * Der Systemprompt ist fest und wird gecacht — er ist bei jedem Lauf gleich.
 */
export function anthropicAufruf(apiKey: string): KiAufruf {
  const client = new Anthropic({ apiKey });
  return async (a) => {
    const antwort = await client.beta.messages.create({
      model: KI_NACHRICHTEN_MODELL,
      max_tokens: a.maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: a.effort, format: { type: 'json_schema', schema: a.schema } },
      system: [{ type: 'text', text: a.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: a.eingabe }],
    });
    const text = antwort.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { stopReason: antwort.stop_reason, text, usage: antwort.usage, modell: antwort.model };
  };
}

/* ── Konten, Relevanz ───────────────────────────────────────────────────── */

export interface Teilnehmer {
  uids: Set<string>;
  relevant: Set<string>;
}

async function teilnehmerLesen(): Promise<Teilnehmer> {
  const db = getFirestore();
  const uids = new Set<string>();
  const relevant = new Set<string>();
  const users = await db.collection('users').where('settings.strategy.engine.running', '==', true).get();
  for (const u of users.docs) {
    const s = u.get('settings.strategy') as Strategy | undefined;
    if (!s || !isStrategy(s) || !mayTrade(u.data())) continue;
    if (s.signals.kiNachrichten === false) continue;
    uids.add(u.id);
    for (const sym of s.watchlist) relevant.add(sym);
  }
  if (uids.size > 0) {
    // Bestand der Teilnehmer (Sockel ausgenommen — den führt der Momentum-Lauf).
    const pos = await db.collectionGroup('positions').select('core').get();
    for (const p of pos.docs) {
      const uid = p.ref.parent.parent?.id;
      if (uid && uids.has(uid) && p.get('core') !== true) relevant.add(p.id);
    }
  }
  return { uids, relevant };
}

/* ── Budget ─────────────────────────────────────────────────────────────── */

interface BudgetStand {
  tag: string;
  verbrauchtUsd: number;
}

async function budgetLesen(tag: string): Promise<BudgetStand> {
  const snap = await getFirestore().doc('admin/kiBudget').get();
  const v = snap.get('tag') === tag ? Number(snap.get('verbrauchtUsd') ?? 0) : 0;
  return { tag, verbrauchtUsd: Number.isFinite(v) ? v : 0 };
}

/** Gemessene Kosten buchen — transaktional, Tageswechsel setzt zurück. */
async function budgetBuchen(tag: string, limitUsd: number, konten: number, usd: number): Promise<number> {
  const db = getFirestore();
  const ref = db.doc('admin/kiBudget');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const gleich = snap.get('tag') === tag;
    const alt = gleich ? Number(snap.get('verbrauchtUsd') ?? 0) : 0;
    const neu = Math.round(((Number.isFinite(alt) ? alt : 0) + usd) * 1_000_000) / 1_000_000;
    tx.set(ref, {
      tag,
      verbrauchtUsd: neu,
      limitUsd,
      konten,
      aufrufe: (gleich ? Number(snap.get('aufrufe') ?? 0) : 0) + 1,
      gemeldetAt: gleich ? (snap.get('gemeldetAt') ?? null) : null,
      at: new Date().toISOString(),
    });
    return neu;
  });
}

/** Einmal je Tag den Admins melden, dass das Budget erreicht ist. */
async function budgetMelden(tag: string, verbrauchtUsd: number, limitUsd: number, konten: number): Promise<boolean> {
  const db = getFirestore();
  const ref = db.doc('admin/kiBudget');
  const erstes = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get('tag') === tag && snap.get('gemeldetAt')) return false;
    tx.set(ref, { tag, gemeldetAt: new Date().toISOString(), ...(snap.get('tag') === tag ? {} : { verbrauchtUsd, limitUsd, konten, aufrufe: 0 }) }, { merge: true });
    return true;
  });
  if (!erstes) return false;
  const admins = await db.collection('users').where('admin', '==', true).get();
  const text = budgetNachricht(tag, verbrauchtUsd, limitUsd, konten);
  for (const a of admins.docs) {
    await a.ref.collection('nachrichten').add({ von: 'admin', text, at: new Date().toISOString() });
  }
  return true;
}

/* ── Lauf ───────────────────────────────────────────────────────────────── */

export interface KiLaufErgebnis {
  grund: null | 'kein_schluessel' | 'fehler';
  konten: number;
  entschieden: number;
  bewertet: number;
  geprueft: number;
  handlungsfaehig: number;
  ausgelassen: Partial<Record<KiAuslassGrund, number>>;
  budgetErreicht: boolean;
}

export interface KiLaufAbhaengigkeiten {
  aufruf?: KiAufruf;
  jetzt?: () => Date;
  fetchImpl?: FetchLike;
  teilnehmer?: () => Promise<Teilnehmer>;
}

export async function runKiNachrichten(abh: KiLaufAbhaengigkeiten = {}): Promise<KiLaufErgebnis> {
  const db = getFirestore();
  const jetzt = abh.jetzt ?? (() => new Date());
  const standRef = db.doc('meta/kiNachrichten');
  const ergebnis: KiLaufErgebnis = {
    grund: null, konten: 0, entschieden: 0, bewertet: 0, geprueft: 0, handlungsfaehig: 0, ausgelassen: {}, budgetErreicht: false,
  };
  const schluessel = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!abh.aufruf && !schluessel) {
    await standRef.set({ letzterLauf: jetzt().toISOString(), grund: 'kein_schluessel' }, { merge: true });
    return { ...ergebnis, grund: 'kein_schluessel' };
  }
  const aufruf = abh.aufruf ?? anthropicAufruf(schluessel);

  try {
    const { uids, relevant } = await (abh.teilnehmer ?? teilnehmerLesen)();
    ergebnis.konten = uids.size;
    const limitUsd = budgetLimitUsd(uids.size);
    const tag = budgetTag(jetzt());
    const budget = await budgetLesen(tag);

    // Unentschiedene Meldungen der letzten Minuten — älteste zuerst.
    const ab = new Date(jetzt().getTime() - (KI_MAX_ALTER_MIN + 15) * 60_000).toISOString();
    const snap = await db.collection('marktNachrichten').where('firstSeenAt', '>=', ab).orderBy('firstSeenAt').limit(300).get();
    const meldungen = snap.docs.map((d) => ({ ...(d.data() as KiMeldung), id: d.id }));
    const vorhanden = new Set<string>();
    if (meldungen.length > 0) {
      for (const u of await db.getAll(...meldungen.map((m) => db.doc(`kiUrteile/${m.id}`)))) if (u.exists) vorhanden.add(u.id);
    }
    const offen = meldungen.filter((m) => !vorhanden.has(m.id));

    const urteile = new Map<string, Record<string, unknown>>();
    const auslassen = (m: KiMeldung, grund: KiAuslassGrund): void => {
      urteile.set(m.id, { ausgelassen: grund });
      ergebnis.ausgelassen[grund] = (ergebnis.ausgelassen[grund] ?? 0) + 1;
    };

    // 1. Auswahl — jede nicht bewertete Meldung bekommt ihren Grund.
    const zuBewerten: KiMeldung[] = [];
    const paare: SichtungsPaar[] = [];
    for (const m of offen) {
      const grund = auswahlGrund(m, jetzt().getTime(), relevant, uids.size);
      if (grund) {
        auslassen(m, grund);
        continue;
      }
      const neuePaare = m.symbole.filter((s) => relevant.has(s)).map((symbol) => ({ id: m.id, symbol }));
      // Was diesmal nicht in den Deckel passt, bleibt OFFEN (kein Urteil) und
      // kommt im nächsten Lauf — bis es zu alt ist und dann seinen Grund bekommt.
      if (paare.length + neuePaare.length > SICHTUNG_MAX_PAARE) continue;
      zuBewerten.push(m);
      paare.push(...neuePaare);
    }

    // 2. Sichtung — nur wenn das Budget sie trägt.
    let verbraucht = budget.verbrauchtUsd;
    const buchen = async (a: KiAntwort): Promise<void> => {
      verbraucht = await budgetBuchen(tag, limitUsd, uids.size, kostenUsd(a.usage, a.modell));
    };
    const budgetErreicht = async (): Promise<void> => {
      if (!ergebnis.budgetErreicht) {
        ergebnis.budgetErreicht = true;
        await budgetMelden(tag, verbraucht, limitUsd, uids.size).catch((err) => logger.warn('kiNachrichten: Budget-Meldung', err));
      }
    };

    let sichtung: SichtungsUrteil[] = [];
    let sichtungModell = KI_NACHRICHTEN_MODELL;
    if (zuBewerten.length > 0) {
      if (!budgetReicht(verbraucht, limitUsd, SCHAETZUNG_SICHTUNG_USD)) {
        await budgetErreicht();
        for (const m of zuBewerten) auslassen(m, 'budget');
      } else {
        const a = await aufruf({
          system: SICHTUNG_SYSTEM,
          eingabe: sichtungEingabe(zuBewerten, paare),
          schema: SICHTUNG_SCHEMA as unknown as Record<string, unknown>,
          effort: 'low',
          maxTokens: SICHTUNG_MAX_TOKENS,
        });
        await buchen(a);
        sichtungModell = a.modell;
        const geparst = a.stopReason === 'refusal' ? null : parseSichtung(a.text, paare);
        if (!geparst) {
          for (const m of zuBewerten) auslassen(m, a.stopReason === 'refusal' ? 'ablehnung' : 'unlesbar');
        } else {
          sichtung = geparst;
        }
      }
    }

    // 3. Gegenprobe — die stärksten eindeutigen zuerst, gedeckelt, budgetiert.
    const pruefungen = new Map<string, PruefUrteil>();
    const ohnePruefung = new Map<string, NonNullable<SymbolUrteil['ohnePruefung']>>();
    const kandidaten = pruefKandidaten(sichtung, relevant);
    const meldungNach = new Map(zuBewerten.map((m) => [m.id, m]));
    let aktuelle: Record<string, { p: number; t: string }> = {};
    if (kandidaten.length > 0) {
      const alpaca = envSchluessel();
      if (alpaca) {
        aktuelle = (await holeLetzteKurse(alpaca, [...new Set(kandidaten.map((k) => k.symbol))], (s) => classify(s) === 'crypto', abh.fetchImpl ?? fetch)).kurse;
      }
    }
    for (const [i, k] of kandidaten.entries()) {
      const schluesselK = `${k.id}|${k.symbol}`;
      if (i >= PRUEFUNG_MAX_JE_LAUF) {
        ohnePruefung.set(schluesselK, 'deckel');
        continue;
      }
      if (!budgetReicht(verbraucht, limitUsd, SCHAETZUNG_PRUEFUNG_USD)) {
        await budgetErreicht();
        ohnePruefung.set(schluesselK, 'budget');
        continue;
      }
      const m = meldungNach.get(k.id)!;
      const marktDoc = await db.doc(`market/${k.symbol}`).get();
      const kontext: Kurskontext = {
        gesehen: m.kurseGesehen?.[k.symbol] ?? null,
        aktuell: aktuelle[k.symbol] ?? null,
        tagesAenderungPct: typeof marktDoc.get('quote.changePct') === 'number' ? (marktDoc.get('quote.changePct') as number) : null,
      };
      try {
        const a = await aufruf({
          system: PRUEFUNG_SYSTEM,
          eingabe: pruefungEingabe(m, k.symbol, k, kontext),
          schema: PRUEFUNG_SCHEMA as unknown as Record<string, unknown>,
          effort: 'high',
          maxTokens: PRUEFUNG_MAX_TOKENS,
        });
        await buchen(a);
        const p = a.stopReason === 'refusal' ? null : parsePruefung(a.text);
        if (p) {
          pruefungen.set(schluesselK, p);
          ergebnis.geprueft += 1;
        } else {
          ohnePruefung.set(schluesselK, a.stopReason === 'refusal' ? 'ablehnung' : 'fehler');
        }
      } catch (err) {
        // Eine gescheiterte Gegenprobe kostet nur DIESES Urteil seine
        // Handlungsfähigkeit — die Sichtung bleibt gültig.
        logger.warn(`kiNachrichten: Gegenprobe ${k.symbol} gescheitert — ${(err as Error).message?.slice(0, 160)}`);
        ohnePruefung.set(schluesselK, 'fehler');
      }
    }

    // 4. Urteile je Meldung zusammensetzen.
    const decidedAt = jetzt().toISOString();
    for (const m of zuBewerten) {
      if (urteile.has(m.id)) continue; // schon mit Grund ausgelassen
      const eigene = sichtung.filter((s) => s.id === m.id);
      if (eigene.length === 0) {
        // Die Antwort war lesbar, nannte diese Meldung aber mit keinem
        // gültigen Paar — kein leeres Urteil, sondern ein Grund.
        auslassen(m, 'unlesbar');
        continue;
      }
      const symbolUrteile: Record<string, SymbolUrteil> = {};
      for (const s of eigene) {
        const schl = `${s.id}|${s.symbol}`;
        const u = endUrteil(s, pruefungen.get(schl) ?? null, ohnePruefung.get(schl) ?? null);
        symbolUrteile[s.symbol] = u;
        if (u.handlungsfaehig) ergebnis.handlungsfaehig += 1;
      }
      urteile.set(m.id, {
        ausgelassen: null,
        sichtung: eigene,
        urteil: symbolUrteile,
        sichtungModell,
      });
      ergebnis.bewertet += 1;
    }

    // 5. Append-only schreiben. Einzeln mit create: Ein paralleler Lauf, der
    // dieselbe Meldung schon entschieden hat, gewinnt — keiner überschreibt.
    for (const [id, u] of urteile) {
      const m = offen.find((x) => x.id === id)!;
      try {
        await db.doc(`kiUrteile/${id}`).create({
          newsId: id,
          symbole: m.symbole,
          publishedAt: m.publishedAt,
          firstSeenAt: m.firstSeenAt,
          decidedAt,
          promptV: KI_NACHRICHTEN_PROMPT_V,
          ...u,
        });
        ergebnis.entschieden += 1;
      } catch (err) {
        if ((err as { code?: unknown }).code !== 6) throw err; // 6 = ALREADY_EXISTS
      }
    }

    await standRef.set(
      {
        letzterLauf: jetzt().toISOString(),
        grund: null,
        konten: ergebnis.konten,
        entschieden: ergebnis.entschieden,
        bewertet: ergebnis.bewertet,
        geprueft: ergebnis.geprueft,
        handlungsfaehig: ergebnis.handlungsfaehig,
        ausgelassen: ergebnis.ausgelassen,
        budgetErreicht: ergebnis.budgetErreicht,
        promptV: KI_NACHRICHTEN_PROMPT_V,
      },
      { merge: true },
    );
    return ergebnis;
  } catch (err) {
    const text = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    logger.warn(`kiNachrichten: ${text}`);
    await standRef.set({ letzterLauf: jetzt().toISOString(), grund: 'fehler', fehler: text }, { merge: true }).catch(() => undefined);
    return { ...ergebnis, grund: 'fehler' };
  }
}

/**
 * Alle fünf Minuten, zwei Minuten nach dem Sammler (:00/:05 …) — dessen Lauf
 * ist dann durch, die frischen Meldungen liegen bereit.
 */
export const kiNachrichten = onSchedule(
  {
    schedule: '2-59/5 * * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    // Unter dem Takt: Ein Lauf darf den nächsten nicht überholen.
    timeoutSeconds: 240,
    memory: '512MiB',
    // ANTHROPIC_API_KEY ist seit 23.07. gebunden (kiBericht), die Alpaca-
    // Schlüssel seit 15.08. (universumSync) — keine neue Ausfallquelle.
    secrets: ['ANTHROPIC_API_KEY', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
  },
  async () => {
    const r = await runKiNachrichten();
    logger.info(
      `kiNachrichten: ${r.bewertet} bewertet, ${r.geprueft} gegengeprüft, ${r.handlungsfaehig} handlungsfähig, `
        + `${Object.values(r.ausgelassen).reduce((a, b) => a + (b ?? 0), 0)} ausgelassen, ${r.konten} Konten`
        + `${r.budgetErreicht ? ', BUDGET ERREICHT' : ''}${r.grund ? ` — ${r.grund}` : ''}`,
    );
  },
);
