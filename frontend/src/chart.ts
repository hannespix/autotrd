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

import type { Bar } from '@autotrd/shared';

export interface ChartBar extends Bar {
  date: string; // YYYY-MM-DD
}

export interface ForecastOverlay {
  points: Array<{ time: string; value: number }>;
  band: Array<{ time: string; upper: number; lower: number }>;
}

export interface ChartMarker {
  time: string;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'circle' | 'arrowUp' | 'arrowDown';
  text?: string;
}

export interface PriceChartHandle {
  setBars(bars: ChartBar[]): void;
  /** Prognose-Overlay: gestrichelte Mittellinie + ±1σ-Band (null = entfernen). */
  setForecast(overlay: ForecastOverlay | null, anchor?: { time: string; value: number }): void;
  /** Event-Marker (sentiment-gefärbt) auf den Kerzen. */
  setMarkers(markers: ChartMarker[]): void;
  /**
   * Crosshair-Datum für Tooltip-Details (M6b): liefert den Handelstag unter
   * dem Cursor plus Viewport-Koordinaten — null beim Verlassen des Charts.
   */
  onCrosshairDate(cb: (date: string | null, pos: { x: number; y: number } | null) => void): void;
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
      timeVisible: false,
    },
    // 0 = Normal — numerisches Literal statt Enum (CLAUDE.md §6)
    crosshair: {
      mode: 0,
      vertLine: { color: 'rgba(0,212,255,.5)', width: 1, labelBackgroundColor: '#0091c2' },
      horzLine: { color: 'rgba(0,212,255,.4)', labelBackgroundColor: '#0091c2' },
    },
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

  const candle = chart.addCandlestickSeries({
    upColor: '#26cf9d',
    downColor: '#f2586b',
    borderVisible: false,
    wickUpColor: '#40e0b4',
    wickDownColor: '#ff8290',
  });
  const vol = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  // Prognose-Serien (leer bis setForecast); 2 = Dashed, 3 = Dotted (numerische
  // Literale statt Enum — CLAUDE.md-§6-Geist)
  const fcCommon = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
  const fcMid = chart.addLineSeries({ color: '#25d0ee', lineWidth: 2, lineStyle: 2, ...fcCommon });
  const fcUp = chart.addLineSeries({ color: 'rgba(37,208,238,.45)', lineWidth: 1, lineStyle: 3, ...fcCommon });
  const fcLo = chart.addLineSeries({ color: 'rgba(37,208,238,.45)', lineWidth: 1, lineStyle: 3, ...fcCommon });

  return {
    setBars(bars: ChartBar[]): void {
      candle.setData(
        bars.map((b) => ({
          time: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        })),
      );
      vol.setData(
        bars.map((b) => ({
          time: b.date,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(38,207,157,.4)' : 'rgba(242,88,107,.4)',
        })),
      );
      chart.timeScale().fitContent();
    },
    setForecast(overlay, anchor): void {
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
      fcMid.setData(mid.map((p) => ({ time: p.time, value: p.value })));
      fcUp.setData(overlay.band.map((b) => ({ time: b.time, value: b.upper })));
      fcLo.setData(overlay.band.map((b) => ({ time: b.time, value: b.lower })));
      chart.timeScale().fitContent();
    },
    setMarkers(markers): void {
      candle.setMarkers(
        [...markers].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)) as never,
      );
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
    destroy(): void {
      chart.remove();
    },
  };
}
