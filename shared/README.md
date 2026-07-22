# shared/ — geteilte Typen & Schema

Von `frontend/` **und** `functions/` importiert — die einzige Wahrheit für:

- `src/strategy.ts` — das **flache** Strategie-Schema
  (`broker/watchlist/engine/indicators/signals`, siehe CLAUDE.md §2) mit
  `DEFAULT_STRATEGY`, plus alle Firestore-Dokument-Typen
  (`Quote/Bar/IndicatorSnapshot/SignalDoc/ForecastDoc/Wallet/Position/Trade`).
- `src/validate.ts` — `validateStrategy()`/`isStrategy()`: lehnt das bekannte
  kaputte verschachtelte Alt-Schema hart ab (Tests in `test/`).

Regeln:
- Schema-Änderungen passieren NUR hier; Frontend/Functions ziehen nach.
- Keine Laufzeit-Abhängigkeiten (kein Firebase-Import) — reine Typen +
  pure Helper, damit beide Seiten es problemlos bundlen.

Verdrahtung (seit M1): Frontend importiert `@autotrd/shared` (Workspace-Link,
Vite bundelt die TS-Quelle direkt); Functions kompilieren `shared/src` per
relativem Import MIT in ihr `lib/` (Details in `functions/README.md`).
