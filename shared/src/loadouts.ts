/**
 * Options-Loadouts (MU4, Owner-Idee 06.08.): vorgefertigte
 * Grundeinstellungen mit Charakter — Titel, augenzwinkernde Beschreibung
 * im Trading-Jargon, und darunter IMMER die ehrliche Risiko-Zeile.
 *
 * Drei Leitplanken (MILESTONES MU4):
 *
 * 1. Ein Loadout setzt STARTWERTE, keine Fesseln. Auto-Tuner,
 *    Klassen-Regler und Handänderungen laufen danach normal weiter —
 *    die Evolution der Einstellungen bleibt ausdrücklich an.
 *
 * 2. Es gibt keine zweite Übernahme-Maschinerie: Ein Loadout ist derselbe
 *    `BewaehrteEinstellungen`-Auszug wie beim Best-Practice-Snapshot (MU3)
 *    und läuft beim Anwenden durch `validateStrategy` + `saveStrategy`.
 *    Watchlist, Kapital, Anbieter und der Start/Stop-Schalter bleiben
 *    IMMER die eigenen.
 *
 * 3. Der Humor verschleiert nie das Risiko: Unter jedem Witz-Titel steht,
 *    was der Regler wirklich tut — und KEIN Loadout verspricht Rendite.
 *    Welche Werte Geld verdienen, weiß heute niemand; genau das misst die
 *    laufende Schatten-Statistik.
 *
 * Einzige Ausnahme von „nur engine/signals/indicators": der HEBEL
 * (broker.leverage). Er gehört zum Charakter eines Loadouts — ein
 * „Boomer-Depot" mit vergessenem 3×-Hebel wäre ein Etikettenschwindel.
 * Deshalb setzt JEDES Loadout den Hebel explizit (fehlend = 1×);
 * Kapital, Anbieter und Modus bleiben unangetastet.
 */

import { uebernehmeEinstellungen, type BewaehrteEinstellungen } from './bestPractice.js';
import {
  DEFAULT_STRATEGY,
  type EngineConfig,
  type SignalsConfig,
  type Strategy,
} from './strategy.js';

export interface Loadout {
  id: string;
  titel: string;
  /** Die augenzwinkernde Zeile — Jargon erlaubt, Lügen nicht. */
  beschreibung: string;
  /** Die ehrliche Risiko-Charakterisierung. Steht in der UI IMMER dabei. */
  risiko: string;
  einstellungen: BewaehrteEinstellungen;
  /** broker.leverage nach Übernahme; fehlend = 1 (kein Hebel). */
  hebel?: number;
}

/** Ein Loadout aus der Werkseinstellung + gezielten Abweichungen bauen. */
function bauEinstellungen(aend: {
  engine?: Partial<EngineConfig>;
  signals?: Partial<SignalsConfig>;
}): BewaehrteEinstellungen {
  const { running: _running, ...engineOhneRunning } = {
    ...DEFAULT_STRATEGY.engine,
    ...(aend.engine ?? {}),
  };
  return {
    engine: engineOhneRunning as Record<string, unknown>,
    signals: { ...DEFAULT_STRATEGY.signals, ...(aend.signals ?? {}) } as unknown as Record<
      string,
      unknown
    >,
    indicators: { ...DEFAULT_STRATEGY.indicators } as unknown as Record<string, unknown>,
  };
}

/**
 * Die eingebauten Loadouts. Reihenfolge = Anzeige-Reihenfolge, vom
 * ruhigsten zum wildesten — wer nur klickt, ohne zu lesen, landet damit
 * eher zu vorsichtig als zu heiß.
 */
export const LOADOUTS: readonly Loadout[] = [
  {
    id: 'boomer',
    titel: 'Boomer-Depot',
    beschreibung:
      'Buy & Hold mit Sicherheitsgurt: handelt selten, hält lange, schläft ' +
      'nachts. Diamond Hands, aber mit Stop-Loss — dein Depot-Onkel nickt ' +
      'anerkennend.',
    risiko:
      'Niedrig: 60 % ruhiger Momentum-Sockel, kein Hebel, keine Shorts, enge ' +
      'Tages-Notbremse (3 %). Langweilig ist hier Absicht.',
    einstellungen: bauEinstellungen({
      engine: {
        corePct: 60,
        maxPositionPct: 8,
        maxOpenPositions: 6,
        cooldownMin: 240,
        minHoldMin: 240,
        dailyLossLimitPct: 3,
      },
      signals: { minConfluence: 3, timeframe: 'daily' },
    }),
  },
  {
    id: 'sparfuchs',
    titel: 'Gebühren-Sparfuchs',
    beschreibung:
      'Der einzige Edge, den unsere eigene Messung bisher BEWIESEN hat: ' +
      'weniger Reibung bezahlen. Handelt nur, wenn die erwartete Bewegung ' +
      'die Kosten deutlich schlägt — no fee, no cry.',
    risiko:
      'Niedrig bis mittel: bewusst wenige Trades, strenge Kostenschwelle. ' +
      'Der Preis sind verpasste Chancen statt bezahlter Gebühren.',
    einstellungen: bauEinstellungen({
      engine: { cooldownMin: 180, minHoldMin: 180, maxOpenPositions: 8 },
      signals: { minEdgeMultiple: 5, exitConfluence: 3, timeframe: 'daily' },
    }),
  },
  {
    id: 'werk',
    titel: 'Werkseinstellung',
    beschreibung:
      'Wie vom Band: die ausgewogene Voreinstellung jedes neuen Kontos. ' +
      'Tageskerzen, Kostenschwelle an, Sockel läuft mit — der Referenzpunkt, ' +
      'zu dem man immer zurück kann.',
    risiko: 'Mittel: kein Hebel, keine Shorts, Tages-Notbremse 5 %.',
    einstellungen: bauEinstellungen({}),
  },
  {
    id: 'daytrader',
    titel: 'Daytrader-Deluxe',
    beschreibung:
      '5-Minuten-Kerzen, kurze Pausen, viele Signale — Tape-Reading-Vibes ' +
      'wie am Sechs-Monitor-Setup. Der Spread isst bei jedem Trade mit.',
    risiko:
      'Hoch: hohe Frequenz heißt hohe Gebührenlast — genau daran ist in ' +
      'unserer Messung schon ein Testkonto gescheitert (Gebühren 4,7× des ' +
      'Brutto-Ergebnisses). Tages-Notbremse bleibt an (5 %).',
    einstellungen: bauEinstellungen({
      engine: { cooldownMin: 15, minHoldMin: 30, maxOpenPositions: 15, maxPositionPct: 8 },
      signals: { timeframe: 'intraday' },
    }),
  },
  {
    id: 'yolo',
    titel: 'YOLO-Vollgas',
    beschreibung:
      'Hebel drauf, Shorts frei, größere Tranchen — full send. Wer nicht ' +
      'regelmäßig aufs Depot schauen kann, lässt die Finger davon.',
    risiko:
      'SEHR HOCH: 3×-Hebel vervielfacht Verluste bis zur Nachschuss-Situation ' +
      '(Margin-Call), Shorts können theoretisch unbegrenzt verlieren. Nur mit ' +
      'Kapital, dessen Totalverlust verkraftbar ist.',
    einstellungen: bauEinstellungen({
      engine: { maxPositionPct: 15, riskPerTradePct: 1, dailyLossLimitPct: 8 },
      signals: { allowShort: true },
    }),
    hebel: 3,
  },
];

/**
 * Loadout anwenden — MU3-Übernahme plus expliziter Hebel.
 *
 * Der Hebel wird IMMER gesetzt (fehlend = 1): Ein Charakter-Wechsel, der
 * einen alten 3×-Hebel stehen ließe, würde genau das Risiko verstecken,
 * das die Risiko-Zeile des neuen Loadouts verneint. Kapital, Anbieter,
 * Modus, Watchlist und der Start/Stop-Schalter bleiben die eigenen.
 */
export function wendeLoadoutAn(
  eigene: Strategy,
  loadout: Pick<Loadout, 'einstellungen' | 'hebel'>,
): Strategy {
  const neu = uebernehmeEinstellungen(eigene, loadout.einstellungen);
  return { ...neu, broker: { ...neu.broker, leverage: loadout.hebel ?? 1 } };
}
