/**
 * Chart-Modul — einziger Ort mit Lightweight-Charts-Import (Fassade wie in
 * docs/VISION.md §5 skizziert; macht einen späteren v5-Umstieg zur
 * Ein-Datei-Änderung).
 *
 * Konventionen aus CLAUDE.md §6:
 * - v4.2.0 exakt gepinnt (package.json), NICHT auf v5 bumpen ohne
 *   addCandlestickSeries → addSeries(...) umzuschreiben.
 * - Kein Top-Level-Zugriff, der bei Ladefehlern das ganze JS killt: die
 *   Bibliothek wird dynamisch importiert und jeder Aufrufer bekommt bei
 *   Fehlern einen sauberen Fallback-Text (Guard wie im Alt-Dashboard).
 * - crosshair.mode als numerisches Literal 0.
 */

import { alsOrtszeit, heikinAshi, lokalerTag, tagesPraefix } from '@autotrd/shared';
import type { Bar } from '@autotrd/shared';

/**
 * Zeitachse in ORTSZEIT (Owner-Entscheidung 04.08.).
 *
 * Lightweight Charts rendert numerische Zeitstempel immer als UTC und kennt
 * keine Zeitzonen-Option. Damit die Achse trotzdem die Uhrzeit des Nutzers
 * zeigt, verschiebt diese Fassade JEDEN numerischen Zeitstempel an genau
 * einer Stelle — beim Eintritt (`zuAchse`) und wieder zurück beim Austritt
 * (`vonAchse`). Alles dazwischen — Kerzen, Prognose-Band, News-Punkte,
 * Positions-Marken, Crosshair — lebt in derselben verschobenen Domäne und
 * bleibt deshalb zueinander konsistent.
 *
 * ISO-Tage (Tages-Sicht) bleiben unangetastet: Ein Handelstag hat keine
 * Uhrzeit, und ihn zu verschieben würde Kerzen auf Nachbartage rutschen
 * lassen. Der Handelstag kommt ohnehin schon in Börsenzeit vom Server
 * (`marketData.fmtDate` mit `exchangeTimezoneName`).
 */
function zuAchse<T extends string | number>(t: T): T {
  return (typeof t === 'number' ? alsOrtszeit(t, new Date(t * 1000).getTimezoneOffset()) : t) as T;
}

/** Uhrzeit eines ACHSEN-Zeitstempels — der ist bereits Ortszeit, also UTC lesen. */
function achsenUhrzeit(t: number): string {
  return new Date(t * 1000).toISOString().slice(11, 16);
}

export interface ChartBar extends Bar {
  date: string; // YYYY-MM-DD
}

export interface ForecastOverlay {
  /** Zeit als ISO-Tag (Tages-Prognose) oder UNIX-Sekunden (Intraday). */
  points: Array<{ time: string | number; value: number }>;
  band: Array<{ time: string | number; upper: number; lower: number }>;
}

export interface ChartMarker {
  /** ISO-Tag (Tages-Sicht) oder UNIX-Sekunden (Intraday-Sicht, 26.07.). */
  time: string | number;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'circle' | 'arrowUp' | 'arrowDown';
  text?: string;
}

export interface IntradayChartBar {
  /** UNIX-Sekunden (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SetBarsOptions {
  /**
   * Sichtbereich an die Daten anpassen — NUR bei expliziten Aktionen
   * (Symbol-/Zeitrahmen-Wechsel) setzen. Snapshot-Updates lassen den
   * User-Zoom in Ruhe (Chart-Audit 24.07.: „kann nicht rauszoomen").
   */
  fit?: boolean;
  /**
   * Deterministisches Fit-Ziel statt fitContent — fitContent landet
   * asynchron und würde ein nachträglich gesetztes Fenster überschreiben
   * (Race beim Pfeil-Polster/Startfenster). Nur zusammen mit fit.
   */
  fitTo?: { from: number; to: number } | undefined;
  /** Uhrzeiten auf der Zeitachse (Intraday). */
  timeVisible?: boolean;
}

/** Farben des Flächen-Verlaufs — die Signal-Richtung färbt das Integral. */
export interface AreaColors {
  line: string;
  top: string;
  bottom: string;
}

export interface OverlayLine {
  /** Eindeutiger Schlüssel (z. B. 'sma50', 'cmp:AAPL'). */
  key: string;
  color: string;
  width?: number;
  /** Eigene Skala (z. B. Prozent-Vergleich) statt der Preis-Skala. */
  separateScale?: boolean;
  points: Array<{ time: string | number; value: number }>;
}

/**
 * Waagerechte Preislinie mit Achsen-Label (Einstieg/Stop/Ziel einer offenen
 * Position, 04.08.). Deklarativ wie `OverlayLine`: fehlende Keys verschwinden.
 */
export interface PriceLineSpec {
  /** Eindeutiger Schlüssel (z. B. 'pos:entry'). */
  key: string;
  price: number;
  color: string;
  /**
   * Text am rechten Rand der Linie. Sparsam einsetzen: Er steht IM Chart und
   * verdeckt Kurs — meist sagt schon das Achsen-Label alles (Owner 04.08.:
   * „überlagert zu viel Info"). Fehlend = kein Text.
   */
  title?: string;
  /**
   * Preis-Kasten auf der Skala (Default an). Jeder Kasten überdeckt einen
   * echten Skalenwert — bei mehreren Linien nur der wichtigsten geben.
   */
  axisLabel?: boolean;
  /** 0 = durchgezogen, 1 = gepunktet, 2 = gestrichelt (numerisch, CLAUDE.md §6). */
  style?: 0 | 1 | 2;
  width?: number;
}

/** Serien-Typen (TV-Parität Teil 1) — Renko/Kagi/P&F bewusst später. */
export type ChartType = 'candles' | 'hollow' | 'heikin' | 'line' | 'area' | 'baseline' | 'bars';

/**
 * Y-Skalen-Modus (Owner-Idee 06.08.):
 * - 'auto': LWC-Standard — alles Sichtbare wird eingepasst; beim Scrubben
 *   stauchen/strecken sich die Kerzen mit jedem Fenster.
 * - 'fix':  fester Y-Zoom — die Spanne (Preis je Pixel) bleibt konstant, die
 *   Skala WANDERT stattdessen mit den sichtbaren Kerzen mit. Scrollen fühlt
 *   sich an wie eine Kamerafahrt statt wie ein Gummiband.
 * - 'frei': manuell — Ziehen auf der Preisskala bestimmt alles selbst.
 */
export type YMode = 'auto' | 'fix' | 'frei';

export interface PriceChartHandle {
  setBars(bars: ChartBar[] | IntradayChartBar[], opts?: SetBarsOptions): void;
  /** Chart-Typ umschalten (rendert aus den zuletzt gesetzten Bars neu). */
  setChartType(type: ChartType): void;
  /** Kombi: Linientyp (Linie/Berg/Baseline) ZUSÄTZLICH zu den Kerzen. */
  setTypeCombine(on: boolean): void;
  /** Ist die Kombi gerade wirksam? (E2E-Hook; bei Kerzen-Typen/Bars false). */
  typeCombineActive(): boolean;
  /** Aktiver Chart-Typ (E2E-Hook). */
  chartType(): ChartType;
  /** Preisskala: 0 = linear, 1 = logarithmisch, 2 = Prozent (LWC PriceScaleMode). */
  setPriceScaleMode(mode: 0 | 1 | 2): void;
  /** Animiert zum Anfang/zur Mitte/ans Ende der geladenen Timeline springen. */
  scrollTo(target: 'start' | 'middle' | 'end'): void;
  /** Indikator-/Vergleichs-Linien deklarativ setzen (fehlende Keys werden entfernt). */
  setOverlays(lines: OverlayLine[]): void;
  /** Anzahl aktiver Overlay-Linien (E2E-Hook). */
  overlayCount(): number;
  /** Chart-Klick → Preis an der Klick-Position (null außerhalb der Skala). */
  onClick(cb: (price: number | null) => void): void;
  /** Pixel-Koordinaten für (Zeit, Preis) — für absolut positionierte Overlays. */
  coords(time: string | number, price: number): { x: number | null; y: number | null };
  /** Flächen-Verlauf unter der Kurslinie (Vektor-Look): null = entfernen. */
  setArea(points: Array<{ time: string | number; value: number }> | null, colors?: AreaColors): void;
  /** Ist der Flächen-Layer aktiv? (E2E-Hook) */
  areaActive(): boolean;
  /** Kerzen + Volumen ein-/ausblenden (ruhiger Vektor-Look bei aktiver Fläche). */
  setCandlesVisible(visible: boolean): void;
  /** Rechten Rand (in Bars) reservieren — z. B. Platz für den Prognose-Pfeil. */
  setRightOffset(bars: number): void;
  /** Y-Skalen-Modus (auto/fix/frei) — auch explizite Fits respektieren die Wahl. */
  setYMode(mode: YMode): void;
  /** Prognose-Overlay: gestrichelte Mittellinie + ±1σ-Band (null = entfernen). */
  setForecast(overlay: ForecastOverlay | null, anchor?: { time: string | number; value: number }): void;
  /** Ist ein Prognose-Overlay gesetzt? (E2E-Hook) */
  forecastActive(): boolean;
  /** Marker auf den Kerzen (News-Punkte, Einstiegs-Marke offener Positionen). */
  setMarkers(markers: ChartMarker[]): void;
  /** Waagerechte Preislinien deklarativ setzen (fehlende Keys werden entfernt). */
  setPriceLines(lines: PriceLineSpec[]): void;
  /** Anzahl aktiver Preislinien (E2E-Hook). */
  priceLineCount(): number;
  /**
   * Crosshair-Datum: liefert den Handelstag unter dem Cursor plus
   * Viewport-Koordinaten — null beim Verlassen des Charts.
   */
  onCrosshairDate(cb: (date: string | null, pos: { x: number; y: number } | null) => void): void;
  /**
   * In-Chart-Legende (TV-Stil, UI-Audit 25.07.): OHLC(+Volumen) des Bars
   * unter dem Crosshair — null beim Verlassen (dann zeigt die HUD den
   * letzten Bar). `time` ist der ISO-Tag bzw. die Intraday-Zeit als Label.
   */
  onCrosshairData(
    cb: (d: { time: string; open: number; high: number; low: number; close: number; volume: number | null } | null) => void,
  ): void;
  /** Zeitachsen-Sync (M9 Chart-Stack): sichtbaren Bereich beobachten/setzen. */
  onVisibleRangeChange(cb: (range: { from: number; to: number } | null) => void): void;
  setVisibleRange(range: { from: number; to: number }): void;
  getVisibleRange(): { from: number; to: number } | null;
  /** Crosshair programmatisch auf einen Handelstag setzen (null = löschen). */
  setCrosshair(date: string | null): void;
  destroy(): void;
}

type Lwc = typeof import('lightweight-charts');

let lwcPromise: Promise<Lwc | null> | null = null;

function loadLwc(): Promise<Lwc | null> {
  lwcPromise ??= import('lightweight-charts').catch(() => null);
  return lwcPromise;
}

function chartTheme(): Record<string, unknown> {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    autoSize: true,
    layout: {
      background: light
        ? { type: 'gradient', topColor: '#f7fafd', bottomColor: '#e7edf6' }
        : { type: 'gradient', topColor: '#0c1526', bottomColor: '#05080f' },
      textColor: light ? '#43516c' : '#9fadc4',
      fontSize: 11,
      fontFamily: "'JetBrains Mono','SF Mono',ui-monospace,monospace",
      // TV-Logo aus dem Chart (Owner-Wunsch 06.08.) — die lizenzrechtlich
      // nötige Attribution steht dafür sichtbar in den Rechtstexten (§legal).
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: light ? 'rgba(15,23,42,.06)' : 'rgba(255,255,255,.045)' },
    },
    rightPriceScale: { borderColor: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.10)' },
    timeScale: {
      borderColor: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.10)',
      rightOffset: 4,
      barSpacing: 6,
      // 0.02 statt 0.1: deutlich tieferes Rauszoomen möglich (Feedback 25.07.)
      minBarSpacing: 0.02,
      timeVisible: false,
    },
    // 0 = Normal — numerisches Literal statt Enum (CLAUDE.md §6)
    crosshair: {
      mode: 0,
      vertLine: { color: 'rgba(0,212,255,.5)', width: 1, labelBackgroundColor: '#0091c2' },
      horzLine: { color: 'rgba(0,212,255,.4)', labelBackgroundColor: '#0091c2' },
    },
    // Zoom-Verhalten wie TradingView (User-Feedback 25.07.): Mausrad/Pinch
    // ums Cursor-Zentrum, Ziehen AUF den Achsen zoomt die jeweilige Achse,
    // Doppelklick auf eine Achse setzt sie zurück; kinetisches Scrollen an.
    handleScale: {
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: { time: true, price: true },
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    // Schwungvolles Scrubbing (User-Wunsch 25.07. nachts): kinetisches
    // Weiterrollen nach dem Ziehen — auch mit der Maus, nicht nur Touch.
    kineticScroll: { touch: true, mouse: true },
  };
}

/**
 * Candlestick + Volumen-Chart in `container`. Liefert `null`, wenn die
 * Chart-Bibliothek nicht geladen werden kann — der Aufrufer zeigt dann den
 * Fallback-Text und der Rest des Dashboards funktioniert weiter.
 */
export async function buildPriceChart(
  container: HTMLElement,
  watermark: string,
): Promise<PriceChartHandle | null> {
  const lwc = await loadLwc();
  if (!lwc) {
    container.innerHTML =
      '<div style="padding:24px 12px;color:var(--t3);font-size:12px">' +
      'Chart-Bibliothek nicht geladen. Rest des Dashboards funktioniert.</div>';
    return null;
  }

  container.innerHTML = '';
  const chart = lwc.createChart(container, chartTheme() as never);
  chart.applyOptions({
    watermark: {
      visible: true,
      text: watermark,
      color: 'rgba(120,150,200,.055)',
      fontSize: 58,
      fontStyle: 'bold',
      horzAlign: 'center',
      vertAlign: 'center',
    },
  } as never);

  // Max-Zoom-Deckel (Owner 06.08.: „5-Minuten-Balken nicht unendlich breit
  // ziehen"): Unter MIN_SICHTBARE_BARS schnappt das Fenster zurück — um die
  // Fenstermitte, damit der Zoom-Fokus erhalten bleibt. LWC v4 kennt kein
  // maxBarSpacing; der Wächter ist das v4-Äquivalent. Re-Entry-Guard, weil
  // setVisibleLogicalRange selbst wieder Range-Events feuert.
  const MIN_SICHTBARE_BARS = 10;
  let zoomClampAktiv = false;
  let rowCount = 0; // Bar-Anzahl der Hauptserie (setBars pflegt ihn)
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (!r || zoomClampAktiv || rowCount < MIN_SICHTBARE_BARS) return;
    const span = r.to - r.from;
    if (span >= MIN_SICHTBARE_BARS) return;
    const mitte = (r.from + r.to) / 2;
    zoomClampAktiv = true;
    chart.timeScale().setVisibleLogicalRange({
      from: mitte - MIN_SICHTBARE_BARS / 2,
      to: mitte + MIN_SICHTBARE_BARS / 2,
    });
    window.setTimeout(() => {
      zoomClampAktiv = false;
    }, 0);
  });

  // Y-Modus 'fix' (Owner-Idee 06.08.: „Kerzen nicht immer größer und kleiner
  // stauchen"): Statt bei jedem Pan die Skala neu einzupassen, bleibt die
  // Preis-SPANNE eingefroren und nur ihre MITTE folgt den sichtbaren Kerzen —
  // die Kamera fährt mit, statt das Bild zu dehnen. LWC kennt keinen direkten
  // Setter für den Preisbereich; der Weg führt über autoscaleInfoProvider:
  // JEDE Serie der rechten Skala liefert im Fix-Modus denselben, hier
  // berechneten Bereich — die Vereinigung ist dann exakt dieser Bereich.
  // Not-Ausdehnung: Ein Ausbruchsfenster größer als die Spanne würde sonst
  // abgeschnitten — es weitet vorübergehend, ohne die Spanne zu ratschen.
  let yModus: YMode = 'auto';
  let fixSpanne: number | null = null;
  // Geglättete Nachführung (Owner 06.08.: „runder und flüssiger, nicht so
  // ruckelnd"): Ohne Glättung springt die Skalen-MITTE hart, sobald eine
  // Extrem-Kerze ins Fenster ein- oder austritt. NUR die Mitte läuft als
  // EMA dem Ziel hinterher — die SPANNE bleibt strikt eingefroren
  // (Owner-Nachschliff: eine mitatmende Spanne las sich wie „Zoom und Pan
  // kombiniert"; gewollt war allein die rundere Bewegung. Ausbruchskerzen
  // dürfen dafür oben/unten aus dem Fenster laufen — das IST fester Zoom;
  // ein Klick auf „Y fix" friert jederzeit am aktuellen Fenster neu ein).
  // Je Frame ein EMA-Schritt (Zeit-Gate, weil ALLE Serien der rechten Skala
  // den Provider im selben Durchlauf fragen); der Nachlauf-Ticker rollt die
  // Bewegung nach dem letzten Pan-Ereignis sanft aus.
  const Y_GLAETTUNG = 0.3;
  let glattMitte: number | null = null;
  let yCacheZeit = -1;
  let yCacheWert: { min: number; max: number } | null = null;
  let nachlaufAktiv = false;
  const fixReset = (): void => {
    fixSpanne = null;
    glattMitte = null;
    yCacheZeit = -1;
    yCacheWert = null;
  };
  const armNachlauf = (): void => {
    if (nachlaufAktiv) return;
    nachlaufAktiv = true;
    requestAnimationFrame(() => {
      nachlaufAktiv = false;
      // applyOptions stößt einen Neu-Autoscale an — der Provider läuft
      // erneut und die EMA macht ihren nächsten Schritt Richtung Ziel.
      if (yModus === 'fix') chart.priceScale('right').applyOptions({ autoScale: true });
    });
  };
  /* Manueller Y-Zoom im Fix-Modus (Owner 07.08.: „die Y-Achse soll man
   * manuell zoomen können, genau wie die X-Achse — auch am Touchscreen").
   * Die SPANNE gehört dem Nutzer: Mausrad über der Preisskala und Ziehen auf
   * der Preisskala (Maus UND Touch) ändern die eingefrorene Spanne; die
   * Mitte führt weiter nach. Doppelklick auf die Skala friert neu am
   * aktuellen Fenster ein — dasselbe „kurz Auto, dann Modus", das beim
   * Symbol-/Zeitrahmen-Wechsel automatisch passiert (fixReset im Fit).
   * Capture-Phase + stopPropagation, damit LWC die Gesten nie sieht: Sein
   * eigener Achsen-Drag würde die Skala auf manuell kippen und die
   * Nachführung stünde still. Im Auto-/Frei-Modus greifen die Gesten nicht —
   * dort bleibt das LWC-Standardverhalten unangetastet. */
  const inPreisAchse = (clientX: number): boolean => {
    const r = container.getBoundingClientRect();
    return clientX >= r.right - chart.priceScale('right').width() - 2 && clientX <= r.right;
  };
  const spanneZoomen = (faktor: number): void => {
    if (yModus !== 'fix' || fixSpanne === null) return;
    fixSpanne = Math.min(Math.max(fixSpanne * faktor, 1e-9), 1e12);
    yCacheZeit = -1; // Cache verwerfen — sofort mit neuer Spanne rechnen
    chart.priceScale('right').applyOptions({ autoScale: true });
  };
  let yDrag: number | null = null;
  const yDragStart = (clientX: number, clientY: number): boolean => {
    if (yModus !== 'fix' || !inPreisAchse(clientX)) return false;
    yDrag = clientY;
    return true;
  };
  const yDragMove = (clientY: number): void => {
    if (yDrag === null) return;
    const dy = clientY - yDrag;
    yDrag = clientY;
    spanneZoomen(Math.exp(dy * 0.006)); // runterziehen = rauszoomen (LWC-Konvention)
  };
  const aufWheel = (ev: WheelEvent): void => {
    if (yModus !== 'fix' || !inPreisAchse(ev.clientX)) return;
    ev.preventDefault();
    ev.stopPropagation();
    spanneZoomen(Math.exp(ev.deltaY * 0.0012));
  };
  const aufMausAb = (ev: MouseEvent): void => {
    if (yDragStart(ev.clientX, ev.clientY)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  const aufMausZug = (ev: MouseEvent): void => yDragMove(ev.clientY);
  const aufMausLos = (): void => {
    yDrag = null;
  };
  const aufTouchAb = (ev: TouchEvent): void => {
    const t = ev.touches[0];
    if (t && ev.touches.length === 1 && yDragStart(t.clientX, t.clientY)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  const aufTouchZug = (ev: TouchEvent): void => {
    const t = ev.touches[0];
    if (yDrag !== null && t) {
      ev.preventDefault();
      ev.stopPropagation();
      yDragMove(t.clientY);
    }
  };
  const aufDoppelklick = (ev: MouseEvent): void => {
    if (yModus !== 'fix' || !inPreisAchse(ev.clientX)) return;
    ev.preventDefault();
    ev.stopPropagation();
    fixReset(); // neu am aktuellen Fenster einfrieren („kurz Auto")
    chart.priceScale('right').applyOptions({ autoScale: true });
  };
  container.addEventListener('wheel', aufWheel, { passive: false, capture: true });
  container.addEventListener('mousedown', aufMausAb, true);
  window.addEventListener('mousemove', aufMausZug);
  window.addEventListener('mouseup', aufMausLos);
  container.addEventListener('touchstart', aufTouchAb, { passive: false, capture: true });
  container.addEventListener('touchmove', aufTouchZug, { passive: false, capture: true });
  container.addEventListener('touchend', aufMausLos, true);
  container.addEventListener('dblclick', aufDoppelklick, true);
  const yGestenLoesen = (): void => {
    window.removeEventListener('mousemove', aufMausZug);
    window.removeEventListener('mouseup', aufMausLos);
  };

  const fixRange = (): { min: number; max: number } | null => {
    const jetzt = performance.now();
    if (jetzt - yCacheZeit < 8) return yCacheWert; // ein EMA-Schritt je Frame
    const lr = chart.timeScale().getVisibleLogicalRange();
    if (!lr || cachedRows.length === 0) return null;
    const i0 = Math.max(0, Math.floor(lr.from));
    const i1 = Math.min(cachedRows.length - 1, Math.ceil(lr.to));
    if (i1 < i0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const r = cachedRows[i]!;
      lo = Math.min(lo, r.low);
      hi = Math.max(hi, r.high);
    }
    if (!(hi > lo)) return null;
    fixSpanne ??= (hi - lo) * 1.15;
    const zielMitte = (lo + hi) / 2;
    glattMitte = glattMitte === null ? zielMitte : glattMitte + (zielMitte - glattMitte) * Y_GLAETTUNG;
    // Ziel noch nicht erreicht? Nächsten Frame nachziehen (sanftes Ausrollen).
    if (Math.abs(zielMitte - glattMitte) > fixSpanne * 0.002) armNachlauf();
    yCacheZeit = jetzt;
    yCacheWert = { min: glattMitte - fixSpanne / 2, max: glattMitte + fixSpanne / 2 };
    return yCacheWert;
  };
  type YInfo = { priceRange: { minValue: number; maxValue: number } } | null;
  const yProvider = (orig: () => YInfo): YInfo => {
    if (yModus !== 'fix') return orig();
    const r = fixRange();
    return r ? { priceRange: { minValue: r.min, maxValue: r.max } } : orig();
  };
  /** In jede Serie der RECHTEN Preisskala spreaden (nicht 'vol'/'overlay'). */
  const Y = { autoscaleInfoProvider: yProvider as never };

  const candle = chart.addCandlestickSeries({
    upColor: '#26cf9d',
    downColor: '#f2586b',
    borderVisible: false,
    wickUpColor: '#40e0b4',
    wickDownColor: '#ff8290',
    ...Y,
  });
  const vol = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  // Prognose-Serien (leer bis setForecast); 2 = Dashed, 3 = Dotted (numerische
  // Literale statt Enum — CLAUDE.md-§6-Geist)
  const fcCommon = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
  let fcOn = false;
  const fcMid = chart.addLineSeries({ color: '#25d0ee', lineWidth: 2, lineStyle: 2, ...fcCommon, ...Y });
  const fcUp = chart.addLineSeries({ color: 'rgba(37,208,238,.45)', lineWidth: 1, lineStyle: 3, ...fcCommon, ...Y });
  const fcLo = chart.addLineSeries({ color: 'rgba(37,208,238,.45)', lineWidth: 1, lineStyle: 3, ...fcCommon, ...Y });

  // Träger der Preislinien (Positions-Overlay 04.08.): eine vollständig
  // transparente Linien-Serie. Warum nicht direkt die Kerzen? Preislinien
  // einer AUSGEBLENDETEN Serie zeichnet Lightweight Charts nicht — im
  // Vektor-Look („Kerzen aus") oder bei Linien-/Berg-Typen wären Einstieg und
  // Stop sonst genau dann weg, wenn man ruhig auf den Kurs schauen will.
  // Die Serie trägt dieselben Schlusskurse (nötig für den Skalen-Bezug),
  // malt aber nichts — sie existiert nur als Anker der Linien.
  const lineHost = chart.addLineSeries({
    color: 'rgba(0,0,0,0)',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    ...Y,
  });
  const priceLines = new Map<string, ReturnType<typeof lineHost.createPriceLine>>();
  let lineHostFed = false;

  // Für setCrosshair: Close je Handelstag (setCrosshairPosition braucht
  // neben der Zeit auch einen Preis auf der Serie)
  const closeByDate = new Map<string, number>();

  // Deklarative Overlay-Linien (SMA/EMA/BB/Vergleich) — Serien werden je Key
  // wiederverwendet und beim Entfernen sauber abgeräumt.
  const overlays = new Map<string, ReturnType<typeof chart.addLineSeries>>();

  // Flächen-Verlauf (Vektor-Look): lazy angelegt, Farbe = Signal-Richtung
  let area: ReturnType<typeof chart.addAreaSeries> | null = null;
  let areaOn = false;
  let currentRightOffset = 4;
  let autoScaleOn = true;

  // Chart-Typen (TV-Parität Teil 1): Kerzen-artige Typen rendern über die
  // candle-Serie (Heikin-Ashi = Daten-Transformation, Hollow = Stil-Optionen);
  // Line/Area/Baseline/Bars laufen über eine Alternativ-Serie. Die zuletzt
  // gesetzten Bars werden gecacht, damit der Typ-Wechsel ohne neue Daten geht.
  type Row = { time: string; open: number; high: number; low: number; close: number; volume: number };
  let cachedRows: Row[] = [];
  let currentType: ChartType = 'candles';
  let candlesWanted = true; // „Kerzen aus"-Layer (gilt nur für Kerzen-Typen)
  // Kombi (User-Wunsch 25.07. nachts): Linientyp (Linie/Berg/Baseline)
  // ZUSÄTZLICH zu den Kerzen — bei OHLC-Bars sinnfrei (doppelte OHLC-Optik).
  let combineOn = false;
  let alt: ReturnType<typeof chart.addLineSeries> | null = null;
  let altKind: ChartType | null = null;
  const CANDLE_TYPES = new Set<ChartType>(['candles', 'hollow', 'heikin']);
  const SOLID_OPTS = { upColor: '#26cf9d', borderVisible: false, borderUpColor: '#26cf9d' };
  const HOLLOW_OPTS = { upColor: 'rgba(0,0,0,0)', borderVisible: true, borderUpColor: '#26cf9d' };

  /** Träger-Serie füttern — nur solange Preislinien hängen (sonst leer). */
  const feedLineHost = (): void => {
    lineHost.setData(
      lineHostFed ? (cachedRows.map((r) => ({ time: r.time, value: r.close })) as never) : [],
    );
  };

  const renderPrice = (): void => {
    const isCandle = CANDLE_TYPES.has(currentType);
    const combineActive = combineOn && !isCandle && currentType !== 'bars';
    const rows = currentType === 'heikin' ? heikinAshi(cachedRows) : cachedRows;
    candle.setData(rows.map(({ volume: _v, ...r }) => r) as never);
    candle.applyOptions({
      visible: (isCandle || combineActive) && candlesWanted,
      ...(currentType === 'hollow' ? HOLLOW_OPTS : SOLID_OPTS),
    });
    if (!isCandle) {
      if (!alt || altKind !== currentType) {
        if (alt) chart.removeSeries(alt);
        const opts = { priceLineVisible: true, lastValueVisible: true, crosshairMarkerVisible: false, ...Y };
        if (currentType === 'line') alt = chart.addLineSeries({ color: '#25d0ee', lineWidth: 2, ...opts });
        else if (currentType === 'area')
          alt = chart.addAreaSeries({
            lineColor: '#25d0ee',
            topColor: 'rgba(37,208,238,.28)',
            bottomColor: 'rgba(37,208,238,0)',
            lineWidth: 2,
            ...opts,
          }) as never;
        else if (currentType === 'baseline')
          alt = chart.addBaselineSeries({
            baseValue: { type: 'price', price: cachedRows[0]?.close ?? 0 },
            topLineColor: '#26cf9d',
            topFillColor1: 'rgba(38,207,157,.25)',
            topFillColor2: 'rgba(38,207,157,0)',
            bottomLineColor: '#f2586b',
            bottomFillColor1: 'rgba(242,88,107,0)',
            bottomFillColor2: 'rgba(242,88,107,.25)',
            lineWidth: 2,
            ...opts,
          }) as never;
        else alt = chart.addBarSeries({ upColor: '#26cf9d', downColor: '#f2586b', thinBars: false, ...opts }) as never;
        altKind = currentType;
      }
      if (currentType === 'bars') alt.setData(cachedRows.map(({ volume: _v, ...r }) => r) as never);
      else {
        if (currentType === 'baseline')
          alt.applyOptions({ baseValue: { type: 'price', price: cachedRows[0]?.close ?? 0 } } as never);
        alt.setData(cachedRows.map((r) => ({ time: r.time, value: r.close })) as never);
      }
    } else if (alt) {
      chart.removeSeries(alt);
      alt = null;
      altKind = null;
    }
  };

  return {
    setBars(bars: ChartBar[] | IntradayChartBar[], opts?: SetBarsOptions): void {
      closeByDate.clear();
      const rows = bars.map((b) => {
        const time = 'date' in b ? b.date : (zuAchse(b.time) as never as string);
        if ('date' in b) closeByDate.set(b.date, b.close);
        return { time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      });
      cachedRows = rows;
      rowCount = rows.length;
      renderPrice();
      feedLineHost();
      vol.setData(
        rows.map((r) => ({
          time: r.time,
          value: r.volume,
          color: r.close >= r.open ? 'rgba(38,207,157,.4)' : 'rgba(242,88,107,.4)',
        })) as never,
      );
      if (opts?.timeVisible !== undefined) {
        chart.timeScale().applyOptions({ timeVisible: opts.timeVisible, secondsVisible: false });
      }
      // Zoom-Respekt: fitContent NUR bei explizitem Wunsch — Snapshot-Updates
      // (alle ~60 s) dürfen den User-Zoom nie zurücksetzen. Beim expliziten
      // Fit wird auch die Y-Skala wieder auf Autoscale gestellt (User-Feedback:
      // „x UND y beim Umschalten optimieren").
      if (opts?.fit) {
        // Expliziter Fit (Symbol-/Zeitrahmen-Wechsel): Fix-Spanne neu
        // einfrieren — die alte gehört zu einem anderen Preisniveau.
        fixReset();
        chart.priceScale('right').applyOptions({ autoScale: autoScaleOn });
        if (opts.fitTo) {
          // Sanity-Clamp (UI-Audit 25.07.): Ein programmatischer Fit darf die
          // Kerzen nie in eine Ecke quetschen — rechts höchstens ~20 % der
          // Spanne (mind. 35 Bars für den Prognose-Pfeil) über den letzten
          // Datenpunkt hinaus. User-Pan/-Zoom bleibt unbegrenzt.
          const span = opts.fitTo.to - opts.fitTo.from;
          const maxTo = rows.length - 1 + Math.max(35, span * 0.2);
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(opts.fitTo.from, -5),
            to: Math.min(opts.fitTo.to, maxTo),
          });
        } else chart.timeScale().fitContent();
      }
    },
    setOverlays(lines: OverlayLine[]): void {
      const wanted = new Set(lines.map((l) => l.key));
      for (const [key, series] of overlays) {
        if (!wanted.has(key)) {
          chart.removeSeries(series);
          overlays.delete(key);
        }
      }
      for (const line of lines) {
        let series = overlays.get(line.key);
        if (!series) {
          series = chart.addLineSeries({
            color: line.color,
            lineWidth: (line.width ?? 1.5) as never,
            priceLineVisible: false,
            lastValueVisible: line.separateScale ?? false,
            crosshairMarkerVisible: false,
            ...(line.separateScale ? { priceScaleId: 'overlay' } : Y),
          });
          if (line.separateScale) {
            chart.priceScale('overlay').applyOptions({ visible: false });
          }
          overlays.set(line.key, series);
        }
        series.applyOptions({ color: line.color });
        series.setData(line.points.map((p) => ({ time: zuAchse(p.time), value: p.value })) as never);
      }
    },
    overlayCount(): number {
      return overlays.size;
    },
    onClick(cb: (price: number | null) => void): void {
      chart.subscribeClick((param) => {
        const y = param.point?.y;
        cb(y == null ? null : (candle.coordinateToPrice(y) as number | null));
      });
    },
    coords(time: string | number, price: number): { x: number | null; y: number | null } {
      return {
        x: chart.timeScale().timeToCoordinate(zuAchse(time) as never) as number | null,
        y: candle.priceToCoordinate(price) as number | null,
      };
    },
    setArea(points, colors): void {
      areaOn = points !== null && points.length > 0;
      if (!areaOn || points === null) {
        area?.setData([]);
        return;
      }
      area ??= chart.addAreaSeries({
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        ...Y,
      });
      if (colors) {
        area.applyOptions({ lineColor: colors.line, topColor: colors.top, bottomColor: colors.bottom });
      }
      area.setData(points.map((p) => ({ time: zuAchse(p.time), value: p.value })) as never);
    },
    areaActive(): boolean {
      return areaOn;
    },
    setCandlesVisible(visible: boolean): void {
      candlesWanted = visible;
      candle.applyOptions({ visible: visible && CANDLE_TYPES.has(currentType) });
      vol.applyOptions({ visible });
    },
    setChartType(type: ChartType): void {
      if (type === currentType) return;
      currentType = type;
      renderPrice();
    },
    chartType(): ChartType {
      return currentType;
    },
    setTypeCombine(on: boolean): void {
      if (on === combineOn) return;
      combineOn = on;
      renderPrice();
    },
    typeCombineActive(): boolean {
      return combineOn && !CANDLE_TYPES.has(currentType) && currentType !== 'bars';
    },
    setPriceScaleMode(mode: 0 | 1 | 2): void {
      chart.priceScale('right').applyOptions({ mode });
    },
    scrollTo(target: 'start' | 'middle' | 'end'): void {
      const ts = chart.timeScale();
      if (target === 'end') {
        ts.scrollToRealTime(); // animiert an die rechte Kante
        return;
      }
      const r = ts.getVisibleLogicalRange();
      if (!r || cachedRows.length === 0) return;
      const span = r.to - r.from;
      const len = cachedRows.length;
      // scrollToPosition: 0 = letzter Bar an der rechten Kante, negativ = links.
      // Anfang: rechte Kante auf Bar `span`; Mitte: Fenster um len/2 zentriert.
      const pos = target === 'start' ? span - (len - 1) : span / 2 - (len - 1) / 2;
      ts.scrollToPosition(Math.min(0, pos), true); // animiert (Schwung)
    },
    setRightOffset(bars: number): void {
      if (bars === currentRightOffset) return;
      currentRightOffset = bars;
      chart.timeScale().applyOptions({ rightOffset: bars });
    },
    setYMode(mode: YMode): void {
      yModus = mode;
      fixReset(); // beim Moduswechsel frisch am aktuellen Fenster einfrieren
      autoScaleOn = mode !== 'frei';
      chart.priceScale('right').applyOptions({ autoScale: autoScaleOn });
    },
    forecastActive(): boolean {
      return fcOn;
    },
    setForecast(overlay, anchor): void {
      fcOn = overlay !== null && overlay.points.length > 0;
      if (!overlay || overlay.points.length === 0) {
        fcMid.setData([]);
        fcUp.setData([]);
        fcLo.setData([]);
        return;
      }
      // Anker (letzter Bar) voranstellen, damit die Linie am Chart andockt
      const mid = anchor
        ? [{ time: anchor.time, value: anchor.value }, ...overlay.points]
        : overlay.points;
      // Zeit kann ISO-Tag ODER UNIX-Sekunden sein (Intraday) — gleiche
      // Laundering-Idiomatik wie bei setBars (LWC akzeptiert beides zur Laufzeit)
      fcMid.setData(mid.map((p) => ({ time: zuAchse(p.time) as never as string, value: p.value })));
      fcUp.setData(overlay.band.map((b) => ({ time: zuAchse(b.time) as never as string, value: b.upper })));
      fcLo.setData(overlay.band.map((b) => ({ time: zuAchse(b.time) as never as string, value: b.lower })));
    },
    setMarkers(markers): void {
      candle.setMarkers(
        markers
          .map((m) => ({ ...m, time: zuAchse(m.time) }))
          .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)) as never,
      );
    },
    setPriceLines(lines): void {
      const wanted = new Set(lines.map((l) => l.key));
      for (const [key, line] of priceLines) {
        if (!wanted.has(key)) {
          lineHost.removePriceLine(line);
          priceLines.delete(key);
        }
      }
      const brauchtHost = lines.length > 0;
      if (brauchtHost !== lineHostFed) {
        lineHostFed = brauchtHost;
        feedLineHost();
      }
      for (const spec of lines) {
        const opts = {
          price: spec.price,
          color: spec.color,
          lineWidth: (spec.width ?? 1) as never,
          lineStyle: (spec.style ?? 2) as never,
          axisLabelVisible: spec.axisLabel ?? true,
          title: spec.title ?? '',
        };
        const vorhanden = priceLines.get(spec.key);
        if (vorhanden) vorhanden.applyOptions(opts as never);
        else priceLines.set(spec.key, lineHost.createPriceLine(opts as never));
      }
    },
    priceLineCount(): number {
      return priceLines.size;
    },
    onCrosshairDate(cb): void {
      chart.subscribeCrosshairMove((param) => {
        // v4 liefert Zeit als BusinessDay-Objekt (bei 'YYYY-MM-DD'-Strings)
        // oder String — beide Formen auf den ISO-Tag normalisieren.
        const t = param.time as unknown;
        let date: string | null = null;
        if (typeof t === 'string') {
          date = t;
        } else if (t && typeof t === 'object' && 'year' in t) {
          const bd = t as { year: number; month: number; day: number };
          date = `${bd.year}-${String(bd.month).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}`;
        } else if (typeof t === 'number') {
          // Intraday: Der Achsen-Zeitstempel ist bereits Ortszeit, also den
          // Kalendertag ohne weitere Verschiebung ablesen — sonst läge der
          // News-Tooltip abends auf dem Folgetag.
          date = new Date(t * 1000).toISOString().slice(0, 10);
        }
        if (!date || !param.point) {
          cb(null, null);
          return;
        }
        // Tooltip ist position:fixed (CLAUDE.md §6) → Viewport-Koordinaten
        const rect = container.getBoundingClientRect();
        cb(date, { x: rect.left + param.point.x, y: rect.top + param.point.y });
      });
    },
    onCrosshairData(cb): void {
      chart.subscribeCrosshairMove((param) => {
        const bar = param.seriesData?.get(candle) as
          | { open?: number; high?: number; low?: number; close?: number }
          | undefined;
        if (!param.point || !bar || bar.open === undefined) {
          cb(null);
          return;
        }
        const volRow = param.seriesData?.get(vol) as { value?: number } | undefined;
        const t = param.time as unknown;
        let label = '';
        if (typeof t === 'string') label = t;
        else if (t && typeof t === 'object' && 'year' in t) {
          const bd = t as { year: number; month: number; day: number };
          label = `${bd.year}-${String(bd.month).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}`;
        } else if (typeof t === 'number') {
          // Achsen-Zeit IST die Ortszeit — `toLocaleTimeString` würde den
          // Offset ein zweites Mal draufrechnen (der Widerspruch vom 04.08.:
          // Achse 13:30, Kurszeile 15:30 für denselben Bar). Aus demselben
          // Grund kommt auch der Kalendertag aus der UTC-Lesart.
          const iso = new Date(t * 1000).toISOString();
          const praefix = tagesPraefix(iso.slice(0, 10), lokalerTag(new Date()));
          label = praefix ? `${praefix} ${achsenUhrzeit(t)}` : achsenUhrzeit(t);
        }
        cb({
          time: label,
          open: bar.open,
          high: bar.high ?? bar.open,
          low: bar.low ?? bar.open,
          close: bar.close ?? bar.open,
          volume: volRow?.value ?? null,
        });
      });
    },
    onVisibleRangeChange(cb): void {
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        cb(range ? { from: range.from, to: range.to } : null);
      });
    },
    setVisibleRange(range): void {
      chart.timeScale().setVisibleLogicalRange(range);
    },
    getVisibleRange(): { from: number; to: number } | null {
      const r = chart.timeScale().getVisibleLogicalRange();
      return r ? { from: r.from, to: r.to } : null;
    },
    setCrosshair(date): void {
      const price = date ? closeByDate.get(date) : undefined;
      if (date && price !== undefined) {
        chart.setCrosshairPosition(price, date as never, candle);
      } else {
        chart.clearCrosshairPosition();
      }
    },
    destroy(): void {
      yGestenLoesen(); // window-Listener der Y-Gesten nicht leaken
      chart.remove();
    },
  };
}

/* ── Indikator-Unterpanels (Chart-Vision): RSI/MACD unter dem Haupt-Chart ── */

export interface PanelLine {
  key: string;
  color: string;
  width?: number;
  /** Gestrichelte Hilfslinie (z. B. RSI 30/70). */
  dashed?: boolean;
  type?: 'line' | 'histogram';
  points: Array<{ time: string | number; value: number; color?: string }>;
}

export interface IndicatorPanelHandle {
  /** Serien deklarativ setzen — Keys werden wiederverwendet, fehlende entfernt. */
  setSeries(lines: PanelLine[]): void;
  onVisibleRangeChange(cb: (range: { from: number; to: number } | null) => void): void;
  setVisibleRange(range: { from: number; to: number }): void;
  getVisibleRange(): { from: number; to: number } | null;
  destroy(): void;
}

/** Kompaktes Unterpanel; die Zeitachse hält der Aufrufer mit dem Haupt-Chart synchron. */
export async function buildIndicatorPanel(
  container: HTMLElement,
  label: string,
): Promise<IndicatorPanelHandle | null> {
  const lwc = await loadLwc();
  if (!lwc) return null;
  container.innerHTML = '';
  const chart = lwc.createChart(container, chartTheme() as never);
  chart.applyOptions({
    watermark: {
      visible: true,
      text: label,
      color: 'rgba(120,150,200,.10)',
      fontSize: 16,
      fontStyle: 'bold',
      horzAlign: 'left',
      vertAlign: 'top',
    },
    rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.1 } },
  } as never);

  type AnySeries = ReturnType<typeof chart.addLineSeries>;
  const series = new Map<string, { type: 'line' | 'histogram'; s: AnySeries }>();

  return {
    setSeries(lines: PanelLine[]): void {
      const wanted = new Set(lines.map((l) => l.key));
      for (const [key, entry] of series) {
        if (!wanted.has(key)) {
          chart.removeSeries(entry.s);
          series.delete(key);
        }
      }
      for (const line of lines) {
        const type = line.type ?? 'line';
        let entry = series.get(line.key);
        if (entry && entry.type !== type) {
          chart.removeSeries(entry.s);
          series.delete(line.key);
          entry = undefined;
        }
        if (!entry) {
          const common = { priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false };
          const s =
            type === 'histogram'
              ? (chart.addHistogramSeries({ ...common, color: line.color }) as never as AnySeries)
              : chart.addLineSeries({
                  ...common,
                  color: line.color,
                  lineWidth: (line.width ?? 1.5) as never,
                  // 2 = Dashed — numerisches Literal statt Enum (CLAUDE.md §6)
                  ...(line.dashed ? { lineStyle: 2, lastValueVisible: false } : {}),
                });
          entry = { type, s };
          series.set(line.key, entry);
        }
        entry.s.setData(line.points as never);
      }
    },
    onVisibleRangeChange(cb): void {
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        cb(range ? { from: range.from, to: range.to } : null);
      });
    },
    setVisibleRange(range): void {
      chart.timeScale().setVisibleLogicalRange(range);
    },
    getVisibleRange(): { from: number; to: number } | null {
      const r = chart.timeScale().getVisibleLogicalRange();
      return r ? { from: r.from, to: r.to } : null;
    },
    destroy(): void {
      chart.remove();
    },
  };
}
