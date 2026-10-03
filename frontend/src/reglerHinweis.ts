/**
 * Warnung am Klassen-Regler, BEVOR der Auto-Regler einen Handwert kassiert.
 *
 * Owner-Befund 15.08.: „wenn ich den krypto hebel auf 1 setze und speichere,
 * ist der wert beim nächsten Öffnen wieder auf 0 — options broken?" Kaputt
 * war nichts: Das Speichern schreibt den Wert korrekt, aber „Automatisch
 * nachregeln" (Standard AN) stellt eine strukturell verlierende Klasse beim
 * nächsten Tageslauf sofort wieder auf 0 — belegt im classLog, erklärt im
 * ⓘ-Tooltip. Nur: An dem Ort, an dem man den Regler ANFASST, sagte es nichts.
 * Ein Wert, der still wieder verschwindet, sieht exakt wie ein Bug aus.
 *
 * Deshalb entsteht die Warnung jetzt im Moment des Verstellens, aus derselben
 * Empfehlung (`stats/main.classAdvice`), nach der die Automatik später
 * entscheidet. Die Oberfläche rechnet bewusst nichts nach — eine zweite
 * Implementierung der Regler-Logik wäre eine zweite Wahrheit.
 */

import { t } from './i18n.js';

/** Teilmenge eines `KlassenRat`s, die die Warnung braucht (s. data.ts). */
export interface ReglerRat {
  empfehlung: string;
  vorschlag: number;
}

/** Zahl im deutschen Format des Reglers (0,25er-Raster — höchstens 2 Stellen). */
function zahl(w: number): string {
  return String(Math.round(w * 100) / 100).replace('.', ',');
}

/**
 * Text für `#owClsMsg`, sobald ein Regler verstellt wird — leer, wenn nichts
 * zu warnen ist.
 *
 * Leer bleibt sie in genau drei Fällen, und jeder ist eine Aussage:
 * Automatik aus (der Wert hält), keine belegte Empfehlung (die Automatik
 * rührt das Gewicht nicht an — Evidenz vor Meinung), oder der Handwert
 * stimmt ohnehin mit dem Vorschlag überein.
 */
export function reglerWarnung(
  autoAn: boolean,
  rat: ReglerRat | undefined,
  wert: number,
  label: string,
): string {
  if (!autoAn) return '';
  if (!rat || rat.empfehlung === 'zu_wenig_daten') return '';
  if (Math.abs(rat.vorschlag - wert) < 1e-9) return '';
  if (rat.empfehlung === 'abschalten') {
    return (
      `${t('rh.abschaltenA')} ${label} ${t('rh.abschaltenB')}`
    );
  }
  return (
    `${t('rh.ziehtA')} ${label} ${t('rh.ziehtB')} ${zahl(rat.vorschlag)} ${t('rh.ziehtC')}`
  );
}
