// Barrel von @autotrd/shared — nur noch, was Functions und Frontend des
// Auto-Traders wirklich importieren. Was hier fehlt, gehörte zu Scan,
// Konfluenz, Prognose, KI, Tuner und Schatten-Flotten und ist mit ihnen
// gegangen (siehe shared/README.md).

// Schema (Strategie/Wallet/Position/Trade — Altdaten bleiben lesbar) und
// Einstellungen des Auto-Traders
export * from './strategy.js';
export * from './autoSettings.js';
export * from './validate.js';

// Konto, Zugang, Regeln
export * from './zugang.js';
export * from './risiko.js';
export * from './nachrichten.js';
export * from './brokerBindung.js';
export * from './circuitBreaker.js';
export * from './liveReadiness.js';
export * from './kontoAbgleich.js';

// Markt, Kalender, Katalog
export * from './universe.js';
export * from './marketHours.js';
export * from './calendar.js';
export * from './fx.js';

// Auswertung (Equity-Snapshot, Historie, Steuer)
export * from './portfolio.js';
export * from './positionView.js';
export * from './tradeAnalytics.js';
export * from './tradingHealth.js';
export * from './bestPractice.js';
export * from './classShadow.js';
export * from './globalLearning.js';
export * from './classAdvisor.js';
export * from './erkenntnisse.js';
export * from './tax.js';

// Wächter
export * from './wachhund.js';
