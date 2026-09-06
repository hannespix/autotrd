/**
 * saveStrategy — Einstellungen des Auto-Traders, geprüft am In-Memory-
 * Firestore der Takt-Tests (kein Emulator, kein Netz).
 *
 * Die Fälle, in denen Geld oder Fremdlast entsteht: eine Engine, die ohne
 * Freischaltung oder ohne bestätigte E-Mail anspringt; Risiko-Werte außerhalb
 * der Hülle, die der Takt beim Lesen ablehnte (Nutzer still übersprungen);
 * Symbole außerhalb des Plattform-Universums; eine abgewählte Symbol-Liste,
 * die ein Merge stehen ließe; ein Alt-Payload, dessen Handelsparameter
 * versehentlich wieder Wirkung bekämen.
 */
import { describe, expect, it } from 'vitest';
import {
  ENGINE_CONFIG_PATH,
  ladePlattformUniversum,
  speichereEinstellungen,
  type SpeicherDeps,
} from '../src/callable/strategy.ts';
import { DEFAULT_UNIVERSE } from '../src/engine/config.ts';
import { CONFIG_PATH } from '../src/engine/tick.ts';
import { FakeFirestore } from './fakes/firestore.ts';

const UID = 'u1';

const ALT_STRATEGIE = {
  broker: { provider: 'paper', mode: 'paper', initialCapital: 25_000, paperTrading: true },
  watchlist: ['QQQ', 'SPY'],
  engine: { running: false, checkIntervalMin: 5, maxPositionPct: 10, stopLossPct: 2, takeProfitPct: 4, riskPerTradePct: 1 },
  indicators: {},
  signals: { minConfluence: 2, allowShort: true },
};

const AUTO = {
  riskPerTradePct: 1,
  maxPositionPct: 25,
  maxPositions: 3,
  maxDailyLossPct: 3,
  maxDrawdownPct: 15,
  allowShort: true,
};

function aufbau(opts: { accessLevel?: string; email?: boolean; ohneProfil?: boolean; engineConfig?: Record<string, unknown> } = {}) {
  const db = new FakeFirestore();
  if (!opts.ohneProfil) {
    db.seed(`users/${UID}`, {
      accessLevel: opts.accessLevel ?? 'approved',
      settings: { strategy: structuredClone(ALT_STRATEGIE), ui: { theme: 'dunkel' }, hotkeys: { halt: 'h' } },
    });
  }
  if (opts.engineConfig) db.seed(ENGINE_CONFIG_PATH, opts.engineConfig);
  const meldungen: unknown[][] = [];
  const deps: SpeicherDeps = { db, emailBestaetigt: opts.email ?? true, log: { info: (...a) => void meldungen.push(a) } };
  return { db, deps, meldungen };
}

const speichern = (deps: SpeicherDeps, data: unknown) => speichereEinstellungen(deps, UID, data);

describe('Payload', () => {
  it('weder auto noch engineRunning noch strategy ⇒ invalid-argument, kein Firestore-Zugriff', async () => {
    const { db, deps } = aufbau();
    await expect(speichern(deps, {})).rejects.toMatchObject({ code: 'invalid-argument', message: 'val.pflichtFehlt|auto' });
    await expect(speichern(deps, null)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(db.log).toEqual([]);
  });

  it('engineRunning muss ein Boolean sein', async () => {
    const { db, deps } = aufbau();
    await expect(speichern(deps, { engineRunning: 'yes' })).rejects.toMatchObject({ code: 'invalid-argument', message: 'val.boolean|engineRunning' });
    expect(db.log).toEqual([]);
  });

  it('ohne Profil ⇒ failed-precondition (ensureProfile zuerst)', async () => {
    const { deps } = aufbau({ ohneProfil: true });
    await expect(speichern(deps, { engineRunning: false })).rejects.toMatchObject({ code: 'failed-precondition', message: 'srv.profilFehltEnsure' });
  });
});

describe('engineRunning', () => {
  it('schreibt NUR settings.strategy.engine.running — Alt-Felder, ui und hotkeys bleiben', async () => {
    const { db, deps } = aufbau();
    const out = await speichern(deps, { engineRunning: true });
    expect(out).toEqual({ ok: true, engineRunning: true });
    const doc = db.get(`users/${UID}`)!;
    const settings = doc.settings as Record<string, unknown>;
    expect((settings.strategy as Record<string, Record<string, unknown>>).engine).toEqual({ ...ALT_STRATEGIE.engine, running: true });
    expect(settings.ui).toEqual({ theme: 'dunkel' });
    expect(settings.hotkeys).toEqual({ halt: 'h' });
    expect(settings.auto).toBeUndefined();
    expect(db.log).toEqual([`update users/${UID}`]);
  });

  it('Einschalten ohne bestätigte E-Mail ⇒ srv.emailZuerstBestaetigen, nichts geschrieben', async () => {
    const { db, deps } = aufbau({ email: false });
    await expect(speichern(deps, { engineRunning: true })).rejects.toMatchObject({ code: 'failed-precondition', message: 'srv.emailZuerstBestaetigen' });
    expect(db.log).toEqual([]);
  });

  it('Einschalten ohne Freischaltung ⇒ srv.freischaltungAbwarten (pending UND blocked)', async () => {
    for (const accessLevel of ['pending', 'blocked']) {
      const { db, deps } = aufbau({ accessLevel });
      await expect(speichern(deps, { engineRunning: true })).rejects.toMatchObject({ code: 'failed-precondition', message: 'srv.freischaltungAbwarten' });
      expect(db.log).toEqual([]);
    }
  });

  it('AUSSCHALTEN ist immer erlaubt — auch ohne Freischaltung und ohne bestätigte E-Mail', async () => {
    const { db, deps } = aufbau({ accessLevel: 'pending', email: false });
    db.seed(`users/${UID}`, { accessLevel: 'pending', settings: { strategy: { engine: { running: true } } } });
    await expect(speichern(deps, { engineRunning: false })).resolves.toEqual({ ok: true, engineRunning: false });
    expect(db.get(`users/${UID}`)).toMatchObject({ settings: { strategy: { engine: { running: false } } } });
  });

  it('Bestandskonto ohne accessLevel gilt als freigeschaltet', async () => {
    const { db, deps } = aufbau();
    db.seed(`users/${UID}`, { settings: {} });
    await expect(speichern(deps, { engineRunning: true })).resolves.toEqual({ ok: true, engineRunning: true });
    // Der Punktpfad legt die fehlenden Zwischen-Maps an.
    expect(db.get(`users/${UID}`)).toEqual({ settings: { strategy: { engine: { running: true } } } });
  });
});

describe('auto', () => {
  it('speichert die normalisierten Einstellungen unter settings.auto und gibt sie zurück', async () => {
    const { db, deps } = aufbau();
    const out = await speichern(deps, { auto: { ...AUTO, symbols: ['aapl', 'msft', 'AAPL'], fremd: 1 } });
    const erwartet = { ...AUTO, notifyTelegram: false, symbols: ['AAPL', 'MSFT'] };
    expect(out).toEqual({ ok: true, auto: erwartet });
    const settings = db.get(`users/${UID}`)!.settings as Record<string, unknown>;
    expect(settings.auto).toEqual(erwartet);
    // Geschwister unberührt — auch die Alt-Strategie samt Schalter.
    expect(settings.strategy).toEqual(ALT_STRATEGIE);
    expect(settings.ui).toEqual({ theme: 'dunkel' });
    expect(db.log).toEqual([`update users/${UID}`]);
  });

  it('Werte außerhalb der Hülle des Kerns werden abgelehnt — alle Codes auf einmal, nichts geschrieben', async () => {
    const { db, deps } = aufbau();
    await expect(speichern(deps, { auto: { ...AUTO, riskPerTradePct: 7, maxPositions: 0 } })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'val.bereich|riskPerTradePct|0|5 · val.bereich|maxPositions|1|50',
    });
    await expect(speichern(deps, { auto: 'alles' })).rejects.toMatchObject({ code: 'invalid-argument', message: 'val.objekt|auto' });
    expect(db.log).toEqual([]);
  });

  it('ohne meta/engineConfig gilt das eingebaute Universum: fremde Symbole werden namentlich abgelehnt', async () => {
    const { db, deps } = aufbau();
    await expect(speichern(deps, { auto: { ...AUTO, symbols: ['AAPL', 'xyz', 'PLTR'] } })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'val.unbekannteSymbole|symbols|XYZ, PLTR',
    });
    expect(db.log).toEqual([]);
    await expect(speichern(deps, { auto: { ...AUTO, symbols: [...DEFAULT_UNIVERSE] } })).resolves.toMatchObject({ ok: true });
  });

  it('meta/engineConfig bestimmt das Universum — Nutzer-Symbole in Broker-Schreibweise (brk-b ⇒ BRK.B)', async () => {
    const { db, deps } = aufbau({ engineConfig: { universe: { assetClass: 'us_equity', symbols: ['NVDA', 'BRK.B'] } } });
    await expect(speichern(deps, { auto: { ...AUTO, symbols: ['AAPL'] } })).rejects.toMatchObject({ message: 'val.unbekannteSymbole|symbols|AAPL' });
    const out = await speichern(deps, { auto: { ...AUTO, symbols: ['brk-b', 'nvda'] } });
    expect(out.auto?.symbols).toEqual(['BRK.B', 'NVDA']);
    expect((db.get(`users/${UID}`)!.settings as Record<string, Record<string, unknown>>).auto!.symbols).toEqual(['BRK.B', 'NVDA']);
  });

  it('Krypto-Universum: btcusd ⇒ BTC/USD, wie der Takt es liest', async () => {
    const { deps } = aufbau({ engineConfig: { universe: { assetClass: 'crypto', symbols: ['BTC/USD', 'ETH/USD'] } } });
    const out = await speichern(deps, { auto: { ...AUTO, symbols: ['btcusd', 'eth-usd', 'BTC/USD'] } });
    expect(out.auto?.symbols).toEqual(['BTC/USD', 'ETH/USD']);
  });

  it('ohne Symbole (oder leer) wird eine vorher gewählte Liste ENTFERNT — kein Merge, der sie stehen ließe', async () => {
    const { db, deps } = aufbau();
    await speichern(deps, { auto: { ...AUTO, symbols: ['AAPL'] } });
    expect((db.get(`users/${UID}`)!.settings as Record<string, Record<string, unknown>>).auto!.symbols).toEqual(['AAPL']);
    await speichern(deps, { auto: { ...AUTO, symbols: [] } });
    const auto = (db.get(`users/${UID}`)!.settings as Record<string, Record<string, unknown>>).auto!;
    expect(auto).not.toHaveProperty('symbols');
    expect(auto).toEqual({ ...AUTO, notifyTelegram: false });
  });

  it('auto und engineRunning zusammen: ein Update, beide Pfade', async () => {
    const { db, deps } = aufbau();
    const out = await speichern(deps, { auto: AUTO, engineRunning: true });
    expect(out).toEqual({ ok: true, auto: { ...AUTO, notifyTelegram: false }, engineRunning: true });
    expect(db.log).toEqual([`update users/${UID}`]);
    expect(db.get(`users/${UID}`)).toMatchObject({ settings: { auto: AUTO, strategy: { engine: { running: true, maxPositionPct: 10 } } } });
  });

  it('ein ungültiges auto verhindert auch das Einschalten — nichts wird halb geschrieben', async () => {
    const { db, deps } = aufbau();
    await expect(speichern(deps, { auto: { ...AUTO, allowShort: 'ja' }, engineRunning: true })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(db.log).toEqual([]);
  });
});

describe('Alt-Payload { strategy } (Übergang)', () => {
  it('übernimmt NUR engine.running; die übrigen Felder bleiben, wie sie gespeichert waren — mit Log-Hinweis', async () => {
    const { db, deps, meldungen } = aufbau();
    const neu = structuredClone(ALT_STRATEGIE);
    neu.engine.running = true;
    neu.engine.maxPositionPct = 99;
    neu.engine.riskPerTradePct = 5;
    neu.watchlist = ['TSLA'];
    const out = await speichern(deps, { strategy: neu });
    expect(out).toEqual({ ok: true, engineRunning: true });
    const gespeichert = (db.get(`users/${UID}`)!.settings as Record<string, unknown>).strategy;
    expect(gespeichert).toEqual({ ...ALT_STRATEGIE, engine: { ...ALT_STRATEGIE.engine, running: true } });
    expect(meldungen).toHaveLength(1);
    expect(String(meldungen[0]![0])).toContain('Alt-Payload');
  });

  it('das Alt-Alt-Schema wird weiterhin hart abgelehnt', async () => {
    const { db, deps } = aufbau();
    await expect(speichern(deps, { strategy: { strategy: { type: 'x' }, engine: { running: true } } })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'val.altSchema|strategy',
    });
    expect(db.log).toEqual([]);
  });

  it('Einschalten über den Alt-Payload läuft durch dieselben Riegel', async () => {
    const { db, deps } = aufbau({ accessLevel: 'pending' });
    const neu = structuredClone(ALT_STRATEGIE);
    neu.engine.running = true;
    await expect(speichern(deps, { strategy: neu })).rejects.toMatchObject({ message: 'srv.freischaltungAbwarten' });
    expect(db.log).toEqual([]);
  });

  it('engineRunning hat Vorrang vor dem Alt-Payload', async () => {
    const { db, deps, meldungen } = aufbau();
    const neu = structuredClone(ALT_STRATEGIE);
    neu.engine.running = true;
    await expect(speichern(deps, { strategy: neu, engineRunning: false })).resolves.toEqual({ ok: true, engineRunning: false });
    expect(db.get(`users/${UID}`)).toMatchObject({ settings: { strategy: { engine: { running: false } } } });
    expect(meldungen).toEqual([]);
  });
});

describe('Plattform-Universum', () => {
  it('liest denselben Pfad wie der Takt', () => {
    expect(ENGINE_CONFIG_PATH).toBe(CONFIG_PATH);
  });

  it('fehlendes Doc oder fehlende Liste ⇒ eingebaute Symbole; sonst das Doc, kanonisch geschrieben', async () => {
    const db = new FakeFirestore();
    expect(await ladePlattformUniversum(db)).toEqual({ assetClass: 'us_equity', symbols: [...DEFAULT_UNIVERSE] });
    db.seed(ENGINE_CONFIG_PATH, { timeframe: 15 });
    expect((await ladePlattformUniversum(db)).symbols).toEqual([...DEFAULT_UNIVERSE]);
    db.seed(ENGINE_CONFIG_PATH, { universe: { assetClass: 'crypto', symbols: ['btcusd', 7, 'ETH/USD'] } });
    expect(await ladePlattformUniversum(db)).toEqual({ assetClass: 'crypto', symbols: ['BTC/USD', 'ETH/USD'] });
  });
});
