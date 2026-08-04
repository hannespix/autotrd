/**
 * Positions-Ansicht — die EINE Rechnung hinter Positionstabelle und Chart
 * (Owner-Wunsch 04.08.: „im Chart sauber sehen, wann man reingegangen ist und
 * wie es sich seither entwickelt hat").
 *
 * Warum pur und geteilt: Die Exit-Abstände in der Tabelle und die Preislinien
 * im Chart MÜSSEN denselben Zahlen entstammen. Zwei Rechnungen driften
 * auseinander, und dann sagt die Tabelle „Stop in 2,1 %", während die Linie
 * woanders liegt — genau die Sorte Widerspruch, die Vertrauen kostet.
 *
 * Die Level-Logik spiegelt die Engine: gespeicherte Level (`stopLoss`,
 * `takeProfit`) haben Vorrang, sonst die klassen-aufgelösten Prozente. Bei
 * ATR-adaptiven Stops kennt nur der Server-Scan die Schwelle — der Client
 * meldet das ehrlich als „adaptiv" statt eine Linie zu erfinden.
 */

import type { Position, RiskConfig } from './strategy.js';

export interface PositionLevels {
  /** Einstandskurs (Bezugslinie). */
  entry: number;
  /** Fester Stop (null = unbekannt/aus). */
  stop: number | null;
  /** Stop läuft ATR-adaptiv — Schwelle kennt nur der Scan. */
  stopAtr: boolean;
  /** Nachziehender Stop, sobald scharf (null = aus oder noch nicht scharf). */
  trail: number | null;
  /** Trailing konfiguriert, aber noch nicht scharf (Position war nie im Gewinn). */
  trailWartet: boolean;
  /** Kursziel (null = unbekannt/aus). */
  target: number | null;
  /** Ziel läuft ATR-adaptiv. */
  targetAtr: boolean;
}

/**
 * Stop-/Trailing-/Ziel-Level einer offenen Position.
 *
 * Bei SHORTS ist alles gespiegelt: Der Stop liegt ÜBER dem Einstand (steigende
 * Kurse tun weh), das Ziel darunter, und der Trailing-Stop zieht am `lowWater`
 * statt am `highWater` nach.
 */
export function positionLevels(p: Position, risk: RiskConfig): PositionLevels {
  const entry = p.avgEntry;
  const short = p.side === 'short';

  const stopAtr = (risk.atrStopMult ?? 0) > 0;
  const stop =
    p.stopLoss ??
    (stopAtr || !(risk.stopLossPct > 0)
      ? null
      : short
        ? entry * (1 + risk.stopLossPct / 100)
        : entry * (1 - risk.stopLossPct / 100));

  const trailPct = risk.trailingStopPct ?? 0;
  // „Scharf" heißt: Die Position war seit Einstieg schon im Gewinn — vorher
  // gäbe es nichts nachzuziehen, und ein Trailing am Einstand wäre ein zweiter
  // Stop, den niemand konfiguriert hat.
  const armed = short ? (p.lowWater ?? entry) < entry : (p.highWater ?? 0) > entry;
  const trail =
    trailPct > 0 && armed
      ? short
        ? (p.lowWater ?? entry) * (1 + trailPct / 100)
        : (p.highWater ?? entry) * (1 - trailPct / 100)
      : null;

  const targetAtr = (risk.atrTakeMult ?? 0) > 0;
  const target =
    p.takeProfit ??
    (targetAtr || !(risk.takeProfitPct > 0)
      ? null
      : short
        ? entry * (1 - risk.takeProfitPct / 100)
        : entry * (1 + risk.takeProfitPct / 100));

  return { entry, stop, stopAtr, trail, trailWartet: trailPct > 0 && !armed, target, targetAtr };
}

/**
 * Abstand des Kurses zu einem Level in Prozent — positiv = Level noch nicht
 * erreicht, ≤ 0 = löst beim nächsten Scan aus. Richtungsabhängig: Beim Long
 * ist der Stop unten, beim Short oben.
 */
export function levelDistPct(
  level: number,
  live: number,
  art: 'stop' | 'target',
  short: boolean,
): number {
  const unten = art === 'stop' ? !short : short;
  return ((unten ? live - level : level - live) / live) * 100;
}

export interface PositionPnl {
  /** Unrealisiert in Kontowährung. */
  pnl: number;
  /** Unrealisiert in Prozent vom Einstand. */
  pct: number;
}

/**
 * Unrealisiertes Ergebnis einer offenen Position. Beim Short gespiegelt: Der
 * Gewinn entsteht am FALLENDEN Kurs.
 */
export function positionPnl(p: Position, live: number): PositionPnl {
  const short = p.side === 'short';
  return {
    pnl: (short ? p.avgEntry - live : live - p.avgEntry) * p.qty,
    pct: p.avgEntry > 0 ? (short ? 1 - live / p.avgEntry : live / p.avgEntry - 1) * 100 : 0,
  };
}

export interface EntryAnchor {
  /** Index des ersten Bars ab dem Einstieg. */
  index: number;
  /**
   * Der Einstieg liegt VOR dem ersten geladenen Bar (z. B. 3-Monats-Fenster,
   * Position fünf Monate alt). Dann darf kein Marker gesetzt werden — er würde
   * einen Einstieg behaupten, der außerhalb des Fensters stattfand.
   */
  vorFenster: boolean;
}

/**
 * Einstiegs-Bar in der aktuellen Zeitachse finden.
 *
 * `times` ist entweder eine Liste von ISO-Tagen (Tages-Sicht) oder von
 * UNIX-Sekunden (Intraday-Sicht) — beide Domänen kommen im Chart vor.
 * Liefert `null`, wenn der Einstieg NACH dem letzten Bar liegt (frisch
 * eröffnet, Kerze noch nicht da): lieber kein Anker als ein falscher.
 */
export function entryAnchor(times: Array<string | number>, openedAt: string): EntryAnchor | null {
  if (times.length === 0) return null;
  const ersteZeit = times[0]!;
  if (typeof ersteZeit === 'number') {
    const ms = Date.parse(openedAt);
    if (!Number.isFinite(ms)) return null;
    const sek = ms / 1000;
    const idx = times.findIndex((t) => (t as number) >= sek);
    if (idx === -1) return null;
    return { index: idx, vorFenster: idx === 0 && (times[0] as number) > sek };
  }
  const tag = openedAt.slice(0, 10);
  if (tag.length < 10) return null;
  const idx = times.findIndex((t) => (t as string) >= tag);
  if (idx === -1) return null;
  return { index: idx, vorFenster: idx === 0 && (times[0] as string) > tag };
}

/** Haltedauer in ganzen Tagen (für „seit 3 Tagen"). */
export function haltedauerTage(openedAt: string, jetzt: number): number {
  const ms = Date.parse(openedAt);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((jetzt - ms) / 86_400_000));
}
