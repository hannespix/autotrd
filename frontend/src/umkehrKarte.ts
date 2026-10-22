/**
 * Karte „Kurzfrist-Umkehr" (Task 34, Schritt 3) — als eigenes Modul, damit
 * Inhalt und Layout ohne Login prüfbar sind (Unit-Tests +
 * `frontend/e2e/umkehr-shot.mjs`, der seine Seite aus GENAU diesem Code baut).
 *
 * Die Karte beantwortet drei Laienfragen, sonst ist sie Dekoration:
 *  1. Was macht die Strategie gerade? (Abends geplant, morgens gekauft,
 *     Krypto nach Mitternacht UTC — mit Uhrzeit des letzten Laufs.)
 *  2. Was kauft/verkauft MEIN Konto als Nächstes? (Plan aus
 *     users/{uid}/meta/umkehrPlan — nur Symbole, keine Beträge.)
 *  3. Warum wurde nichts gekauft? (`ohneKauf` des Morgenlaufs: Sperre,
 *     schon gehalten, kein Bargeld/Platz, abgelehnt.) „Keine Signale" ist
 *     bei dieser Strategie ein normaler Tag, kein Fehler — das muss dastehen.
 *
 * Symbole rendert der Aufrufer (`sym`), damit jede Stelle das anklickbare
 * Etikett mit `data-sym` trägt (CLAUDE.md §6) — ohne dass dieses Modul das
 * Dashboard importiert.
 */
import { esc } from './html.js';
import { sprachWahl, t } from './i18n.js';

export interface UmkehrOhneKauf {
  gesperrt?: number;
  gehalten?: number;
  bargeldOderPlatz?: number;
  abgelehnt?: number;
}

/** Öffentlicher Stand der drei Läufe (meta/umkehr). Alles optional: alte oder halbe Dokumente dürfen die Karte nicht sprengen. */
export interface UmkehrStatus {
  abend?: { at?: string; tag?: string; konten?: number; signale?: Array<{ symbol: string; rsi: number }>; signaleN?: number };
  morgen?: { at?: string; konten?: number; kaeufe?: number; verkaeufe?: number; ohneKauf?: UmkehrOhneKauf };
  krypto?: {
    at?: string;
    tag?: string;
    soll?: string;
    veraltet?: boolean;
    kaeufe?: number;
    verkaeufe?: number;
    signale?: Array<{ symbol: string; rsi: number }>;
  };
}

/** Plan des eigenen Kontos (users/{uid}/meta/umkehrPlan). */
export interface UmkehrKontoPlan {
  tag?: string;
  kaufen?: Array<{ symbol: string; rsi: number }>;
  verkaufen?: Array<{ symbol: string; grund: string }>;
  ausgefuehrtAm?: string | null;
}

type SymFn = (symbol: string) => string;

const lokal = (): string => (sprachWahl() === 'en' ? 'en-US' : 'de-DE');

/** RSI mit einer Nachkommastelle, Dezimalzeichen nach Sprache. */
export function rsiText(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString(lokal(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—';
}

/** „22.10. 22:45" bzw. „10/22 10:45 PM" — lokale Uhrzeit des Betrachters. `null` ⇒ „—". */
export function laufZeit(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const tag = d.toLocaleDateString(lokal(), { day: '2-digit', month: '2-digit' });
  const uhr = d.toLocaleTimeString(lokal(), { hour: '2-digit', minute: '2-digit' });
  return `${tag} ${uhr}`;
}

/** Die drei Kennzahlen oben: Signale (Börse), Käufe heute früh, Krypto. */
export function umkehrZahlen(s: UmkehrStatus | null): { signale: string; kaeufe: string; krypto: string } {
  const n = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—');
  return {
    signale: n(s?.abend?.signaleN ?? s?.abend?.signale?.length),
    kaeufe: n(s?.morgen?.kaeufe),
    krypto: s?.krypto?.veraltet ? t('uk.wartet') : n(s?.krypto?.kaeufe),
  };
}

/** Eine Zeile je Lauf: wann zuletzt, was dabei herauskam. */
export function umkehrLaeufe(s: UmkehrStatus | null): string {
  const zeile = (name: string, at: string | undefined, text: string): string =>
    `<div class="uk-row uk-lauf"><span>${esc(name)}</span><span class="mono">${esc(laufZeit(at))}</span><span>${esc(text)}</span></div>`;
  const a = s?.abend;
  const m = s?.morgen;
  const k = s?.krypto;
  const abendText = a ? `${a.signaleN ?? a.signale?.length ?? 0} ${t('uk.signale')}` : t('uk.nochNicht');
  const morgenText = m ? `${m.kaeufe ?? 0} ${t('uk.kaeufe')} · ${m.verkaeufe ?? 0} ${t('uk.verkaeufe')}` : t('uk.nochNicht');
  const kryptoText = !k
    ? t('uk.nochNicht')
    : k.veraltet
      ? t('uk.kryptoWartet')
      : `${k.kaeufe ?? 0} ${t('uk.kaeufe')} · ${k.verkaeufe ?? 0} ${t('uk.verkaeufe')}`;
  return (
    zeile(t('uk.abend'), a?.at, abendText)
    + zeile(t('uk.morgen'), m?.at, morgenText)
    + zeile(t('uk.krypto'), k?.at, kryptoText)
  );
}

/** Der eigene Plan: Käufe zur nächsten Eröffnung, Verkäufe mit Grund in Klartext. */
export function umkehrPlanHtml(plan: UmkehrKontoPlan | null, sym: SymFn): string {
  const kaufen = plan?.kaufen ?? [];
  const verkaufen = plan?.verkaufen ?? [];
  if (!plan || (kaufen.length === 0 && verkaufen.length === 0)) {
    return `<div class="hint">${esc(t('uk.planLeer'))}</div>`;
  }
  const grund = (g: string): string =>
    g === 'umkehr_erholt' ? t('uk.grundErholt') : g === 'umkehr_frist' ? t('uk.grundFrist') : g;
  const kopf = plan.ausgefuehrtAm ? t('uk.planErledigt') : t('uk.planOffen');
  return (
    `<div class="hint uk-plankopf">${esc(kopf)}</div>`
    + kaufen
      .map((k) => `<div class="uk-row"><span>${sym(k.symbol)}</span><span class="c-gn">${esc(t('uk.kauf'))}</span><span class="mono">RSI ${esc(rsiText(k.rsi))}</span></div>`)
      .join('')
    + verkaufen
      .map((v) => `<div class="uk-row"><span>${sym(v.symbol)}</span><span class="c-rd">${esc(t('uk.verkauf'))}</span><span>${esc(grund(v.grund))}</span></div>`)
      .join('')
  );
}

/** Die aktuellen Kaufsignale aller Konten (Marktinformation, öffentlich), Börse und Krypto zusammen, tiefster RSI zuerst. */
export function umkehrSignaleHtml(s: UmkehrStatus | null, sym: SymFn, max = 8): string {
  const alle = [...(s?.abend?.signale ?? []), ...(s?.krypto?.veraltet ? [] : (s?.krypto?.signale ?? []))]
    .filter((x) => x && typeof x.symbol === 'string' && Number.isFinite(x.rsi))
    .sort((a, b) => a.rsi - b.rsi)
    .slice(0, max);
  if (alle.length === 0) return `<div class="hint">${esc(t('uk.keineSignale'))}</div>`;
  return alle
    // Mittlere Zelle bewusst leer: „starker Rücksetzer" stand in jeder
    // Zeile und sagte nichts (Bildbefund) — die Bedeutung trägt die
    // Überschrift, die Zahl steht rechtsbündig unter dem Plan-RSI.
    .map((x) => `<div class="uk-row"><span>${sym(x.symbol)}</span><span></span><span class="mono">RSI ${esc(rsiText(x.rsi))}</span></div>`)
    .join('');
}

/**
 * Warum heute früh nichts (oder weniger) gekauft wurde — nur die Gründe,
 * die tatsächlich vorkamen. Leer, wenn es nichts zu erklären gibt.
 */
export function umkehrOhneKaufText(s: UmkehrStatus | null): string {
  const o = s?.morgen?.ohneKauf;
  if (!o) return '';
  const teile: string[] = [];
  const add = (n: number | undefined, text: string): void => {
    if (typeof n === 'number' && n > 0) teile.push(`${n}× ${text}`);
  };
  add(o.gehalten, t('uk.ohneGehalten'));
  add(o.bargeldOderPlatz, t('uk.ohneBargeld'));
  add(o.gesperrt, t('uk.ohneGesperrt'));
  add(o.abgelehnt, t('uk.ohneAbgelehnt'));
  return teile.length === 0 ? '' : `${t('uk.ohneKopf')} ${teile.join(' · ')}`;
}

/** Steht das eigene Konto gar nicht auf Kurzfrist-Umkehr? Dann sagt die Karte das, statt einen fremden Plan vorzutäuschen. */
export function umkehrModusHinweis(mode: string | undefined): string {
  return mode === 'umkehr' || mode === undefined ? '' : t('uk.andererModus');
}

/**
 * Das Kartengerüst — EINE Quelle für App und Bild-Prüfstand. `info` ist der
 * fertige ⓘ-Knopf des Aufrufers (das Dashboard verdrahtet ihn).
 */
export function umkehrGeruest(info: string): string {
  return `<div class="card" data-panel="umkehr"><div class="sect">${t('panel.umkehr')} ${info}</div><div class="cbody">
        <div class="row" style="gap:12px;margin-top:8px">
          <div><label class="lbl">${t('uk.lblSignale')}</label><div id="ukSig" class="smv mono">--</div></div>
          <div><label class="lbl">${t('uk.lblKaeufe')}</label><div id="ukKauf" class="smv mono">--</div></div>
          <div><label class="lbl">${t('uk.lblKrypto')}</label><div id="ukKrypto" class="smv mono">--</div></div>
        </div>
        <div class="hint" id="ukModus" hidden></div>
        <label class="lbl" style="margin-top:10px">${t('uk.deinPlan')}</label>
        <div id="ukPlan" class="uk-tbl"><div class="hint">${t('uk.planLeer')}</div></div>
        <label class="lbl" style="margin-top:10px">${t('uk.signaleListe')}</label>
        <div id="ukSignale" class="uk-tbl"><div class="hint">${t('uk.keineSignale')}</div></div>
        <label class="lbl" style="margin-top:10px">${t('uk.laeufe')}</label>
        <div id="ukLaeufe" class="uk-tbl"></div>
        <div class="hint" id="ukOhne"></div>
      </div></div>`;
}

/** Füllt das Gerüst. `el` holt ein Element per id (Dashboard: `$`, Prüfstand: `getElementById`). */
export function umkehrRendern(
  el: (id: string) => HTMLElement,
  s: UmkehrStatus | null,
  plan: UmkehrKontoPlan | null,
  mode: string | undefined,
  sym: SymFn,
): void {
  const z = umkehrZahlen(s);
  el('ukSig').textContent = z.signale;
  el('ukKauf').textContent = z.kaeufe;
  el('ukKrypto').textContent = z.krypto;
  const modus = umkehrModusHinweis(mode);
  const modusEl = el('ukModus');
  modusEl.textContent = modus;
  modusEl.hidden = modus === '';
  el('ukPlan').innerHTML = umkehrPlanHtml(plan, sym);
  el('ukSignale').innerHTML = umkehrSignaleHtml(s, sym);
  el('ukLaeufe').innerHTML = umkehrLaeufe(s);
  el('ukOhne').textContent = umkehrOhneKaufText(s);
}
