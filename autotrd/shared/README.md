# shared/ — geteilte Typen & Schema

Von `frontend/` **und** `functions/` importiert — die einzige Wahrheit für:

- `src/strategy.ts` — das **flache** Strategie-Schema
  (`broker/watchlist/engine/indicators/signals`, siehe CLAUDE.md §2) mit
  `DEFAULT_STRATEGY`, plus alle Firestore-Dokument-Typen
  (`Quote/Bar/IndicatorSnapshot/SignalDoc/ForecastDoc/Wallet/Position/Trade`).

Regeln:
- Schema-Änderungen passieren NUR hier; Frontend/Functions ziehen nach.
- Keine Laufzeit-Abhängigkeiten (kein Firebase-Import) — reine Typen +
  pure Helper, damit beide Seiten es problemlos bundlen.
- npm-Workspace-Verdrahtung folgt in M1.
