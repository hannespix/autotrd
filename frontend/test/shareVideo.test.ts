/**
 * Wächter des Story-Videos (Owner 20.08.).
 *
 * Ehrlichkeit ist nicht animierbar: Das Papier-Siegel muss auf JEDEM Frame
 * jeder Zahlen-Szene in voller Deckkraft stehen — auch beim allerersten
 * (p=0) und letzten (p=1). Die Einladungs-Szene behauptet keine Ziffer.
 * Der Stub zeichnet jeden fillText mitsamt der in dem Moment wirksamen
 * Deckkraft auf — genau die Größen, um die es geht.
 */
import { zerlegeDepot } from '@autotrd/shared';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ShareDaten } from '../src/shareCard.js';
import { datenrate, maleSzene, OFFLINE_KODIERUNGEN, VIDEO_FPS, videoSzenen, zerlegeHaupt } from '../src/shareVideo.js';

beforeEach(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
});

/** Aufzeichnender 2D-Kontext: Texte mit Deckkraft, sonst stumme Züge. */
class StubKontext {
  globalAlpha = 1;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  font = '';
  textAlign = 'left';
  texte: Array<{ text: string; alpha: number }> = [];
  fillText(text: string): void {
    this.texte.push({ text, alpha: this.globalAlpha });
  }
  strokeText(): void {}
  measureText(text: string): { width: number } {
    return { width: text.length * 14 };
  }
  fillRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arcTo(): void {}
  arc(): void {}
  fill(): void {}
  stroke(): void {}
  setLineDash(): void {}
  save(): void {}
  restore(): void {}
  scale(): void {}
}

function fixture(): ShareDaten {
  const tage = [
    { date: '2026-08-14', equity: 10_000 },
    { date: '2026-08-17', equity: 10_120 },
    { date: '2026-08-19', equity: 10_240 },
  ];
  const trades = [
    { symbol: 'NVDA', side: 'sell', qty: 1, price: 100, pnl: 180, executedAt: '2026-08-16T19:00:00.000Z' },
    { symbol: 'EWJ', side: 'sell', qty: 1, price: 100, pnl: -60, executedAt: '2026-08-17T19:00:00.000Z' },
  ];
  return {
    zerlegung: zerlegeDepot(tage, trades),
    renditePct: 2.4,
    ergebnis: 240,
    waehrung: 'USD',
    trefferquotePct: 50,
    profitFaktor: 3,
    trades: 2,
    maxDrawdownPct: -1.1,
    bestes: { label: 'NVDA', pct: 1.8 },
    schlechtestes: { label: 'EWJ', pct: -0.6 },
    echtgeld: false,
    betraege: false,
    tradeBilanz: 120,
    vonTag: '2026-08-16',
    bisTag: '2026-08-17',
  };
}

const male = (id: 'ergebnis' | 'verlauf' | 'womit' | 'cta', p: number): StubKontext => {
  const ctx = new StubKontext();
  maleSzene(ctx as unknown as CanvasRenderingContext2D, fixture(), id, p);
  return ctx;
};

describe('videoSzenen — gleiche Auswahllogik wie die Karten', () => {
  it('volle Daten ⇒ vier Szenen, ohne Kurve nur Ergebnis + Einladung', () => {
    expect(videoSzenen(fixture()).map((s) => s.id)).toEqual(['ergebnis', 'verlauf', 'womit', 'cta']);
    const leer = { ...fixture(), zerlegung: zerlegeDepot([], []) };
    expect(videoSzenen(leer).map((s) => s.id)).toEqual(['ergebnis', 'cta']);
  });
});

describe('Ehrlichkeit im Bewegtbild', () => {
  it('das Siegel steht auf JEDEM Frame jeder Zahlen-Szene in voller Deckkraft', () => {
    for (const id of ['ergebnis', 'verlauf', 'womit'] as const) {
      for (const p of [0, 0.01, 0.5, 1]) {
        const siegel = male(id, p).texte.find((z) => z.text === 'PAPIERKONTO');
        expect(siegel, `${id} bei p=${p}`).toBeDefined();
        expect(siegel!.alpha, `${id} bei p=${p}`).toBe(1);
      }
    }
  });

  it('die Einladungs-Szene behauptet keine Ziffer — zu keinem Zeitpunkt', () => {
    for (const p of [0.2, 0.6, 1]) {
      for (const z of male('cta', p).texte) {
        expect(z.text, `CTA p=${p}: „${z.text}"`).not.toMatch(/\d/);
      }
    }
  });

  it('die Zahl zählt hoch: unterwegs kleiner, am Ende exakt die Aussage', () => {
    const unterwegs = male('ergebnis', 0.2).texte.map((z) => z.text);
    const ende = male('ergebnis', 1).texte.map((z) => z.text);
    expect(ende).toContain('+2,40 %');
    expect(unterwegs).not.toContain('+2,40 %');
  });
});

/**
 * Wächter des Offline-Encoders (Owner 21.08.: „WhatsApp verschickt nur
 * 3 Sekunden" + „ruckelig"). Wurzel: MediaRecorder streamt Fragmente ohne
 * verlässliche Container-Dauer, und die Echtzeit-Aufnahme nahm nur die
 * Frames, die das Gerät schaffte. Der Offline-Pfad (WebCodecs + Muxer mit
 * echter Dauer im Header, festes 30-fps-Raster) fixt beides — diese Pins
 * halten die tragenden Entscheidungen fest.
 */
describe('Offline-Encoder — echte Dauer im Container, festes Frame-Raster', () => {
  const quelle = readFileSync(fileURLToPath(new URL('../src/shareVideo.ts', import.meta.url)), 'utf8');

  it('Kaskade: H.264-MP4 vor VP9-WebM — Messenger lesen nur MP4-Dauer zuverlässig', () => {
    const arten = OFFLINE_KODIERUNGEN.map((k) => k.art);
    expect(arten.lastIndexOf('mp4')).toBeLessThan(arten.indexOf('webm'));
    expect(OFFLINE_KODIERUNGEN.some((k) => k.codec.startsWith('avc1.'))).toBe(true);
    expect(OFFLINE_KODIERUNGEN.some((k) => k.codec.startsWith('vp09.'))).toBe(true);
  });

  it('H.264-Level passt zur Bildrate der Stufe — 60 fps sprengen Level 4.0', () => {
    /* Owner 22.08. („laggy und stockend") — die Bildrate liess sich NICHT
     * einfach verdoppeln: 1080×1080 bei 60 fps braucht 68 × 68 × 60 ≈
     * 273.000 Makroblöcke/s, Level 4.0 (`…28`) erlaubt 245.760. Ein
     * 60er-Kandidat auf Level 4.0 fiele bei `isConfigSupported` durch, und
     * der Clip landete auf dem Echtzeit-Netz — dem Weg, der Frames
     * verliert. Die „Verbesserung" hätte das Ruckeln verschlimmert.
     * Deshalb: 60 fps nur auf Level 4.2 (`…2a`), 30 fps auf 4.0. */
    for (const k of OFFLINE_KODIERUNGEN.filter((k) => k.art === 'mp4')) {
      expect(k.codec.endsWith(k.fps >= 60 ? '2a' : '28'), `${k.codec}@${k.fps}`).toBe(true);
    }
    // Es MUSS eine 60er-Stufe geben — sonst ist der Fix stillschweigend weg.
    expect(OFFLINE_KODIERUNGEN.some((k) => k.fps >= 60)).toBe(true);
    // …und eine 30er als Netz für Browser ohne Level 4.2.
    expect(OFFLINE_KODIERUNGEN.some((k) => k.fps === 30)).toBe(true);
    // Das Echtzeit-Netz bleibt bei 30 — mehr schafft es ohnehin nicht.
    expect(VIDEO_FPS).toBe(30);
  });

  it('Datenrate wächst mit der Bildrate — sonst wird jedes Bild dünner', () => {
    /* Doppelt so viele Frames bei gleicher Rate heisst halb so viel pro
     * Bild. Blockartefakte in Bewegung lesen sich wie Ruckeln, obwohl die
     * Frames alle da sind — der Fix hätte sich selbst aufgehoben. */
    expect(datenrate(60)).toBeGreaterThan(datenrate(30));
    expect(quelle).toContain('bitrate: datenrate(fps),');
  });

  it('die Probe fragt MIT der Bildrate des Kandidaten', () => {
    /* Mit einer festen 30 in `isConfigSupported` hätte der Browser eine
     * Konfiguration bestätigt, die danach gar nicht encodiert wird. */
    expect(quelle).toContain('bitrate: datenrate(k.fps),');
    expect(quelle).toContain('framerate: k.fps,');
  });

  it('MP4 mit moov voran und avc-Format — sonst liest WhatsApp wieder Fragment-Dauer', () => {
    expect(quelle).toContain("fastStart: 'in-memory',");
    expect(quelle).toContain("avc: { format: 'avc' as const }");
  });

  it('festes Frame-Raster statt Echtzeit — jeder Frame wird gerendert, keiner fällt aus', () => {
    expect(quelle).toContain('timestamp: Math.round((i * 1_000_000) / fps),');
    expect(quelle).toContain('duration: Math.round(1_000_000 / fps),');
    // Endstand-Nachlauf wie im Echtzeit-Pfad.
    expect(quelle).toContain('Math.round(((gesamtMs + 400) / 1000) * fps)');
  });

  it('Reihenfolge: erst Offline versuchen, das Echtzeit-Netz bleibt für Browser ohne WebCodecs', () => {
    expect(quelle).toContain('const wahl = await offlineKodierung();');
    expect(quelle).toContain('return nimmEchtzeit(canvas, ctx, gesamtMs, maleFrame, dateiStamm, meldeFortschritt, beobachter);');
    expect(quelle).toContain('canvas.captureStream(30);');
  });
});

describe('zerlegeHaupt — die Zerlegung fürs Hochzählen', () => {
  it('zerlegt Vorzeichen, Wert, Dezimalstellen und Rest', () => {
    expect(zerlegeHaupt('+6,40 %')).toEqual({ vorzeichen: '+', wert: 6.4, dezimal: 2, rest: ' %' });
    expect(zerlegeHaupt('−12,3 %')).toEqual({ vorzeichen: '−', wert: 12.3, dezimal: 1, rest: ' %' });
  });

  it('Unparsebares wird nicht angefasst', () => {
    expect(zerlegeHaupt('Noch keine abgeschlossenen Trades')).toBeNull();
  });
});
