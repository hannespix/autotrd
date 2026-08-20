/**
 * „Die Maschine bei der Arbeit" — das Technologie-Video (V2, Owner 20.08.:
 * „Autotuning und Trading in den Mittelpunkt").
 *
 * Fünf Akte auf EINER festen Bühne (Rahmen, Marke, Fußzeile stehen):
 * Scanner → Signal (der echte Trade, Kurve zeichnet sich, die eingefrorenen
 * Signal-Stimmen ploppen ein) → Netz (Ausgang offen, Exit mit ehrlichem
 * Mechanismus-Text) → Tuning (das nächtliche Selbst-Nachmessen als Bild) →
 * Abspann. Je Akt bewegt sich GENAU EIN Blickziel, danach Lese-Ruhe.
 *
 * EHRLICHKEIT: Dieses Video behauptet KEINE Rendite — keine Prozente, kein
 * Geld (Wächter: keine Zahlen-Formatierer im Modul, ts.*-Texte zifferfrei).
 * Die Marker zeigen einen echten Trade aus der Historie, die Chips die
 * eingefrorenen Journal-Stimmen. Der Papier-Hinweis steht als leise
 * Abspann-Zeile (statt Siegel — es gibt keine Zahl zu besiegeln; führt
 * jemand wieder Zahlen ein, kommt das Siegel zurück, siehe tradeStory.ts).
 */

import { t } from './i18n.js';
import { FARBE } from './shareCard.js';
import { maleKopf, maleRahmen, nimmClipAuf } from './shareVideo.js';
import { type AktSzene, type KursPunkt, type TradeStoryDaten, aktBei, aktPlan } from './tradeStory.js';

const klemme = (v: number): number => Math.min(1, Math.max(0, v));
const weich = (v: number): number => 1 - (1 - klemme(v)) ** 3;

/* Bühne im 1200er-Koordinatenraum (wie alle Karten und Videos). */
const B_X = 90;
const B_Y = 280;
const B_B = 1020;
const B_H = 660;
const ZEILE_Y = 1040;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = 'ui-sans-serif, system-ui, sans-serif';

interface Lage {
  fenster: KursPunkt[];
  einstiegIdx: number;
  exitIdx: number;
  min: number;
  max: number;
}

/** Kurs-Fenster auf die Bühne abbilden — einmal vorgerechnet. */
export function vermesseLage(d: TradeStoryDaten): Lage {
  const fenster = d.kurse;
  const eMs = Date.parse(d.einstiegAt);
  const xMs = Date.parse(d.exitAt);
  let einstiegIdx = 0;
  let exitIdx = fenster.length - 1;
  for (let i = 0; i < fenster.length; i++) {
    if (fenster[i]!.at <= eMs) einstiegIdx = i;
    if (fenster[i]!.at <= xMs) exitIdx = i;
  }
  const werte = fenster.map((k) => k.c).concat([d.einstiegPreis, d.exitPreis]);
  const min = Math.min(...werte);
  const max = Math.max(...werte);
  const rand = Math.max((max - min) * 0.12, 0.0001);
  return { fenster, einstiegIdx, exitIdx: Math.max(exitIdx, einstiegIdx), min: min - rand, max: max + rand };
}

const xVon = (lage: Lage, idx: number): number =>
  B_X + (lage.fenster.length < 2 ? 0 : (idx / (lage.fenster.length - 1)) * B_B);
const yVon = (lage: Lage, preis: number): number =>
  B_Y + B_H - ((preis - lage.min) / (lage.max - lage.min)) * B_H;

/** Die Kurve bis `bisIdx` (anteilig ins letzte Segment hinein) zeichnen. */
function maleKurve(ctx: CanvasRenderingContext2D, lage: Lage, bis: number, farbe: string): void {
  if (lage.fenster.length < 2) return;
  const voll = Math.floor(bis);
  const rest = bis - voll;
  ctx.beginPath();
  ctx.moveTo(xVon(lage, 0), yVon(lage, lage.fenster[0]!.c));
  for (let i = 1; i <= voll && i < lage.fenster.length; i++) {
    ctx.lineTo(xVon(lage, i), yVon(lage, lage.fenster[i]!.c));
  }
  let spitzeX = xVon(lage, Math.min(voll, lage.fenster.length - 1));
  if (rest > 0 && voll + 1 < lage.fenster.length) {
    const a = lage.fenster[voll]!;
    const b = lage.fenster[voll + 1]!;
    spitzeX = xVon(lage, voll) + (xVon(lage, voll + 1) - xVon(lage, voll)) * rest;
    ctx.lineTo(spitzeX, yVon(lage, a.c + (b.c - a.c) * rest));
  }
  ctx.strokeStyle = farbe;
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  // Fläche unter der gezeichneten Kurve — derselbe Verlauf wie im Dashboard.
  ctx.lineTo(spitzeX, B_Y + B_H);
  ctx.lineTo(xVon(lage, 0), B_Y + B_H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, B_Y, 0, B_Y + B_H);
  grad.addColorStop(0, 'rgba(37, 208, 238, 0.20)');
  grad.addColorStop(1, 'rgba(37, 208, 238, 0)');
  ctx.fillStyle = grad;
  ctx.fill();
}

/** Pulsierender Marker (Einstieg/Ausstieg) mit Beschriftung. */
function maleMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  p: number,
  oben: boolean,
): void {
  const ein = weich(p / 0.25);
  ctx.globalAlpha = ein;
  ctx.fillStyle = FARBE.akzent;
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.fill();
  // Zwei auslaufende Ringe — das Pulsieren.
  for (const versatz of [0, 0.5]) {
    const ring = ((p * 2 + versatz) % 1 + 1) % 1;
    ctx.globalAlpha = ein * (1 - ring) * 0.7;
    ctx.strokeStyle = FARBE.akzent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 12 + ring * 34, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = ein;
  ctx.fillStyle = FARBE.text;
  ctx.font = `700 30px ${SANS}`;
  ctx.textAlign = 'center';
  const textY = oben ? y - 58 : y + 76;
  ctx.fillText(text, Math.min(Math.max(x, B_X + 90), B_X + B_B - 90), textY);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

/** Chip-Reihe (Signal-Stimmen) — poppt gestaffelt ein. */
function maleChips(ctx: CanvasRenderingContext2D, chips: string[], tMs: number, ab: number): void {
  let x = B_X;
  const y = B_Y + 24;
  for (let i = 0; i < chips.length; i++) {
    const ein = weich((tMs - ab - i * 350) / 320);
    if (ein <= 0) continue;
    ctx.font = `600 30px ${MONO}`;
    const b = ctx.measureText(chips[i]!).width + 44;
    ctx.globalAlpha = ein;
    ctx.fillStyle = 'rgba(37, 208, 238, 0.12)';
    ctx.strokeStyle = FARBE.akzent;
    ctx.lineWidth = 2;
    const r = 23;
    ctx.beginPath();
    ctx.roundRect(x, y, b, 46, r);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = FARBE.text;
    ctx.fillText(chips[i]!, x + 22, y + 33);
    ctx.globalAlpha = 1;
    x += b + 16;
  }
}

/** Eine erklärende Zeile unten — blendet weich ein, große Schrift.
 *  Auto-Fit: Läuft der Text über die Karte hinaus, schrumpft die Schrift,
 *  bis er passt (fing der Prüfstand beim News-Akt: 40px × langer Satz >
 *  Bühnenbreite — und die EN-Texte sind teils noch länger). */
function maleZeile(ctx: CanvasRenderingContext2D, text: string, tMs: number, ab: number, betont = false): void {
  const ein = weich((tMs - ab) / 450);
  if (ein <= 0) return;
  ctx.globalAlpha = ein;
  ctx.fillStyle = betont ? FARBE.text : FARBE.text2;
  let groesse = 40;
  ctx.font = `${betont ? 700 : 400} ${groesse}px ${SANS}`;
  while (groesse > 24 && ctx.measureText(text).width > B_B - 20) {
    groesse -= 2;
    ctx.font = `${betont ? 700 : 400} ${groesse}px ${SANS}`;
  }
  ctx.textAlign = 'center';
  ctx.fillText(text, 600, ZEILE_Y);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

/* ── Die Akte ─────────────────────────────────────────────────────────── */

function maleScanner(ctx: CanvasRenderingContext2D, d: TradeStoryDaten, tMs: number): void {
  maleKopf(ctx, t('ts.titelScanner'));
  const symbole = d.scannerSymbole.slice(0, 20);
  const spalten = 4;
  const zellB = 240;
  const zellH = 96;
  const startX = B_X + (B_B - spalten * zellB - (spalten - 1) * 20) / 2 + 0;
  for (let i = 0; i < symbole.length; i++) {
    const reihe = Math.floor(i / spalten);
    const spalte = i % spalten;
    const x = startX + spalte * (zellB + 20);
    const y = B_Y + 30 + reihe * (zellH + 22);
    const ein = weich((tMs - i * 55) / 300);
    if (ein <= 0) continue;
    // Der Scan-Läufer: genau eine Zelle glüht, der Lauf wandert.
    const läufer = Math.floor(tMs / 130) % symbole.length === i;
    ctx.globalAlpha = ein;
    ctx.fillStyle = läufer ? 'rgba(37, 208, 238, 0.16)' : 'rgba(255, 255, 255, 0.03)';
    ctx.strokeStyle = läufer ? FARBE.akzent : FARBE.linie;
    ctx.lineWidth = läufer ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(x, y, zellB, zellH, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = läufer ? FARBE.text : FARBE.text2;
    ctx.font = `600 34px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(symbole[i]!.slice(0, 8), x + zellB / 2, y + zellH / 2 + 12);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
  maleZeile(ctx, t('ts.scannerZeile'), tMs, 900, true);
}

function maleSignal(ctx: CanvasRenderingContext2D, d: TradeStoryDaten, lage: Lage, tMs: number): void {
  maleKopf(ctx, t('ts.titelSignal'));
  ctx.fillStyle = FARBE.text3;
  ctx.font = `28px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(d.symbol, 1110, 140);
  ctx.textAlign = 'left';
  const bis = lage.einstiegIdx * weich(tMs / 2000);
  maleKurve(ctx, lage, bis, FARBE.akzent);
  if (tMs > 2000) {
    const verb = d.einstiegSeite === 'buy' ? t('ts.kauft') : t('ts.verkauft');
    maleMarker(
      ctx,
      xVon(lage, lage.einstiegIdx),
      yVon(lage, lage.fenster[lage.einstiegIdx]!.c),
      `${t('ts.einstieg')} · ${verb}`,
      (tMs - 2000) / 3000,
      lage.fenster[lage.einstiegIdx]!.c > (lage.min + lage.max) / 2,
    );
  }
  const chips = [
    ...d.kontext.stimmen.map((s) => `${s} ${d.einstiegSeite === 'buy' ? t('ts.kauft') : t('ts.verkauft')}`),
    ...(d.kontext.konfluenz ? [`${t('ts.konfluenz')} ${d.kontext.konfluenz}`] : []),
  ];
  if (chips.length > 0) maleChips(ctx, chips, tMs, 2400);
  maleZeile(ctx, t('ts.signalZeile'), tMs, 3400, true);
}

function maleNetz(ctx: CanvasRenderingContext2D, d: TradeStoryDaten, lage: Lage, tMs: number): void {
  maleKopf(ctx, t('ts.titelNetz'));
  ctx.fillStyle = FARBE.text3;
  ctx.font = `28px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(d.symbol, 1110, 140);
  ctx.textAlign = 'left';
  // Die Kurve läuft vom Einstieg weiter — der Ausgang ist offen.
  const bis = lage.einstiegIdx + (lage.exitIdx - lage.einstiegIdx) * weich(tMs / 3000);
  maleKurve(ctx, lage, bis, FARBE.akzent);
  maleMarker(
    ctx,
    xVon(lage, lage.einstiegIdx),
    yVon(lage, lage.fenster[lage.einstiegIdx]!.c),
    t('ts.einstieg'),
    1,
    lage.fenster[lage.einstiegIdx]!.c > (lage.min + lage.max) / 2,
  );
  if (tMs > 3000) {
    maleMarker(
      ctx,
      xVon(lage, lage.exitIdx),
      yVon(lage, lage.fenster[lage.exitIdx]!.c),
      t('ts.ausstieg'),
      (tMs - 3000) / 2000,
      lage.fenster[lage.exitIdx]!.c > (lage.min + lage.max) / 2,
    );
  }
  maleZeile(ctx, netzZeile(d.riskExit), tMs, 3300, true);
}

/** Der ehrliche Mechanismus-Text zum Ausstieg — keine Zahl, nur das Wie. */
export function netzZeile(riskExit: string | null): string {
  switch (riskExit) {
    case 'stop_loss':
      return t('ts.netzStop');
    case 'take_profit':
      return t('ts.netzZiel');
    case 'trailing_stop':
      return t('ts.netzTrailing');
    case 'max_hold':
      return t('ts.netzHalte');
    default:
      return t('ts.netzSignal');
  }
}

function maleNews(ctx: CanvasRenderingContext2D, tMs: number): void {
  maleKopf(ctx, t('ts.titelNews'));
  /* Drei abstrakte Schlagzeilen-Karten (BEWUSST ohne Text: erfundene
   * Schlagzeilen wären Fake-News im eigenen Video) — die mittlere bekommt
   * das Veto-Kreuz. Der Mechanismus ist echt: Der News-Check sitzt im
   * Einstiegspfad (newsGate), schlechte Nachrichten blocken den Kauf. */
  const kartenB = 840;
  const kartenH = 130;
  const startX = 600 - kartenB / 2;
  for (let i = 0; i < 3; i++) {
    const y = B_Y + 50 + i * (kartenH + 34);
    const ein = weich((tMs - i * 320) / 420);
    if (ein <= 0) continue;
    const veto = i === 1 && tMs > 1900;
    ctx.globalAlpha = ein * (veto ? 0.9 : 1);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.strokeStyle = veto ? FARBE.rot : FARBE.linie;
    ctx.lineWidth = veto ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(startX, y, kartenB, kartenH, 16);
    ctx.fill();
    ctx.stroke();
    // Abstrakte Textzeilen: zwei graue Balken je Karte.
    ctx.fillStyle = veto ? 'rgba(255, 95, 95, 0.35)' : 'rgba(159, 176, 196, 0.35)';
    ctx.beginPath();
    ctx.roundRect(startX + 32, y + 34, kartenB * (0.62 - i * 0.08), 20, 10);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(startX + 32, y + 74, kartenB * (0.4 + i * 0.06), 20, 10);
    ctx.fill();
    if (veto) {
      const kreuz = weich((tMs - 1900) / 350);
      ctx.globalAlpha = ein * kreuz;
      ctx.strokeStyle = FARBE.rot;
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      const cx = startX + kartenB - 78;
      const cy = y + kartenH / 2;
      ctx.beginPath();
      ctx.moveTo(cx - 26, cy - 26);
      ctx.lineTo(cx + 26, cy + 26);
      ctx.moveTo(cx + 26, cy - 26);
      ctx.lineTo(cx - 26, cy + 26);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  maleZeile(ctx, t('ts.newsZeile'), tMs, 2100, true);
  const ein = weich((tMs - 2600) / 450);
  if (ein > 0) {
    ctx.globalAlpha = ein;
    ctx.fillStyle = FARBE.text3;
    ctx.font = `32px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText(t('ts.newsZeile2'), 600, ZEILE_Y + 52);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

function maleLernen(ctx: CanvasRenderingContext2D, tMs: number): void {
  maleKopf(ctx, t('ts.titelTuning'));
  /* Das Prognose-Gitter als Bild: Zellen leuchten der Reihe nach auf (die
   * nächtliche Messung), ein Ring wandert zur nächsten Zelle (die beste
   * Kombination zieht um). Bewusst OHNE Zahlen — die Mechanik ist echt,
   * konkrete Messwerte würden hier ohne Kontext nur behaupten. */
  const spalten = 5;
  const reihen = 3;
  const zellB = 180;
  const zellH = 150;
  const startX = B_X + (B_B - spalten * zellB - (spalten - 1) * 18) / 2;
  const startY = B_Y + 60;
  for (let i = 0; i < spalten * reihen; i++) {
    const x = startX + (i % spalten) * (zellB + 18);
    const y = startY + Math.floor(i / spalten) * (zellH + 18);
    const mess = klemme((tMs - i * 140) / 500);
    /* Jede Kombination misst anders gut — ein deterministisches Muster
     * (kein Zufall: der Prüfstand vergleicht Standbilder), das nach der
     * Messung STEHEN bleibt. So sieht man ein Ergebnis-Relief statt
     * fünfzehn identischer Kacheln. */
    const staerke = 0.5 + 0.5 * Math.sin(i * 2.7 + 1);
    ctx.globalAlpha = 0.25 + 0.75 * mess;
    ctx.fillStyle = `rgba(37, 208, 238, ${0.03 + 0.3 * staerke * mess})`;
    ctx.strokeStyle = mess > 0.99 && staerke > 0.8 ? FARBE.akzent : FARBE.linie;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, zellB, zellH, 14);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Achsen-Wörter (zifferfrei): das Bild ist ein SUCHGITTER, kein Deko-Raster.
  ctx.fillStyle = FARBE.text3;
  ctx.font = `26px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${t('ts.gitterX')} →`, 600, startY - 24);
  ctx.textAlign = 'left';
  ctx.save();
  ctx.translate(startX - 26, startY + (reihen * (zellH + 18)) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(`${t('ts.gitterY')} →`, 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
  // Die wandernde Bestmarke: der alte Ring verblasst, der neue leuchtet auf.
  const zelleMitte = (s: number, r: number): { x: number; y: number } => ({
    x: startX + s * (zellB + 18) + zellB / 2,
    y: startY + r * (zellH + 18) + zellH / 2,
  });
  const alt = zelleMitte(1, 1);
  const neu = zelleMitte(3, 1);
  const zug = weich((tMs - 1900) / 1100);
  ctx.lineWidth = 5;
  ctx.strokeStyle = FARBE.gruen;
  ctx.globalAlpha = 1 - zug;
  ctx.beginPath();
  ctx.arc(alt.x, alt.y, 62, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = zug;
  ctx.beginPath();
  ctx.arc(neu.x, neu.y, 62, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  maleZeile(ctx, t('ts.lernenZeile'), tMs, 800, true);
  const ein = weich((tMs - 1600) / 450);
  if (ein > 0) {
    ctx.globalAlpha = ein;
    ctx.fillStyle = FARBE.text3;
    ctx.font = `32px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText(t('ts.lernenZeile2'), 600, ZEILE_Y + 52);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

function maleAbspann(ctx: CanvasRenderingContext2D, d: TradeStoryDaten, tMs: number): void {
  const ein = weich(tMs / 600);
  ctx.globalAlpha = ein;
  ctx.textAlign = 'center';
  ctx.font = `800 120px ${SANS}`;
  ctx.fillStyle = FARBE.text;
  ctx.fillText('AUTO', 600 - 128, 560);
  ctx.fillStyle = FARBE.akzent;
  ctx.fillText('TRD', 600 + 178, 560);
  ctx.fillStyle = FARBE.text2;
  ctx.font = `600 44px ${SANS}`;
  ctx.fillText(t('ts.abspannZeile'), 600, 660);
  /* Der leise, ehrliche Papier-Hinweis — bewusst klein, aber immer da,
   * solange das Konto keins mit echtem Geld ist. */
  if (!d.echtgeld) {
    ctx.fillStyle = FARBE.text3;
    ctx.font = `30px ${SANS}`;
    ctx.fillText(t('ts.papierHinweis'), 600, 730);
  }
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

/** Der Frame-Maler — pur genug für Standbild-Prüfungen im Prüfstand. */
export function maleAkt(
  ctx: CanvasRenderingContext2D,
  d: TradeStoryDaten,
  lage: Lage,
  akt: AktSzene['id'],
  tMs: number,
): void {
  maleRahmen(ctx);
  if (akt === 'scanner') maleScanner(ctx, d, tMs);
  else if (akt === 'signal') maleSignal(ctx, d, lage, tMs);
  else if (akt === 'netz') maleNetz(ctx, d, lage, tMs);
  else if (akt === 'news') maleNews(ctx, tMs);
  else if (akt === 'lernen') maleLernen(ctx, tMs);
  else maleAbspann(ctx, d, tMs);
}

/** Aufnahme — derselbe Rekorder-Kern wie alle Videos (nimmClipAuf). */
export async function baueTradeStoryVideo(
  d: TradeStoryDaten,
  meldeFortschritt?: (prozent: number) => void,
  beobachter?: (canvas: HTMLCanvasElement, tMs: number) => void,
): Promise<File> {
  const plan = aktPlan();
  const gesamt = plan.reduce((s, a) => s + a.dauerMs, 0);
  const lage = vermesseLage(d);
  return nimmClipAuf(
    gesamt,
    (ctx, tMs) => {
      const { akt, p } = aktBei(plan, tMs);
      ctx.save();
      ctx.scale(1080 / 1200, 1080 / 1200);
      maleAkt(ctx, d, lage, akt.id, p * akt.dauerMs);
      ctx.restore();
    },
    `autotrd-maschine-${d.exitAt.slice(0, 10)}`,
    meldeFortschritt,
    beobachter,
  );
}
