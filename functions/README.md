# functions/ — Firebase Functions der Plattform autotrd.net

Der Handelskern liegt in `src/` im Repo-Wurzelverzeichnis. Dieses Verzeichnis
enthält **keine Handelslogik**, sondern die Adapter, mit denen der Kern als
Firebase-Function läuft: Takt, Firestore-State, Kommandos, Callables.

> **Alles, was Geld bewegt, bleibt in `src/`.** `functions/` importiert den
> Kern relativ (`../../../src/...`) und kopiert ihn nie. Der Kern kennt
> Firestore nicht — er sieht nur `StateStoreLike`/`JournalLike` aus
> `src/core/journal.ts` und injizierte Deps.

## Struktur

```
src/
├── scheduled/engineTick.ts   Takt je Minute (onSchedule '* * * * *', maxInstances 1)
├── engine/
│   ├── tick.ts               Ein Takt: Lease, Kalender, Nutzer, geteilte Bars,
│   │                         Engine je Nutzer (parallel ≤ 3), Health
│   ├── state.ts, journal.ts  Firestore-Adapter für den Kern
│   ├── mirror.ts             Spiegel für das Frontend
│   ├── commands.ts           halt · resume · flatten (Callable engineCommand)
│   ├── config.ts             meta/engineConfig + users/{uid}.settings.auto ⇒ Config
│   ├── sharedData.ts         geteilter Bars-Cache über alle Nutzer eines Takts
│   └── strategyFor.ts        Champion → Basis-Stufe → noTrade (wie src/app.ts)
├── core/                     Key-Tresor (AES-256-GCM), Broker-Zugang,
│                             Echtgeld-Kette, Freischaltung
└── callable/                 Callables des Frontends (saveStrategy validiert
                              settings.auto serverseitig)
```

## Regeln

- **Secrets** nur über Firebase Secret Manager (`defineSecret`): `BROKER_MASTER_KEY`,
  `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` (Plattform-Datenkey). Nutzer-Keys liegen
  verschlüsselt im Key-Tresor und werden nie geloggt.
- **Idempotenz** an der logischen Einheit: Einstiegs-Kennung aus
  (mode, symbol, Bucket-Beginn), Exit-Kennung aus (mode, symbol, entryTime).
  Firestore-Doc-IDs sind fachliche Schlüssel.
- **Exits werden nie gesperrt.** Kill-Switch (`meta/live.killSwitch`) und
  Nutzer-Halt blockieren Einstiege, nie Ausstiege. Stops liegen beim Broker.
- **Ein Entscheidungspfad**: Der Takt ruft dieselbe `decide()` wie Backtest und
  eigener Prozess. Was nur in einer Welt gilt, ist ein Messfehler.

## Bauen und prüfen

```bash
npm run build --workspace functions       # lib/ (shared/src wird mitkompiliert)
npm run typecheck --workspace functions
npm test                                  # Functions-Tests laufen mit (Firestore-Fake)
```

Build-Detail: `tsconfig.json` kompiliert `../shared/src` MIT nach `lib/`
(rootDir = Repo-Wurzel), damit das Deploy-Artefakt self-contained ist —
`shared` deshalb hier per relativem Pfad importieren
(`../../shared/src/index.js`), nicht als npm-Paket.

Betrieb, Einrichtung und Ablauf: `docs/PLATTFORM.md`. Regeln und Fallen:
`CLAUDE.md`.
