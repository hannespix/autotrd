/**
 * Karte „Kurzfrist-Umkehr" (Task 34, Schritt 3) — als eigenes Modul, damit
 * Inhalt und Layout ohne Login prüfbar sind (Unit-Tests +
 * `frontend/e2e/umkehr-shot.mjs`, der seine Seite aus GENAU diesem Code baut).
 *
 * Die Karte beantwortet drei Laienfragen, sonst ist sie Dekoration:
 *  1. Was macht die Strategie gerade — und was kommt als Nächstes?
 *  2. Was kauft/verkauft MEIN Konto? (Plan aus users/{uid}/meta/umkehrPlan,
 *     nur Symbole, keine Beträge.)
 *  3. Warum wurde nichts gekauft?
 *
 * Grundsatz nach der Prüfung (UI-Kritik + Red-Team 22.10.): Die Karte sagt
 * über das eigene Konto nur, was sie WEISS.
 *  - „ausgeführt" gibt es nicht: Der Server stempelt den Plan VOR dem
 *    Handel; ob ein Kauf zustande kam, zeigt allein das Depot.
 *  - Ein Plan gilt nur, wenn er zum letzten Abendplan gehört; ein
 *    gestopptes, Echtgeld- oder fremd-modiges Konto bekommt keinen —
 *    das steht dann da, statt „das ist normal".
 *  - Leer heißt erst dann „normaler Tag", wenn ein Abendplan vorliegt.
 *
 * Symbole rendert der Aufrufer (`sym`), damit jede Stelle das anklickbare
 * Etikett mit `data-sym` trägt (CLAUDE.md §6) — ohne dass dieses Modul das
 * Dashboard importiert.
 */
import { esc } from './html.js';
import { sprachWahl, t, type TextSchluessel } from './i18n.js';

export interface UmkehrOhneKauf {
  gesperrt?: number;
  gehalten?: number;
  bargeldOderPlatz?: number;
  /** Seit 23.10. aufgeschlüsselt; ältere Stände tragen nur `bargeldOderPlatz`. */
  keinBargeld?: number;
  keinPlatz?: number;
  keinKurs?: number;
  abgelehnt?: number;
}

type Signal = { symbol: string; rsi: number };

/** Öffentlicher Stand der drei Läufe (meta/umkehr). Alles optional: alte oder halbe Dokumente dürfen die Karte nicht sprengen. */
export interface UmkehrStatus {
  abend?: { at?: string; tag?: string; konten?: number; signale?: Signal[]; signaleN?: number };
  morgen?: { at?: string; konten?: number; kaeufe?: number; verkaeufe?: number; ohneKauf?: UmkehrOhneKauf };
  krypto?: {
    at?: string;
    tag?: string;
    soll?: string;
    veraltet?: boolean;
    kaeufe?: number;
    verkaeufe?: number;
    ohneKauf?: UmkehrOhneKauf;
    signale?: Signal[];
  };
}

/** Plan des eigenen Kontos (users/{uid}/meta/umkehrPlan) — so, wie umkehrLauf.ts ihn schreibt. */
export interface UmkehrKontoPlan {
  tag?: string;
  erstelltAt?: string;
  kaufen?: Signal[];
  verkaufen?: Array<{ symbol: string; grund: string }>;
  /** YYYY-MM-DD (ET) — gestempelt VOR dem Handel, also kein Beleg für Käufe. */
  ausgefuehrtAm?: string | null;
  /** Einstiegs-Tor zur Eröffnung (z. B. Tages-Notbremse) — Käufe ausgelassen. */
  einstiegGesperrt?: string | null;
}

/** Was die Karte über das Konto wissen muss (aus settings.strategy). */
export interface UmkehrKonto {
  mode: string | undefined;
  running: boolean;
  echtgeld: boolean;
}

type SymFn = (symbol: string) => string;

const lokal = (): string => (sprachWahl() === 'en' ? 'en-US' : 'de-DE');
const zahl = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const gueltig = <T extends { symbol?: unknown }>(xs: T[] | undefined): T[] =>
  (Array.isArray(xs) ? xs : []).filter((x) => !!x && typeof x.symbol === 'string' && x.symbol !== '');
/** Einzelne Teilstücke („12 Käufe") brechen nie in sich um. */
const stueck = (s: string): string => `<span class="uk-nw">${esc(s)}</span>`;

/** RSI mit einer Nachkommastelle, Dezimalzeichen nach Sprache. */
export function rsiText(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString(lokal(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—';
}

/** Uhrzeit beim Betrachter MIT Zeitzone („22.10. 22:45 MESZ") — neben „9:35 New York" sonst missverständlich. */
export function laufZeit(iso: string | number | undefined): string {
  const ms = typeof iso === 'number' ? iso : iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const tag = d.toLocaleDateString(lokal(), { day: '2-digit', month: '2-digit' });
  const uhr = d.toLocaleTimeString(lokal(), { hour: sprachWahl() === 'en' ? 'numeric' : '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return `${tag} ${uhr}`;
}

/** Kalendertag „YYYY-MM-DD" (ET-Kerzentag) als „21.10." / „10/21" — ohne Zeitzonen-Umrechnung. */
export function tagText(tag: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tag ?? '');
  if (!m) return '—';
  return sprachWahl() === 'en' ? `${Number(m[2])}/${Number(m[3])}` : `${m[3]}.${m[2]}.`;
}

/* ── Zeitplan (fest, wie in umkehrLauf.ts) ─────────────────────────────── */

/** Versatz der New Yorker Uhr gegenüber UTC zum Zeitpunkt `ms`, in Minuten (EDT −240, EST −300). */
function nyVersatz(ms: number): number {
  const teile = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const w = (typ: string): number => Number(teile.find((p) => p.type === typ)?.value);
  const alsUtc = Date.UTC(w('year'), w('month') - 1, w('day'), w('hour'), w('minute'));
  return Math.round((alsUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** Zeitpunkt (UTC-ms) einer New Yorker Wanduhrzeit an einem Kalendertag — auch über die Zeitumstellung. */
export function nyZeitpunkt(jahr: number, monat: number, tag: number, h: number, m: number): number {
  const roh = Date.UTC(jahr, monat - 1, tag, h, m);
  const erst = roh - nyVersatz(roh) * 60_000;
  return roh - nyVersatz(erst) * 60_000;
}

export type UmkehrSchritt = { art: 'morgen' | 'abend'; ms: number };

/**
 * Nächster planmäßiger Börsenlauf: Kauf 9:35 oder Abendplan 16:45 New York,
 * Montag bis Freitag. Feiertage kennt die Karte nicht (der Lauf schon) —
 * deshalb heißt es im Text „planmäßig".
 */
export function naechsterSchritt(nowMs: number): UmkehrSchritt {
  const ny = new Date(nowMs + nyVersatz(nowMs) * 60_000);
  for (let d = 0; d < 8; d++) {
    const t0 = new Date(Date.UTC(ny.getUTCFullYear(), ny.getUTCMonth(), ny.getUTCDate() + d));
    const wt = t0.getUTCDay();
    if (wt === 0 || wt === 6) continue;
    const [j, mo, ta] = [t0.getUTCFullYear(), t0.getUTCMonth() + 1, t0.getUTCDate()];
    for (const [art, h, m] of [['morgen', 9, 35], ['abend', 16, 45]] as const) {
      const ms = nyZeitpunkt(j, mo, ta, h, m);
      if (ms > nowMs) return { art, ms };
    }
  }
  return { art: 'morgen', ms: nowMs };
}

/** Nächster Kryptoversuch nach einem Lauf um `atMs`: alle 2 h bis 14:10 UTC, danach erst 00:10 UTC am Folgetag. */
export function naechsterKryptoVersuch(atMs: number): number {
  const d = new Date(atMs);
  const h = d.getUTCHours();
  if (h < 14) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h + 2 - (h % 2), 10);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 10);
}

/* ── Inhalt ────────────────────────────────────────────────────────────── */

/** Bekommt dieses Konto überhaupt Pläne? Spiegelt den Kontenfilter des Servers (umkehrKonten). */
export function umkehrKontoHinweis(k: UmkehrKonto): string {
  if (k.mode !== 'umkehr') return t('uk.andererModus');
  if (k.echtgeld) return t('uk.echtgeld');
  if (!k.running) return t('uk.gestoppt');
  return '';
}

/** Der Plan gilt nur, wenn er zum LETZTEN Abendplan gehört — ältere stehen nicht als „geplant" da. */
export function planAktuell(plan: UmkehrKontoPlan | null, s: UmkehrStatus | null): UmkehrKontoPlan | null {
  if (!plan || typeof plan.tag !== 'string') return null;
  const abendTag = s?.abend?.tag;
  return typeof abendTag === 'string' && plan.tag === abendTag ? plan : null;
}

/** Alle aktuellen Signale aus derselben Quelle wie die Liste: Abendplan (Börse) + frischer Kryptolauf. */
function alleSignale(s: UmkehrStatus | null): Array<Signal & { krypto: boolean }> {
  return [
    ...gueltig(s?.abend?.signale).map((x) => ({ ...x, krypto: false })),
    ...(s?.krypto?.veraltet ? [] : gueltig(s?.krypto?.signale).map((x) => ({ ...x, krypto: true }))),
  ].filter((x) => Number.isFinite(x.rsi));
}

/** Gesamtzahl der Signale; `signaleN` zählt auch die, die der Abendlauf nicht mitschickt (über 30). */
export function umkehrSignalAnzahl(s: UmkehrStatus | null): number | null {
  if (!s?.abend && !s?.krypto) return null;
  const n = s.abend?.signaleN;
  const boerse = zahl(n) ? n : gueltig(s.abend?.signale).length;
  const krypto = s.krypto?.veraltet ? 0 : gueltig(s.krypto?.signale).length;
  return boerse + krypto;
}

/**
 * Die drei Kennzahlen oben. „Deine Käufe" zählt beim offenen Plan die
 * geplanten, nach der Eröffnung nur die, die WIRKLICH im Depot liegen —
 * „10" neben zwei gekauften war derselbe Fehler wie „ausgeführt" (Bild 22.10.).
 */
export function umkehrZahlen(
  s: UmkehrStatus | null,
  plan: UmkehrKontoPlan | null,
  gehalten: ReadonlySet<string> = new Set(),
): { plan: string; signale: string; alle: string } {
  const p = planAktuell(plan, s);
  const n = umkehrSignalAnzahl(s);
  const alle = s?.morgen?.kaeufe;
  const kaufen = gueltig(p?.kaufen);
  const bearbeitet = typeof p?.ausgefuehrtAm === 'string' && p.ausgefuehrtAm !== '';
  return {
    plan: !p ? '—' : String(bearbeitet ? kaufen.filter((k) => gehalten.has(k.symbol)).length : kaufen.length),
    signale: n === null ? '—' : String(n),
    alle: zahl(alle) ? String(alle) : '—',
  };
}

/**
 * Der eigene Plan. Offen: Käufe zur nächsten Eröffnung mit RSI. Bearbeitet:
 * je Zeile, was das DEPOT sagt (im Depot / nicht im Depot) — nie „gekauft".
 */
export function umkehrPlanHtml(
  plan: UmkehrKontoPlan | null,
  s: UmkehrStatus | null,
  konto: UmkehrKonto,
  gehalten: ReadonlySet<string>,
  sym: SymFn,
): string {
  const hinweis = umkehrKontoHinweis(konto);
  if (hinweis) return `<div class="hint">${esc(hinweis)}</div>`;
  if (!s?.abend) return `<div class="hint">${esc(t('uk.nochKeinAbend'))}</div>`;
  const krypto = `<div class="hint">${esc(t('uk.kryptoOhnePlan'))}</div>`;
  const p = planAktuell(plan, s);
  const kaufen = gueltig(p?.kaufen);
  const verkaufen = gueltig(p?.verkaufen);
  if (!p || (kaufen.length === 0 && verkaufen.length === 0)) {
    return `<div class="hint">${esc(t('uk.planLeer').replace('{0}', tagText(s.abend.tag)))}</div>${krypto}`;
  }
  const grund = (g: string): string =>
    g === 'umkehr_erholt' ? t('uk.grundErholt') : g === 'umkehr_frist' ? t('uk.grundFrist') : g;
  const bearbeitet = typeof p.ausgefuehrtAm === 'string' && p.ausgefuehrtAm !== '';
  // Kein Stempel, aber der Morgenlauf kam schon nach dem Plan ⇒ das Konto
  // wurde übersprungen (Handelssperre) — nicht „nächste Eröffnung".
  const morgenMs = Date.parse(s.morgen?.at ?? '');
  const planMs = Date.parse(p.erstelltAt ?? '');
  const uebersprungen = !bearbeitet && Number.isFinite(morgenMs) && Number.isFinite(planMs) && morgenMs > planMs;
  const kopf = bearbeitet
    ? t('uk.planBearbeitet').replace('{0}', tagText(p.tag)).replace('{1}', tagText(p.ausgefuehrtAm))
    : uebersprungen
      ? t('uk.planUebersprungen').replace('{0}', tagText(p.tag))
      : t('uk.planOffen').replace('{0}', tagText(p.tag));
  const sperre = bearbeitet && p.einstiegGesperrt ? `<div class="hint uk-warn">${esc(t('uk.planSperre'))}</div>` : '';
  const kaufZeile = (k: Signal): string => {
    const rechts = bearbeitet
      ? (gehalten.has(k.symbol) ? t('uk.imDepot') : t('uk.nichtImDepot'))
      : `RSI ${rsiText(k.rsi)}`;
    return `<div class="uk-row"><span>${sym(k.symbol)}</span><span class="c-gn">${esc(t('uk.kauf'))}</span><span class="mono">${esc(rechts)}</span></div>`;
  };
  const verkaufZeile = (v: { symbol: string; grund: string }): string => {
    const rechts = bearbeitet
      ? (gehalten.has(v.symbol) ? t('uk.nochImDepot') : t('uk.verkauft'))
      : grund(v.grund);
    return `<div class="uk-row"><span>${sym(v.symbol)}</span><span class="c-rd">${esc(t('uk.verkauf'))}</span><span>${esc(rechts)}</span></div>`;
  };
  return `<div class="hint uk-plankopf">${esc(kopf)}</div>${sperre}`
    + kaufen.map(kaufZeile).join('')
    + verkaufen.map(verkaufZeile).join('')
    + krypto;
}

/** Aktuelle Kaufsignale (Marktinformation, öffentlich), tiefster RSI zuerst; mittlere Spalte: im eigenen Plan / Krypto. */
export function umkehrSignaleHtml(s: UmkehrStatus | null, plan: UmkehrKontoPlan | null, sym: SymFn, max = 8): string {
  if (!s?.abend && !s?.krypto) return `<div class="hint">${esc(t('uk.nochKeinAbend'))}</div>`;
  const imPlan = new Set(gueltig(planAktuell(plan, s)?.kaufen).map((k) => k.symbol));
  const alle = alleSignale(s).sort((a, b) => a.rsi - b.rsi);
  if (alle.length === 0) return `<div class="hint">${esc(t('uk.keineSignale').replace('{0}', tagText(s.abend?.tag)))}</div>`;
  const zeilen = alle.slice(0, max).map((x) => {
    const mitte = imPlan.has(x.symbol) ? t('uk.inDeinemPlan') : x.krypto ? t('uk.krypto') : '';
    return `<div class="uk-row"><span>${sym(x.symbol)}</span><span>${esc(mitte)}</span><span class="mono">RSI ${esc(rsiText(x.rsi))}</span></div>`;
  });
  const rest = (umkehrSignalAnzahl(s) ?? alle.length) - Math.min(alle.length, max);
  const mehr = rest > 0 ? `<div class="hint">${esc(t('uk.weitere').replace('{0}', String(rest)))}</div>` : '';
  return zeilen.join('') + mehr;
}

/** Eine Zeile je Lauf: wann zuletzt, was dabei herauskam. */
export function umkehrLaeufe(s: UmkehrStatus | null): string {
  const zeile = (name: string, at: string | undefined, text: string): string =>
    // Uhrzeit UNTER dem Namen: Nebeneinander (mit Zeitzone, „10/22 3:35 PM
    // GMT+2") lief die Zeile in der 280-px-Spalte über (Prüfstand 22.10.).
    `<div class="uk-row uk-lauf"><span>${esc(name)}<br><span class="mono uk-zeit">${esc(laufZeit(at))}</span></span><span></span><span>${text}</span></div>`;
  const a = s?.abend;
  const m = s?.morgen;
  const k = s?.krypto;
  const nie = esc(t('uk.nochNicht'));
  const anzahl = (n: number, eins: TextSchluessel, viele: TextSchluessel): string => stueck(`${n} ${t(n === 1 ? eins : viele)}`);
  const abendText = a ? anzahl(umkehrSignalAnzahl({ abend: a }) ?? 0, 'uk.signal1', 'uk.signale') : nie;
  const handel = (x: { kaeufe?: number; verkaeufe?: number }): string =>
    `${anzahl(x.kaeufe ?? 0, 'uk.kauf1', 'uk.kaeufe')} · ${anzahl(x.verkaeufe ?? 0, 'uk.verkauf1', 'uk.verkaeufe')}`;
  const kAt = Date.parse(k?.at ?? '');
  const kryptoText = !k
    ? nie
    : k.veraltet
      ? esc(t('uk.kryptoWartet').replace('{0}', Number.isFinite(kAt) ? laufZeit(naechsterKryptoVersuch(kAt)) : '—'))
      : handel(k);
  return (
    zeile(t('uk.abend'), a?.at, abendText)
    + zeile(t('uk.morgen'), m?.at, m ? handel(m) : nie)
    + zeile(t('uk.krypto'), k?.at, kryptoText)
  );
}

/**
 * Warum nicht alles gekauft wurde — Eröffnung UND frischer Kryptolauf, über
 * alle Konten, nur die Gründe, die vorkamen. Leer, wenn nichts zu erklären ist.
 */
export function umkehrOhneKaufText(s: UmkehrStatus | null): string {
  const quellen = [s?.morgen?.ohneKauf, s?.krypto?.veraltet ? undefined : s?.krypto?.ohneKauf];
  const summe = (f: keyof UmkehrOhneKauf): number =>
    quellen.reduce<number>((acc, q) => {
      const v = q?.[f];
      return acc + (zahl(v) && v > 0 ? v : 0);
    }, 0);
  // Aufgeschlüsselt, wo der Lauf es schon kann; ältere Stände bleiben beim Sammelgrund.
  const fein = (q: UmkehrOhneKauf | undefined): boolean =>
    zahl(q?.keinBargeld) || zahl(q?.keinPlatz) || zahl(q?.keinKurs);
  const sammel = quellen.reduce<number>((acc, q) => {
    const v = q?.bargeldOderPlatz;
    return acc + (!fein(q) && zahl(v) && v > 0 ? v : 0);
  }, 0);
  const teile: string[] = [];
  for (const [f, text] of [
    ['gehalten', t('uk.ohneGehalten')],
    ['keinBargeld', t('uk.ohneKeinBargeld')],
    ['keinPlatz', t('uk.ohneKeinPlatz')],
    ['keinKurs', t('uk.ohneKeinKurs')],
    ['gesperrt', t('uk.ohneGesperrt')],
    ['abgelehnt', t('uk.ohneAbgelehnt')],
  ] as const) {
    const n = summe(f);
    if (n > 0) teile.push(`${n}× ${text}`);
  }
  if (sammel > 0) teile.splice(1, 0, `${sammel}× ${t('uk.ohneBargeld')}`);
  return teile.length === 0 ? '' : `${t('uk.ohneKopf')} ${teile.join(' · ')}`;
}

/** Kopf-Tag: der nächste planmäßige Schritt in der Uhrzeit des Betrachters. */
export function umkehrNaechsterText(nowMs: number): string {
  const n = naechsterSchritt(nowMs);
  return `${t(n.art === 'morgen' ? 'uk.naechsterKauf' : 'uk.naechsterAbend')} ${laufZeit(n.ms)}`;
}

/**
 * Das Kartengerüst — EINE Quelle für App und Bild-Prüfstand. `info` ist der
 * fertige ⓘ-Knopf des Aufrufers (das Dashboard verdrahtet ihn).
 * Startzustand „lädt", nicht „normaler Tag": Vor dem ersten Snapshot weiß
 * die Karte noch nichts.
 */
export function umkehrGeruest(info: string): string {
  return `<div class="card" data-panel="umkehr"><div class="sect">${t('panel.umkehr')} ${info}
        <span id="ukNaechst" class="tn-tag" style="float:right"></span>
      </div><div class="cbody">
        <div class="row uk-zahlen" style="gap:12px;margin-top:8px">
          <div><label class="lbl">${t('uk.lblPlan')}</label><div id="ukPlanN" class="smv mono">--</div></div>
          <div><label class="lbl">${t('uk.lblSignale')}</label><div id="ukSig" class="smv mono">--</div></div>
          <div><label class="lbl">${t('uk.lblAlle')}</label><div id="ukAlle" class="smv mono">--</div></div>
        </div>
        <label class="lbl" style="margin-top:10px">${t('uk.deinPlan')}</label>
        <div id="ukPlan" class="uk-tbl"><div class="hint">${t('uk.laedt')}</div></div>
        <div class="hint" id="ukOhne"></div>
        <label class="lbl" style="margin-top:10px">${t('uk.signaleListe')}</label>
        <div id="ukSignale" class="uk-tbl"><div class="hint">${t('uk.laedt')}</div></div>
        <label class="lbl" style="margin-top:10px">${t('uk.laeufe')}</label>
        <div id="ukLaeufe" class="uk-tbl"></div>
      </div></div>`;
}

/** Füllt das Gerüst. `el` holt ein Element per id (Dashboard: `$`, Prüfstand: `getElementById`). */
export function umkehrRendern(
  el: (id: string) => HTMLElement,
  s: UmkehrStatus | null,
  plan: UmkehrKontoPlan | null,
  konto: UmkehrKonto,
  gehalten: ReadonlySet<string>,
  sym: SymFn,
  nowMs: number,
): void {
  // Ein Konto ohne Pläne (anderer Modus, gestoppt, Echtgeld) zeigt keinen
  // alten Plan — weder in der Kennzahl noch als „in deinem Plan".
  const eigenerPlan = umkehrKontoHinweis(konto) ? null : plan;
  const z = umkehrZahlen(s, eigenerPlan, gehalten);
  el('ukNaechst').textContent = umkehrNaechsterText(nowMs);
  el('ukPlanN').textContent = z.plan;
  el('ukSig').textContent = z.signale;
  el('ukAlle').textContent = z.alle;
  el('ukPlan').innerHTML = umkehrPlanHtml(eigenerPlan, s, konto, gehalten, sym);
  el('ukOhne').textContent = umkehrOhneKaufText(s);
  el('ukSignale').innerHTML = umkehrSignaleHtml(s, eigenerPlan, sym);
  el('ukLaeufe').innerHTML = umkehrLaeufe(s);
}
