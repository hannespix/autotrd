/**
 * Wächter für den Veraltete-Prognose-Fix (Owner 21.08., Task #191:
 * „Sektor-ETFs und andere Symbole werden nicht richtig gerendert, wenn
 * nicht Clean aktiviert ist").
 *
 * Die Wurzel: Katalog-Symbole außerhalb der Scan-Rotation behalten im
 * market-Doc einen ALTEN Forecast, während ihre Chart-Historie (momentumRun)
 * täglich weiterläuft. Der Tages-Pfad stellte den Anker (jüngste Kerze)
 * UNGEFILTERT vor die Prognose-Punkte — die Serie war nicht mehr aufsteigend,
 * Lightweight Charts warf „data must be asc ordered by time", und der
 * Abbruch mitten in renderChart ließ Overlays, Preisskala und Unterpanels
 * auf dem Vorgänger-Symbol stehen. Clean-View überspringt den Prognose-Pfad
 * — deshalb „nur ohne Clean". E2E-Nachweis: scratchpad/etf-repro.mjs
 * (TSLA komplett veraltet, SPY Grenzfall Punkt == Ankertag).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const chart = lese('../src/chart.ts');
const dashboard = lese('../src/dashboard.ts');
const i18n = lese('../src/i18n.ts');

describe('Veralteter Tages-Forecast — kein LWC-Wurf, ehrlich ausblenden', () => {
  it('chart.ts setForecast filtert als Sicherheitsnetz alles auf/vor dem Anker', () => {
    // Das Netz gilt für JEDEN Aufrufer (Haupt-Chart, Raster, Vergleich):
    // kein Punkt darf zeitgleich mit oder vor dem Anker liegen — sonst ist
    // die Anker-Serie nicht aufsteigend und LWC wirft.
    expect(chart).toContain('overlay.points.filter((p) => p.time > anchor.time)');
    expect(chart).toContain('overlay.band.filter((b) => b.time > anchor.time)');
    // fcOn spiegelt den GEFILTERTEN Stand — eine komplett veraltete Prognose
    // gilt als aus (E2E-Hook forecastActive bleibt ehrlich).
    expect(chart).toContain('fcOn = punkte.length > 0;');
    expect(chart).not.toContain('fcOn = overlay !== null && overlay.points.length > 0;');
  });

  it('Haupt-Chart: Anker ist die letzte GEZEIGTE Kerze, Punkte nur danach', () => {
    // st.bars (Scan-Bars) können hinter der Katalog-Historie zurückliegen —
    // die Prognose dockte dann mitten im Chart an. shownDaily ist die Wahrheit.
    expect(dashboard).toContain('const last = st.shownDaily[st.shownDaily.length - 1];');
    expect(dashboard).toContain('const zukunft = last ? fc.points.filter((p) => p.time > last.date) : fc.points;');
    expect(dashboard).toContain('band: last ? fc.band.filter((b) => b.time > last.date) : fc.band');
    // Komplett veraltet → Overlay aus + ehrlicher Hinweis statt Phantom-Linie.
    expect(dashboard).toContain("info.textContent = t('af.veraltet');");
    // Die Info-Zeile zählt die wirklich gezeichneten Punkte, nicht das Roh-Doc.
    expect(dashboard).toContain("${zukunft.length} ${t('af.handelstage')}");
  });

  it('Raster-Panels: derselbe Filter im Tages-Zweig', () => {
    expect(dashboard).toContain('fc.points.filter((x) => x.time > lastB.time)');
    expect(dashboard).toContain('fc.band.filter((b) => b.time > lastB.time)');
    expect(dashboard).toContain('zukunft.length > 0 && lastB ? { time: lastB.time, value: lastB.close } : undefined');
  });

  it('die Intraday-Filter bleiben (dieselbe Regel, andere Zeitdomäne)', () => {
    expect(dashboard).toContain('ifc.points.filter((p) => p.t > lastBar.time)');
    expect(dashboard).toContain('ifc.points.filter((x) => x.t > (lastB.time as number))');
  });

  it('Symbolwechsel leert auch die gezeigten Bars — kein Anker auf fremdem Preisniveau', () => {
    expect(dashboard).toContain('st.shownDaily = [];');
    expect(dashboard).toContain('st.shownIntraday = [];');
  });

  it('der Hinweis-Text existiert auf Deutsch und Englisch', () => {
    expect((i18n.match(/'af\.veraltet':/g) ?? []).length).toBe(2);
  });
});
