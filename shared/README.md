# shared/ — geteilte Typen & Schema

Von `frontend/` **und** `functions/` importiert — die einzige Wahrheit für:

- `src/strategy.ts` — das **flache** Strategie-Schema
  (`broker/watchlist/engine/indicators/signals`) mit `DEFAULT_STRATEGY`,
  plus alle Firestore-Dokument-Typen (`Wallet/Position/Trade`, …). Die alten
  Handelsparameter haben im Auto-Trader keine Wirkung mehr; das Schema bleibt
  vollständig, weil Altdaten in Firestore liegen und lesbar bleiben müssen.
  Der Engine-Takt liest daraus nur noch `engine.running`.
- `src/autoSettings.ts` — `AutoSettings` (`users/{uid}.settings.auto`): der
  nutzerabhängige Teil der Engine-Config (Risiko je Trade, Deckel,
  Notbremsen, Shorts, optionale Symbol-Teilmenge, Telegram).
  `validateAutoSettings()` prüft mit denselben Grenzen wie das Schema des
  Kerns (`src/core/config.ts`, `risk`); `autoSettingsFromLegacy()` leitet
  aus dem alten `settings.strategy` ab — dieselbe Ableitung wie der Takt.
- `src/validate.ts` — `validateStrategy()`: nur noch die Struktur des
  Alt-Payloads `{ strategy }` (Objekt, kein verschachteltes Alt-Alt-Schema,
  `engine.running` boolean). Meldungen sind Codes `val.<muster>|<feld>|…`.
- Konto und Regeln: `zugang`, `risiko`, `nachrichten`, `brokerBindung`,
  `circuitBreaker`, `liveReadiness`, `kontoAbgleich`.
- Markt: `universe` (Katalog), `marketHours`, `calendar`, `fx`.
- Auswertung (Equity-Snapshot, Historie, Steuer): `portfolio`, `positionView`,
  `tradeAnalytics`, `tradingHealth`, `bestPractice`, `classShadow`,
  `globalLearning`, `classAdvisor`, `erkenntnisse`, `tax`.
- Wächter: `wachhund`.

Was hier fehlt (Prognose, Indikatoren, Regelbaum, Tuner, Schatten-Flotten,
Regime, News, KI-Berichte, Chart-Helfer …), gehörte zum alten Scan und ist mit
ihm gegangen.

Regeln:
- Schema-Änderungen passieren NUR hier; Frontend/Functions ziehen nach.
- Keine Laufzeit-Abhängigkeiten (kein Firebase-Import) — reine Typen +
  pure Helper, damit beide Seiten es problemlos bundlen.
- Tests in `test/` (vitest, Root-Config `vitest.config.ts`).

Verdrahtung: Frontend importiert `@autotrd/shared` (Workspace-Link, Vite
bundelt die TS-Quelle direkt); Functions kompilieren `shared/src` per
relativem Import MIT in ihr `lib/` (Details in `functions/README.md`).
