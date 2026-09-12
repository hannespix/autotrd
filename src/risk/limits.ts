/**
 * Konto-Sperren: Tages-Notbremse und Drawdown-Halt.
 *
 * Sperren sind Messergebnisse, keine Schalter (CLAUDE.md-Regel des Owners):
 * Die Tages-Notbremse löst sich am nächsten Handelstag von selbst; die
 * Drawdown-Sperre nur über ein bewusstes `resume`, das den Peak neu setzt
 * und im Journal steht.
 *
 * ── Bremsen je Stufe (seit 12.09.2026) ───────────────────────────────────
 *
 * `risk.tiers` gibt der Alpha- und der Basis-Stufe eigene Latten. Gemessen
 * wird weiter am KONTO — es gibt eine Equity, einen Broker und einen
 * Tagesverlust; eine Zerlegung dieses Verlusts auf Stufen wäre eine
 * Zuschreibung, die der Broker nicht bestätigt. Was die Stufe entscheidet,
 * ist die LATTE und die FOLGE: Reißt der Kontoverlust die Latte einer Stufe,
 * werden deren Positionen glattgestellt und deren Einstiege gesperrt — die
 * andere Stufe läuft weiter.
 *
 * Bekannte Eigenschaft, nicht wegdefiniert: Eine Stufe kann für einen
 * Verlust gebremst werden, den die andere verursacht hat. Das ist die
 * vorsichtige Richtung (was dem Konto passiert, gefährdet das Konto), aber
 * es ist keine Zurechnung je Stufe — wer die will, braucht eine Equity-Kurve
 * je Stufe, und die gibt es nicht.
 */
import type { AccountView, HaltState, Ms } from '../core/types.ts';
import type { RiskConfig } from '../core/config.ts';

/**
 * Stufe einer Position oder einer Wahl: Alpha-Champion, Basis-Stufe oder
 * „ohne Stufe" (Fallback-Strategie, adoptierter Bestand, alter State).
 */
export type Stufe = 'alpha' | 'basis' | 'other';

export const STUFEN: readonly Stufe[] = ['alpha', 'basis', 'other'];

/** Die beiden Latten einer Stufe (bzw. des Kontos). */
export interface StufenGrenzen {
  maxDailyLossPct: number;
  maxDrawdownPct: number;
}

/**
 * Quelle der Wahl (`champion` · `basis` · `config`, siehe app.ts /
 * functions/src/engine/strategyFor.ts) bzw. `PositionState.stufe` ⇒ Stufe.
 * Alles Unbekannte ist `other` und bekommt damit die GLOBALEN Werte — ein
 * unbekannter Name darf nie eine gelockerte Stufe erben.
 */
export function stufeOf(quelle: string | undefined | null): Stufe {
  return quelle === 'basis' ? 'basis' : quelle === 'champion' || quelle === 'alpha' ? 'alpha' : 'other';
}

/** Sind überhaupt Stufen-Bremsen konfiguriert? Ohne sie bleibt alles wie bisher (eine Bremse). */
export function stufenBremsenAktiv(risk: RiskConfig): boolean {
  const t = risk.tiers;
  if (!t) return false;
  for (const s of [t.alpha, t.basis]) {
    // `null` (Vorgabe) heißt „globaler Wert" — das ist KEINE Stufen-Latte.
    if (s && (typeof s.maxDailyLossPct === 'number' || typeof s.maxDrawdownPct === 'number')) return true;
  }
  return false;
}

/** Latten einer Stufe: der Wert der Stufe, sonst der globale. `other` ist immer global. */
export function grenzenFuer(risk: RiskConfig, stufe: Stufe): StufenGrenzen {
  const t = stufe === 'alpha' ? risk.tiers?.alpha : stufe === 'basis' ? risk.tiers?.basis : undefined;
  return {
    maxDailyLossPct: t?.maxDailyLossPct ?? risk.maxDailyLossPct,
    maxDrawdownPct: t?.maxDrawdownPct ?? risk.maxDrawdownPct,
  };
  // `??` fängt null UND undefined: Beides heißt „der globale Wert gilt".
}

/**
 * Latten des KONTOS: die lockerste aller Stufen — erst wenn selbst die
 * duldsamste Stufe aufgegeben hätte, steht das ganze Konto still. Ohne
 * `tiers` sind das exakt die globalen Werte (nichts ändert sich).
 *
 * Eine 0 (Bremse der Stufe aus) hebt die Konto-Bremse NIE auf: Sie zählt
 * hier nicht als „lockerster Wert", sonst schaltete eine abgeschaltete Stufe
 * die Sicherung des ganzen Kontos ab.
 */
export function kontoGrenzen(risk: RiskConfig): StufenGrenzen {
  let daily = risk.maxDailyLossPct;
  let dd = risk.maxDrawdownPct;
  for (const s of [risk.tiers?.alpha, risk.tiers?.basis]) {
    if (!s) continue;
    if (typeof s.maxDailyLossPct === 'number' && s.maxDailyLossPct > daily) daily = s.maxDailyLossPct;
    if (typeof s.maxDrawdownPct === 'number' && s.maxDrawdownPct > dd) dd = s.maxDrawdownPct;
  }
  return { maxDailyLossPct: daily, maxDrawdownPct: dd };
}

export interface HaltCheckInput {
  account: AccountView;
  halt: HaltState;
  risk: RiskConfig;
  now: Ms;
  /** ET-Handelstag von `now`. */
  today: string;
  /** Nächster Handelstag nach heute (für das Ende des Tages-Halts). */
  nextDay: string;
  /**
   * Latten dieser Prüfung; fehlen sie, gelten die globalen aus `risk` —
   * dann ist das Verhalten Zeile für Zeile das bisherige. `decide()` gibt
   * die Konto-Latten bzw. die der Stufe.
   */
  grenzen?: StufenGrenzen | undefined;
}

export interface HaltCheckResult {
  halt: HaltState;
  /** true, wenn in diesem Aufruf neu ausgelöst (⇒ alles glattstellen). */
  triggered: boolean;
  /** true, wenn ein Tages-Halt gerade automatisch geendet hat. */
  lifted: boolean;
}

export function dailyLossPct(a: AccountView): number {
  if (!(a.dayStartEquity > 0)) return 0;
  return ((a.equity - a.dayStartEquity) / a.dayStartEquity) * 100;
}

export function drawdownPct(a: AccountView): number {
  if (!(a.peakEquity > 0)) return 0;
  return ((a.peakEquity - a.equity) / a.peakEquity) * 100;
}

export function checkHalt(inp: HaltCheckInput): HaltCheckResult {
  let halt = inp.halt;
  let lifted = false;
  const grenzen = inp.grenzen ?? { maxDailyLossPct: inp.risk.maxDailyLossPct, maxDrawdownPct: inp.risk.maxDrawdownPct };

  // Tages-Halt endet automatisch, sobald der Zieltag erreicht ist.
  if (halt.halted && halt.reason === 'daily_loss' && halt.until && inp.today >= halt.until) {
    halt = { halted: false, reason: null, since: null, until: null, note: `Tages-Halt geendet (${halt.until})` };
    lifted = true;
  }

  // Die Messung läuft IMMER — auch im Halt (HALT-Datei, Abgleich, Fehlerserie). Ein
  // bestehender Halt sperrt nur Einstiege; die Notbremsen müssen weiterhin glattstellen
  // können. Eskaliert wird nur zu einem strengeren Grund (drawdown > daily_loss > Rest).
  const dd = drawdownPct(inp.account);
  if (grenzen.maxDrawdownPct > 0 && dd >= grenzen.maxDrawdownPct && halt.reason !== 'drawdown') {
    return {
      halt: {
        halted: true,
        reason: 'drawdown',
        since: inp.now,
        until: null,
        note: `Drawdown ${dd.toFixed(2)} % ≥ ${grenzen.maxDrawdownPct} % vom Hoch ${inp.account.peakEquity.toFixed(2)} — Halt bis manuelles resume`,
      },
      triggered: true,
      lifted,
    };
  }

  const dl = dailyLossPct(inp.account);
  if (grenzen.maxDailyLossPct > 0 && dl <= -grenzen.maxDailyLossPct && halt.reason !== 'drawdown' && halt.reason !== 'daily_loss') {
    return {
      halt: {
        halted: true,
        reason: 'daily_loss',
        since: inp.now,
        until: inp.nextDay,
        note: `Tagesverlust ${dl.toFixed(2)} % ≤ −${grenzen.maxDailyLossPct} % — alles glatt, Halt bis ${inp.nextDay}`,
      },
      triggered: true,
      lifted,
    };
  }

  return { halt, triggered: false, lifted };
}

/** Manuelles Aufheben (nur drawdown/manual/errors/reconcile) — setzt den Peak auf die aktuelle Equity. */
export function resumeHalt(halt: HaltState, account: AccountView, now: Ms, note: string): { halt: HaltState; account: AccountView } {
  if (!halt.halted) return { halt, account };
  return {
    halt: { halted: false, reason: null, since: null, until: null, note: `resume ${new Date(now).toISOString()}: ${note}` },
    account: { ...account, peakEquity: account.equity },
  };
}
