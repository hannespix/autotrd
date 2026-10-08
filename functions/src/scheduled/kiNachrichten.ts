/**
 * kiNachrichten — KI-Kaskade Stufe 2a (05.10.): frische Meldungen sichten,
 * eindeutige skeptisch gegenprüfen, Urteile append-only ablegen.
 *
 * Der pure Teil (Auswahl, Prompts, Schemas, Parser, Kosten, Budget) steht in
 * `shared/src/kiNachrichten.ts` samt Begründung. Hier ist das IO — in der
 * dritten Fassung nach zwei Red-Team-Runden (05.10.).
 *
 * ── Ablage ────────────────────────────────────────────────────────────────
 *
 *   `kiSichtungen/{newsId}`        genau EIN Eintrag je Meldung — bewertet
 *                                  oder mit Grund ausgelassen.
 *   `kiUrteile/{newsId}_{symbol}`  das Urteil je (Meldung, Symbol), sofort
 *                                  geschrieben, sobald es feststeht.
 *   `kiOffen/{newsId}_{symbol}`    ARBEITSLISTE der fälligen Gegenproben.
 *                                  Angelegt mit der Sichtung, gelöscht mit
 *                                  dem Urteil. Die zweite Fassung suchte
 *                                  offene Kandidaten über ein Zeitfenster in
 *                                  `kiSichtungen` — wer herausfiel (Nachlese-
 *                                  Flut, Fehlerstunde), blieb für immer ohne
 *                                  Urteil. Eine Liste kann das nicht.
 *   `kiAufrufe/{laufId}_{n}`       Journal JEDES Modell-Aufrufs: reserviert,
 *                                  gebucht, Token, Modell, Status. Nur so
 *                                  ergeben die Kosten der Urteile später die
 *                                  Tagesbuchung (Stufe 3).
 *
 * ── Reihenfolge eines Laufs ───────────────────────────────────────────────
 *
 *   0. Sperre mit Besitzer (`admin/kiLauf`), Leck-Umbuchung, Nachlese.
 *   1. Phase B ZUERST: offene Gegenproben, die ältesten zuerst, parallel —
 *      sie sind schon bezahlt-gesichtet und laufen zuerst ab.
 *   2. Phase A: neue Meldungen sichten, solange Zeit und Topf reichen.
 *   Ein Aufruf-Fehler ohne HTTP-Status (Timeout, Verbindung) beendet das
 *   Aufrufen für diesen Lauf: Hängt der Anbieter, soll nicht jeder weitere
 *   Versuch den Worst Case kosten.
 *
 * ── Geld (Owner 05.10.: 2 $ je Konto und Tag) ─────────────────────────────
 *
 * Tagesdokument `admin/kiBudget-{tag}`; vor jedem Aufruf wird sein Worst
 * Case transaktional reserviert (Haupt- plus zwei Rückfall-Hops samt
 * Fortsetzung), danach der gemessene Betrag je Iteration gebucht. Ohne
 * eindeutige Antwort zählt der Worst Case. Eine Sichtung startet nur, wenn
 * danach die Gegenproben aller offenen Kandidaten plus einer in den Topf
 * passen. Taktung über den Tag, nie unter einem vollen Zyklus.
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
  FIRMENBLOCK_MAX_ZEICHEN,
  PROFIL_KLASSEN,
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
  hauptversuchWorstUsd,
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
  type Profil,
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
/** Puffer über der Lauf-Frist, den ein laufender Aufruf noch bekommt. */
export const AUFRUF_PUFFER_MS = 60_000;
/** Mindest-Restzeit, damit eine Sichtung bzw. Gegenprobe noch startet. */
export const MIN_REST_SICHTUNG_MS = 60_000;
export const MIN_REST_PRUEFUNG_MS = 100_000;
/** Gültigkeit der Lauf-Sperre — über der Plattform-Grenze. */
const SPERRE_MS = 250_000;
/** Fenster frischer Meldungen (Alter wird zusätzlich ab `publishedAt` geprüft). */
const FENSTER_MIN = 60;
/** Die Nachlese läuft, wenn die letzte länger her ist. */
const NACHLESE_ABSTAND_MS = 55 * 60_000;
/** HTTP-Status, bei denen der Anbieter sicher nichts gerechnet hat. */
const UNBERECHNET = new Set([400, 401, 403, 404, 413, 429]);

/* ── Modell-Aufruf (injizierbar für Tests) ──────────────────────────────── */

export interface KiAnfrage {
  system: string;
  eingabe: string;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /** Restzeit des Laufs plus Puffer — mehr bekommt kein Aufruf. */
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
 * 'default'` — keine eigene Modellliste, die bei einer Abkündigung bricht).
 * Ohne SDK-Wiederholungen: Eine Wiederholung wäre ein zweiter, nicht
 * reservierter Aufruf. Kein Prompt-Caching: Die Systemprompts liegen unter
 * der Mindestlänge cachebarer Präfixe.
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
  for (const uid of uids) {
    // Bestand der Teilnehmer (Sockel ausgenommen — den führt der Momentum-Lauf).
    const pos = await db.collection(`users/${uid}/positions`).select('core').get();
    for (const p of pos.docs) if (p.get('core') !== true) relevant.add(p.id);
  }
  return { uids, relevant };
}

/* ── Sperre ─────────────────────────────────────────────────────────────── */

/**
 * Sperre mit Besitzer: Ein Lauf, den die Plattform pausierte und der später
 * weiterlief, darf beim Aufräumen nicht die Sperre seines Nachfolgers lösen
 * (Red-Team 05.10.).
 */
async function sperreNehmen(laufId: string, jetztMs: number): Promise<boolean> {
  const db = getFirestore();
  const ref = db.doc('admin/kiLauf');
  return db.runTransaction(async (tx) => {
    const bis = Date.parse(String((await tx.get(ref)).get('bis') ?? ''));
    if (Number.isFinite(bis) && bis > jetztMs) return false;
    tx.set(ref, { bis: new Date(jetztMs + SPERRE_MS).toISOString(), laufId });
    return true;
  });
}

async function sperreFreigeben(laufId: string): Promise<void> {
  const db = getFirestore();
  const ref = db.doc('admin/kiLauf');
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).get('laufId') === laufId) tx.set(ref, { bis: new Date(0).toISOString(), laufId: null });
  });
}

/* ── Budget ─────────────────────────────────────────────────────────────── */

const zahl = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v));
const rund = (x: number): number => Math.round(x * 1_000_000) / 1_000_000;

interface Topf {
  tag: string;
  limitUsd: number;
  konten: number;
  freigegebenUsd: number;
}

/**
 * Reservierungen, die beim Erwerb der Sperre noch stehen, gehören keinem
 * Lauf mehr (es läuft ja keiner): Ein Vorgänger starb zwischen Reservieren
 * und Abrechnen. Ihr Betrag wird als verbraucht gebucht — unklar, was der
 * Anbieter berechnet hat, also der Worst Case — und gezählt, damit es
 * sichtbar ist statt bis Mitternacht im Topf zu kleben.
 */
async function leckeUmbuchen(tag: string): Promise<void> {
  const db = getFirestore();
  const ref = db.doc(`admin/kiBudget-${tag}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const r = zahl(snap.get('reserviertUsd'));
    if (!(r > 0)) return;
    tx.set(ref, {
      verbrauchtUsd: rund(zahl(snap.get('verbrauchtUsd')) + r),
      verbrauchtUnklarUsd: rund(zahl(snap.get('verbrauchtUnklarUsd')) + r),
      reserviertUsd: 0,
      lecks: zahl(snap.get('lecks')) + 1,
    }, { merge: true });
  });
}

/**
 * Worst Case reservieren — transaktional. `zusatzUsd` muss zusätzlich noch
 * hineinpassen, wird aber nicht reserviert.
 */
async function reservieren(t: Topf, worstUsd: number, zusatzUsd: number): Promise<BudgetUrteil> {
  const db = getFirestore();
  const ref = db.doc(`admin/kiBudget-${t.tag}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const verbraucht = zahl(snap.get('verbrauchtUsd'));
    const reserviert = zahl(snap.get('reserviertUsd'));
    const u = budgetPruefen(verbraucht, reserviert, t.limitUsd, t.freigegebenUsd, worstUsd + zusatzUsd);
    if (u === 'ok') {
      tx.set(ref, { tag: t.tag, limitUsd: t.limitUsd, konten: t.konten, verbrauchtUsd: verbraucht, reserviertUsd: rund(reserviert + worstUsd) }, { merge: true });
    }
    return u;
  });
}

async function abrechnen(t: Topf, worstUsd: number, usd: number, at: string): Promise<void> {
  const db = getFirestore();
  const ref = db.doc(`admin/kiBudget-${t.tag}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.set(ref, {
      verbrauchtUsd: rund(zahl(snap.get('verbrauchtUsd')) + usd),
      reserviertUsd: Math.max(0, rund(zahl(snap.get('reserviertUsd')) - worstUsd)),
      aufrufe: zahl(snap.get('aufrufe')) + 1,
      at,
    }, { merge: true });
  });
}

/** Einmal je Tag den Admins melden, dass der Topf leer ist (erst Nachricht, dann Marke). */
async function budgetMelden(t: Topf, at: string): Promise<void> {
  const db = getFirestore();
  const ref = db.doc(`admin/kiBudget-${t.tag}`);
  const snap = await ref.get();
  if (snap.get('gemeldetAt')) return;
  const text = budgetNachricht(t.tag, zahl(snap.get('verbrauchtUsd')), t.limitUsd, t.konten);
  const admins = await db.collection('users').where('admin', '==', true).get();
  for (const a of admins.docs) await a.ref.collection('nachrichten').add({ von: 'admin', text, at });
  await ref.set({ gemeldetAt: at }, { merge: true });
}

/* ── Lauf ───────────────────────────────────────────────────────────────── */

export interface KiLaufErgebnis {
  grund: null | 'kein_schluessel' | 'laeuft_schon' | 'fehler';
  konten: number;
  gesichtet: number;
  geprueft: number;
  handlungsfaehig: number;
  /** Bleibt für den nächsten Lauf (Frist, Takt, Deckel, Anbieter-Fehler). */
  offen: number;
  ausgelassen: Partial<Record<KiAuslassGrund, number>>;
  budgetErreicht: boolean;
  aufrufFehler: number;
}

export interface KiLaufAbhaengigkeiten {
  aufruf?: KiAufruf;
  jetzt?: () => Date;
  fetchImpl?: FetchLike;
  teilnehmer?: () => Promise<Teilnehmer>;
  laufId?: string;
}

const urteilId = (newsId: string, symbol: string): string => `${newsId}_${symbol}`;

/**
 * Firmenprofile (Task 19 Teil 2b) für die Prompts: `market/{sym}.profil`,
 * das der Finnhub-Nachtlauf schreibt. Nur Klassen, die ein Profil haben
 * können — Krypto/Indizes kosten so keinen Lese-Zugriff und bekommen
 * keinen Block. Fehlt das Dokument oder das Feld, steht null in der Karte.
 */
async function ladeProfile(db: FirebaseFirestore.Firestore, symbole: readonly string[]): Promise<Map<string, Partial<Profil> | null>> {
  const profile = new Map<string, Partial<Profil> | null>();
  const kandidaten = [...new Set(symbole)].filter((s) => PROFIL_KLASSEN.includes(classify(s)));
  if (kandidaten.length === 0) return profile;
  try {
    // Nur das eine Feld — das Dokument trägt sonst Kurs, Kennzahlen, News.
    for (const d of await db.getAll(...kandidaten.map((s) => db.doc(`market/${s}`)), { fieldMask: ['profil'] })) {
      const profil = d.exists ? (d.get('profil') as Partial<Profil> | null | undefined) : null;
      profile.set(d.id, profil && typeof profil === 'object' ? profil : null);
    }
  } catch (err) {
    // Der Block ist Anreicherung, kein Muss (Red-Team M2): Ein Lesefehler
    // darf die Kaskade nicht stoppen, die ohne Block genauso liefe.
    logger.warn(`Profile für Prompt nicht lesbar — ohne Firmenblock weiter: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
    profile.clear();
  }
  return profile;
}

interface Offen {
  newsId: string;
  symbol: string;
  publishedAt: string;
  firstSeenAt: string;
  urteil: SichtungsUrteil;
}

export async function runKiNachrichten(abh: KiLaufAbhaengigkeiten = {}): Promise<KiLaufErgebnis> {
  const db = getFirestore();
  const jetzt = abh.jetzt ?? (() => new Date());
  const laufBeginn = jetzt().getTime();
  const laufId = abh.laufId ?? `${new Date(laufBeginn).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const restMs = (): number => laufBeginn + LAUF_FRIST_MS - jetzt().getTime();
  const iso = (): string => jetzt().toISOString();
  const standRef = db.doc('meta/kiNachrichten');
  const e: KiLaufErgebnis = {
    grund: null, konten: 0, gesichtet: 0, geprueft: 0, handlungsfaehig: 0, offen: 0, ausgelassen: {}, budgetErreicht: false, aufrufFehler: 0,
  };
  const schluessel = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  const aufruf = abh.aufruf ?? (schluessel ? anthropicAufruf(schluessel) : null);

  if (!(await sperreNehmen(laufId, laufBeginn))) return { ...e, grund: 'laeuft_schon' };
  try {
    /* ── Schreiben, append-only ─────────────────────────────────────────── */
    const anlegen = async (pfad: string, daten: Record<string, unknown>): Promise<boolean> => {
      try {
        await db.doc(pfad).create({ ...daten, promptV: KI_NACHRICHTEN_PROMPT_V, laufId, gespeichertAt: FieldValue.serverTimestamp() });
        return true;
      } catch (err) {
        if ((err as { code?: unknown }).code === 6) return false; // ALREADY_EXISTS
        throw err;
      }
    };
    const auslassen = async (m: KiMeldung, grund: KiAuslassGrund, extra: Record<string, unknown> = {}): Promise<void> => {
      if (await anlegen(`kiSichtungen/${m.id}`, {
        newsId: m.id, symbole: m.symbole, publishedAt: m.publishedAt, firstSeenAt: m.firstSeenAt,
        entschiedenAt: iso(), ausgelassen: grund, ...extra,
      })) e.ausgelassen[grund] = (e.ausgelassen[grund] ?? 0) + 1;
    };
    /** Urteil schreiben und die Arbeitsliste räumen. */
    const urteilSchreiben = async (m: Pick<Offen, 'newsId' | 'publishedAt' | 'firstSeenAt'>, symbol: string, daten: Record<string, unknown>): Promise<void> => {
      await anlegen(`kiUrteile/${urteilId(m.newsId, symbol)}`, {
        newsId: m.newsId, symbol, publishedAt: m.publishedAt, firstSeenAt: m.firstSeenAt, decidedAt: iso(), bewertet: false, ...daten,
      });
      await db.doc(`kiOffen/${urteilId(m.newsId, symbol)}`).delete().catch(() => undefined);
    };

    /* ── Stand, Nachlese ────────────────────────────────────────────────── */
    const stand = await standRef.get();
    const letzteNachlese = Date.parse(String(stand.get('nachleseAt') ?? ''));
    let nachleseAt: string | null = null;
    if (!Number.isFinite(letzteNachlese) || laufBeginn - letzteNachlese > NACHLESE_ABSTAND_MS) {
      // Was nie bearbeitet wurde (Ausfall, kein Schlüssel), bekommt seinen
      // Grund — auch ohne Schlüssel. Ohne `entschiedenAt`-Fenster: nichts
      // davon füllt eine spätere Abfrage.
      const von = new Date(laufBeginn - 6 * 3_600_000).toISOString();
      const bis = new Date(laufBeginn - FENSTER_MIN * 60_000).toISOString();
      const alt = (await db.collection('marktNachrichten').where('firstSeenAt', '>=', von).orderBy('firstSeenAt').limit(1000).get())
        .docs.map((d) => ({ ...(d.data() as KiMeldung), id: d.id }))
        .filter((m) => m.firstSeenAt < bis);
      if (alt.length > 0) {
        const da = new Set((await db.getAll(...alt.map((m) => db.doc(`kiSichtungen/${m.id}`)))).filter((s) => s.exists).map((s) => s.id));
        for (const m of alt) if (!da.has(m.id)) await auslassen(m, 'ausfall');
      }
      nachleseAt = iso();
    }

    if (!aufruf) {
      await standRef.set({ letzterLauf: iso(), grund: 'kein_schluessel', ...(nachleseAt ? { nachleseAt } : {}) }, { merge: true });
      return { ...e, grund: 'kein_schluessel' };
    }

    const { uids, relevant } = await (abh.teilnehmer ?? teilnehmerLesen)();
    e.konten = uids.size;
    const limitUsd = budgetLimitUsd(uids.size);
    const worstPruefung = worstCaseUsd(2_500, PRUEFUNG_SYSTEM.length, PRUEFUNG_MAX_TOKENS);
    // Firmenblöcke (Teil 2b) zählen in die Worst-Case-Reservierung mit — sonst
    // taktet die Mindestfreigabe einen vollen Stapel weg (Red-Team M3).
    const worstSichtungMax = worstCaseUsd(SICHTUNG_MAX_MELDUNGEN * 1_100 + SICHTUNG_MAX_PAARE * FIRMENBLOCK_MAX_ZEICHEN, SICHTUNG_SYSTEM.length, SICHTUNG_MAX_TOKENS);
    const worstSichtungEinzeln = worstCaseUsd(1_100 + FIRMENBLOCK_MAX_ZEICHEN, SICHTUNG_SYSTEM.length, SICHTUNG_MAX_TOKENS);
    const tag = budgetTag(jetzt());
    const topf: Topf = {
      tag, limitUsd, konten: uids.size,
      freigegebenUsd: budgetFreigegebenUsd(limitUsd, jetzt(), worstSichtungMax + worstPruefung),
    };
    await leckeUmbuchen(tag);

    /* ── Ein Aufruf: reservieren, aufrufen, buchen, ins Journal ─────────── */
    let aufrufNr = 0;
    let stopp = false; // nach einem Fehler ohne HTTP-Status: keine weiteren Aufrufe
    /** Worst Cases, die DIESER Lauf gerade reserviert hat (laufende Aufrufe). */
    let eigeneReserviertUsd = 0;
    type Ergebnis =
      | { art: 'budget'; urteil: Exclude<BudgetUrteil, 'ok'> }
      | { art: 'fehler'; status: number | null }
      | { art: 'gestoppt' }
      | { art: 'antwort'; antwort: KiAntwort; usd: number; aufrufId: string };

    /**
     * Ist der Tag wirklich vorbei? Nur wenn nicht einmal EINE Gegenprobe mehr
     * passt — gerechnet OHNE die eigenen laufenden Reservierungen. Die erste
     * Fassung mit parallelen Gegenproben prüfte gegen die Reservierungen der
     * Geschwister, schrieb endgültige „budget"-Urteile und schickte die
     * Owner-Nachricht, obwohl der Topf fast voll war (Red-Team Runde 3).
     */
    const istErschoepft = async (bedarfUsd: number): Promise<boolean> => {
      const snap = await db.doc(`admin/kiBudget-${tag}`).get();
      const fremdReserviert = Math.max(0, zahl(snap.get('reserviertUsd')) - eigeneReserviertUsd);
      return budgetPruefen(zahl(snap.get('verbrauchtUsd')), fremdReserviert, limitUsd, limitUsd, bedarfUsd) === 'erschoepft';
    };
    /**
     * `bedarfUsd`: was mindestens noch passen müsste, damit der Tag nicht
     * vorbei ist. Phase B: eine Gegenprobe. Phase A: eine Einzel-Sichtung
     * PLUS eine Gegenprobe — sonst wäre Phase A am Topfende für den Rest des
     * Tages still, ohne „budget" und ohne Nachricht (Kurzprüfung Runde 3).
     * Exakt, weil der Verbrauch innerhalb eines Tages nur steigt.
     */
    const meldenWennErschoepft = async (bedarfUsd: number): Promise<boolean> => {
      if (!(await istErschoepft(bedarfUsd))) return false;
      if (!e.budgetErreicht) {
        e.budgetErreicht = true;
        /* Stufe 2b (06.10.): Der TAG der Erschöpfung, nicht nur das Flag des
         * Laufs — `budgetErreicht` überschreibt jeder Folgelauf, der
         * zufällig nichts zu tun hat, mit false. Der Scan liest dieses Feld
         * und schaltet für den Rest des ET-Tages den Lexikon-Rückfall zu. */
        await standRef.set({ budgetErreichtTag: tag }, { merge: true })
          .catch((err) => logger.warn('kiNachrichten: Budget-Tag', err));
        await budgetMelden(topf, iso()).catch((err) => logger.warn('kiNachrichten: Budget-Meldung', err));
      }
      return true;
    };

    const bezahlterAufruf = async (
      anfrage: Omit<KiAnfrage, 'timeoutMs'>,
      zusatzUsd: number,
      bezug: Record<string, unknown>,
    ): Promise<Ergebnis> => {
      // Auch ein später fortgesetzter (pausierter) Lauf startet nichts mehr.
      if (stopp || restMs() < 0) return { art: 'gestoppt' };
      const worst = worstCaseUsd(anfrage.eingabe.length, anfrage.system.length, anfrage.maxTokens);
      const u = await reservieren(topf, worst, zusatzUsd);
      if (u !== 'ok') return { art: 'budget', urteil: u };
      eigeneReserviertUsd += worst;
      aufrufNr += 1;
      const aufrufId = `${laufId}_${aufrufNr}`;
      const timeoutMs = Math.max(5_000, restMs() + AUFRUF_PUFFER_MS);
      const journal = { ...bezug, effort: anfrage.effort, maxTokens: anfrage.maxTokens, timeoutMs, reserviertUsd: worst, startAt: iso() };
      const journalSchreiben = (daten: Record<string, unknown>): Promise<unknown> =>
        // Das Journal ist Protokoll: Sein Fehler darf weder doppelt buchen
        // noch eine bezahlte Antwort verwerfen (Red-Team Runde 3).
        anlegen(`kiAufrufe/${aufrufId}`, { ...journal, ...daten, endeAt: iso() })
          .catch((err) => logger.warn(`kiNachrichten: Journal ${aufrufId}`, err));

      // NUR der Modell-Aufruf steht im try — Buchung genau einmal danach.
      let antwort: KiAntwort;
      try {
        antwort = await aufruf({ ...anfrage, timeoutMs });
      } catch (err) {
        const status = typeof (err as { status?: unknown }).status === 'number' ? ((err as { status: number }).status) : null;
        // Mit eindeutigem 4xx hat der Anbieter nicht gerechnet. Sonst (Timeout,
        // Verbindung, 5xx, 529) ist unklar, was berechnet wurde: Worst Case.
        const usd = status !== null && UNBERECHNET.has(status) ? 0 : worst;
        await abrechnen(topf, worst, usd, iso());
        eigeneReserviertUsd -= worst;
        await journalSchreiben({ status: 'fehler', httpStatus: status, fehler: (err as Error).message?.slice(0, 160) ?? '', gebuchtUsd: usd });
        e.aufrufFehler += 1;
        if (status === null) stopp = true;
        logger.warn(`kiNachrichten: Aufruf ${aufrufId} gescheitert (${status ?? 'ohne Status'}) — ${(err as Error).message?.slice(0, 160)}`);
        return { art: 'fehler', status };
      }
      // Ohne Iterationen, aber mit fremdem Modell, ist der abgelehnte
      // Hauptversuch nirgends gezählt — dann zählt er mit seinem Deckel.
      const ohneIterationen = !(antwort.usage.iterations ?? []).some((i) => i.type === 'message');
      const zuschlag = antwort.modell !== KI_NACHRICHTEN_MODELL && ohneIterationen
        ? hauptversuchWorstUsd(anfrage.eingabe.length, anfrage.system.length, anfrage.maxTokens)
        : 0;
      const usd = rund(kostenUsd(antwort.usage, antwort.modell) + zuschlag);
      await abrechnen(topf, worst, usd, iso());
      eigeneReserviertUsd -= worst;
      await journalSchreiben({ status: 'antwort', stopReason: antwort.stopReason, modell: antwort.modell, usage: antwort.usage, gebuchtUsd: usd });
      return { art: 'antwort', antwort, usd, aufrufId };
    };

    /* ── Phase B zuerst: offene Gegenproben ─────────────────────────────── */
    const offenAlle = (await db.collection('kiOffen').orderBy('publishedAt').limit(200).get()).docs.map((d) => d.data() as Offen);
    // Schon entschieden, aber nicht von der Liste gelöscht (Abbruch zwischen
    // Urteil und Löschen)? Dann nur räumen — keine zweite, bezahlte Gegenprobe.
    const schonEntschieden = new Set<string>();
    if (offenAlle.length > 0) {
      for (const u of await db.getAll(...offenAlle.map((k) => db.doc(`kiUrteile/${urteilId(k.newsId, k.symbol)}`)))) {
        if (u.exists) schonEntschieden.add(u.id);
      }
    }
    const offen: Offen[] = [];
    for (const k of offenAlle) {
      if (schonEntschieden.has(urteilId(k.newsId, k.symbol))) {
        await db.doc(`kiOffen/${urteilId(k.newsId, k.symbol)}`).delete().catch(() => undefined);
      } else if (zuAlt(k, laufBeginn)) {
        await urteilSchreiben(k, k.symbol, { sichtung: k.urteil, ...endUrteil(k.urteil, null, 'zu_alt') });
      } else {
        offen.push(k);
      }
    }
    const auswahl = restMs() >= MIN_REST_PRUEFUNG_MS ? pruefAuswahl(offen) : [];
    e.offen += offen.length - auswahl.length;
    if (auswahl.length > 0) {
      const texte = new Map((await db.getAll(...auswahl.map((k) => db.doc(`marktNachrichten/${k.newsId}`))))
        .filter((d) => d.exists).map((d) => [d.id, { ...(d.data() as KiMeldung), id: d.id }]));
      const profile = await ladeProfile(db, auswahl.map((k) => k.symbol));
      const alpaca = envSchluessel();
      const aktuelle = alpaca
        ? (await holeLetzteKurse(alpaca, [...new Set(auswahl.map((k) => k.symbol))], (s) => classify(s) === 'crypto', abh.fetchImpl ?? fetch, {
          bisMs: laufBeginn + 20_000, jetzt: () => jetzt().getTime(),
        })).kurse
        : {};
      const budgetAbgewiesen: Offen[] = [];
      // Parallel: Jede reserviert für sich, dann laufen alle gleichzeitig —
      // nacheinander passten vier Gegenproben nicht sicher in die Frist.
      // `allSettled`: Phase B endet erst, wenn ALLE fertig sind — sonst gäbe
      // `finally` die Sperre frei, während Geschwister noch laufen.
      const ausgaenge = await Promise.allSettled(auswahl.map(async (k) => {
        const m = texte.get(k.newsId);
        if (!m) {
          await urteilSchreiben(k, k.symbol, { sichtung: k.urteil, ...endUrteil(k.urteil, null, 'fehler') });
          return;
        }
        const kontext: Kurskontext = { gesehen: m.kurseGesehen?.[k.symbol] ?? null, aktuell: aktuelle[k.symbol] ?? null };
        const r = await bezahlterAufruf(
          {
            system: PRUEFUNG_SYSTEM,
            eingabe: pruefungEingabe(m, k.symbol, k.urteil.richtung, k.urteil.ereignis, kontext, iso(), profile.get(k.symbol)),
            schema: PRUEFUNG_SCHEMA as unknown as Record<string, unknown>,
            effort: 'high',
            maxTokens: PRUEFUNG_MAX_TOKENS,
          },
          0,
          { art: 'pruefung', newsIds: [k.newsId], symbol: k.symbol },
        );
        if (r.art !== 'antwort') {
          e.offen += 1; // bleibt auf der Liste — Endgültiges erst nach allen
          if (r.art === 'budget') budgetAbgewiesen.push(k);
          return;
        }
        const p = r.antwort.stopReason === 'refusal' ? null : parsePruefung(r.antwort.text);
        const ohne: SymbolUrteil['ohnePruefung'] = p ? null : r.antwort.stopReason === 'refusal' ? 'ablehnung' : 'unlesbar';
        const u = endUrteil(k.urteil, p, ohne);
        await urteilSchreiben(k, k.symbol, {
          sichtung: k.urteil,
          ...u,
          pruefung: {
            ...(p ?? {}),
            aufrufId: r.aufrufId,
            modell: r.antwort.modell,
            stopReason: r.antwort.stopReason,
            usd: r.usd,
            kurskontext: kontext,
          },
        });
        if (p) e.geprueft += 1;
        if (u.handlungsfaehig) e.handlungsfaehig += 1;
      }));
      for (const a of ausgaenge) {
        if (a.status === 'rejected') {
          // Der Eintrag bleibt auf der Liste — als Wartender mitzählen.
          e.offen += 1;
          logger.warn('kiNachrichten: Gegenprobe gescheitert', a.reason);
        }
      }
      // Erst jetzt, mit allen Geschwistern fertig: Ist der Tag wirklich vorbei?
      if (budgetAbgewiesen.length > 0 && (await meldenWennErschoepft(worstPruefung))) {
        for (const k of budgetAbgewiesen) {
          await urteilSchreiben(k, k.symbol, { sichtung: k.urteil, ...endUrteil(k.urteil, null, 'budget') });
          e.offen -= 1;
        }
      }
    }

    /* ── Phase A: neue Meldungen sichten ────────────────────────────────── */
    // Neueste zuerst gelesen: Bei einer Flut sollen die frischen nicht hinter
    // 500 älteren verschwinden (die werden ohnehin zu alt / Nachlese).
    const ab = new Date(laufBeginn - FENSTER_MIN * 60_000).toISOString();
    const frisch = (await db.collection('marktNachrichten').where('firstSeenAt', '>=', ab).orderBy('firstSeenAt', 'desc').limit(500).get())
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
    const paareVon = (m: KiMeldung): number => m.symbole.filter((s) => relevant.has(s)).length;
    for (const m of zuSichten) {
      const letzter = stapel[stapel.length - 1];
      if (letzter && letzter.length < SICHTUNG_MAX_MELDUNGEN && letzter.reduce((n, x) => n + paareVon(x), 0) + paareVon(m) <= SICHTUNG_MAX_PAARE) letzter.push(m);
      else stapel.push([m]);
    }
    /** Wartende Gegenproben — fortlaufend, auch die in diesem Lauf neu entstandenen. */
    let wartend = e.offen;

    /**
     * Alles zu einer gesichteten Meldung in EINEM Batch: Arbeitsliste,
     * Sofort-Urteile und zuletzt der Sichtungs-Eintrag. Die zweite Fassung
     * schrieb einzeln; scheiterte die Liste nach dem Eintrag, sah die Meldung
     * gesichtet aus und das Paar bekam nie ein Urteil (Red-Team Runde 3).
     */
    const sichtungAblegen = async (
      m: KiMeldung,
      eigene: SichtungsUrteil[],
      kandidaten: SichtungsUrteil[],
      fehlend: string[],
      meta: Record<string, unknown>,
      aufrufId: string,
    ): Promise<boolean> => {
      const kopf = { promptV: KI_NACHRICHTEN_PROMPT_V, laufId, gespeichertAt: FieldValue.serverTimestamp() };
      const ref = { newsId: m.id, publishedAt: m.publishedAt, firstSeenAt: m.firstSeenAt };
      const batch = db.batch();
      for (const u of kandidaten) batch.create(db.doc(`kiOffen/${urteilId(m.id, u.symbol)}`), { ...kopf, ...ref, symbol: u.symbol, urteil: u });
      for (const u of eigene.filter((x) => !kandidaten.includes(x))) {
        batch.create(db.doc(`kiUrteile/${urteilId(m.id, u.symbol)}`), { ...kopf, ...ref, symbol: u.symbol, decidedAt: iso(), bewertet: false, sichtung: u, ...endUrteil(u, null, null), sichtungAufrufId: aufrufId });
      }
      for (const symbol of fehlend) {
        batch.create(db.doc(`kiUrteile/${urteilId(m.id, symbol)}`), { ...kopf, ...ref, symbol, decidedAt: iso(), bewertet: false, sichtung: null, richtung: null, handlungsfaehig: false, stufe: 'sichtung', ohnePruefung: 'unlesbar', sichtungAufrufId: aufrufId });
      }
      batch.create(db.doc(`kiSichtungen/${m.id}`), {
        ...kopf, ...ref, symbole: m.symbole, entschiedenAt: iso(), ausgelassen: null,
        sichtung: eigene, kandidaten: kandidaten.map((u) => u.symbol), fehlend, ...meta,
      });
      try {
        await batch.commit();
        return true;
      } catch (err) {
        if ((err as { code?: unknown }).code === 6) return false; // ein anderer Lauf war schneller
        throw err;
      }
    };

    const sichte = async (gruppe: KiMeldung[]): Promise<void> => {
      if (stopp || restMs() < MIN_REST_SICHTUNG_MS) {
        e.offen += gruppe.length; // bleibt offen — der nächste Lauf
        return;
      }
      const paare: SichtungsPaar[] = gruppe.flatMap((m) => m.symbole.filter((s) => relevant.has(s)).map((symbol) => ({ id: m.id, symbol })));
      const profile = await ladeProfile(db, paare.map((p) => p.symbol));
      const r = await bezahlterAufruf(
        { system: SICHTUNG_SYSTEM, eingabe: sichtungEingabe(gruppe, paare, iso(), profile), schema: SICHTUNG_SCHEMA as unknown as Record<string, unknown>, effort: 'low', maxTokens: SICHTUNG_MAX_TOKENS },
        // Danach müssen die Gegenproben aller Wartenden plus einer passen.
        worstPruefung * (wartend + 1),
        { art: 'sichtung', newsIds: gruppe.map((m) => m.id) },
      );
      if (r.art === 'budget') {
        // Endgültig nur, wenn der Tag wirklich vorbei ist — Takt oder der
        // Kopfraum für Wartende lassen die Meldungen offen (Red-Team Runde 3:
        // sonst wurden bei fast vollem Topf neue Meldungen endgültig „budget").
        if (await meldenWennErschoepft(worstSichtungEinzeln + worstPruefung)) {
          for (const m of gruppe) await auslassen(m, 'budget');
        } else {
          e.offen += gruppe.length;
        }
        return;
      }
      if (r.art !== 'antwort') {
        e.offen += gruppe.length;
        return;
      }
      const { antwort, usd, aufrufId } = r;
      const meta = { sichtungModell: antwort.modell, sichtungStop: antwort.stopReason, sichtungUsd: usd, sichtungAufrufId: aufrufId, sichtungMeldungen: gruppe.length };
      if (antwort.stopReason === 'refusal' || antwort.stopReason === 'max_tokens') {
        // Eine auslösende Meldung (oder ein zu langer Stapel) soll nicht den
        // ganzen Stapel kosten: halbieren, bis sie allein steht.
        if (gruppe.length > 1) {
          const mitte = Math.ceil(gruppe.length / 2);
          await sichte(gruppe.slice(0, mitte));
          await sichte(gruppe.slice(mitte));
        } else {
          await auslassen(gruppe[0]!, antwort.stopReason === 'refusal' ? 'ablehnung' : 'unlesbar', meta);
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
        if (eigene.length === 0) {
          await auslassen(m, 'unlesbar', meta);
          continue;
        }
        const kandidaten = eigene.filter((u) => brauchtPruefung(u, relevant));
        const fehlend = m.symbole.filter((s) => relevant.has(s) && !eigene.some((u) => u.symbol === s));
        if (!(await sichtungAblegen(m, eigene, kandidaten, fehlend, meta, aufrufId))) continue;
        e.gesichtet += 1;
        e.offen += kandidaten.length;
        wartend += kandidaten.length;
      }
    };
    for (const g of stapel) await sichte(g);

    // Öffentlicher Stand: nur Zähler — keine Kosten, keine Kontozahl.
    await standRef.set(
      {
        letzterLauf: iso(),
        grund: null,
        gesichtet: e.gesichtet,
        geprueft: e.geprueft,
        handlungsfaehig: e.handlungsfaehig,
        offen: e.offen,
        ausgelassen: e.ausgelassen,
        budgetErreicht: e.budgetErreicht,
        aufrufFehler: e.aufrufFehler,
        promptV: KI_NACHRICHTEN_PROMPT_V,
        ...(nachleseAt ? { nachleseAt } : {}),
      },
      { merge: true },
    );
    return e;
  } catch (err) {
    const text = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    logger.warn(`kiNachrichten: ${text}`);
    await standRef.set({ letzterLauf: iso(), grund: 'fehler', fehler: text }, { merge: true }).catch(() => undefined);
    return { ...e, grund: 'fehler' };
  } finally {
    await sperreFreigeben(laufId).catch(() => undefined);
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
        + `${Object.values(r.ausgelassen).reduce((a, b) => a + (b ?? 0), 0)} ausgelassen, ${r.konten} Konten, ${r.aufrufFehler} Aufruf-Fehler`
        + `${r.budgetErreicht ? ', BUDGET ERREICHT' : ''}${r.grund ? ` — ${r.grund}` : ''}`,
    );
  },
);
