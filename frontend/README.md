# frontend/ — Oberfläche des Auto-Traders (autotrd.net)

Vite + TypeScript-SPA mit Firebase Auth und Firestore. Sie zeigt, was der
Engine-Takt (`functions/`, `engineTick`: handelt je Minute bei Alpaca) nach
Firestore spiegelt, und schreibt ausschließlich über Callable Functions.
**Keine Handelslogik im Browser** — jede Entscheidung fällt im Kern
(`src/core/logic.ts`), die Oberfläche stellt dar und hinterlegt Kommandos.

## Was drin ist

- **Zugang:** Login/Registrierung/Passwort-Reset/Google, Risiko-Häkchen und
  Risiko-Tor, Rechtstexte (`legal.ts`), Admin-Freischaltung, Nachrichten-Faden.
- **Engine-Karte:** Schalter (`saveStrategy({ engineRunning })`), Spiegel aus
  `users/{uid}.engine` (Modus, Halt, Equity, Tagesstart, Peak/Drawdown,
  Day-Trades/PDT, Positionen, Einstiegssperre, Notizen, Alter des letzten
  Takts), Kommandos Halt/Resume/Flatten über `engineCommand` — Resume bei
  Drawdown-Halt nur mit Bestätigung, Flatten nur mit Bestätigung; ein
  Tages-Halt endet von selbst und ist nicht per Knopf lösbar.
- **Einstellungen des Auto-Traders:** `settings.auto` (Risiko je Trade,
  Positionsdeckel, Positionsanzahl, Tages-Notbremse, Drawdown-Sperre, Shorts,
  Telegram) plus Symbolauswahl aus `meta/engineConfig`; geprüft mit
  `validateAutoSettings` aus `@autotrd/shared`, Klartext über `valText`.
- **Positionen** (bewertet mit `market/{sym}.quote`), **Handelshistorie** mit
  Paging, **Performance** (Cash/Equity/P&L/Equity-Kurve).
- **„Warum handelt die Engine (nicht)?"** aus `engine` + `meta/health.engine`;
  **Champion-Karte** aus `meta/champion` mit Bericht aus `meta/optimizeReports/berichte`.

## `overrides` in der Wurzel-package.json — nicht entfernen

`firebase@11.10.0` hängt fest an `@firebase/app@0.13.2`, seine Teilpakete
(`auth`, `app-check`, `firestore`, `functions`) fordern aber `0.14.4`. Ohne
Auflösung installiert npm BEIDE — zwei Komponenten-Registries im selben
Bundle. Die Teilpakete registrieren sich dann in der einen, `initializeApp()`
liest die andere, und `getAuth()` wirft beim Start
`Component auth has not been registered yet`: weiße Seite, ohne dass ein Test
etwas merkt. Deshalb steht in der Wurzel-package.json
`"overrides": { "@firebase/app": "0.14.4" }`, und
`frontend/test/firebaseEinmal.test.ts` hält genau eine Kopie fest.
- **Optionen:** Broker (Schlüssel, Echtgeld-Schalter, Live-Reife), Konto
  (Abmelden, Steuer-Export, Neu anfangen), Anzeige (Theme, Sprache). Not-Aus, PWA.

Texte laufen über `i18n.ts` (Deutsch ist die Quelle, Englisch mit Fallback),
ⓘ-Erklärungen über `infotips.ts`. Es gibt keine Charts, keine Scans, keine
Prognosen und keinen Handel von Hand mehr.

## Entwickeln und prüfen

- `npm run dev -w frontend` — Dev-Server. Firebase-Web-Config aus
  `frontend/.env.local` (Vorlage `.env.example`); ohne Config rendert ein
  Einrichtungs-Hinweis. `VITE_FIREBASE_USE_EMULATORS=1` läuft gegen die
  lokale Emulator-Suite (`npm run emulators`).
- Aus dem Repo-Root: `npm run typecheck --workspace frontend`,
  `npm run build --workspace frontend`, `npx vitest run frontend/test`,
  `npx eslint --no-ignore frontend/src frontend/test`.
- Browser-Prüfstände (bewusst nicht in der CI, Playwright ohne Speicherung
  installieren): `frontend/e2e/smoke.mjs`, `ui-audit.mjs`, `theme-shot.mjs`,
  `admin-shot.mjs`, `archiv-shot.mjs`, `preview-smoke.mjs`.
- Konventionen: `data-theme` Hell/Dunkel, `prefers-reduced-motion`,
  responsive bis 360 px, Touch-Ziele ≥ 40 px; Tests unter `frontend/test/`
  pinnen Markup und Verträge als Quelltext-Wächter.
- Build (`npm run build --workspace frontend`) → `dist/` → FTPS-Deploy zu
  webgo via `.github/workflows/deploy-frontend.yml`.
