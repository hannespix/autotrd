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

export interface PriceChartHandle {
  setBars(bars: ChartBar[]): void;
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
    destroy(): void {
      chart.remove();
    },
  };
}
