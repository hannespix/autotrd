/**
 * KI-Einordnungen lesbar machen (Task 22) — rein, ohne DOM.
 *
 * Quelle ist allein die Whitelist-Kopie `market/{sym}.ki` (shared/kiAnzeige.ts):
 * strukturierte Felder, kein Freitext, keine Schlagzeile. Deshalb gibt es hier
 * nichts zu escapen außer dem, was wir selbst zusammensetzen — und auch das
 * landet im Aufrufer ausschließlich über textContent bzw. escText.
 */
import { kiWirkt, type KiAnzeigeEintrag } from '@autotrd/shared';
import { sprachWahl, t } from './i18n.js';

export interface KiZeile {
  pfeil: '▲' | '▼' | '•';
  farbe: 'gn' | 'rd' | 't3';
  /** „gut für den Wert · gegengeprüft · Stärke 7/10 · Quartalszahlen · noch nicht im Kurs · wirkt etwa 3 Tage" */
  text: string;
  /** „09.10., 16:05" */
  wann: string;
  /** Wirkt diese Einordnung JETZT auf den Handel? Dieselben Bedingungen wie der Handel (kiWirkt). */
  wirkt: boolean;
}

const EREIGNIS_SCHLUESSEL: Record<string, Parameters<typeof t>[0]> = {
  zahlen: 'kie.ev.zahlen', prognose: 'kie.ev.prognose', uebernahme: 'kie.ev.uebernahme', zulassung: 'kie.ev.zulassung',
  auftrag: 'kie.ev.auftrag', recht: 'kie.ev.recht', management: 'kie.ev.management', produkt: 'kie.ev.produkt',
  kapital: 'kie.ev.kapital', analyst: 'kie.ev.analyst', makro: 'kie.ev.makro', sonstiges: 'kie.ev.sonstiges',
};
const EINGEPREIST_SCHLUESSEL: Record<string, Parameters<typeof t>[0]> = {
  nein: 'kie.ep.nein', teilweise: 'kie.ep.teilweise', ja: 'kie.ep.ja', unklar: 'kie.ep.unklar',
};

export function kiZeile(e: KiAnzeigeEintrag, jetztMs: number): KiZeile {
  const teile: string[] = [];
  teile.push(t(e.richtung === 'positiv' ? 'kie.positiv' : e.richtung === 'negativ' ? 'kie.negativ' : 'kie.neutral'));
  teile.push(t(e.gegengeprueft ? (e.handlungsfaehig ? 'kie.gegengeprueft' : 'kie.nichtBestaetigt') : 'kie.nurGesichtet'));
  teile.push(t('kie.staerke').replace('{0}', String(Math.round(e.staerke * 10))));
  if (e.ereignis && EREIGNIS_SCHLUESSEL[e.ereignis]) teile.push(t(EREIGNIS_SCHLUESSEL[e.ereignis]!));
  if (e.eingepreist && EINGEPREIST_SCHLUESSEL[e.eingepreist]) teile.push(t(EINGEPREIST_SCHLUESSEL[e.eingepreist]!));
  if (typeof e.horizontTage === 'number') {
    teile.push(t(e.horizontTage === 1 ? 'kie.horizont1' : 'kie.horizont').replace('{0}', String(e.horizontTage)));
  }
  const d = new Date(e.decidedAt);
  const wann = Number.isFinite(d.getTime())
    ? d.toLocaleString(sprachWahl() === 'en' ? 'en-US' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  return {
    pfeil: e.richtung === 'positiv' ? '▲' : e.richtung === 'negativ' ? '▼' : '•',
    farbe: e.richtung === 'positiv' ? 'gn' : e.richtung === 'negativ' ? 'rd' : 't3',
    text: teile.join(' · '),
    wann,
    wirkt: kiWirkt(e, jetztMs),
  };
}

/** Die Einordnung zu einem Urteil (Join fürs Trade-Journal über `{newsId}_{symbol}`). */
export function kiEintragZu(verlauf: readonly KiAnzeigeEintrag[] | null | undefined, newsId: string | undefined, symbol: string): KiAnzeigeEintrag | null {
  if (!newsId) return null;
  const id = `${newsId}_${symbol}`;
  return (verlauf ?? []).find((e) => e.id === id) ?? null;
}
