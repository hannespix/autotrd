/**
 * Konto-Sperren: Tages-Notbremse und Drawdown-Halt.
 *
 * Sperren sind Messergebnisse, keine Schalter (CLAUDE.md-Regel des Owners):
 * Die Tages-Notbremse löst sich am nächsten Handelstag von selbst; die
 * Drawdown-Sperre nur über ein bewusstes `resume`, das den Peak neu setzt
 * und im Journal steht.
 */
import type { AccountView, HaltState, Ms } from '../core/types.ts';
import type { RiskConfig } from '../core/config.ts';

export interface HaltCheckInput {
  account: AccountView;
  halt: HaltState;
  risk: RiskConfig;
  now: Ms;
  /** ET-Handelstag von `now`. */
  today: string;
  /** Nächster Handelstag nach heute (für das Ende des Tages-Halts). */
  nextDay: string;
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

  // Tages-Halt endet automatisch, sobald der Zieltag erreicht ist.
  if (halt.halted && halt.reason === 'daily_loss' && halt.until && inp.today >= halt.until) {
    halt = { halted: false, reason: null, since: null, until: null, note: `Tages-Halt geendet (${halt.until})` };
    lifted = true;
  }

  // Die Messung läuft IMMER — auch im Halt (HALT-Datei, Abgleich, Fehlerserie). Ein
  // bestehender Halt sperrt nur Einstiege; die Notbremsen müssen weiterhin glattstellen
  // können. Eskaliert wird nur zu einem strengeren Grund (drawdown > daily_loss > Rest).
  const dd = drawdownPct(inp.account);
  if (inp.risk.maxDrawdownPct > 0 && dd >= inp.risk.maxDrawdownPct && halt.reason !== 'drawdown') {
    return {
      halt: {
        halted: true,
        reason: 'drawdown',
        since: inp.now,
        until: null,
        note: `Drawdown ${dd.toFixed(2)} % ≥ ${inp.risk.maxDrawdownPct} % vom Hoch ${inp.account.peakEquity.toFixed(2)} — Halt bis manuelles resume`,
      },
      triggered: true,
      lifted,
    };
  }

  const dl = dailyLossPct(inp.account);
  if (inp.risk.maxDailyLossPct > 0 && dl <= -inp.risk.maxDailyLossPct && halt.reason !== 'drawdown' && halt.reason !== 'daily_loss') {
    return {
      halt: {
        halted: true,
        reason: 'daily_loss',
        since: inp.now,
        until: inp.nextDay,
        note: `Tagesverlust ${dl.toFixed(2)} % ≤ −${inp.risk.maxDailyLossPct} % — alles glatt, Halt bis ${inp.nextDay}`,
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
