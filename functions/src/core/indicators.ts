/**
 * Indikator-Fassade für Functions — die reine Mathematik lebt in `shared/`
 * (eine Implementierung für Scan, Backtest und Frontend-Vorschau; Golden-
 * Tests gegen die Python-Referenz in shared/test/indicators.golden.test.ts).
 */
export {
  bollinger,
  ema,
  lastValue,
  macd,
  sma,
  wilderRsi,
  type BollingerResult,
  type MacdResult,
  type Series,
} from '../../../shared/src/indicators.js';
