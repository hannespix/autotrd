/**
 * Onboarding-Tour (MU2): Spotlight-Overlay auf die ECHTE Oberfläche —
 * keine Fremdbibliothek, keine nachgebauten Screenshots.
 *
 * Mechanik: Ein fixiertes Rechteck legt sich über das Ziel-Element und
 * dunkelt per riesigem box-shadow alles andere ab (der klassische
 * Spotlight-Trick — ein Element, kein Canvas, keine vier Schattenwände).
 * Daneben eine Karte mit Titel, zwei Sätzen und Weiter/Zurück.
 *
 * Stationen, deren Ziel gerade nicht sichtbar ist (abgewähltes Modul,
 * eingeklappte Spalte am Handy), werden ÜBERSPRUNGEN statt ins Leere zu
 * zeigen — die Tour beschreibt, was da ist, nicht was da sein könnte.
 */

import { t } from './i18n.js';

export interface TourStation {
  /** CSS-Selektor des Ziels. */
  ziel: string;
  titel: string;
  /** Zwei Sätze — mehr liest beim ersten Login niemand. */
  text: string;
}

interface Lauf {
  stationen: TourStation[];
  index: number;
  spot: HTMLElement;
  karte: HTMLElement;
  amEnde: () => void;
  /** Positionierer der AKTUELLEN Station — resize/scroll rufen ihn auf. */
  positionieren: () => void;
}

let lauf: Lauf | null = null;

export function tourAktiv(): boolean {
  return lauf !== null;
}

function zielElement(s: TourStation): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(s.ziel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Unsichtbar (display:none, leeres Layout, Off-Canvas-Spalte) → keine Station.
  if (r.width < 8 || r.height < 8) return null;
  return el;
}

function nachfuehren(): void {
  lauf?.positionieren();
}

function beenden(): void {
  if (!lauf) return;
  window.removeEventListener('resize', nachfuehren);
  window.removeEventListener('scroll', nachfuehren, true);
  lauf.spot.remove();
  lauf.karte.remove();
  const amEnde = lauf.amEnde;
  lauf = null;
  amEnde();
}

function zeige(index: number, richtung: 1 | -1): void {
  if (!lauf) return;
  // Nächste SICHTBARE Station in Laufrichtung suchen.
  let i = index;
  let el: HTMLElement | null = null;
  while (i >= 0 && i < lauf.stationen.length) {
    el = zielElement(lauf.stationen[i]!);
    if (el) break;
    i += richtung;
  }
  if (!el || i < 0 || i >= lauf.stationen.length) {
    beenden();
    return;
  }
  lauf.index = i;
  const station = lauf.stationen[i]!;

  const reduziert = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: reduziert ? 'auto' : 'smooth' });

  lauf.positionieren = (): void => {
    if (!lauf) return;
    const ziel = zielElement(station);
    if (!ziel) return;
    const r = ziel.getBoundingClientRect();
    const rand = 6;
    Object.assign(lauf.spot.style, {
      top: `${r.top - rand}px`,
      left: `${r.left - rand}px`,
      width: `${r.width + 2 * rand}px`,
      height: `${r.height + 2 * rand}px`,
    });
    // Karte unter das Ziel, wenn Platz ist — sonst darüber; horizontal geklemmt.
    const kb = lauf.karte.getBoundingClientRect();
    const unten = r.bottom + 12 + kb.height < window.innerHeight;
    const top = unten ? r.bottom + 12 : Math.max(12, r.top - kb.height - 12);
    const left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - kb.width - 12));
    Object.assign(lauf.karte.style, { top: `${top}px`, left: `${left}px` });
  };

  const anzahl = lauf.stationen.length;
  const erste = lauf.stationen.findIndex((s) => zielElement(s) !== null);
  lauf.karte.innerHTML = `
    <div class="tour-kopf"><b>${station.titel}</b>
      <button class="tour-x" data-tour="x" aria-label="${t('tour.beenden')}">✕</button></div>
    <p>${station.text}</p>
    <div class="tour-fuss">
      <span class="tour-schritt">${i + 1}/${anzahl}</span>
      ${i > erste ? `<button class="btn btn-n" data-tour="zurueck">${t('tour.zurueck')}</button>` : ''}
      <button class="btn btn-g" data-tour="weiter">${i >= anzahl - 1 ? t('tour.fertig') : t('tour.weiter')}</button>
    </div>`;
  lauf.karte.querySelector('[data-tour="x"]')!.addEventListener('click', () => beenden());
  lauf.karte
    .querySelector('[data-tour="weiter"]')!
    .addEventListener('click', () => zeige(lauf!.index + 1, 1));
  lauf.karte
    .querySelector('[data-tour="zurueck"]')
    ?.addEventListener('click', () => zeige(lauf!.index - 1, -1));

  // Nach dem (sanften) Scrollen mehrfach nachziehen — scrollIntoView meldet
  // kein Ende, und eine Karte neben dem Ziel wäre schlimmer als zwei kurze
  // Sprünge. Der Scroll-Listener führt dazwischen ohnehin laufend nach.
  lauf.positionieren();
  window.setTimeout(nachfuehren, 150);
  window.setTimeout(nachfuehren, 400);
}

/**
 * Tour starten. `amEnde` feuert bei „Fertig" UND beim Abbrechen (✕) —
 * beides zählt als „gesehen": Wer abbricht, will die Tour nicht bei jedem
 * Login erneut vorgesetzt bekommen. Der ?-Knopf holt sie jederzeit zurück.
 */
export function starteTour(stationen: TourStation[], amEnde: () => void): void {
  if (lauf) beenden();
  if (stationen.every((s) => zielElement(s) === null)) {
    amEnde();
    return;
  }
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const karte = document.createElement('div');
  karte.className = 'tour-karte';
  karte.setAttribute('role', 'dialog');
  karte.setAttribute('aria-label', t('tour.aria'));
  document.body.appendChild(spot);
  document.body.appendChild(karte);

  lauf = { stationen, index: 0, spot, karte, amEnde, positionieren: () => undefined };
  window.addEventListener('resize', nachfuehren);
  window.addEventListener('scroll', nachfuehren, true);
  zeige(0, 1);
}
