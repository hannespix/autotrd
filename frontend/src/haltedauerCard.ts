/**
 * Darstellung der Haltedauer-Kurve — als eigenes Modul, nicht im Dashboard.
 *
 * Zwei Gründe:
 *
 *  1. Prüfbarkeit. Die Karte trifft eine Aussage, aus der eine echte
 *     Einstellungs-Änderung folgen kann. Als String-Bau in einer
 *     Render-Funktion mit DOM-Zugriffen wäre sie nur im Browser prüfbar;
 *     hier ist sie eine reine Funktion mit Unit-Tests.
 *  2. Der Layout-Prüfstand (`frontend/e2e/haltedauer-shot.mjs`) baut seine
 *     Seite aus GENAU diesem Code. Ein Prüfstand, der die Markup-Struktur
 *     nachbaut, prüft irgendwann etwas anderes als die App zeigt.
 */
import { type HaltedauerZeile } from '@autotrd/shared';
import { esc } from './html.js';
import { t } from './i18n.js';

/** Prozent mit drei Nachkommastellen, deutsches Komma. `null` ⇒ Gedankenstrich. */
export function pct3(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(3)} %`.replace('.', ',');
}

/** Quote als Prozent mit einer Nachkommastelle. */
export function quote1(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1).replace('.', ',')} %`;
}

/** Die Tabelle als HTML — Kopfzeile plus eine Zeile je Haltedauer. */
export function haltedauerTabelle(
  zeilen: HaltedauerZeile[],
  beste: HaltedauerZeile | null,
): string {
  return (
    `<div class="hd-row hd-head"><span>${t('hc.halten')}</span><span>n</span><span>${t('hc.netto')}</span>`
    + `<span>${t('hc.treffer')}</span><span>${t('hc.kauf')}</span><span>${t('hc.verkauf')}</span></div>`
    + zeilen
      .map((z) => {
        const kl = ['hd-row', z.belastbar ? '' : 'hd-dim', z === beste ? 'hd-best' : '']
          .filter(Boolean)
          .join(' ');
        return (
          `<div class="${kl}">`
          + `<span>${z.tage} ${z.tage === 1 ? t('hc.tag') : t('hc.tage')}</span>`
          + `<span>${z.n}</span><span>${esc(pct3(z.nettoPct))}</span>`
          + `<span>${esc(quote1(z.trefferquote))}</span>`
          + `<span>${esc(pct3(z.buyPct))}</span><span>${esc(pct3(z.sellPct))}</span>`
          + '</div>'
        );
      })
      .join('')
  );
}

/**
 * Der Satz unter der Tabelle.
 *
 * Ohne belastbare Zeile MUSS hier „noch keine Aussage" stehen. Ein
 * Spitzenreiter aus dünnen Daten würde als Empfehlung gelesen — und die
 * Karte ist genau dafür da, gelesen zu werden.
 */
export function haltedauerFazit(beste: HaltedauerZeile | null): string {
  if (!beste) {
    return t('hc.nochKeineZeile');
  }
  // Die Drift-Warnung ist der ehrlichste Teil der Karte: Verdient nur die
  // Kaufseite, misst man den steigenden Markt und nicht das Signal.
  const drift =
    beste.buyPct !== null && beste.sellPct !== null && beste.sellPct <= 0
      ? ` ${t('hc.driftWarnung')}`
      : '';
  return (
    `${t('hc.bestesHalten')} ${beste.tage} ${beste.tage === 1 ? t('hc.handelstag') : t('hc.handelstage')}`
    + ` ${t('hc.mit')} ${pct3(beste.nettoPct)} ${t('hc.jeSignalNachKosten')} (n = ${beste.n}).${drift}`
  );
}

/** Die Fußzeile: woraus die Zahl besteht. */
export function haltedauerMeta(d: {
  symbole?: number;
  fenster?: number;
  version?: number;
}): string {
  return [
    d.symbole ? `${d.symbole} Symbole` : null,
    d.fenster ? `${d.fenster} Basistage je Symbol` : null,
    d.version ? `Rechnung v${d.version}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
