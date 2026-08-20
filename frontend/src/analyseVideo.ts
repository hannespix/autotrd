/**
 * Das Analyse-VIDEO (Owner-Wunsch 20.08.): „daraus Videos erstellen, wo die
 * schick animierten Schaubilder sich verändern — nacheinander verschiedene
 * Werte, Sachen umgeschaltet, verschiedene Aspekte des Trading-Pools."
 *
 * Die Regie: Ergebnis-Karte (Zahl zählt hoch) → Kontoverlauf zeichnet sich →
 * je-Symbol-Balken wachsen → Zeitmuster-Balken wachsen und MORPHEN mitten in
 * der Szene von Stunden auf Wochentage (der sichtbare Aspekt-Wechsel) →
 * Einladung. Die Diagramme sind DIESELBEN wie im Analyse-Fenster
 * (`baueOptionen` aus analyseCharts) — nur offscreen mit Canvas-Renderer
 * gerendert und je Frame in die Aufnahme-Leinwand kopiert. Video und
 * Dashboard können nicht auseinanderlaufen.
 *
 * Aufnahme, Rahmen, Kopf und Siegel kommen aus shareVideo (`nimmClipAuf`,
 * `maleRahmen`, `maleKopf`, `maleSiegel`): Ehrlichkeit ist nicht animierbar —
 * das Papier-Siegel steht auf JEDEM Frame in voller Deckkraft, die
 * Einladungs-Szene enthält keine Ziffer, das Teilen-Gate gilt davor.
 *
 * Die Optionen laufen hier IMMER mit Animation (der Clip IST die Animation —
 * `prefers-reduced-motion` regelt die Wiedergabe im UI, nicht das erzeugte
 * Artefakt) und mit festen dunklen Karten-Farben (FARBE aus shareCard,
 * literal wie bei den Bildern: gerastert wird ohne Stylesheet).
 */

import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { type AnalyseChartDaten, type ChartLook, baueOptionen } from './analyseCharts.js';
import { t } from './i18n.js';
import { FARBE, type ShareDaten } from './shareCard.js';
import { maleKopf, maleRahmen, maleSiegel, maleSzene, nimmClipAuf, szeneBei } from './shareVideo.js';

// Chart-Typen und Komponenten registriert analyseCharts beim Import;
// hier kommt nur der Canvas-Renderer für die Offscreen-Bühne dazu.
echarts.use([CanvasRenderer]);

/** Feste Video-Farben: dieselbe dunkle Karte wie Bilder und Story-Video. */
const VIDEO_LOOK: ChartLook = {
  text: FARBE.text2,
  leise: FARBE.text3,
  hair: 'rgba(255, 255, 255, .07)',
  bd: FARBE.linie,
  gn: FARBE.gruen,
  rd: FARBE.rot,
  kat: [FARBE.akzent, '#8b7cff', FARBE.gruen, FARBE.rot, '#5ce4fb', '#40e0b4', '#ff8290', FARBE.text2],
  dunkel: true,
  animation: true,
};

export interface RegieSzene {
  id: 'ergebnis' | 'kurve' | 'symbole' | 'zeitmuster' | 'cta';
  dauerMs: number;
}

/**
 * Die Szenenfolge — Aspekte ohne Daten fliegen raus, die Einladung schließt
 * immer ab. Gesamt ~10–16 s, je nachdem, was das Konto hergibt.
 */
export function regiePlan(chart: AnalyseChartDaten): RegieSzene[] {
  const plan: RegieSzene[] = [{ id: 'ergebnis', dauerMs: 3000 }];
  if (chart.verlauf.length >= 2) plan.push({ id: 'kurve', dauerMs: 3200 });
  if (chart.symbole.length > 0) plan.push({ id: 'symbole', dauerMs: 3200 });
  if (chart.stunden.some((s) => s.value !== 0) && chart.wochentage.some((w) => w.value !== 0)) {
    plan.push({ id: 'zeitmuster', dauerMs: 3600 });
  }
  plan.push({ id: 'cta', dauerMs: 2800 });
  return plan;
}

/* Chart-Fläche in der 1080er-Leinwand: innerhalb der Karte (1200er-Raum
 * 90…1110 ⇒ nativ 81…999), unter Kopf und Titel, über der Fußzeile. */
const CHART_X = 81;
const CHART_Y = 252;
const CHART_B = 918;
const CHART_H = 690;

interface Buehne {
  chart: echarts.ECharts;
  leinwand: HTMLCanvasElement | null;
  gewechselt: boolean;
}

/**
 * Nimmt das Analyse-Video auf. `story` liefert Ergebnis-/Einladungs-Szene,
 * Zeitraum und das Siegel; `chart` die Diagramm-Daten des Analyse-Fensters.
 */
export async function baueAnalyseVideo(
  story: ShareDaten,
  chart: AnalyseChartDaten,
  meldeFortschritt?: (prozent: number) => void,
  beobachter?: (canvas: HTMLCanvasElement, tMs: number) => void,
): Promise<File> {
  const plan = regiePlan(chart);
  const gesamt = plan.reduce((s, sz) => s + sz.dauerMs, 0);
  const optionen = baueOptionen(chart, VIDEO_LOOK);

  let buehne: Buehne | null = null;
  let buehneFuer: RegieSzene['id'] | null = null;

  const szenenOption = (id: RegieSzene['id']): object =>
    id === 'kurve' ? optionen.verlauf : id === 'symbole' ? optionen.symbole : optionen.stunden;
  const szenenTitel = (id: RegieSzene['id'], gewechselt: boolean): string =>
    id === 'kurve'
      ? t('an.kontoverlauf')
      : id === 'symbole'
        ? t('an.jeSymbol')
        : gewechselt
          ? t('an.nachWochentag')
          : t('an.nachStunde');

  const raeumeAuf = (): void => {
    buehne?.chart.dispose();
    buehne = null;
    buehneFuer = null;
  };

  const macheBuehne = (id: RegieSzene['id']): void => {
    raeumeAuf();
    const host = document.createElement('div');
    const instanz = echarts.init(host, undefined, { renderer: 'canvas', width: CHART_B, height: CHART_H });
    // Längere Eintritts-Animation als im UI (die Szene trägt sie), und kein
    // Tooltip — im Video hovert niemand.
    instanz.setOption({ ...szenenOption(id), animationDuration: 1100, tooltip: { show: false } });
    buehne = { chart: instanz, leinwand: host.querySelector('canvas'), gewechselt: false };
    buehneFuer = id;
  };

  const datei = await nimmClipAuf(
    gesamt,
    (ctx, tMs) => {
      const { szene, p } = szeneBei(plan, tMs);

      // Karten-Szenen (Zahl / Einladung) malt das Story-Video.
      if (szene.id === 'ergebnis' || szene.id === 'cta') {
        if (buehneFuer) raeumeAuf();
        ctx.save();
        ctx.scale(1080 / 1200, 1080 / 1200);
        maleSzene(ctx, story, szene.id, p);
        ctx.restore();
        return;
      }

      if (buehneFuer !== szene.id) macheBuehne(szene.id);
      // Der Umschalt-Moment: Ab der Hälfte der Zeitmuster-Szene morphen die
      // Stunden-Balken in die Wochentage — sichtbarer Aspekt-Wechsel in
      // DERSELBEN Instanz, wie beim Zeitraum-Umschalter im Dashboard.
      if (szene.id === 'zeitmuster' && p >= 0.5 && buehne && !buehne.gewechselt) {
        buehne.gewechselt = true;
        buehne.chart.setOption({
          ...optionen.wochentage,
          animationDurationUpdate: 700,
          tooltip: { show: false },
        });
      }

      ctx.save();
      ctx.scale(1080 / 1200, 1080 / 1200);
      maleRahmen(ctx);
      maleKopf(ctx, szenenTitel(szene.id, buehne?.gewechselt === true));
      if (story.vonTag && story.bisTag) {
        ctx.fillStyle = FARBE.text3;
        ctx.font = '26px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(`${story.vonTag} → ${story.bisTag}`, 90, 186);
      }
      ctx.restore();
      if (buehne?.leinwand) ctx.drawImage(buehne.leinwand, CHART_X, CHART_Y, CHART_B, CHART_H);
      // Das Siegel zuletzt und in voller Deckkraft — auf JEDEM Frame.
      ctx.save();
      ctx.scale(1080 / 1200, 1080 / 1200);
      maleSiegel(ctx, story.echtgeld);
      ctx.restore();
    },
    `autotrd-analyse-${story.zerlegung.tage[story.zerlegung.tage.length - 1] ?? story.bisTag ?? 'aktuell'}`,
    meldeFortschritt,
    beobachter,
  );
  raeumeAuf();
  return datei;
}
