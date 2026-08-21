/**
 * Das Story-VIDEO (Owner-Wunsch 20.08.: „saubere Animationen mit
 * Wow-Effekt teilen").
 *
 * Die Portale nehmen kein animiertes SVG und kein interaktives HTML an —
 * aber alle nehmen Video. Also: Die Story-Karten werden animiert auf eine
 * Leinwand gemalt (Zahl zählt hoch, Kurve zeichnet sich, Bänder wachsen,
 * Balken schieben sich raus, Einladung) und mit MediaRecorder als ~12-s-Clip
 * aufgenommen — MP4 wo der Browser es kann, sonst WebM.
 *
 * Die Maler rechnen im 1200er-Koordinatenraum der SVG-Karten (der Aufrufer
 * skaliert auf die Leinwand) und ziehen Farben/Namen aus DENSELBEN Helfern
 * wie die Bilder — Video und Karte können nicht auseinanderlaufen.
 *
 * ── Ehrlichkeit ist nicht animierbar ──────────────────────────────────────
 *
 * Das Papier-Siegel steht auf JEDEM Frame in voller Deckkraft — es blendet
 * nie ein oder aus (Wächter-Test). Die Einladungs-Szene enthält keine
 * Ziffer. Das Teilen-Gate der Bilder gilt unverändert davor.
 */
import { stapelBaender } from '@autotrd/shared';
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';
import { t } from './i18n.js';
import { type Aussage, kartenAussage } from './shareAussage.js';
import { FARBE, mitVorzeichen, siegelBreite, type ShareDaten } from './shareCard.js';
import { bandFarben, bandName } from './shareStory.js';

export interface VideoSzene {
  id: 'ergebnis' | 'verlauf' | 'womit' | 'cta';
  dauerMs: number;
}

/** Die Szenenfolge — gleiche Auswahllogik wie die Karten der Story. */
export function videoSzenen(d: ShareDaten): VideoSzene[] {
  const szenen: VideoSzene[] = [{ id: 'ergebnis', dauerMs: 3400 }];
  if (d.zerlegung.tage.length >= 2) szenen.push({ id: 'verlauf', dauerMs: 3400 });
  if (d.zerlegung.baender.some((b) => b.key !== '__rest__' && b.summe !== 0)) {
    szenen.push({ id: 'womit', dauerMs: 2800 });
  }
  szenen.push({ id: 'cta', dauerMs: 3000 });
  return szenen;
}

const klemme = (v: number): number => Math.min(1, Math.max(0, v));
const weich = (v: number): number => 1 - (1 - klemme(v)) ** 3;
/** Teil-Fortschritt: startet bei `ab`, dauert `anteil` des Ganzen. */
const ab = (p: number, start: number, anteil: number): number => klemme((p - start) / anteil);

function rundRect(ctx: CanvasRenderingContext2D, x: number, y: number, b: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + b, y, x + b, y + h, r);
  ctx.arcTo(x + b, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + b, y, r);
  ctx.closePath();
}

/** Grundkarte: Hintergrund, Kachel, Fußzeile — auf jedem Frame gleich. */
export function maleRahmen(ctx: CanvasRenderingContext2D): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = FARBE.bg;
  ctx.fillRect(0, 0, 1200, 1200);
  ctx.fillStyle = FARBE.karte;
  rundRect(ctx, 40, 40, 1120, 1120, 36);
  ctx.fill();
  ctx.strokeStyle = FARBE.linie;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(90, 1108);
  ctx.lineTo(1110, 1108);
  ctx.stroke();
  ctx.fillStyle = FARBE.akzent;
  ctx.font = '700 34px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('autotrd.net', 90, 1152);
  ctx.fillStyle = FARBE.text3;
  ctx.font = '26px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(t('share.fuss'), 1110, 1152);
  ctx.textAlign = 'left';
}

/** Das Siegel — IMMER volle Deckkraft, nie Teil einer Animation. */
export function maleSiegel(ctx: CanvasRenderingContext2D, echtgeld: boolean): void {
  ctx.globalAlpha = 1;
  const siegel = echtgeld ? t('share.siegelEchtgeld') : t('share.siegelPapier');
  const b = siegelBreite(siegel);
  ctx.strokeStyle = FARBE.text3;
  ctx.lineWidth = 2;
  rundRect(ctx, 1110 - b, 104, b, 46, 23);
  ctx.stroke();
  ctx.fillStyle = FARBE.text3;
  ctx.font = '24px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(siegel, 1110 - b / 2, 136);
  ctx.textAlign = 'left';
}

export function maleKopf(ctx: CanvasRenderingContext2D, titel: string): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = FARBE.text2;
  ctx.font = '30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(titel.toUpperCase(), 90, 140);
}

/** Zahl aus der Kopfzeile zum Hochzählen zerlegen — unparsebar ⇒ Einblenden. */
export function zerlegeHaupt(haupt: string): { vorzeichen: string; wert: number; dezimal: number; rest: string } | null {
  const m = /^([+−-]?)(\d+(?:,\d+)?)(.*)$/.exec(haupt);
  if (!m) return null;
  const zahlTeil = m[2]!;
  const dezimal = zahlTeil.includes(',') ? zahlTeil.split(',')[1]!.length : 0;
  return { vorzeichen: m[1]!, wert: Number(zahlTeil.replace(',', '.')), dezimal, rest: m[3]! };
}

function aussageVon(d: ShareDaten): Aussage {
  return kartenAussage({
    kurventage: d.zerlegung.tage.length,
    renditePct: d.renditePct,
    ergebnis: d.ergebnis,
    trades: d.trades,
    tradeBilanz: d.tradeBilanz,
    vonTag: d.vonTag,
    bisTag: d.bisTag,
    betraege: d.betraege,
    waehrung: d.waehrung,
  });
}

function maleErgebnis(ctx: CanvasRenderingContext2D, d: ShareDaten, p: number): void {
  const aussage = aussageVon(d);
  const tonFarbe = aussage.ton === 'gruen' ? FARBE.gruen : aussage.ton === 'rot' ? FARBE.rot : FARBE.text2;
  maleKopf(ctx, t('share.kopf'));

  // Hauptzeile: die Zahl zählt hoch (weich), der Rest steht fest.
  const teil = zerlegeHaupt(aussage.haupt);
  ctx.fillStyle = tonFarbe;
  ctx.font = '800 120px ui-sans-serif, system-ui, sans-serif';
  if (teil) {
    const lauf = teil.wert * weich(ab(p, 0.05, 0.55));
    ctx.fillText(`${teil.vorzeichen}${lauf.toFixed(teil.dezimal).replace('.', ',')}${teil.rest}`, 90, 290);
  } else {
    ctx.globalAlpha = weich(ab(p, 0.05, 0.4));
    ctx.fillText(aussage.haupt, 90, 290);
  }
  ctx.globalAlpha = weich(ab(p, 0.35, 0.3));
  ctx.fillStyle = FARBE.text2;
  ctx.font = '30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(aussage.unter, 90, 356);

  // Die Kurve zeichnet sich von links nach rechts.
  const eq = d.zerlegung.equity;
  if (eq.length >= 2) {
    const min = Math.min(...eq);
    const max = Math.max(...eq);
    const spanne = max - min || 1;
    const bis = Math.max(2, Math.ceil(eq.length * weich(ab(p, 0.15, 0.65))));
    const px = (i: number): number => 90 + (i / (eq.length - 1)) * 1020;
    const py = (v: number): number => 690 - ((v - min) / spanne) * 260;
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = tonFarbe;
    ctx.beginPath();
    ctx.moveTo(px(0), 690);
    for (let i = 0; i < bis; i++) ctx.lineTo(px(i), py(eq[i]!));
    ctx.lineTo(px(bis - 1), 690);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = tonFarbe;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(px(0), py(eq[0]!));
    for (let i = 1; i < bis; i++) ctx.lineTo(px(i), py(eq[i]!));
    ctx.stroke();
  }

  // Kennzahlen unten, sanft nacheinander.
  const zahl2 = (v: number | null, n: number, suffix = ''): string =>
    v === null ? '—' : `${v.toFixed(n).replace('.', ',').replace('-', '−')}${suffix}`;
  const kpis: Array<[string, string]> = [
    [t('share.trades'), String(d.trades)],
    [t('share.trefferquote'), zahl2(d.trefferquotePct, 1, ' %')],
    [t('share.profitFaktor'), zahl2(d.profitFaktor, 2)],
    [t('share.maxDrawdown'), zahl2(d.maxDrawdownPct, 1, ' %')],
  ];
  kpis.forEach(([label, wert], i) => {
    ctx.globalAlpha = weich(ab(p, 0.6 + i * 0.07, 0.25));
    const x = 90 + i * 255;
    ctx.fillStyle = FARBE.text3;
    ctx.font = '26px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(label.toUpperCase(), x, 880);
    ctx.fillStyle = FARBE.text;
    ctx.font = '700 46px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(wert, x, 932);
  });
  ctx.globalAlpha = 1;
  maleSiegel(ctx, d.echtgeld);
}

function maleVerlauf(ctx: CanvasRenderingContext2D, d: ShareDaten, p: number): void {
  const z = d.zerlegung;
  const n = z.tage.length;
  const flaechen = stapelBaender(z).filter((f) => f.kanten.some(([u, o]) => o - u > 0));
  const farben = bandFarben(flaechen);
  maleKopf(ctx, t('share.storyVerlauf'));
  ctx.fillStyle = FARBE.text3;
  ctx.font = '26px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(`${z.tage[0] ?? ''} → ${z.tage[n - 1] ?? ''} · ${t('share.storyBasis')}`, 90, 200);

  let min = 0;
  let max = 0;
  for (const f of flaechen) {
    for (const [u, o] of f.kanten) {
      min = Math.min(min, u);
      max = Math.max(max, o);
    }
  }
  for (const v of z.equity) {
    min = Math.min(min, v - z.basis);
    max = Math.max(max, v - z.basis);
  }
  const spanne = max - min || 1;
  const px = (i: number): number => 90 + (n < 2 ? 0 : (i / (n - 1)) * 1020);
  const py = (v: number): number => 720 - ((v - min) / spanne) * 470;

  /* Bänder wachsen gestaffelt — aber der Stapel wird JE FRAME neu
   * aufeinandergesetzt. Der erste Wurf skalierte jedes Band unabhängig an
   * seinen fertigen Kanten: mitten im Wuchs schwebten Flächen frei und
   * kreuzten sich, weil Band 2 nicht mehr auf Band 1 saß (Standbild-Beweis
   * im Prüfstand). Jetzt skaliert der BEITRAG, und die Treppe entsteht in
   * jedem Frame aus der laufenden Summe — die Wasserfall-Invariante hält
   * zu jedem Zeitpunkt. Reihenfolge wie stapelBaender: Gewinner, Verlierer,
   * offener Anteil. */
  const reihe = [
    ...z.baender.filter((b) => b.summe >= 0),
    ...z.baender.filter((b) => b.summe < 0),
    { key: '__offen__', label: '', werte: z.offen, summe: z.offen[n - 1] ?? 0, trades: 0 },
  ];
  const lauf = new Array<number>(n).fill(0);
  reihe.forEach((b, idx) => {
    const wuchs = weich(ab(p, 0.05 + idx * 0.08, 0.5));
    const oben: number[] = [];
    const unten: number[] = [];
    for (let i = 0; i < n; i++) {
      const vorher = lauf[i]!;
      const neu = vorher + (b.werte[i] ?? 0) * wuchs;
      unten.push(Math.min(vorher, neu));
      oben.push(Math.max(vorher, neu));
      lauf[i] = neu;
    }
    const farbe = farben.get(b.key);
    if (!farbe || wuchs <= 0) return; // im Endbild unsichtbar oder noch nicht dran
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = farbe;
    ctx.beginPath();
    oben.forEach((v, i) => {
      if (i === 0) ctx.moveTo(px(i), py(v));
      else ctx.lineTo(px(i), py(v));
    });
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(px(i), py(unten[i]!));
    ctx.closePath();
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  ctx.strokeStyle = FARBE.text3;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(90, py(0));
  ctx.lineTo(1110, py(0));
  ctx.stroke();
  ctx.setLineDash([]);

  // Die Depot-Linie zeichnet sich über die volle Szene.
  const bis = Math.max(2, Math.ceil(n * weich(ab(p, 0.1, 0.75))));
  ctx.strokeStyle = FARBE.text;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(px(0), py(z.equity[0]! - z.basis));
  for (let i = 1; i < bis; i++) ctx.lineTo(px(i), py(z.equity[i]! - z.basis));
  ctx.stroke();

  // Etiketten poppen ein, wenn ihre Fläche steht (gleiche Regeln wie die Karte).
  const gesetzt: Array<{ x: number; y: number }> = [];
  flaechen.forEach((f, idx) => {
    let besterIdx = 0;
    let besteHoehe = 0;
    f.kanten.forEach(([u, o], i) => {
      const h = py(u) - py(o);
      if (h > besteHoehe) {
        besteHoehe = h;
        besterIdx = i;
      }
    });
    if (besteHoehe < 40) return;
    const name = bandName(f.key, f.label, f.trades).slice(0, 18);
    const halbBreit = name.length * 8 + 8;
    const ex = Math.min(Math.max(px(besterIdx), 90 + halbBreit), 1110 - halbBreit);
    const [u, o] = f.kanten[besterIdx]!;
    const ey = (py(u) + py(o)) / 2 + 9;
    if (gesetzt.some((g) => Math.abs(g.x - ex) < 150 && Math.abs(g.y - ey) < 34)) return;
    gesetzt.push({ x: ex, y: ey });
    ctx.globalAlpha = weich(ab(p, 0.65 + idx * 0.05, 0.2));
    ctx.font = '700 26px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = FARBE.karte;
    ctx.lineWidth = 5;
    ctx.strokeText(name, ex, ey);
    ctx.fillStyle = FARBE.text;
    ctx.fillText(name, ex, ey);
    ctx.textAlign = 'left';
  });
  ctx.globalAlpha = 1;
  maleSiegel(ctx, d.echtgeld);
}

function maleWomit(ctx: CanvasRenderingContext2D, d: ShareDaten, p: number): void {
  const z = d.zerlegung;
  const reihen = [...z.baender]
    .filter((b) => b.key !== '__rest__')
    .sort((a, b) => b.summe - a.summe)
    .slice(0, 7);
  const maxBetrag = Math.max(...reihen.map((r) => Math.abs(r.summe)), 1);
  maleKopf(ctx, t('share.storyWomit'));
  ctx.fillStyle = FARBE.text3;
  ctx.font = '26px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(
    `${z.tage[0] ?? d.vonTag ?? ''} → ${z.tage[z.tage.length - 1] ?? d.bisTag ?? ''} · ${d.trades} ${t(d.trades === 1 ? 'share.einTrade' : 'share.trades')}`,
    90,
    200,
  );

  const mitte = 640;
  ctx.strokeStyle = FARBE.linie;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mitte, 270);
  ctx.lineTo(mitte, 320 + reihen.length * 100 - 40);
  ctx.stroke();

  reihen.forEach((r, i) => {
    const y = 320 + i * 100;
    const auf = weich(ab(p, 0.08 + i * 0.07, 0.45));
    ctx.globalAlpha = weich(ab(p, 0.05 + i * 0.07, 0.3));
    ctx.fillStyle = FARBE.text;
    ctx.font = '600 32px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(r.label.slice(0, 12), 90, y + 8);
    ctx.fillStyle = FARBE.text3;
    ctx.font = '22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${r.trades} ${t(r.trades === 1 ? 'share.einTrade' : 'share.trades')}`, 90, y + 44);

    const w = (Math.abs(r.summe) / maxBetrag) * 280 * auf;
    const farbe = r.summe >= 0 ? FARBE.gruen : FARBE.rot;
    ctx.globalAlpha = 0.85 * weich(ab(p, 0.05 + i * 0.07, 0.3));
    ctx.fillStyle = farbe;
    rundRect(ctx, r.summe >= 0 ? mitte : mitte - w, y - 16, Math.max(3, w), 34, 17);
    ctx.fill();

    const wert = z.basis > 0 ? `${mitVorzeichen((r.summe / z.basis) * 100, 1)} %` : '';
    ctx.globalAlpha = weich(ab(p, 0.35 + i * 0.07, 0.3));
    ctx.fillStyle = farbe;
    ctx.font = '600 30px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(wert, 1110, y + 8);
    ctx.textAlign = 'left';
  });
  ctx.globalAlpha = 1;
  maleSiegel(ctx, d.echtgeld);
}

function maleCta(ctx: CanvasRenderingContext2D, p: number): void {
  // Wortmarke steigt sanft ein.
  const e1 = weich(ab(p, 0, 0.35));
  ctx.globalAlpha = e1;
  ctx.font = '800 128px ui-sans-serif, system-ui, sans-serif';
  const hub = 24 * (1 - e1);
  ctx.fillStyle = FARBE.text;
  ctx.fillText('AUTO', 90, 330 + hub);
  const autoBreite = ctx.measureText('AUTO').width;
  ctx.fillStyle = FARBE.gruen;
  ctx.fillText('TRD', 90 + autoBreite, 330 + hub);

  ctx.fillStyle = FARBE.text2;
  ctx.font = '36px ui-sans-serif, system-ui, sans-serif';
  ctx.globalAlpha = weich(ab(p, 0.15, 0.3));
  ctx.fillText(t('share.ctaClaim1'), 90, 410);
  ctx.fillText(t('share.ctaClaim2'), 90, 462);

  const merkmale = [t('share.ctaF1'), t('share.ctaF2'), t('share.ctaF3'), t('share.ctaF4')];
  merkmale.forEach((m, i) => {
    const alpha = weich(ab(p, 0.3 + i * 0.12, 0.22));
    if (alpha <= 0) return;
    const y = 560 + i * 96;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = FARBE.gruen;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(112, y - 10, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(101, y - 10);
    ctx.lineTo(109, y - 1);
    ctx.lineTo(124, y - 19);
    ctx.stroke();
    ctx.fillStyle = FARBE.text2;
    ctx.font = '31px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(m, 160, y);
  });

  ctx.globalAlpha = weich(ab(p, 0.75, 0.2));
  ctx.fillStyle = FARBE.akzent;
  ctx.font = '700 40px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(t('share.ctaLos'), 90, 1024);
  ctx.globalAlpha = 1;
}

/** Einen Frame malen — pure Dispatch-Funktion, direkt testbar. */
export function maleSzene(
  ctx: CanvasRenderingContext2D,
  d: ShareDaten,
  id: VideoSzene['id'],
  p: number,
): void {
  maleRahmen(ctx);
  if (id === 'ergebnis') maleErgebnis(ctx, d, p);
  else if (id === 'verlauf') maleVerlauf(ctx, d, p);
  else if (id === 'womit') maleWomit(ctx, d, p);
  else maleCta(ctx, p);
}

/** Feste Bildrate aller Video-Exporte (Offline-Pfad rendert exakt dieses Raster). */
export const VIDEO_FPS = 30;

/**
 * Codec-Kaskade des Offline-Pfads: H.264-MP4 zuerst — WhatsApp & Co. lesen
 * Dauer-Metadaten nur dort zuverlässig —, VP9-WebM als freier Ersatz für
 * Browser ohne H.264-Encoder (z. B. Chromium). Alle avc1-Stufen tragen
 * Level 4.0 (…28): 1080×1080@30 sprengt die Makroblock-Grenze von Level
 * 3.1, ein 1f-Level würde auf Geräten mit strengem Encoder abgelehnt.
 */
export const OFFLINE_KODIERUNGEN = [
  { codec: 'avc1.640028', art: 'mp4' },
  { codec: 'avc1.4d0028', art: 'mp4' },
  { codec: 'avc1.420028', art: 'mp4' },
  { codec: 'vp09.00.10.08', art: 'webm' },
] as const;

async function offlineKodierung(): Promise<(typeof OFFLINE_KODIERUNGEN)[number] | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const k of OFFLINE_KODIERUNGEN) {
    try {
      const sup = await VideoEncoder.isConfigSupported({
        codec: k.codec,
        width: 1080,
        height: 1080,
        bitrate: 8_000_000,
        framerate: VIDEO_FPS,
      });
      if (sup.supported) return k;
    } catch {
      /* Kandidat dem Browser unbekannt — nächste Stufe. */
    }
  }
  return null;
}

/**
 * Offline-Aufnahme (WebCodecs): Jeder Frame wird auf einem FESTEN
 * 30-fps-Zeitraster gemalt und einzeln encodiert — unabhängig davon, wie
 * schnell das Gerät malt. Das fixt beide Owner-Befunde vom 21.08.:
 *
 * 1. „Nur 3 Sekunden": MediaRecorder streamt Fragmente ohne verlässliche
 *    Gesamtdauer im Container (WebM ohne Duration-Element, MP4 nur
 *    fragmentiert). Player raten die Dauer aus dem ersten Fragment, und
 *    WhatsApp SCHNEIDET beim Versand auf die geratene Dauer. Der Muxer
 *    hier schreibt die echte Dauer in den Header (MP4 mit moov voran).
 * 2. „Ruckelig": Die Echtzeit-Aufnahme nahm nur die Frames, die das Gerät
 *    in Echtzeit schaffte — am Handy deutlich unter 30 fps. Offline wird
 *    JEDER Frame gerendert; die Encodierdauer spielt keine Rolle mehr.
 */
async function nimmOffline(
  wahl: (typeof OFFLINE_KODIERUNGEN)[number],
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  gesamtMs: number,
  maleFrame: (ctx: CanvasRenderingContext2D, tMs: number) => void,
  dateiStamm: string,
  meldeFortschritt?: (prozent: number) => void,
  beobachter?: (canvas: HTMLCanvasElement, tMs: number) => void,
): Promise<File> {
  const mp4 = wahl.art === 'mp4';
  let addChunk: (c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata) => void;
  let schliesseDatei: () => ArrayBuffer;
  if (mp4) {
    const muxer = new Mp4Muxer({
      target: new Mp4Target(),
      video: { codec: 'avc', width: 1080, height: 1080 },
      // moov an den Dateianfang: Messenger lesen die Dauer, bevor die
      // Datei ganz da ist — genau der WhatsApp-Fall.
      fastStart: 'in-memory',
    });
    addChunk = (c, m) => muxer.addVideoChunk(c, m);
    schliesseDatei = () => {
      muxer.finalize();
      return muxer.target.buffer;
    };
  } else {
    const muxer = new WebmMuxer({
      target: new WebmTarget(),
      video: { codec: 'V_VP9', width: 1080, height: 1080, frameRate: VIDEO_FPS },
    });
    addChunk = (c, m) => muxer.addVideoChunk(c, m);
    schliesseDatei = () => {
      muxer.finalize();
      return muxer.target.buffer;
    };
  }
  let encoderFehler: unknown;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      addChunk(chunk, meta);
    },
    error: (e) => {
      encoderFehler = e;
    },
  });
  encoder.configure({
    codec: wahl.codec,
    width: 1080,
    height: 1080,
    bitrate: 8_000_000,
    framerate: VIDEO_FPS,
    // Length-prefixed NALUs + avcC-Description — das Format, das der
    // MP4-Muxer erwartet (Annex B wäre für .mp4 falsch).
    ...(mp4 ? { avc: { format: 'avc' as const } } : {}),
  });

  // +400 ms Endstand-Nachlauf wie im Echtzeit-Pfad (Szenen klemmen p auf 1).
  const frames = Math.max(1, Math.round(((gesamtMs + 400) / 1000) * VIDEO_FPS));
  for (let i = 0; i < frames && encoderFehler === undefined; i++) {
    const tMs = (i * 1000) / VIDEO_FPS;
    maleFrame(ctx, tMs);
    beobachter?.(canvas, tMs);
    meldeFortschritt?.(Math.min(100, Math.round((tMs / gesamtMs) * 100)));
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1_000_000) / VIDEO_FPS),
      duration: Math.round(1_000_000 / VIDEO_FPS),
    });
    encoder.encode(frame, { keyFrame: i % (VIDEO_FPS * 2) === 0 });
    frame.close();
    // Encoder-Rückstau abbauen und dem UI-Thread regelmäßig Luft lassen.
    if (encoder.encodeQueueSize > 4 || i % 10 === 9) await new Promise((r) => setTimeout(r));
  }
  if (encoderFehler !== undefined) {
    try {
      encoder.close();
    } catch {
      /* schon zu — egal, der Fehler unten zählt */
    }
    throw encoderFehler instanceof Error ? encoderFehler : new Error(String(encoderFehler));
  }
  await encoder.flush();
  encoder.close();
  const puffer = schliesseDatei();
  const basisTyp = mp4 ? 'video/mp4' : 'video/webm';
  return new File([puffer], `${dateiStamm}.${mp4 ? 'mp4' : 'webm'}`, { type: basisTyp });
}

/**
 * Der Rekorder-Kern. Primär: Offline-Encoding über WebCodecs + eigenem
 * Muxer (`nimmOffline`) — korrekte Dauer im Container, jeder Frame im
 * festen 30-fps-Raster. Netz: die alte Echtzeit-Aufnahme über
 * MediaRecorder für Browser ohne WebCodecs.
 *
 * `beobachter` ist für den Prüfstand: Er bekommt die Leinwand mitten in der
 * ECHTEN Aufnahme gereicht und kann Standbilder ziehen — dieselben Frames,
 * die im Video landen, kein zweiter Malpfad.
 */
export async function nimmClipAuf(
  gesamtMs: number,
  maleFrame: (ctx: CanvasRenderingContext2D, tMs: number) => void,
  dateiStamm: string,
  meldeFortschritt?: (prozent: number) => void,
  beobachter?: (canvas: HTMLCanvasElement, tMs: number) => void,
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('sh.canvasFehlt'));

  const wahl = await offlineKodierung();
  if (wahl) {
    try {
      return await nimmOffline(wahl, canvas, ctx, gesamtMs, maleFrame, dateiStamm, meldeFortschritt, beobachter);
    } catch {
      /* Encoder unterwegs gescheitert (Hardware-Grenze o. ä.) → Echtzeit-Netz. */
    }
  }
  return nimmEchtzeit(canvas, ctx, gesamtMs, maleFrame, dateiStamm, meldeFortschritt, beobachter);
}

/** Das Echtzeit-Netz: die MediaRecorder-Aufnahme (Dauer = Cliplänge). */
async function nimmEchtzeit(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  gesamtMs: number,
  maleFrame: (ctx: CanvasRenderingContext2D, tMs: number) => void,
  dateiStamm: string,
  meldeFortschritt?: (prozent: number) => void,
  beobachter?: (canvas: HTMLCanvasElement, tMs: number) => void,
): Promise<File> {
  const typ = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(
    (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
  );
  if (!typ) throw new Error(t('sh.videoNichtMoeglich'));

  const strom = canvas.captureStream(30);
  const rekorder = new MediaRecorder(strom, { mimeType: typ, videoBitsPerSecond: 8_000_000 });
  const teile: Blob[] = [];
  rekorder.ondataavailable = (e) => {
    if (e.data.size > 0) teile.push(e.data);
  };
  const gestoppt = new Promise<void>((fertig) => {
    rekorder.onstop = () => fertig();
  });
  rekorder.start(250);

  const start = performance.now();
  await new Promise<void>((fertig) => {
    const frame = (): void => {
      const tMs = performance.now() - start;
      maleFrame(ctx, tMs);
      beobachter?.(canvas, tMs);
      meldeFortschritt?.(Math.min(100, Math.round((tMs / gesamtMs) * 100)));
      if (tMs >= gesamtMs + 200) {
        fertig();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  rekorder.stop();
  await gestoppt;
  for (const spur of strom.getTracks()) spur.stop();

  /* Aufgenommen wird mit vollem Codec-Profil (typ), GESTEMPELT wird die
   * Datei mit dem Basis-Typ: Chromes Teilen-Liste kennt nur parameterlose
   * Typen („video/mp4"). Trägt die Datei „video/mp4;codecs=avc1", meldet
   * canShare zwar true, aber share() antwortet NotAllowedError „Permission
   * denied" trotz frischer Geste (Owner-Screenshot 20.08., Android — im
   * Test-Chromium unsichtbar, weil das avc1 nicht kann und den Basis-Typ
   * wählt). */
  const basisTyp = typ.split(';')[0]!;
  const endung = basisTyp === 'video/mp4' ? 'mp4' : 'webm';
  return new File([new Blob(teile, { type: basisTyp })], `${dateiStamm}.${endung}`, { type: basisTyp });
}

/** Welche Szene bei `tMs` dran ist — und wie weit sie ist (0…1). */
export function szeneBei<S extends { dauerMs: number }>(szenen: S[], tMs: number): { szene: S; p: number } {
  let acc = 0;
  for (const s of szenen) {
    if (tMs < acc + s.dauerMs) return { szene: s, p: klemme((tMs - acc) / s.dauerMs) };
    acc += s.dauerMs;
  }
  return { szene: szenen[szenen.length - 1]!, p: 1 };
}

/** Das Story-Video: die vier Karten-Szenen, aufgenommen mit `nimmClipAuf`. */
export async function baueStoryVideo(
  d: ShareDaten,
  meldeFortschritt?: (prozent: number) => void,
): Promise<File> {
  const szenen = videoSzenen(d);
  const gesamt = szenen.reduce((s, sz) => s + sz.dauerMs, 0);
  const bis = d.zerlegung.tage[d.zerlegung.tage.length - 1] ?? d.bisTag ?? 'aktuell';
  return nimmClipAuf(
    gesamt,
    (ctx, tMs) => {
      const { szene, p } = szeneBei(szenen, tMs);
      ctx.save();
      ctx.scale(1080 / 1200, 1080 / 1200);
      maleSzene(ctx, d, szene.id, p);
      ctx.restore();
    },
    `autotrd-story-${bis}`,
    meldeFortschritt,
  );
}
