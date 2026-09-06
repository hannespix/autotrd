# BETRIEB.md — Tagesablauf, Kommandos, Störungen

Für den, der den Dienst fährt. Installation und systemd stehen in
[ops/README.md](../ops/README.md), das Warum in
[ARCHITEKTUR.md](ARCHITEKTUR.md), die Regeln für Strategien in
[VALIDIERUNG.md](VALIDIERUNG.md). Alle Zeiten in ET (America/New_York),
sofern nicht anders angegeben.

## 1. Tagesablauf

| Zeit (ET) | Was passiert |
|---|---|
| durchgehend | Die Engine (`autotrd run`) läuft als Dienst. Außerhalb der Sitzung hält sie die Streams, gleicht alle `engine.reconcileEverySec` (60 s) Buch und Broker ab, schreibt `state.json` und wartet. |
| vor 09:30 | Broker-Kalender prüfen (Feiertag? Frühschluss 13:00?), `dayStartEquity` setzen — die Basis der Tages-Notbremse (`risk.maxDailyLossPct`). Ein Tages-Halt vom Vortag endet jetzt von selbst. |
| 09:30–16:00 | Je geschlossener Bar im Strategie-Zeitrahmen (`timeframe`, Default 5 min, plus `engine.barGraceSec` Karenz): Snapshot bauen → `decide()` → Orders. Keine Einstiege in den ersten `session.noEntryFirstMin` (5) und letzten `session.noEntryLastMin` (30) Minuten. Intraday-Strategien werden `session.flattenBeforeCloseMin` (5) vor Schluss glattgestellt. |
| nach 16:00 | Keine Entscheidungen mehr. Übernacht-Positionen bleiben mit ihrem Broker-Stop liegen. |
| nachts (Werktage) | Optimierer: `autotrd fetch` (Bars + Kalender inkrementell in den Cache) und `autotrd optimize` (Walk-Forward über alle Strategien, Bericht nach `reports/`, ggf. neues `champion.json`). Danach den Dienst neu starten, damit die Engine den Champion liest — außerhalb der Sitzung ist das gefahrlos (§6). |
| Wochenende | Nichts zu tun. Krypto (`assetClass: crypto`) handelt durchgehend in UTC-Tagen; die Sitzungs-Tore gelten dort nicht. |

Beispiel-Cron für den Optimierer (23:30 UTC = 18:30 EST / 19:30 EDT, Mo–Fr,
mit dem Wrapper aus ops/README.md):

```
30 23 * * 1-5  /usr/local/bin/autotrd fetch && /usr/local/bin/autotrd optimize && systemctl restart autotrd
```

## 2. Kommandos

`autotrd <kommando> [--config <pfad>] [--env <pfad>] [--home <pfad>] [--verbose] [--json]`
(Defaults: `config/config.yaml`, `.env`, State aus `AUTOTRD_HOME` bzw. `paths.home`).

| Kommando | Absicht |
|---|---|
| `doctor` | Alles prüfen, was den Start scheitern lässt: Config gegen das Schema, Key-Präfix gegen den Modus (PK ↔ Paper, AK ↔ Live), aufgelöster Modus mit Gründen, Konto erreichbar/nicht blockiert, Uhr, Kalender, Assets handelbar, Cache vorhanden, Champion vorhanden. Erst wenn `doctor` grün ist, den Dienst starten. |
| `fetch` | 1-Minuten-Bars (und Tagesbars) aller Symbole plus Benchmark inkrementell in den Cache laden; Broker-Kalender aktualisieren. `--days <n>` für die Tiefe. |
| `backtest` | Champion oder `strategy.id`/`--strategy` mit `--params` über den Cache simulieren; Metriken und Trades ausgeben. `--stress <faktor>` multipliziert die Kosten, `--from/--to` grenzen ein. Ein Werkzeug zum Nachrechnen — **kein** Auswahlverfahren (dafür `optimize`). |
| `optimize` | Walk-Forward nach VALIDIERUNG.md: Suche, Gates, Champion/Challenger. Schreibt den Bericht nach `reports/` und nur bei bestandener Beförderung ein neues `champion.json`. „Kein Champion" ist ein gültiges Ergebnis. |
| `run` | Die Engine: Streams verbinden, Buch abgleichen, Bars schließen, entscheiden, Orders routen. Läuft, bis SIGINT/SIGTERM kommt. Startet nicht, wenn kein Symbol handelbar ist (kein Champion, `allowWithoutChampion: false`). |
| `status` | Zustand aus `state.json` und Journal (Engine aktiv?, Halt, Positionen, Tages- und Gesamt-Netto) und — wenn Keys da sind — Konto und Broker-Positionen. `--json` für Skripte. Braucht keine laufende Engine. |
| `flatten` | Not-Aus: alle offenen Orders stornieren, alle Positionen per Marktorder schließen, HALT-Datei setzen. Fragt nach, außer mit `--yes`. |
| `halt` | HALT-Datei setzen (`--reason <text>` als Notiz): keine neuen Einstiege; Exits, Stops, EOD-Flatten und die Notbremsen laufen weiter. |
| `resume` | HALT-Datei entfernen. Einen Drawdown-Halt hebt nur `--ack-drawdown` auf: Die CLI setzt dazu einen RESUME-Marker im State-Verzeichnis, den die Engine beim nächsten Tick bzw. Start verarbeitet — Peak = aktuelle Equity, Journal-Eintrag `resume`. Tages-Halts enden von selbst und lassen sich nicht vorzeitig aufheben. |
| `readiness` | Live-Reife aus dem Journal (VALIDIERUNG.md §8): fünf Kriterien, Ergebnis ERREICHT / NICHT ERREICHT, `--json` für Skripte. |

## 3. Wo was liegt (`AUTOTRD_HOME`, Default `./var`)

| Datei | Inhalt |
|---|---|
| `state.json` | Snapshot der Engine für Neustart und `status` (§4). Atomar geschrieben (temp + rename). |
| `journal.jsonl` | Append-only, eine JSON-Zeile je Ereignis — die Wahrheit über das, was die Engine getan hat. Wird nie umgeschrieben. |
| `champion.json` | Aktive Strategie + Parameter aus `optimize`, mit OOS-Kennzahl und Zeitstempel der Beförderung. |
| `bars/` | Cache der 1-Minuten-/Tagesbars je Symbol. |
| `calendar.json` | Broker-Kalender (Handelstage, Öffnungs-/Schlusszeiten). |
| `reports/` | Optimierer-Berichte (Markdown) je Lauf. |
| `HALT` | Existiert ⇒ keine neuen Einstiege. Inhalt: Grund und Zeit. |

## 4. State und Journal im Detail

**`state.json`** (`EngineState`, `src/core/journal.ts`):

```jsonc
{
  "version": 1, "mode": "paper", "updatedAt": 1757155200000,
  "day": "2026-09-05", "dayStartEquity": 100000, "peakEquity": 101250.5,
  "halt": { "halted": false, "reason": null, "since": null, "until": null, "note": null },
  "positions": { "AAPL": { "side": "long", "qty": 12, "entryPrice": 231.4, "stop": 229.1, "target": 236.0, "initialStop": 229.1,
                           "highWater": 232.8, "strategy": "trend_donchian", "barsHeld": 7, "entryDay": "2026-09-05", "…": "…" } },
  "pendingEntries": { "MSFT": "atd-…" },     // Symbol → client_order_id der offenen Einstiegs-Order
  "protectiveOrders": { "AAPL": "atd-…" },   // Symbol → client_order_id des Schutz-Stops beim Broker
  "consecutiveErrors": 0,
  "dayTrades": { "2026-09-04": 1 },          // lokal gezählte Daytrades je ET-Tag
  "lastBarAt": { "AAPL": 1757154900000 }
}
```

`updatedAt` ist der Herzschlag: `status` meldet „läuft", wenn der State
jünger als 30 s ist. Ein Halt hat einen Grund (`daily_loss`, `drawdown`,
`manual`, `errors`, `reconcile`), einen Beginn und bei `daily_loss` den Tag,
an dem er endet.

**`journal.jsonl`** — jede Zeile `{ "ts": <ms>, "kind": "<art>", … }`:

| `kind` | Wann |
|---|---|
| `start` / `stop` | Engine-Lebenszyklus, mit Modus, Symbolen, Champion. |
| `decision` | Ergebnis von `decide()` je Bar: Notizen (blockiert, warum), Intents. |
| `intent` | Ein `OrderIntent`, bevor er zum Broker geht. |
| `order_submitted` / `order_update` | Order beim Broker angenommen; Statuswechsel aus dem Trade-Stream. |
| `fill` | Ausführung (Preis, Menge, Zeit, Ausführungs-ID). |
| `trade_closed` | Abgeschlossener Trade: `trade` ist ein `Trade` (Symbol, Seite, Menge, Einstieg/Ausstieg, `grossPnl`, `fees`, `netPnl`, `rMultiple`, `exitReason`, `barsHeld`, MAE/MFE). Grundlage für `readiness` und `status`. |
| `halt` / `resume` | Sperre ausgelöst bzw. aufgehoben, mit Grund und Note. |
| `reconcile` | Ergebnis eines Abgleichs: Drift, fremde Positionen, nachgebuchte Fills. |
| `error` | Fehler mit geschwärzter Meldung; zählt für `maxConsecutiveErrors`. |
| `notify` | Was an den Notifier ging (Level, Text). |
| `champion` | Champion geladen/gewechselt. |
| `note` | Alles andere Erwähnenswerte. |

Auswertung ohne Werkzeug: `jq -c 'select(.kind=="trade_closed") | .trade | {symbol, netPnl, exitReason}' journal.jsonl`.

## 5. Telegram

1. Bot bei `@BotFather` anlegen → Token (`123456789:AAF…`).
2. Dem Bot eine Nachricht schicken, dann
   `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[0].message.chat.id'` → Chat-ID.
3. `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` in `.env`, `notify.telegram: true` in der Config, Dienst neu starten. Das Log meldet „Telegram-Benachrichtigung aktiv"; fehlt eines der beiden, kommt einmal die Warnung „…fehlen — Benachrichtigungen nur im Log" und alles bleibt im Log.

Was kommt: ℹ️ Start/Stop, Fills, geschlossene Trades, Champion-Wechsel ·
⚠️ Halts (Tagesverlust, Drawdown, Fehlerserie), Abgleich-Drift, Daten nicht
frisch, Stream-Abriss · 🚨 Order abgelehnt, Fehlerserie erreicht, Engine
stoppt ungeplant.

Verhalten: höchstens 20 Nachrichten je Minute — der Rest wird gezählt und
als „… und N weitere" nachgereicht. Ein Fehler beim Senden wird geloggt und
stört den Handel nicht; der Token erscheint nie im Log. Jede Benachrichtigung
steht unabhängig von Telegram im Log (`"channel":"notify"`).

## 6. Not-Aus

Reihenfolge, wenn es schnell gehen muss:

1. `autotrd flatten --yes` — storniert alle Orders, schließt alle Positionen,
   setzt HALT. Dauert Sekunden.
2. Im Alpaca-Dashboard prüfen: keine Positionen, keine offenen Orders. Das
   Dashboard ist die letzte Instanz („Close All Positions"), falls die CLI
   nicht antwortet.
3. `sudo systemctl stop autotrd`, wenn der Prozess selbst das Problem ist.

Wenn nur keine **neuen** Einstiege mehr kommen sollen (Positionen sollen
normal auslaufen): `autotrd halt` oder `touch $AUTOTRD_HOME/HALT`. Die Datei
wirkt in jedem Zyklus, auch wenn die CLI kaputt ist. Aufheben: `autotrd
resume` bzw. Datei löschen.

Automatische Sperren löst man über die Ursache: Tagesverlust endet am
nächsten Handelstag; Drawdown, Fehlerserie und Abgleich nur über `resume`
(Drawdown mit `--ack-drawdown`), nachdem man verstanden hat, was passiert
ist. Es gibt keinen Schalter, der eine Sperre ignoriert — absichtlich.

## 7. Neustart-Verhalten

- **Positionen bleiben, Stops liegen beim Broker.** Ein Stopp, Absturz oder
  Update lässt keine Position ungeschützt: Der Schutz-Stop ist ein Bein der
  Bracket-Order und wirkt ohne den Prozess.
- **Beim Start:** `state.json` laden, Buch gegen Broker abgleichen.
  Positionen werden über das Symbol, Schutz-Stops und offene Einstiege über
  ihre `client_order_id` wiedergefunden — Neustarts erzeugen keine doppelten
  Orders. Während der Abwesenheit beim Broker geschlossene Positionen
  werden nachgebucht: Ist der Fill des Stop-/Ziel-Beins per REST auffindbar,
  mit `exitReason: "stop"`/`"target"` zum echten Fill-Kurs; ist die Position
  ohne auffindbaren Fill verschwunden, mit `exitReason: "reconcile"` zum
  geschätzten Kurs (laut im Log).
- **Fremde Positionen** (im Alpaca-Dashboard von Hand eröffnet, nicht im
  Buch): `engine.onOrphan: halt` (Default) ⇒ Halt `reconcile`, keine
  Einstiege, bis die Position weg ist oder `adopt` konfiguriert wird
  (Übernahme mit Schutz-Stop).
- **Sperren überleben den Neustart:** HALT-Datei, Tages-Halt (bis zum
  Zieltag), Drawdown-Halt (bis `resume --ack-drawdown`).
- **Bars:** Nach dem Start werden fehlende Minuten seit der letzten
  bekannten Bar nachgeladen, bevor entschieden wird; bis dahin gilt „Daten
  nicht frisch" (nur Exits).

## 8. Update

Kurz (Details ops/README.md §6): `systemctl stop` → `git pull --ff-only` →
`npm ci && npm run build && npm prune --omit=dev` → `autotrd doctor` →
`systemctl start` → `journalctl -u autotrd -n 50`. Vorher
`tar czf` über `AUTOTRD_HOME`. Am besten nach 16:00 ET; nötig ist das nicht,
weil der Start reconciliert.

## 9. Typische Fehler

| Symptom | Ursache / Abhilfe |
|---|---|
| `PDT: 3/3 Daytrades im 5-Tage-Fenster verbraucht` blockiert Einstiege | Equity < 25 000 $ und drei Daytrades in fünf Handelstagen. Warten, bis das Fenster rollt, oder Equity erhöhen. `risk.pdt.respect: false` **nicht** setzen: Der vierte Daytrade markiert das Konto als PDT und Alpaca sperrt es für 90 Tage. |
| `Daten nicht frisch` bei liquiden Symbolen | Stream abgerissen oder Uhr falsch. `journalctl` nach `disconnected`/`error` durchsuchen; `timedatectl` prüfen. Die Engine verbindet neu; Exits laufen währenddessen weiter. |
| Einzelne Symbole haben Lücken, wenige Bars je Tag | `broker.feed: iex` sieht nur die IEX-Börse (wenige Prozent des Volumens). Nur liquide Symbole handeln oder auf `sip` wechseln (Alpaca-Datenabo) — **dann auch den Cache neu laden**, sonst misst der Backtest einen anderen Feed als die Engine. |
| `Live-Key (AK…) konfiguriert, aber Betrieb wäre Paper` | Doppel-Guard: `broker.mode` ist `paper` oder `ALPACA_ALLOW_LIVE` ≠ 1. Gewollt Paper ⇒ Paper-Keys (`PK…`) eintragen. Gewollt Live ⇒ alle drei Bedingungen erfüllen — nach bestandener `readiness`. |
| Alpaca antwortet 401/403 | Key-Paar passt nicht zum Endpunkt (Paper-Key gegen Live-API oder umgekehrt), Key widerrufen, oder Konto blockiert (`doctor` zeigt `tradingBlocked`). |
| `Key-Präfix unbekannt (weder PK noch AK)` | Tippfehler oder alter Key-Typ. Wird als Paper behandelt; besser neuen Paper-Key erzeugen. |
| `Kein Symbol handelbar: kein Champion` | Noch kein bestandener `optimize`-Lauf. Erst `fetch`, dann `optimize`; Bericht lesen. Ohne Champion nicht handeln — das ist die Regel, nicht der Fehler. Nur für Paper-Erkundung: `strategy.allowWithoutChampion: true`. |
| Halt `errors` | `engine.maxConsecutiveErrors` (5) Fehler in Folge — Netz, Broker-Störung, abgelehnte Orders. Log lesen, Ursache beheben, `autotrd resume`. |
| Halt `reconcile` / Drift | Position oder Order beim Broker, die das Buch nicht kennt (Hand-Trade im Dashboard, anderer Prozess). Dort schließen oder `engine.onOrphan: adopt`. Der Halt fällt beim nächsten Abgleich von selbst, wenn die Drift weg ist. |
| Halt `drawdown` | Equity ≥ `risk.maxDrawdownPct` unter dem Hoch. Erst verstehen (Journal), dann `resume --ack-drawdown` — setzt den Peak auf die aktuelle Equity. |
| `Status-Endpunkt konnte nicht starten … EADDRINUSE` | Port `status.httpPort` belegt (zweite Instanz?). Die Engine läuft weiter, nur `/status` fehlt. `ss -ltnp | grep 8787`. |
| Bars schließen zur falschen Minute, EOD-Flatten zu früh/spät | Systemuhr driftet. NTP aktivieren. Frühschluss-Tage (13:00) kennt die Engine nur mit Broker-Kalender (`fetch`) oder über den eingebauten NYSE-Fallback. |
| Order abgelehnt: `insufficient qty`, `wash trade`, `qty must be integer` | Bruchstücke bei Aktien (Bracket braucht ganze Stücke — Sizing rundet ab), Gegenorder im selben Symbol, oder Konto zu klein für den Stop-Abstand (`Sizing: Stückzahl < 1`). Meist ist die Position für das Risiko-Budget zu klein — kein Bug, ein Größenproblem. |
