/**
 * kiNachrichten — KI-Kaskade Stufe 2a (05.10.): frische Meldungen sichten,
 * eindeutige skeptisch gegenprüfen, Urteile append-only ablegen.
 *
 * Der pure Teil (Auswahl, Prompts, Schemas, Parser, Kosten, Budget) steht in
 * `shared/src/kiNachrichten.ts` samt Begründung. Hier ist das IO.
 *
 * ── Ablage (zweite Fassung nach Red-Team 05.10.) ──────────────────────────
 *
 *   `kiSichtungen/{newsId}`          genau EIN Eintrag je Meldung — bewertet
 *                                    oder mit Grund ausgelassen (Regel 4/5).
 *   `kiUrteile/{newsId}_{symbol}`    das Urteil je (Meldung, Symbol), SOFORT
 *                                    geschrieben, sobald es feststeht.
 *
 * Die erste Fassung schrieb alle Urteile am Laufende. Brach die Plattform
 * den Lauf ab (vier Gegenproben mit hoher Denktiefe passen nicht sicher in
 * vier Minuten), war alles Bezahlte verloren und wurde im nächsten Lauf neu
 * bezahlt. Jetzt: Sichtung → sofort `kiSichtungen` + die Urteile, die keine
 * Gegenprobe brauchen; jede Gegenprobe → sofort ihr Urteil. Was offen bleibt
 * (Frist, Deckel), holt der nächste Lauf aus `kiSichtungen` — ohne die
 * Sichtung noch einmal zu bezahlen.
 *
 * ── Geld (Owner 05.10.: 2 $ je Konto und Tag) ─────────────────────────────
 *
 *   - Tagesdokument `admin/kiBudget-{tag}` (server-only, ein Dokument je
 *     Tag: Kein Lauf über Mitternacht kann den neuen Tag überschreiben).
 *   - Vor JEDEM Aufruf wird transaktional sein Worst Case reserviert
 *     (Deckel × teuerster Satz, inklusive Rückfall); danach wird der
 *     gemessene Betrag gebucht und die Reservierung frei. Eine Sichtung
 *     startet nur, wenn danach noch eine Gegenprobe in den Topf passt.
 *   - Taktung über den Tag (`budgetFreigegebenUsd`), damit zur Eröffnung
 *     noch Budget da ist.
 *   - Lauf-Sperre `admin/kiLauf`: Cloud Scheduler liefert mindestens einmal
 *     aus — zwei Läufe dürfen nicht gleichzeitig reservieren und bezahlen.
 *   - Die Plattform-Grenze (240 s) ist hart; der Lauf selbst hört nach
 *     150 s auf, neue Aufrufe zu starten, und gibt jedem Aufruf nur die
 *     Restzeit (ohne SDK-Wiederholungen).
 *
 * ── Was hier NICHT passiert ───────────────────────────────────────────────
 *
 * Keine Order, kein Stop, keine Strategie-Änderung. Die Urteile sind Daten;
 * Stufe 2b liest sie mit festen Regeln. Fällt dieser Lauf aus, handelt das
 * System exakt wie vorher.
 */

import Anthropic from '@anthropic-ai/sdk';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  KI_NACHRICHTEN_MODELL,
  KI_NACHRICHTEN_PROMPT_V,
  PRUEFUNG_MAX_TOKENS,
  PRUEFUNG_SCHEMA,
  PRUEFUNG_SYSTEM,
  SICHTUNG_MAX_MELDUNGEN,
  SICHTUNG_MAX_PAARE,
  SICHTUNG_MAX_TOKENS,
  SICHTUNG_SCHEMA,
  SICHTUNG_SYSTEM,
  auswahlGrund,
  brauchtPruefung,
  budgetFreigegebenUsd,
  budgetLimitUsd,
  budgetNachricht,
  budgetPruefen,
  budgetTag,
  classify,
  endUrteil,
  isStrategy,
  kostenUsd,
  parsePruefung,
  parseSichtung,
  pruefAuswahl,
  pruefungEingabe,
  sichtungEingabe,
  worstCaseUsd,
  zuAlt,
  type BudgetUrteil,
  type KiAuslassGrund,
  type KiMeldung,
  type KiUsage,
  type Kurskontext,
  type SichtungsPaar,
  type SichtungsUrteil,
  type Strategy,
  type SymbolUrteil,
} from '../../../shared/src/index.js';
import { mayTrade } from '../core/access.js';
import { envSchluessel, type FetchLike } from '../core/alpacaBroker.js';
import { holeLetzteKurse } from '../core/alpacaNews.js';

/** Ab Laufbeginn: danach startet kein neuer Aufruf mehr (Plattform-Grenze 240 s). */
export const LAUF_FRIST_MS = 150_000;
/** So viel Restzeit braucht ein Aufruf mindestens, um zu starten. */
export const MIN_REST_MS = 40_000;
/** Gültigkeit der Lauf-Sperre — knapp unter dem Takt, über der Plattform-Grenze. */
const SPERRE_MS = 250_000;
/** Fenster frischer Meldungen (Alter wird zusätzlich ab `publishedAt` geprüft). */
const FENSTER_MIN = 60;

/* ── Modell-Aufruf (injizierbar für Tests) ──────────────────────────────── */

export interface KiAnfrage {
  system: string;
  eingabe: string;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /** Restzeit des Laufs — mehr bekommt kein Aufruf. */
  timeoutMs: number;
}

export interface KiAntwort {
  /** `refusal` = auch die Rückfall-Kette lehnte ab. */
  stopReason: string | null;
  text: string;
  usage: KiUsage;
  /** Das Modell, das tatsächlich antwortete (Rückfall möglich). */
  modell: string;
}

export type KiAufruf = (a: KiAnfrage) => Promise<KiAntwort>;

/**
 * Der echte Aufruf: strukturierte Ausgabe (festes JSON-Schema) und
 * serverseitiger Rückfall bei einer Sicherheits-Ablehnung (`fallbacks:
 * 'default'`). Ohne SDK-Wiederholungen — eine Wiederholung nach einem
 * Timeout wäre ein zweiter, unreservierter Aufruf. Kein Prompt-Caching:
 * Die Systemprompts liegen unter der Mindestlänge cachebarer Präfixe.
 */
export function anthropicAufruf(apiKey: string): KiAufruf {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return async (a) => {
    const antwort = await client.beta.messages.create(
      {
        model: KI_NACHRICHTEN_MODELL,
        max_tokens: a.maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: a.effort, format: { type: 'json_schema', schema: a.schema } },
        system: a.system,
        messages: [{ role: 'user', content: a.eingabe }],
      },
      { timeout: a.timeoutMs },
    );
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

/* ── Sperre und Budget ──────────────────────────────────────────────────── */

async function sperreNehmen(jetzt: Date): Promise<boolean> {
  const db = getFirestore();
  const ref = db.doc('admin/kiLauf');
  return db.runTransaction(async (tx) => {
    const bis = Date.parse(String((await tx.get(ref)).get('bis') ?? ''));
    if (Number.isFinite(bis) && bis > jetzt.getTime()) return false;
    tx.set(ref, { bis: new Date(jetzt.getTime() + SPERRE_MS).toISOString() });
    return true;
  });
}

async function sperreFreigeben(): Promise<void> {
  await getFirestore().doc('admin/kiLauf').set({ bis: new Date(0).toISOString() });
}

const zahl = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v));

interface Topf {
  tag: string;
  limitUsd: number;
  konten: number;
  freigegebenUsd: number;
}

/**
 * Worst Case reservieren — transaktional. `zusatzUsd` muss zusätzlich noch
 * hineinpassen, wird aber nicht reserviert (Sichtung nur, wenn danach eine
 * Gegenprobe möglich ist).
 */
async function reservieren(t: Topf, worstUsd: number, zusatzUsd = 0): Promise<BudgetUrteil> {
  const db = getFirestore();
  const ref = db.doc(`admin/kiBudget-${t.tag}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const verbraucht = zahl(snap.get('verbrauchtUsd'));
    const reserviert = zahl(snap.get('reserviertUsd'));
    const u = budgetPruefen(verbraucht, reserviert, t.limitUsd, t.freigegebenUsd, worstUsd + zusatzUsd);
    if (u === 'ok') {
      tx.set(ref, { tag: t.tag, limitUsd: t.limitUsd, konten: t.konten, verbrauchtUsd: verbraucht, reserviertUsd: reserviert + worstUsd }, { merge: true });
    }
    return u;
  });
}

/** Gemessenen Betrag buchen, Reservierung freigeben. */
async function abrechnen(t: Topf, worstUsd: number, usd: number): Promise<number> {
  const db = getFirestore();
  const ref = db.doc(`admin/kiBudget-${t.tag}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const neu = Math.round((zahl(snap.get('verbrauchtUsd')) + usd) * 1_000_000) / 1_000_000;
    tx.set(ref, {
      verbrauchtUsd: neu,
      reserviertUsd: Math.max(0, Math.round((zahl(snap.get('reserviertUsd')) - worstUsd) * 1_000_000) / 1_000_000),
      aufrufe: zahl(snap.get('aufrufe')) + 1,
      at: new Date().toISOString(),
    }, { merge: true });
    return neu;
  });
}

/** Einmal je Tag den Admins melden, dass der Topf leer ist (erst Nachricht, dann Marke). */
async function budgetMelden(t: Topf): Promise<void> {
  const db = getFirestore();
  const ref = db.doc(`admin/kiBudget-${t.tag}`);
  const snap = await ref.get();
  if (snap.get('gemeldetAt')) return;
  const text = budgetNachricht(t.tag, zahl(snap.get('verbrauchtUsd')), t.limitUsd, t.konten);
  const admins = await db.collection('users').where('admin', '==', true).get();
  for (const a of admins.docs) {
    await a.ref.collection('nachrichten').add({ von: 'admin', text, at: new Date().toISOString() });
  }
  await ref.set({ gemeldetAt: new Date().toISOString() }, { merge: true });
}

type Bezahlt =
  | { art: 'budget'; urteil: Exclude<BudgetUrteil, 'ok'> }
  | { art: 'antwort'; antwort: KiAntwort; usd: number };

/* ── Lauf ───────────────────────────────────────────────────────────────── */

export interface KiLaufErgebnis {
  grund: null | 'kein_schluessel' | 'laeuft_schon' | 'fehler';
  konten: number;
  gesichtet: number;
  geprueft: number;
  handlungsfaehig: number;
  offen: number;
  ausgelassen: Partial<Record<KiAuslassGrund, number>>;
  budgetErreicht: boolean;
}

export interface KiLaufAbhaengigkeiten {
  aufruf?: KiAufruf;
  jetzt?: () => Date;
  fetchImpl?: FetchLike;
  teilnehmer?: () => Promise<Teilnehmer>;
}

const urteilId = (newsId: string, symbol: string): string => `${newsId}_${symbol}`;

export async function runKiNachrichten(abh: KiLaufAbhaengigkeiten = {}): Promise<KiLaufErgebnis> {
  const db = getFirestore();
  const jetzt = abh.jetzt ?? (() => new Date());
  const laufBeginn = jetzt().getTime();
  const restMs = (): number => laufBeginn + LAUF_FRIST_MS - jetzt().getTime();
  const standRef = db.doc('meta/kiNachrichten');
  const e: KiLaufErgebnis = {
    grund: null, konten: 0, gesichtet: 0, geprueft: 0, handlungsfaehig: 0, offen: 0, ausgelassen: {}, budgetErreicht: false,
  };
  const schluessel = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  const aufruf = abh.aufruf ?? (schluessel ? anthropicAufruf(schluessel) : null);

  if (!(await sperreNehmen(jetzt()))) return { ...e, grund: 'laeuft_schon' };
  try {
    /* ── Schreiben, append-only ─────────────────────────────────────────── */
    const anlegen = async (pfad: string, daten: Record<string, unknown>): Promise<boolean> => {
      try {
        await db.doc(pfad).create({ ...daten, promptV: KI_NACHRICHTEN_PROMPT_V, gespeichertAt: FieldValue.serverTimestamp() });
        return true;
      } catch (err) {
        if ((err as { code?: unknown }).code === 6) return false; // ALREADY_EXISTS — ein anderer Lauf war schneller
        throw err;
      }
    };
    const auslassen = async (m: KiMeldung, grund: KiAuslassGrund, extra: Record<string, unknown> = {}): Promise<void> => {
      if (await anlegen(`kiSichtungen/${m.id}`, {
        newsId: m.id, symbole: m.symbole, publishedAt: m.publishedAt, firstSeenAt: m.firstSeenAt,
        sichtungAt: jetzt().toISOString(), ausgelassen: grund, ...extra,
      })) e.ausgelassen[grund] = (e.ausgelassen[grund] ?? 0) + 1;
    };
    const urteilSchreiben = async (m: Pick<KiMeldung, 'id' | 'publishedAt' | 'firstSeenAt'>, symbol: string, daten: Record<string, unknown>): Promise<void> => {
      await anlegen(`kiUrteile/${urteilId(m.id, symbol)}`, {
        newsId: m.id, symbol, publishedAt: m.publishedAt, firstSeenAt: m.firstSeenAt, decidedAt: jetzt().toISOString(), ...daten,
      });
    };

    /* ── Nachlese: was nie bearbeitet wurde, bekommt seinen Grund ───────── */
    // Stündlich (erster Lauf der Stunde), über die letzten sechs Stunden —
    // auch ohne Schlüssel. Sonst fielen Meldungen aus Ausfallzeiten still aus
    // dem Fenster, und „jede Null hat einen Grund" wäre gebrochen.
    if (jetzt().getUTCMinutes() < 5) {
      const von = new Date(laufBeginn - 6 * 3_600_000).toISOString();
      const bis = new Date(laufBeginn - FENSTER_MIN * 60_000).toISOString();
      const alt = (await db.collection('marktNachrichten').where('firstSeenAt', '>=', von).orderBy('firstSeenAt').limit(1000).get())
        .docs.map((d) => ({ ...(d.data() as KiMeldung), id: d.id }))
        .filter((m) => m.firstSeenAt < bis);
      if (alt.length > 0) {
        const da = new Set((await db.getAll(...alt.map((m) => db.doc(`kiSichtungen/${m.id}`)))).filter((s) => s.exists).map((s) => s.id));
        for (const m of alt) if (!da.has(m.id)) await auslassen(m, 'ausfall');
      }
    }

    if (!aufruf) {
      await standRef.set({ letzterLauf: jetzt().toISOString(), grund: 'kein_schluessel' }, { merge: true });
      return { ...e, grund: 'kein_schluessel' };
    }

    const { uids, relevant } = await (abh.teilnehmer ?? teilnehmerLesen)();
    e.konten = uids.size;
    const limitUsd = budgetLimitUsd(uids.size);
    const topf: Topf = { tag: budgetTag(jetzt()), limitUsd, konten: uids.size, freigegebenUsd: budgetFreigegebenUsd(limitUsd, jetzt()) };

    /** Ein Aufruf mit Reservierung und Abrechnung. Wirft nur bei Aufruf-Fehlern. */
    const bezahlterAufruf = async (anfrage: Omit<KiAnfrage, 'timeoutMs'>, zusatzUsd = 0): Promise<Bezahlt> => {
      const worst = worstCaseUsd(anfrage.eingabe.length, anfrage.system.length, anfrage.maxTokens);
      const u = await reservieren(topf, worst, zusatzUsd);
      if (u !== 'ok') {
        if (u === 'erschoepft' && !e.budgetErreicht) {
          e.budgetErreicht = true;
          await budgetMelden(topf).catch((err) => logger.warn('kiNachrichten: Budget-Meldung', err));
        }
        return { art: 'budget', urteil: u };
      }
      try {
        const antwort = await aufruf({ ...anfrage, timeoutMs: Math.max(5_000, restMs() + 60_000) });
        const usd = kostenUsd(antwort.usage, antwort.modell);
        await abrechnen(topf, worst, usd);
        return { art: 'antwort', antwort, usd };
      } catch (err) {
        // Mit HTTP-Status hat der Anbieter abgelehnt, bevor gerechnet wurde.
        // Ohne (Timeout, Verbindung) ist unklar, was berechnet wurde — dann
        // zählt der Worst Case als verbraucht. Sicher statt billig.
        const status = (err as { status?: unknown }).status;
        await abrechnen(topf, worst, typeof status === 'number' ? 0 : worst);
        throw err;
      }
    };

    /* ── Phase A: Sichtung ──────────────────────────────────────────────── */
    const ab = new Date(laufBeginn - FENSTER_MIN * 60_000).toISOString();
    const frisch = (await db.collection('marktNachrichten').where('firstSeenAt', '>=', ab).orderBy('firstSeenAt').limit(500).get())
      .docs.map((d) => ({ ...(d.data() as KiMeldung), id: d.id }));
    const gesichtet = new Set<string>();
    if (frisch.length > 0) {
      for (const s of await db.getAll(...frisch.map((m) => db.doc(`kiSichtungen/${m.id}`)))) if (s.exists) gesichtet.add(s.id);
    }
    const zuSichten: KiMeldung[] = [];
    for (const m of frisch.filter((x) => !gesichtet.has(x.id))) {
      const grund = auswahlGrund(m, laufBeginn, relevant, uids.size);
      if (grund) await auslassen(m, grund);
      else zuSichten.push(m);
    }
    zuSichten.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));

    const stapel: KiMeldung[][] = [];
    for (const m of zuSichten) {
      const letzter = stapel[stapel.length - 1];
      const paareDazu = m.symbole.filter((s) => relevant.has(s)).length;
      const paareBisher = (letzter ?? []).reduce((n, x) => n + x.symbole.filter((s) => relevant.has(s)).length, 0);
      if (letzter && letzter.length < SICHTUNG_MAX_MELDUNGEN && paareBisher + paareDazu <= SICHTUNG_MAX_PAARE) letzter.push(m);
      else stapel.push([m]);
    }
    const worstPruefung = worstCaseUsd(2_500, PRUEFUNG_SYSTEM.length, PRUEFUNG_MAX_TOKENS);

    const sichte = async (gruppe: KiMeldung[]): Promise<void> => {
      if (restMs() < MIN_REST_MS) {
        e.offen += gruppe.length; // bleibt offen — der nächste Lauf
        return;
      }
      const paare: SichtungsPaar[] = gruppe.flatMap((m) => m.symbole.filter((s) => relevant.has(s)).map((symbol) => ({ id: m.id, symbol })));
      const r = await bezahlterAufruf(
        { system: SICHTUNG_SYSTEM, eingabe: sichtungEingabe(gruppe, paare, jetzt().toISOString()), schema: SICHTUNG_SCHEMA as unknown as Record<string, unknown>, effort: 'low', maxTokens: SICHTUNG_MAX_TOKENS },
        worstPruefung,
      );
      if (r.art === 'budget') {
        for (const m of gruppe) await auslassen(m, 'budget', { budget: r.urteil });
        return;
      }
      const { antwort, usd } = r;
      const meta = { sichtungModell: antwort.modell, sichtungStop: antwort.stopReason, sichtungUsd: usd, sichtungMeldungen: gruppe.length };
      if (antwort.stopReason === 'refusal') {
        // Eine einzige auslösende Meldung soll nicht den ganzen Stapel
        // kosten: halbieren, bis die eine allein steht.
        if (gruppe.length > 1) {
          const mitte = Math.ceil(gruppe.length / 2);
          await sichte(gruppe.slice(0, mitte));
          await sichte(gruppe.slice(mitte));
        } else {
          await auslassen(gruppe[0]!, 'ablehnung', meta);
        }
        return;
      }
      const urteile = parseSichtung(antwort.text, paare);
      if (!urteile) {
        for (const m of gruppe) await auslassen(m, 'unlesbar', meta);
        return;
      }
      for (const m of gruppe) {
        const eigene = urteile.filter((u) => u.id === m.id);
        const angefragt = m.symbole.filter((s) => relevant.has(s));
        if (eigene.length === 0) {
          await auslassen(m, 'unlesbar', meta);
          continue;
        }
        const kandidaten = eigene.filter((u) => brauchtPruefung(u, relevant)).map((u) => u.symbol);
        const fehlend = angefragt.filter((s) => !eigene.some((u) => u.symbol === s));
        if (!(await anlegen(`kiSichtungen/${m.id}`, {
          newsId: m.id, symbole: m.symbole, publishedAt: m.publishedAt, firstSeenAt: m.firstSeenAt,
          sichtungAt: jetzt().toISOString(), ausgelassen: null, sichtung: eigene, kandidaten, fehlend, ...meta,
        }))) continue;
        e.gesichtet += 1;
        // Was keine Gegenprobe braucht, ist jetzt entschieden.
        for (const u of eigene.filter((x) => !kandidaten.includes(x.symbol))) {
          await urteilSchreiben(m, u.symbol, { sichtung: u, ...endUrteil(u, null, null) });
        }
        for (const symbol of fehlend) {
          await urteilSchreiben(m, symbol, { sichtung: null, richtung: null, handlungsfaehig: false, stufe: 'sichtung', ohnePruefung: 'unlesbar' });
        }
      }
    };
    for (const g of stapel) await sichte(g);

    /* ── Phase B: Gegenprobe der offenen Kandidaten ─────────────────────── */
    const sichtungen = (await db.collection('kiSichtungen').where('sichtungAt', '>=', ab).limit(500).get()).docs
      .map((d) => d.data() as { newsId: string; publishedAt: string; firstSeenAt: string; sichtung?: SichtungsUrteil[]; kandidaten?: string[] })
      .filter((s) => (s.kandidaten ?? []).length > 0);
    const kandidatenListe = sichtungen.flatMap((s) =>
      (s.kandidaten ?? []).map((symbol) => ({
        newsId: s.newsId, publishedAt: s.publishedAt, firstSeenAt: s.firstSeenAt, symbol,
        urteil: (s.sichtung ?? []).find((u) => u.symbol === symbol)!,
      }))).filter((k) => k.urteil);
    const entschieden = new Set<string>();
    if (kandidatenListe.length > 0) {
      for (const u of await db.getAll(...kandidatenListe.map((k) => db.doc(`kiUrteile/${urteilId(k.newsId, k.symbol)}`)))) {
        if (u.exists) entschieden.add(u.id);
      }
    }
    const offen = [];
    for (const k of kandidatenListe.filter((x) => !entschieden.has(urteilId(x.newsId, x.symbol)))) {
      if (zuAlt(k, laufBeginn)) {
        await urteilSchreiben({ id: k.newsId, publishedAt: k.publishedAt, firstSeenAt: k.firstSeenAt }, k.symbol, { sichtung: k.urteil, ...endUrteil(k.urteil, null, 'zu_alt') });
      } else {
        offen.push(k);
      }
    }
    const auswahl = pruefAuswahl(offen);
    e.offen += offen.length - auswahl.length;
    if (auswahl.length > 0) {
      const texte = new Map((await db.getAll(...auswahl.map((k) => db.doc(`marktNachrichten/${k.newsId}`))))
        .filter((d) => d.exists).map((d) => [d.id, { ...(d.data() as KiMeldung), id: d.id }]));
      const alpaca = envSchluessel();
      const aktuelle = alpaca
        ? (await holeLetzteKurse(alpaca, [...new Set(auswahl.map((k) => k.symbol))], (s) => classify(s) === 'crypto', abh.fetchImpl ?? fetch)).kurse
        : {};
      for (const k of auswahl) {
        const m = texte.get(k.newsId);
        if (!m) continue;
        if (restMs() < MIN_REST_MS) {
          e.offen += 1;
          continue;
        }
        let tagesAenderungPct: number | null = null;
        let tagesAenderungStand: string | null = null;
        try {
          const markt = await db.doc(`market/${k.symbol}`).get();
          if (typeof markt.get('quote.changePct') === 'number') {
            tagesAenderungPct = markt.get('quote.changePct') as number;
            tagesAenderungStand = (markt.get('quote.updatedAt') as string | undefined) ?? null;
          }
        } catch (err) {
          logger.warn(`kiNachrichten: market/${k.symbol} nicht lesbar`, err);
        }
        const kontext: Kurskontext = { gesehen: m.kurseGesehen?.[k.symbol] ?? null, aktuell: aktuelle[k.symbol] ?? null, tagesAenderungPct, tagesAenderungStand };
        let r: Bezahlt;
        try {
          r = await bezahlterAufruf({
            system: PRUEFUNG_SYSTEM,
            eingabe: pruefungEingabe(m, k.symbol, k.urteil.richtung, k.urteil.ereignis, kontext, jetzt().toISOString()),
            schema: PRUEFUNG_SCHEMA as unknown as Record<string, unknown>,
            effort: 'high',
            maxTokens: PRUEFUNG_MAX_TOKENS,
          });
        } catch (err) {
          // Bleibt offen: Der nächste Lauf versucht es, bis die Meldung zu alt ist.
          logger.warn(`kiNachrichten: Gegenprobe ${k.symbol} gescheitert — ${(err as Error).message?.slice(0, 160)}`);
          e.offen += 1;
          continue;
        }
        if (r.art === 'budget') {
          await urteilSchreiben(m, k.symbol, { sichtung: k.urteil, ...endUrteil(k.urteil, null, 'budget'), budget: r.urteil });
          continue;
        }
        const p = r.antwort.stopReason === 'refusal' ? null : parsePruefung(r.antwort.text);
        const ohne: SymbolUrteil['ohnePruefung'] = p ? null : r.antwort.stopReason === 'refusal' ? 'ablehnung' : 'unlesbar';
        const u = endUrteil(k.urteil, p, ohne);
        await urteilSchreiben(m, k.symbol, {
          sichtung: k.urteil,
          ...u,
          pruefung: {
            ...(p ?? {}),
            modell: r.antwort.modell,
            stopReason: r.antwort.stopReason,
            usd: r.usd,
            effort: 'high',
            maxTokens: PRUEFUNG_MAX_TOKENS,
            kurskontext: kontext,
          },
        });
        if (p) e.geprueft += 1;
        if (u.handlungsfaehig) e.handlungsfaehig += 1;
      }
    }

    // Öffentlicher Stand: nur Zähler — keine Kosten, keine Kontozahl.
    await standRef.set(
      {
        letzterLauf: jetzt().toISOString(),
        grund: null,
        gesichtet: e.gesichtet,
        geprueft: e.geprueft,
        handlungsfaehig: e.handlungsfaehig,
        offen: e.offen,
        ausgelassen: e.ausgelassen,
        budgetErreicht: e.budgetErreicht,
        promptV: KI_NACHRICHTEN_PROMPT_V,
      },
      { merge: true },
    );
    return e;
  } catch (err) {
    const text = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    logger.warn(`kiNachrichten: ${text}`);
    await standRef.set({ letzterLauf: jetzt().toISOString(), grund: 'fehler', fehler: text }, { merge: true }).catch(() => undefined);
    return { ...e, grund: 'fehler' };
  } finally {
    await sperreFreigeben().catch(() => undefined);
  }
}

/**
 * Alle fünf Minuten, vier Minuten nach dem Sammler (:00/:05 …) — dessen Lauf
 * darf bis zu 180 s dauern; dann liegen die frischen Meldungen sicher bereit.
 */
export const kiNachrichten = onSchedule(
  {
    schedule: '4-59/5 * * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    // Harte Plattform-Grenze; der Lauf selbst startet nach 150 s nichts mehr.
    timeoutSeconds: 240,
    memory: '512MiB',
    // ANTHROPIC_API_KEY ist seit 23.07. gebunden (kiBericht), die Alpaca-
    // Schlüssel seit 15.08. (universumSync) — keine neue Ausfallquelle.
    secrets: ['ANTHROPIC_API_KEY', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
  },
  async () => {
    const r = await runKiNachrichten();
    logger.info(
      `kiNachrichten: ${r.gesichtet} gesichtet, ${r.geprueft} gegengeprüft, ${r.handlungsfaehig} handlungsfähig, ${r.offen} offen, `
        + `${Object.values(r.ausgelassen).reduce((a, b) => a + (b ?? 0), 0)} ausgelassen, ${r.konten} Konten`
        + `${r.budgetErreicht ? ', BUDGET ERREICHT' : ''}${r.grund ? ` — ${r.grund}` : ''}`,
    );
  },
);
