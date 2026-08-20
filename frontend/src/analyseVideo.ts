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
  /* Die 918px-Bühne schrumpft im Feed auf Handybreite — ohne diesen Faktor
   * sind die Skalen unlesbar (Owner-Kritik 20.08.: „viel zu kleine Schrift").
   * Und der Canvas-Renderer braucht eine ECHTE Schriftfamilie: mit dem
   * App-Default `inherit` verwirft der Canvas jede Font-Zuweisung still und
   * malt 10px sans-serif — der Faktor käme nie an (siehe ChartLook.schrift). */
  skala: 2.6,
  schrift: 'ui-sans-serif, system-ui, sans-serif',
};

export interface RegieSzene {
  id: 'ergebnis' | 'kurve' | 'symbole' | 'zeitmuster' | 'cta';
  dauerMs: number;
}

/**
 * Die Szenenfolge — Regie nach Owner-Kritik 20.08. („Regisseur-mäßig, kein
 * Werbe-Look, manche Teile fixiert"):
 *
 *  - Der HOOK zuerst: keine stehende Titelkarte, sondern die Kurve, die sich
 *    zeichnet, während die Rendite im Kopf hochzählt — „da geht was" ab
 *    Sekunde 1. LinkedIn entscheidet in den ersten zwei Sekunden, ob
 *    weitergeschaut wird.
 *  - Die Chart-Szenen teilen EINE feste Bühne (Rahmen, Marke, Zeitraum,
 *    Siegel stehen — nur die Diagrammfläche wechselt, mit weicher Blende).
 *  - Die Einladung ist eine kurze, leise Schlusskarte (Abspann, keine
 *    Werbung) — und die Ergebnis-Karte läuft nur noch als Einstieg, wenn es
 *    keine Kurve gibt (die Zahl ist dann der einzige Inhalt).
 *
 * Aspekte ohne Daten fliegen raus. Gesamt ~6–15 s.
 */
export function regiePlan(chart: AnalyseChartDaten): RegieSzene[] {
  /* Owner-Nachkritik („zu schnell, zu hektisch, zu linear"): Jede Szene
   * bekommt nach ihrer Animation einen HALTE-MOMENT zum Lesen — das Auge
   * braucht bei einem neuen Diagramm ~2 s Orientierung plus Lesezeit.
   * Und es bewegt sich immer nur EIN Blickziel (geteilte Aufmerksamkeit
   * ist der klassische Multimedia-Fehler): erst zeichnet die Kurve, DANN
   * zählt die Zahl, dann Ruhe. ~18 s gesamt — Verständnis schlägt Kürze. */
  /* Zeit-Verteilung nach Kritiker-Befund: Die Symbol-Szene ist der
   * simpelste Inhalt (kürzeste Ruhe), der Morph-Payoff und der Abspann
   * brauchen die Lesezeit (vier Zeilen ≈ 4 s auf Handybreite). */
  const plan: RegieSzene[] = [];
  if (chart.verlauf.length >= 2) plan.push({ id: 'kurve', dauerMs: 6000 });
  else plan.push({ id: 'ergebnis', dauerMs: 3000 });
  if (chart.symbole.length > 0) plan.push({ id: 'symbole', dauerMs: 4200 });
  if (chart.stunden.some((s) => s.value !== 0) && chart.wochentage.some((w) => w.value !== 0)) {
    plan.push({ id: 'zeitmuster', dauerMs: 5200 });
  }
  plan.push({ id: 'cta', dauerMs: 4000 });
  return plan;
}

/** Weiches Ein/Aus (cubic) — dieselbe Handschrift wie im Story-Video. */
const weich = (p: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

/** „+5,49 %" im deutschen Format — Vorzeichen immer, echtes Minuszeichen. */
export function formatRendite(pct: number): string {
  const betrag = Math.abs(pct).toFixed(2).replace('.', ',');
  return `${pct < 0 ? '−' : '+'}${betrag} %`;
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

  /* Feste y-Spanne über BEIDE Zeitmuster-Aspekte: Ohne sie rescaled die
   * Achse mitten im Morph, während die Balken schon neu ankern — sie
   * durchstoßen sichtbar die Null-Linie (Kritiker-No-Go, Frame 13,7 s). */
  const zeitWerte = [...chart.stunden, ...chart.wochentage].map((b) => b.value);
  const zeitPuffer = (Math.max(0, ...zeitWerte) - Math.min(0, ...zeitWerte)) * 0.08 || 1;
  const festeSpanne = {
    min: Math.floor(Math.min(0, ...zeitWerte) - zeitPuffer),
    max: Math.ceil(Math.max(0, ...zeitWerte) + zeitPuffer),
  };
  const mitFesterAchse = (o: object): object => ({
    ...o,
    yAxis: { ...((o as { yAxis?: object }).yAxis ?? {}), ...festeSpanne },
  });

  let buehne: Buehne | null = null;
  let buehneFuer: RegieSzene['id'] | null = null;

  const szenenOption = (id: RegieSzene['id']): object =>
    id === 'kurve'
      ? optionen.verlauf
      : id === 'symbole'
        ? optionen.symbole
        : mitFesterAchse(optionen.stunden);
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

  /* Bühne der ersten Szene VOR der Aufnahme aufbauen und einen Frame
   * rendern lassen: Sonst ist Frame 0 — das Poster-Bild im Feed — eine
   * leere Karte (Kritiker-Befund: ECharts malt erst im nächsten rAF). */
  const erste = plan[0]!;
  if (erste.id !== 'ergebnis' && erste.id !== 'cta') {
    macheBuehne(erste.id);
    await new Promise((f) => requestAnimationFrame(() => f(undefined)));
  }

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
        // Auch der Abspann trägt das Siegel: Ausgerechnet der CTA-Frame
        // wird am ehesten pausiert und gescreenshottet (Kritiker-Befund).
        if (szene.id === 'cta') maleSiegel(ctx, story.echtgeld);
        ctx.restore();
        return;
      }

      if (buehneFuer !== szene.id) macheBuehne(szene.id);
      // Der Umschalt-Moment: Ab der Hälfte der Zeitmuster-Szene morphen die
      // Stunden-Balken in die Wochentage — sichtbarer Aspekt-Wechsel in
      // DERSELBEN Instanz, wie beim Zeitraum-Umschalter im Dashboard.
      if (szene.id === 'zeitmuster' && p >= 0.55 && buehne && !buehne.gewechselt) {
        // Erst lesen lassen, dann langsam morphen — der Aspekt-Wechsel ist
        // der Höhepunkt der Szene, kein weiterer Schnitt.
        buehne.gewechselt = true;
        buehne.chart.setOption({
          ...mitFesterAchse(optionen.wochentage),
          animationDurationUpdate: 900,
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
      /* Der Hook: In der Eröffnungs-Szene zählt die Rendite oben rechts
       * hoch, während sich die Kurve darunter zeichnet — die Zahl gehört
       * zur Kurve, nicht auf eine eigene Titelkarte. Prozent nur mit
       * Zeitraum (dieselbe Ehrlichkeitsregel wie auf den Karten). */
      if (szene.id === 'kurve' && story.vonTag && story.bisTag) {
        /* EIN Blickziel nach dem anderen (geteilte Aufmerksamkeit ist der
         * klassische Multimedia-Fehler): 0–1,6 s zeichnet NUR die Kurve,
         * dann blendet die Zahl ein und zählt in 1,2 s hoch, danach steht
         * alles still — Lesezeit statt Dauerbewegung. */
        const tSz = p * szene.dauerMs;
        if (tSz > 1100) {
          // Fertig bei ~2,0 s — die stärkste Zahl muss ins Scroll-Fenster
          // fallen (Kritiker-Befund: vorher erst bei 2,7 s).
          const wert = story.renditePct * weich((tSz - 1100) / 900);
          ctx.globalAlpha = weich((tSz - 1100) / 400);
          ctx.fillStyle = story.renditePct > 0 ? FARBE.gruen : story.renditePct < 0 ? FARBE.rot : FARBE.text2;
          ctx.font = '700 68px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'right';
          // Rechtsbündig UNTER dem Siegel (Chip endet ~150) — nie darüber.
          ctx.fillText(formatRendite(wert), 1110, 246);
          ctx.textAlign = 'left';
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();
      /* Weiche Blende in BEIDE Richtungen: Die Bühne (Rahmen, Marke,
       * Zeitraum, Siegel) steht fest — die Diagrammfläche blendet beim
       * Szenenwechsel aus (300 ms) und ein (600 ms). Ein harter Schnitt
       * war der Hektik-Treiber Nummer eins (Owner-Nachkritik). */
      if (buehne?.leinwand) {
        ctx.save();
        const tSz = p * szene.dauerMs;
        // Die Ein-Blende gilt nur ÜBERGÄNGEN — die Eröffnungs-Szene startet
        // voll sichtbar, sonst ist Frame 0 (das Poster im Feed) wieder leer.
        const ein = szene === plan[0] ? 1 : weich(tSz / 600);
        ctx.globalAlpha = Math.min(ein, weich((szene.dauerMs - tSz) / 300));
        ctx.drawImage(buehne.leinwand, CHART_X, CHART_Y, CHART_B, CHART_H);
        ctx.restore();
      }
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
