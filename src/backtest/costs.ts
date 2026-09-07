/**
 * Kostenmodell des Backtests — Slippage, Spread, Gebühren, Leihe.
 *
 * Konvention (gilt für Simulator UND Trade-Buch): Der Fill wird zum
 * REFERENZKURS gebucht (Folge-Open, Stop-Marke, Ziel-Marke); Slippage und
 * halber Spread erscheinen als eigener Kostenposten in `Trade.fees`. So
 * bleibt `grossPnl` ein reiner Kursvergleich, und die Kosten sind als
 * Zahl sichtbar — sonst würde eine Strategie, die nur vom Spread lebt,
 * im Bruttoergebnis unsichtbar bleiben. `slippedPrice` liefert den
 * Kurs, den man effektiv bezahlt; `fillCosts` rechnet denselben Aufschlag
 * in USD um, damit beides nie auseinanderläuft.
 *
 * Der `multiplier` ist der Stressfaktor des Optimierers: Ein Kandidat muss
 * auch bei ×1,5 Kosten bestehen — deshalb skaliert er ALLE Posten, nicht
 * nur die Slippage.
 */
import type { CostConfig } from '../core/config.ts';
import type { AssetClass } from '../core/types.ts';

export interface FillCosts {
  /** Slippage + halber Spread in USD (Marktorder gegen den Spread). */
  slippage: number;
  /** Regulatorische Gebühren (SEC/TAF) bzw. Krypto-Taker-Gebühr in USD. */
  fees: number;
  total: number;
}

export type FillSide = 'buy' | 'sell';

function bpsOf(costs: CostConfig, multiplier: number): number {
  return (costs.slippageBps + costs.spreadBps) * multiplier;
}

/**
 * Kurs inkl. Slippage + halbem Spread (in Basispunkten): Kauf teurer,
 * Verkauf billiger. Gilt für Aktien wie Krypto — bei Alpaca-Krypto ist
 * der Spread eher größer, nicht kleiner.
 */
export function slippedPrice(args: {
  side: FillSide;
  price: number;
  assetClass: AssetClass;
  costs: CostConfig;
  multiplier: number;
}): number {
  const factor = bpsOf(args.costs, args.multiplier) / 10_000;
  return args.side === 'buy' ? args.price * (1 + factor) : args.price * (1 - factor);
}

/** Regulatorische Gebühren einer Seite (ohne Slippage) — für Limit-Fills, die keinen Spread zahlen. */
export function regulatoryFees(args: {
  side: FillSide;
  qty: number;
  price: number;
  assetClass: AssetClass;
  costs: CostConfig;
  multiplier: number;
}): number {
  const notional = args.qty * args.price;
  if (args.assetClass === 'crypto') {
    // Alpaca-Krypto: Taker-Gebühr auf beiden Seiten, Prozent vom Gegenwert.
    return (notional * args.costs.cryptoTakerPct) / 100 * args.multiplier;
  }
  // Aktien: kommissionsfrei; nur Verkäufe tragen SEC-Gebühr (auf den Erlös)
  // und FINRA TAF (je Stück, gedeckelt). Ein Short-Einstieg IST ein Verkauf.
  if (args.side !== 'sell') return 0;
  const sec = notional * args.costs.secFeeRate;
  const taf = Math.min(args.qty * args.costs.finraTafPerShare, args.costs.finraTafMax);
  return (sec + taf) * args.multiplier;
}

/** Kosten eines Marktorder-Fills zum Referenzkurs `price`: Slippage/Spread in USD + Gebühren. */
export function fillCosts(args: {
  side: FillSide;
  qty: number;
  price: number;
  assetClass: AssetClass;
  costs: CostConfig;
  multiplier: number;
}): FillCosts {
  const eff = slippedPrice(args);
  const slippage = args.qty * Math.abs(eff - args.price);
  const fees = regulatoryFees(args);
  return { slippage, fees, total: slippage + fees };
}

/** Leihkosten einer Short-Position für `days` Kalendertage (p. a. in %, taggenau/365). */
export function borrowCost(args: { notional: number; days: number; costs: CostConfig; multiplier: number }): number {
  if (!(args.days > 0) || !(args.notional > 0)) return 0;
  return (Math.abs(args.notional) * (args.costs.shortBorrowAnnualPct / 100) * args.days) / 365 * args.multiplier;
}
