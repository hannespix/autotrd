# autotrd — Alpaca-Auto-Trader (Neubau)

Ein Handelskern, der bei **Alpaca** handelt: Entscheidungen aus
parametrisierten Strategie-Vorlagen, Stops beim Broker (Bracket-Orders),
nächtliche Walk-Forward-Selbstoptimierung mit strengen Gates. Derselbe Kern
läuft in zwei Betriebsarten:

| Betriebsart | Wo | Für wen |
|---|---|---|
| **Plattform** (Standard) | Firebase-Function `engineTick` je Minute, Firestore als State, Login und Keys wie bisher auf autotrd.net, Optimierer nächtlich in GitHub Actions — keine Serverkosten | alle freigeschalteten Nutzer (`docs/PLATTFORM.md`) |
| **Eigener Prozess** | `node src/cli.ts run` mit WebSocket-Streams, State als Dateien | Entwicklung, Backtests, Optimierer-Läufe, ein einzelner Betreiber (`docs/BETRIEB.md`) |

Keine Charts, keine News, keine Prognose, keine KI-Erklärung — nur das, was
zum Handeln, Absichern und Messen nötig ist.

> ⚠️ **Kein Finanzrat. Kein Verfahren garantiert Gewinn.** Default ist das
> Paper-Konto. Echtgeld braucht drei Bedingungen gleichzeitig
> (`broker.mode: live`, `ALPACA_ALLOW_LIVE=1`, Live-Key `AK…`) und sollte erst
> nach erfüllter Live-Reife (`autotrd readiness`) eingeschaltet werden.

> **Zu diesem Branch:** Er ist der komplette Neustart der Handelslogik. Die
> bisherige Plattform bleibt unverändert auf `main`. Hier sind `functions/`,
> `frontend/` und `shared/` auf den neuen Kern umgebaut (Login, Key-Tresor,
> Nutzerverwaltung und Deploy-Pipelines bleiben); die alte Signal-Engine mit
> Scan, Prognose, News und KI ist entfernt. Reste ohne Funktion (`reference/`,
> `supabase/`, `rules-test/`, `ARCHITECTURE.md`, `MILESTONES.md`) werden nach
> Freigabe des Owners in einem eigenen Commit gelöscht. Was aus dem Vorgänger
> gelernt wurde, steht in `docs/ARCHITEKTUR.md`.

## Was es tut

| Schritt | Werkzeug |
|---|---|
| Marktdaten laden (1-Min- oder Tagesbars) und lokal auf den Strategie-Zeitrahmen aggregieren | `autotrd fetch` |
| Strategie gegen die Historie simulieren — mit **demselben** Entscheidungspfad wie live | `autotrd backtest` |
| Walk-Forward-Optimierung je Symbol × Strategie, Robustheits-Gates, Champion-Datei | `autotrd optimize` |
| Handeln: Streaming-Bars → Entscheidung → Bracket-Order (Stop + Ziel beim Broker) → Abgleich | `autotrd run` |
| Prüfen, überwachen, stoppen | `autotrd doctor`, `status`, `halt`, `resume`, `flatten`, `readiness` |
| Erklären, was die Engine je Symbol tut und warum (Klasse, Trend, Rang, Vol, Stop, Taktik, Haltedauer) — Anzeige, kein Handel | `autotrd profile` (läuft am Ende von `optimize` mit) |

Die Strategie-Vorlagen: `trend_donchian` (Ausbruch + ATR-Trailing),
`momentum_pullback` (Trend + RSI-Rücksetzer), `mean_reversion` (RSI/z-Score
im Aufwärtstrend), `orb_breakout` (Opening-Range, intraday, EOD-Flatten).
Welche Vorlage mit welchen Parametern ein Symbol handelt, entscheidet der
Optimierer — oder er entscheidet **„nicht handeln"** (`noTrade`), wenn kein
Kandidat die Gates besteht.

## Schnellstart

```bash
# Voraussetzung: Node ≥ 22.18 (führt TypeScript direkt aus)
npm ci
cp .env.example .env                  # Paper-Keys (PK…) eintragen
cp config/config.example.yaml config/config.yaml

npm run check                          # typecheck + lint + Tests
node src/cli.ts doctor                 # Keys, Modus, Konto, Uhr, Assets, Cache
node src/cli.ts fetch                  # Kalender + Bars (optimizer.lookbackDays)
node src/cli.ts optimize               # ⇒ var/champion.json + var/reports/optimize-*.md
node src/cli.ts backtest               # Champion gegen den Cache
node src/cli.ts profile                # ⇒ var/profile.json — Symbolprofil (Anzeige, kein Handel)
node src/cli.ts run                    # Engine (Paper)
```

Produktiv als eigener Prozess: `npm run build` und `node dist/cli.js …`, als
systemd-Dienst oder Container (siehe `ops/`).

## Betrieb als Plattform (autotrd.net)

Der Handelskern läuft für alle freigeschalteten Nutzer als Firebase-Function
je Minute (`functions/src/scheduled/engineTick.ts`): Lease, Kalender, ein
gemeinsamer Marktdaten-Abruf, dann je Nutzer Engine bauen, abgleichen,
entscheiden, Orders senden, Journal und Spiegel nach Firestore schreiben.
Stops liegen beim Broker, deshalb reicht der Minutentakt. Der nächtliche
Optimierer läuft in GitHub Actions (`.github/workflows/optimize.yml`) und
veröffentlicht den Champion nach `meta/champion`; ohne Champion handelt
niemand. Nutzer stellen im Frontend nur Risiko und Grenzen ein
(`settings.auto`), Strategie und Parameter entscheidet der Champion für alle.
Einrichtung, Ablauf und Betriebsregeln: `docs/PLATTFORM.md`.

## Sicherheitsregeln (nicht verhandelbar)

- **Echtgeld-Doppel-Guard** — fehlt eine der drei Bedingungen, läuft alles
  gegen Paper. Ein Live-Key gegen Paper wird abgelehnt.
- **Stops liegen beim Broker.** Jeder Einstieg ist eine Bracket-Order; der
  Abgleich setzt fehlende Schutz-Stops nach. Stirbt der Prozess, bleiben die
  Stops.
- **Exits werden nie gesperrt.** Halt, PDT, Datenalter und Positionslimit
  blockieren nur Einstiege.
- **Tages-Notbremse und Drawdown-Halt** stellen glatt; der Tages-Halt endet
  von selbst am nächsten Handelstag, der Drawdown-Halt nur über
  `autotrd resume --ack-drawdown`.
- **Not-Aus**: `autotrd halt` (keine Einstiege) oder `autotrd flatten --yes`
  (alles schließen). Beides setzt die Datei `HALT` im State-Verzeichnis, die
  die laufende Engine jede Sekunde prüft.
- **PDT-Regel** unter 25 000 $ Equity ist ein Gate, keine Anzeige.
- **Keys** stehen nur in `.env`, werden nie geloggt (Schwärzung).

## Validierung

`docs/VALIDIERUNG.md` beschreibt das Protokoll: rollierendes Walk-Forward mit
Embargo und unangetastetem Holdout, Kosten inklusive Stress ×1,5, Gates
(Mindest-Trades, Fold-Anteil, Stress, Nachbarschafts-Plateau, Probabilistic
Sharpe ≥ 0,9 auf der OOS-Kette, Gebührenanteil ≤ 0,5; Deflated Sharpe
informativ), Champion/Challenger mit Marge. Backtest und
Live rechnen über `src/core/logic.ts` — dieselbe Funktion.

## Repo-Layout

```
src/core       Typen, Config (zod), ET-Zeit/DST, Bars, Session, Entscheidungspfad, Journal
src/risk       Sizing auf Equity, Tages-/Drawdown-Halt, PDT
src/alpaca     REST-Client, WebSocket-Streams, Symbol-Mapping
src/data       Bars-Cache, Backfill, Kalender
src/strategy   Indikatoren (kausal) + Vorlagen
src/backtest   Portfolio-Simulator, Kosten, Metriken (Sharpe/Sortino/PSR/DSR)
src/optimize   Walk-Forward, Gates, Champion/Challenger, Report
src/engine     Buch, Orders, Abgleich, Uhr, Schleife
src/notify     Telegram · src/status Status-HTTP (127.0.0.1) · src/readiness.ts Live-Reife
src/cli.ts     Kommandos · config/ Vorlage + platform.yaml · ops/ Docker+systemd · docs/ Architektur, Validierung, Betrieb, Plattform
test/          vitest (keine Netzwerkzugriffe, keine Keys)
functions/     Firebase: engineTick (Takt je Minute), Firestore-Adapter, engineCommand, Login/Keys/Admin wie bisher
frontend/      Vite-Frontend: Login, Broker-Keys, Auto-Trader-Einstellungen, Positionen, Historie, Champion, Status
shared/        Von functions und frontend geteilte Typen/Validierung (settings.auto)
scripts/       publish-champion, sync-engine-config (Optimierer-Workflow → Firestore)
```

Für Claude Code und Mitwirkende: **`CLAUDE.md`** (Regeln, Fallen, Arbeitsweise).

## Lizenz / Haftung

Privates Projekt, alle Rechte vorbehalten. Bereitgestellt „wie besehen", ohne
Gewähr. Handel mit Finanzinstrumenten ist mit Verlustrisiko verbunden.
