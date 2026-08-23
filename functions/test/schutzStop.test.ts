/**
 * Tests des Schutz-Stops (Bracket Stufe 1) — das Sicherheitsnetz zwischen
 * den Scans.
 *
 * Schwerpunkt sind die Fälle, in denen ein Fehler Geld kostet, ohne
 * aufzufallen: ein Stop, der enger gerundet wird als geplant; ein
 * „nicht stornierbar", das in Wahrheit „schon verkauft" heißt (ein zweiter
 * Verkauf eröffnete einen ungewollten Short); und ein Trailing, das bei
 * jedem Mini-Hoch ersetzt und damit Dauerrauschen erzeugt.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Position, RiskConfig } from '../../shared/src/index.js';
import {
  KRYPTO_LIMIT_ABSTAND,
  pflegeSchutz,
  planeSchutzStop,
  rundeAufSchritt,
  rundeStopPreis,
  schutzAufheben,
  schutzStopPreis,
  sollSchutzErsetzen,
} from '../src/core/schutzStop.js';

/* Firestore-Attrappe (Muster aus orderRouting.test.ts): vor den Importen
 * gehoistet, ein Doc mit get/set reicht für die Positions-Zugriffe. */
const { holt, setzt } = vi.hoisted(() => ({
  holt: vi.fn(),
  setzt: vi.fn(async () => undefined),
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ doc: () => ({ get: holt, set: setzt }) }),
}));

const SCHLUESSEL = { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' };
const VERBINDUNG = { mode: 'paper' as const, schluessel: SCHLUESSEL };

const RISK: RiskConfig = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1 };

const POS: Position = {
  symbol: 'AAPL',
  qty: 10,
  avgEntry: 100,
  stopLoss: null,
  takeProfit: null,
  openedAt: '2026-08-06T14:00:00Z',
  side: 'long',
  highWater: 100,
  broker: true,
  schutz: { orderId: 'alt1', stopPreis: 99, qty: 10 },
};

/** Antwort-Folge: jede Antwort mit eigenem ok/status/Körper. */
const folge = (
  ...antw: Array<{ ok?: boolean; status?: number; body?: unknown }>
): ReturnType<typeof vi.fn> => {
  let i = 0;
  return vi.fn(async () => {
    const a = antw[Math.min(i++, antw.length - 1)]!;
    return {
      ok: a.ok ?? true,
      status: a.status ?? 200,
      text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)),
    } as unknown as Response;
  });
};

const posSnap = (daten: Record<string, unknown> | null) => ({
  exists: daten !== null,
  data: () => daten,
});

beforeEach(() => {
  holt.mockReset();
  setzt.mockReset();
  setzt.mockResolvedValue(undefined);
});

describe('rundeStopPreis (vom Kurs WEG runden)', () => {
  it('Long rundet abwärts, Short aufwärts — 2 Stellen ab 1 $', () => {
    expect(rundeStopPreis(98.789, 'long')).toBe(98.78);
    expect(rundeStopPreis(98.781, 'short')).toBe(98.79);
  });
  it('unter 1 $ mit 4 Stellen', () => {
    expect(rundeStopPreis(0.98765, 'long')).toBe(0.9876);
    expect(rundeStopPreis(0.98761, 'short')).toBe(0.9877);
  });
});

describe('schutzStopPreis (der engere von Einstands- und Trailing-Stop)', () => {
  it('nur Stop-Loss: Einstand minus Prozent', () => {
    const r: RiskConfig = { stopLossPct: 2, takeProfitPct: 4 };
    expect(schutzStopPreis({ side: 'long', qty: 10, avgEntry: 100 }, r)).toBe(98);
  });
  it('Trailing über gestiegenem Hoch schlägt den Einstands-Stop', () => {
    const preis = schutzStopPreis(
      { side: 'long', qty: 10, avgEntry: 100, highWater: 110 },
      RISK,
    );
    // 110 × 0,99 = 108,9 — deutlich über den 98 des Einstands-Stops.
    expect(preis).toBeCloseTo(108.9, 2);
  });
  it('Short gespiegelt: der TIEFERE Kandidat gewinnt (näher am Kurs)', () => {
    const preis = schutzStopPreis(
      { side: 'short', qty: 10, avgEntry: 100, lowWater: 95 },
      RISK,
    );
    // Einstands-Stop 102, Trailing 95 × 1,01 = 95,95 → 95,95 gilt.
    expect(preis).toBeCloseTo(95.95, 2);
  });
  it('ohne Prozent-Stops gibt es kein Niveau', () => {
    const r: RiskConfig = { stopLossPct: 0, takeProfitPct: 4, trailingStopPct: 0 };
    expect(schutzStopPreis({ side: 'long', qty: 10, avgEntry: 100 }, r)).toBeNull();
  });
});

describe('planeSchutzStop (wann der Broker-Stop überhaupt entsteht)', () => {
  const lage = { side: 'long' as const, qty: 10, avgEntry: 100 };
  it('legt für US-Session-Klassen mit ganzen Stücken an', () => {
    const plan = planeSchutzStop(lage, RISK, 'stocks_us');
    expect(plan.anlegen).toBe(true);
    expect(plan.qty).toBe(10);
    expect(plan.stopPreis).toBeGreaterThan(0);
  });
  it('Forex/Rohstoffe bleiben Engine-only, unbekannte Klasse ebenfalls', () => {
    // Historische yfinance-Klassen, die Alpaca gar nicht handelt.
    expect(planeSchutzStop(lage, RISK, 'forex').grund).toBe('klasse_ohne_us_session');
    expect(planeSchutzStop(lage, RISK, 'commodities').grund).toBe('klasse_ohne_us_session');
    expect(planeSchutzStop(lage, RISK, null).grund).toBe('klasse_unbekannt');
  });
  it('Bruchstücke kann Alpaca nicht schützen — 10,4 Stück ⇒ Stop über 10', () => {
    expect(planeSchutzStop({ ...lage, qty: 10.4 }, RISK, 'stocks_us').qty).toBe(10);
    expect(planeSchutzStop({ ...lage, qty: 0.4 }, RISK, 'stocks_us').grund).toBe('bruchstueck');
  });
  it('reine ATR-Konten (kein Prozent-Stop) bekommen keinen Broker-Stop', () => {
    const r: RiskConfig = { stopLossPct: 0, takeProfitPct: 4 };
    expect(planeSchutzStop(lage, r, 'stocks_us').grund).toBe('kein_prozent_stop');
  });
});

describe('sollSchutzErsetzen (0,1-%-Schwelle gegen Dauerrauschen)', () => {
  it('ersetzt erst ab spürbarer Verbesserung', () => {
    expect(sollSchutzErsetzen(100, 100.05, 'long')).toBe(false);
    expect(sollSchutzErsetzen(100, 100.2, 'long')).toBe(true);
  });
  it('Short spiegelt die Richtung: besser heißt TIEFER', () => {
    expect(sollSchutzErsetzen(100, 99.8, 'short')).toBe(true);
    expect(sollSchutzErsetzen(100, 100.2, 'short')).toBe(false);
  });
  it('nie auf kaputte Werte reagieren', () => {
    expect(sollSchutzErsetzen(0, 100, 'long')).toBe(false);
    expect(sollSchutzErsetzen(100, 0, 'long')).toBe(false);
  });
});

describe('schutzAufheben (die Regel, die nie brechen darf)', () => {
  it('Storno frei (204 ohne Körper) → eigener Exit darf raus', async () => {
    const f = folge({ ok: true, status: 200 }); // leerer Körper = 204-Fall
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b.stand).toBe('frei');
  });
  it('Order schon weg (404) ist gleichwertig frei', async () => {
    const f = folge({ ok: false, status: 404, body: { message: 'not found' } });
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b.stand).toBe('frei');
  });
  it('„nicht stornierbar" + Fill ⇒ der Broker war schneller: dessen Fill zählt', async () => {
    const f = folge(
      { ok: false, status: 422, body: { message: 'not cancelable' } },
      { body: { id: 'o1', status: 'filled', filled_qty: '10', filled_avg_price: '98.4' } },
    );
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    /* `quelle` seit 23.08.: Dieser Pfad muss dasselbe Etikett liefern wie
     * `pflegeSchutz` — derselbe physische Fill kann über beide Wege entdeckt
     * werden. Ohne die Angleichung wäre die Mischung nicht aufgelöst, sondern
     * nur verkleinert. Der Aufrufer gibt hier keine Marke mit ⇒ Altbestand
     * ⇒ bisheriges Etikett. */
    expect(b).toEqual({
      stand: 'gefuellt',
      fillPreis: 98.4,
      fillQty: 10,
      orderId: 'o1',
      quelle: 'einstand',
    });
  });
});

describe('pflegeSchutz (Scan-Takt: buchen, neu anlegen, nachziehen)', () => {
  it('ausgelöster Stop → gefuellt, Schutz-Feld geräumt', async () => {
    const f = folge({
      body: { id: 'alt1', status: 'filled', filled_qty: '10', filled_avg_price: '98.9' },
    });
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', POS, RISK, 'stocks_us', 'scan1', f as never,
    );
    /* `quelle` seit der Mess-Korrektur 23.08.: Gelesen wird die beim ANLEGEN
     * festgehaltene Marke. `POS.schutz` trägt keine — das ist der Altbestands-
     * Fall, und der bleibt beim bisherigen Etikett.
     *
     * (Am Rande: `POS.schutz.stopPreis` ist 99,00, ein Niveau, das der heutige
     * Code gar nicht mehr erzeugt — bei `highWater === avgEntry` ist das
     * Trailing nicht scharf, `schutzStopPreis` liefert 98,00. Die 99,00 sind
     * exakt der Pegel des Bugs vom 11.08. Ein erster Anlauf dieser Korrektur
     * hat daraus per Rückrechnung „trailing" abgeleitet und damit dem
     * Trailing einen fremden Vorfall angelastet — der Grund, warum die Marke
     * jetzt beim Schreiben festgehalten wird statt beim Lesen geraten.) */
    expect(b).toEqual({
      stand: 'gefuellt',
      fillPreis: 98.9,
      fillQty: 10,
      orderId: 'alt1',
      quelle: 'einstand',
    });
    expect(setzt).toHaveBeenCalledWith({ schutz: null }, { merge: true });
  });

  it('ausgelöster Stop mit festgehaltener Trailing-Marke → trailing', () => {
    // Stimmige Lage: 110 im Plus, Trailing 3 % ⇒ 106,70 schlägt den
    // Einstands-Stop 98,00. Genau so hätte `planeSchutzStop` sie angelegt.
    const mitMarke: Position = {
      ...POS,
      highWater: 110,
      schutz: { orderId: 'alt1', stopPreis: 106.7, qty: 10, quelle: 'trailing' },
    };
    const f = folge({
      body: { id: 'alt1', status: 'filled', filled_qty: '10', filled_avg_price: '106.5' },
    });
    return pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', mitMarke, RISK, 'stocks_us', 'scan1', f as never,
    ).then((b) => {
      expect(b).toEqual({
        stand: 'gefuellt',
        fillPreis: 106.5,
        fillQty: 10,
        orderId: 'alt1',
        quelle: 'trailing',
      });
    });
  });

  it('verschwundene Order (404) → Schutz wird neu angelegt', async () => {
    // Reihenfolge: GET 404 → (Anlegen liest Position) → POST neue Stop-Order.
    holt.mockResolvedValue(posSnap({ ...POS, schutz: null }));
    const f = folge(
      { ok: false, status: 404, body: { message: 'not found' } },
      { body: { id: 'neu2', status: 'accepted', client_order_id: 'x' } },
    );
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', POS, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
    // Der letzte Schreibvorgang trägt die NEUE Order-Kennung.
    const letzter = setzt.mock.calls.at(-1)?.[0] as { schutz?: { orderId: string } };
    expect(letzter?.schutz?.orderId).toBe('neu2');
  });

  it('stehende Order + gestiegenes Hoch → Stop wird ersetzt', async () => {
    const pos: Position = { ...POS, highWater: 110 };
    const f = folge(
      { body: { id: 'alt1', status: 'new', filled_qty: '0', filled_avg_price: null } },
      { body: { id: 'ersetzt1', status: 'accepted' } },
    );
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', pos, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
    const geschrieben = setzt.mock.calls.at(-1)?.[0] as {
      schutz?: { orderId: string; stopPreis: number };
    };
    expect(geschrieben?.schutz?.orderId).toBe('ersetzt1');
    expect(geschrieben?.schutz?.stopPreis).toBeCloseTo(108.9, 2);
  });

  it('stehende Order OHNE besseres Niveau bleibt unangetastet', async () => {
    const f = folge({ body: { id: 'alt1', status: 'new', filled_qty: '0' } });
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', { ...POS, highWater: 100 }, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
    expect(setzt).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1); // nur der Status-GET, kein PATCH
  });

  it('Pflege-Fehler stoppen den Scan nicht', async () => {
    const f = folge({ ok: false, status: 500, body: { message: 'kaputt' } });
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', POS, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
  });
});

/**
 * Krypto — Bracket Stufe 1b (19.08.).
 *
 * Die Klasse, die das Netz am nötigsten hat: Sie läuft rund um die Uhr,
 * während der Scan alle fünf Minuten schaut. Bis heute war der Scan dort
 * der EINZIGE Wächter.
 *
 * Geprüft werden hier die vier Stellen, an denen ein Fehler nicht auffällt,
 * sondern still eine tote Order erzeugt: das Preis-Raster der Münze, die
 * Mindestgröße, die Richtung der Rundung und der Abstand des Limits. Eine
 * abgelehnte Order sähe im Log nach „Netz liegt" aus und wäre keins.
 */
describe('planeSchutzStop für Krypto (Stufe 1b)', () => {
  const RISK_K: RiskConfig = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1 };
  const btc = { side: 'long' as const, qty: 0.25, avgEntry: 60_000 };

  it('legt eine stop_limit-Order an — mit Limit UNTER dem Stop', () => {
    const plan = planeSchutzStop(btc, RISK_K, 'crypto', { preisSchritt: 1 });
    expect(plan.anlegen).toBe(true);
    // Bruchstücke bleiben Bruchstücke: 0,25 BTC werden NICHT auf 0 abgerundet.
    expect(plan.qty).toBe(0.25);
    // 60 000 × 0,98 = 58 800, Raster 1 ⇒ ganze Dollar.
    expect(plan.stopPreis).toBe(58_800);
    expect(plan.limitPreis).toBeDefined();
    expect(plan.limitPreis!).toBeLessThan(plan.stopPreis);
    // 1,5 % unter dem Stop, aufs Raster abgerundet.
    expect(plan.limitPreis!).toBe(Math.floor(58_800 * (1 - KRYPTO_LIMIT_ABSTAND)));
  });

  it('ohne bekanntes Preis-Raster wird NICHTS angelegt', () => {
    /* Der wichtigste Fall: Ein Stop-Preis neben dem Raster wird von Alpaca
     * abgelehnt. Lieber kein Netz (Zustand wie vor dieser Änderung) als eine
     * Order-Ablehnung bei jedem Scan — die kostet Broker-Aufrufe und sieht
     * im Positionsdokument trotzdem nach Schutz aus. */
    expect(planeSchutzStop(btc, RISK_K, 'crypto', null).grund).toBe('kein_preisraster');
    expect(planeSchutzStop(btc, RISK_K, 'crypto', {}).grund).toBe('kein_preisraster');
    expect(planeSchutzStop(btc, RISK_K, 'crypto', { preisSchritt: 0 }).grund).toBe(
      'kein_preisraster',
    );
  });

  it('unter der Mindestgröße der Münze wird NICHTS angelegt', () => {
    const plan = planeSchutzStop({ ...btc, qty: 0.00005 }, RISK_K, 'crypto', {
      preisSchritt: 1,
      mindestGroesse: 0.0001,
    });
    expect(plan.anlegen).toBe(false);
    expect(plan.grund).toBe('unter_mindestgroesse');
  });

  it('Krypto-Shorts gibt es bei Alpaca nicht — kein Kauf-Stop aus Versehen', () => {
    const plan = planeSchutzStop({ ...btc, side: 'short' }, RISK_K, 'crypto', {
      preisSchritt: 1,
    });
    expect(plan.anlegen).toBe(false);
    expect(plan.grund).toBe('krypto_nur_long');
  });

  it('grobes Raster bei kleinem Kurs: lieber kein Netz als ein Limit AUF dem Stop', () => {
    /* Ein Limit, das aufs Stop-Niveau hochrundet, ist kein Limit mehr,
     * sondern eine zweite Auslösemarke — die Order füllte nur bei exakt
     * diesem Kurs. Genau dann muss der Plan aussteigen. */
    const plan = planeSchutzStop(
      { side: 'long', qty: 5, avgEntry: 2 },
      RISK_K,
      'crypto',
      { preisSchritt: 1 },
    );
    expect(plan.anlegen).toBe(false);
    expect(plan.grund).toBe('limit_unter_raster');
  });
});

describe('rundeAufSchritt (Preis-Raster der Münze)', () => {
  it('rundet Long ABWÄRTS und Short AUFWÄRTS — nie enger als geplant', () => {
    expect(rundeAufSchritt(58_800.75, 1, 'long')).toBe(58_800);
    expect(rundeAufSchritt(58_800.25, 1, 'short')).toBe(58_801);
  });
  it('trifft feine Raster ohne Fließkomma-Schwanz', () => {
    // 0.1 × 3 ist in Fließkomma 0.30000000000000004 — Alpaca liest das als
    // ungültigen Preis.
    expect(rundeAufSchritt(0.34, 0.1, 'long')).toBe(0.3);
    expect(rundeAufSchritt(0.0001234, 0.0001, 'long')).toBe(0.0001);
  });
  it('ohne gültiges Raster bleibt der Preis unverändert', () => {
    expect(rundeAufSchritt(123.45, 0, 'long')).toBe(123.45);
    expect(rundeAufSchritt(123.45, Number.NaN, 'long')).toBe(123.45);
  });
});

describe('Krypto-Netz: die Invarianten, die keine Einzelprobe erwischt', () => {
  const RISK_K: RiskConfig = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1 };

  it('über hunderte Raster/Kurs-Paare: Limit IMMER echt unter dem Stop und auf dem Raster', () => {
    /* Warum eine Eigenschafts-Prüfung und keine weitere Einzelprobe:
     *
     * Die beiden Fehler, die hier möglich sind, hängen an der KOMBINATION
     * aus Kurs und Raster, nicht an einzelnen Werten. Ein Limit, das aufs
     * Stop-Niveau hochrundet, entsteht nur bei grobem Raster und kleinem
     * Kurs; ein Preis neben dem Raster nur bei krummen Schritten wie 0,05.
     * Eine Handvoll Beispiele trifft beides zuverlässig NICHT — und eine
     * abgelehnte Order fällt im Betrieb nicht auf, weil im Positions-
     * dokument trotzdem ein Schutz zu stehen scheint. */
    const raster = [1, 0.5, 0.05, 0.01, 0.001, 0.0001];
    const kurse = [0.002, 0.05, 1.5, 12.5, 250, 3_400, 61_234.56];
    let angelegt = 0;
    for (const schritt of raster) {
      for (const kurs of kurse) {
        for (const qty of [0.0005, 0.25, 3, 1_200]) {
          const plan = planeSchutzStop(
            { side: 'long', qty, avgEntry: kurs },
            RISK_K,
            'crypto',
            { preisSchritt: schritt },
          );
          if (!plan.anlegen) {
            // Ein Nein ist immer erlaubt — aber nie ohne Begründung.
            expect(plan.grund, `${schritt}/${kurs}/${qty} ohne Grund`).toBeTruthy();
            continue;
          }
          angelegt++;
          expect(plan.limitPreis, `${schritt}/${kurs}: kein Limit`).toBeDefined();
          expect(plan.limitPreis!, `${schritt}/${kurs}: Limit nicht unter Stop`).toBeLessThan(
            plan.stopPreis,
          );
          // Beide Preise müssen exakte Vielfache des Rasters sein.
          for (const preis of [plan.stopPreis, plan.limitPreis!]) {
            const rest = Math.abs(preis / schritt - Math.round(preis / schritt));
            expect(rest, `${schritt}/${kurs}: ${preis} liegt neben dem Raster`).toBeLessThan(1e-6);
          }
          // Die Menge wird bei Krypto NIE auf ganze Stücke gerundet.
          expect(plan.qty).toBe(qty);
        }
      }
    }
    // Die Probe muss auch wirklich etwas anlegen, sonst prüft sie nichts.
    expect(angelegt).toBeGreaterThan(50);
  });

  it('der Storno-vor-Exit-Pfad kennt KEINE Klassen — sonst sperrte das Netz Ausstiege', () => {
    /* Die eine Regel aus dem Modul-Kopf: Alpaca reserviert die Stücke für
     * die offene Schutz-Order. Ein eigener Exit MUSS sie vorher stornieren.
     * Dieser Storno hängt in `broker.ts` allein an `position.schutz` — wer
     * dort eine Klassen-Bedingung einzöge (etwa `usSessionClass(klasse)`),
     * würde Krypto-Ausstiege ab sofort mit „insufficient qty" ablehnen
     * lassen: Das Netz, das schützen soll, würde zur Falle.
     *
     * Deshalb wird hier der Quelltext geprüft und nicht das Verhalten: Ein
     * Verhaltenstest bräuchte den Broker; diese Bedingung ist aber eine
     * Struktur-Aussage und als solche direkt lesbar. */
    const quelle = readFileSync(
      join(import.meta.dirname, '..', 'src', 'core', 'broker.ts'),
      'utf8',
    );
    const zeile = quelle
      .split('\n')
      .find((l) => l.includes('const schutz =') && l.includes('position.schutz'));
    expect(zeile, 'Storno-Bedingung nicht gefunden — Pfad umgebaut?').toBeTruthy();
    expect(zeile!).not.toMatch(/usSessionClass|klasse\s*[=!]==|'crypto'/);
  });
});

/**
 * Selbstheilung des Netzes (19.08.).
 *
 * Der Befund, der diese Tests erzwungen hat: Ein Schutz-Stop entstand
 * AUSSCHLIESSLICH nach einem eröffnenden Fill. Nach einem Teilausstieg —
 * der die Order stornieren MUSS, sonst sind die Stücke reserviert — kam
 * nie wieder einer. Die Restposition lag ungeschützt da, und im Dashboard
 * sah nichts danach aus.
 */
describe('pflegeSchutz legt ein fehlendes Netz an', () => {
  beforeEach(() => {
    holt.mockReset();
    setzt.mockReset();
    setzt.mockResolvedValue(undefined);
  });

  it('Position ohne Schutz bekommt eine Order — der Fall nach dem Teilausstieg', async () => {
    const ohne: Position = { ...POS, qty: 6, schutz: null };
    // schutzAnlegen liest die Position frisch nach.
    holt.mockResolvedValue({ exists: true, data: () => ohne });
    const fetchImpl = folge({ body: { id: 'neu1', status: 'new' } });

    const befund = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', ohne, RISK, 'stocks_us', 'lauf1', fetchImpl,
    );

    expect(befund.stand).toBe('ok');
    // Genau EIN Broker-Aufruf: die neue Stop-Order.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, opts] = fetchImpl.mock.calls[0] as [string, { body: string }];
    const gesendet = JSON.parse(opts.body) as Record<string, unknown>;
    expect(gesendet['type']).toBe('stop');
    expect(gesendet['qty']).toBe('6');
    // `quelle` seit 23.08.: Die Marke wird beim ANLEGEN festgehalten. Hier
    // ist highWater gleich avgEntry, das Trailing also nicht scharf — der
    // Einstands-Stop setzt das Niveau.
    expect(setzt).toHaveBeenCalledWith(
      { schutz: { orderId: 'neu1', stopPreis: expect.any(Number), qty: 6, quelle: 'einstand' } },
      { merge: true },
    );
  });

  it('ohne Prozent-Stop wird NICHT angelegt — und nichts nachgelesen', async () => {
    /* Die Kostenseite: Konten mit reinen ATR-Stops bekommen kein Netz. Der
     * Plan entscheidet das aus der Position, die der Scan schon in der Hand
     * hat. Würde stattdessen blind `schutzAnlegen` gerufen, wäre das ein
     * Firestore-Lesevorgang je Position und Scan — für nichts. */
    const nurAtr: RiskConfig = { stopLossPct: 0, takeProfitPct: 4, trailingStopPct: 0 };
    const ohne: Position = { ...POS, schutz: null };
    const fetchImpl = folge({ body: {} });

    await pflegeSchutz(VERBINDUNG, 'u1', 'AAPL', ohne, nurAtr, 'stocks_us', 'lauf1', fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(holt).not.toHaveBeenCalled();
    expect(setzt).not.toHaveBeenCalled();
  });

  it('Bruchstück-Rest bekommt keins — und liest ebenfalls nichts nach', async () => {
    const rest: Position = { ...POS, qty: 0.4, schutz: null };
    const fetchImpl = folge({ body: {} });
    await pflegeSchutz(VERBINDUNG, 'u1', 'AAPL', rest, RISK, 'stocks_us', 'lauf1', fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(holt).not.toHaveBeenCalled();
  });
});
