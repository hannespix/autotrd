/**
 * „Warum NICHT gekauft" in Alltagssprache (Task 21, Phase 2) — rein, ohne DOM.
 * Quelle sind ausschließlich feste Codes und Zahlen aus users/{uid}/absagen;
 * das Ergebnis landet im Aufrufer nur über escText/textContent.
 */
import type { AbsageEintrag, AbsageGrund } from '@autotrd/shared';
import { sprachWahl, t } from './i18n.js';

type Schluessel = Parameters<typeof t>[0];
const SCHLUESSEL: Record<AbsageGrund, Schluessel> = {
  pos_limit: 'abs.pos_limit',
  cooldown_aktiv: 'abs.cooldown_aktiv',
  sockel_besitz: 'abs.sockel_besitz',
  live_verriegelt: 'abs.live_verriegelt',
  breaker_aktiv: 'abs.breaker_aktiv',
  abgleich_drift: 'abs.abgleich_drift',
  fremdbestand: 'abs.fremdbestand',
  pdt_schutz: 'abs.pdt_schutz',
  nicht_handelbar: 'abs.nicht_handelbar',
  regime_stress: 'abs.regime_stress',
  regime_gegen_trend: 'abs.regime_gegen_trend',
  cluster_voll: 'abs.cluster_voll',
  news_veto: 'abs.news_veto',
  ki_veto: 'abs.ki_veto',
  klasse_aus: 'abs.klasse_aus',
  unter_kosten: 'abs.unter_kosten',
  filter_blockiert: 'abs.filter_blockiert',
  ausfuehrung_abgelehnt: 'abs.ausfuehrung_abgelehnt',
};

const zahl = (x: number, stellen = 2): string =>
  x.toLocaleString(sprachWahl() === 'en' ? 'en-US' : 'de-DE', { minimumFractionDigits: 0, maximumFractionDigits: stellen });

/** Der Grund als Satz — mit den Zahlen, die entschieden haben, sofern aufgezeichnet. */
export function absageText(e: AbsageEintrag): string {
  const z = e.z;
  const basis = t(SCHLUESSEL[e.grund]);
  switch (e.grund) {
    case 'pos_limit':
      return z.offen !== null && z.limit !== null ? `${basis} (${z.offen}/${z.limit})` : basis;
    case 'cooldown_aktiv':
      return z.cooldownMin !== null ? `${basis} (${t('abs.minuten').replace('{0}', String(z.cooldownMin))})` : basis;
    case 'unter_kosten':
      return z.erwartetPct !== null && z.noetigPct !== null
        ? `${basis}: ${t('abs.kostenZahlen').replace('{0}', zahl(z.erwartetPct)).replace('{1}', zahl(z.noetigPct))}`
        : basis;
    case 'filter_blockiert':
      return z.steckbriefN !== null
        ? `${basis} (${t('abs.steckbriefZahlen').replace('{0}', String(z.steckbriefN))})`
        : basis;
    default:
      return basis;
  }
}

/** Weitere Gründe desselben Tages („außerdem: 3× Wartezeit"), ohne den Hauptgrund. */
export function absageWeitere(e: AbsageEintrag): string {
  const teile = Object.entries(e.je)
    .filter(([g, n]) => g !== e.grund && typeof n === 'number' && n > 0)
    .map(([g, n]) => `${n}× ${t(SCHLUESSEL[g as AbsageGrund])}`);
  return teile.length > 0 ? `${t('abs.ausserdem')} ${teile.join(' · ')}` : '';
}
