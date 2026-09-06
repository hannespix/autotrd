# PLATTFORM.md — Betrieb als Firebase-Plattform (autotrd.net)

Der Handelskern (`src/`) läuft in zwei Betriebsarten: als **eigener Prozess**
(`autotrd run`, siehe BETRIEB.md) und als **Firebase-Function je Minute**
für alle freigeschalteten Nutzer der Plattform. Dieses Dokument beschreibt
die zweite Betriebsart. Sie ist die Standard-Betriebsart von autotrd.net:
kein eigener Server, Kosten im Blaze-Freikontingent, Login und Nutzerverwaltung
wie bisher.

## 1. Warum das ohne Dauerprozess geht

Die Sicherheit liegt beim Broker: Jeder Einstieg ist eine Bracket-Order,
Stop und Ziel wirken bei Alpaca in Echtzeit, ob die Function läuft oder
nicht. Die Function muss nur Bar-Schlüsse bewerten, Orders senden und das
Buch mit dem Broker abgleichen. Dafür reicht ein Takt pro Minute — der
Strategie-Zeitrahmen ist 5 Minuten, und Exits nach Sitzungsschluss werden
ohnehin bis zur nächsten Eröffnung zurückgestellt (BETRIEB.md).

Was gegenüber dem Dauerprozess fehlt: die Sekunden-Reaktion des
WebSocket-Streams. Sie wird für keine der Vorlagen gebraucht, weil Exits
über Stop und Ziel beim Broker laufen.

## 2. Bausteine

| Baustein | Ort | Aufgabe |
|---|---|---|
| `engineTick` | `functions/src/scheduled/engineTick.ts` | `onSchedule('* * * * *')`, us-central1, 512 MiB, 55 s, `maxInstances: 1`, Secrets `BROKER_MASTER_KEY`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` |
| Takt-Logik | `functions/src/engine/tick.ts` | Lease, Nutzerschleife, geteilte Marktdaten, Engine je Nutzer, Health |
| State | `users/{uid}/private/engineState` | `EngineState` (Buch, Sperren, laufende Exits, Konto-ID) + zurückgestellte Intents + Journal-Puffer des Takts; `private/**` ist für Clients dicht. Abgelöste States (Kontowechsel) unter `private/archiv/engineStates/{iso}` |
| Journal | `users/{uid}/journal/{hash}` | Entscheidungen, Orders, Fills, Halts; je Takt EIN Batch, der zugleich den Puffer im State-Doc leert — scheitert er, schreibt der nächste Takt nach. Doc-IDs sind Inhalts-Hashes, das Nachschreiben ist idempotent (auch Trade-Docs) |
| Trades | `users/{uid}/trades/{autoId}` | Ein- und Ausstiegs-Fill im bisherigen Schema (Steuer-Export, Historie), EZB-Kurs beim Schreiben eingefroren |
| Spiegel | `users/{uid}/positions/{symbol}`, `users/{uid}.wallet`, `users/{uid}.engine`, `market/{symbol}.quote` | Was das Frontend liest |
| Kommandos | `users/{uid}/private/engineCommands` | `halt` / `resume` (Drawdown nur mit `ackDrawdown`) / `flatten` (nur das eigene Buch), gesetzt vom Callable `engineCommand` (nur mit verbundenem Broker), verarbeitet im nächsten Takt, verfallen nach 24 h |
| Config | `meta/engineConfig` (global) + `users/{uid}.settings.auto` (Risiko je Nutzer) | Quelle: `config/platform.yaml` über `scripts/sync-engine-config.mjs` |
| Champion | `meta/champion`, Berichte `meta/optimizeReports/{date}` | Vom nächtlichen Optimierer (`.github/workflows/optimize.yml`) veröffentlicht |
| Lease | `meta/engineLease` | Transaktion mit 90 s TTL — zwei Takte laufen nie gleichzeitig |
| Health | `meta/health` | `lastRunAt`, `lastRunSkipped`, `engine.{users, ok, failed, durationMs}` — Nutzer nur als kurzer Hash, keine Fehlertexte; `healthz`, `wachhund` und `check-scheduler` lesen es |
| Öffentlich lesbar | `meta/champion`, `meta/engineConfig`, `meta/health`, `meta/optimizeReports/*` | Alles andere unter `meta/` (Lease, Depot-Bindungen) ist Serversache (Rules-Allowlist) |

## 3. Ablauf eines Takts

1. Lease nehmen. Hält sie ein anderer Lauf, nur Heartbeat.
2. Uhr und Kalender mit dem Plattform-Datenkey holen. Ist der Aktienmarkt
   geschlossen, laufen nur Nutzer mit zurückgestellten Exits oder offenen
   Kommandos; sonst Heartbeat `market_closed`.
3. Nutzer laden: `settings.strategy.engine.running == true`, freigeschaltet
   (`accessLevel`), kein laufender Konto-Reset, Broker-Zugang über
   `brokerZugang()` — dort hängt die Echtgeld-Kette: `ALPACA_ALLOW_LIVE=1`
   **und** Kill-Switch aus **und** Nutzer-Schalter `live` **und** Live-Reife.
   Fehlt eines, ist der Order-Pfad des Live-Kontos **verriegelt**: Die Engine
   läuft trotzdem, aber mit Einstiegs-Sperre (Grund im Spiegel
   `engine.entryLock`) — Abgleich, Schutz-Stops, Trailing, EOD-Flatten und
   zurückgestellte Exits gehen weiter, eigene offene Einstiegs-Orders werden
   storniert, Fremdbestand wird nie adoptiert. Exits werden nie gesperrt.
   Paper-Keys sind nie verriegelt. Ohne Broker wird der Nutzer übersprungen
   und ein liegengebliebenes Kommando verworfen.
4. Minutenbars für die Vereinigung aller Symbole einmal laden (Warmup-Fenster),
   in einen geteilten Bars-Cache unter `/tmp`. Kein Nutzer löst eigene
   Datenaufrufe aus.
5. Je Nutzer (parallel, höchstens drei, Reihenfolge rotiert je Minute):
   Config ableiten, Engine bauen (Firestore-State, Firestore-Journal,
   geteilte Daten, keine Streams), `start()` (Konto, eigene Orders
   übernehmen, Abgleich, Schutz-Stops), Kommandos anwenden, `tick(now)`,
   `stop()`, Journal und Spiegel schreiben. Jeder Nutzer hat ein Zeitbudget
   (20 s; der REST-Client bekommt dieselbe Frist, 5 s je Aufruf, höchstens
   ein Wiederholversuch); danach gilt der Lauf als aufgegeben und darf nichts
   mehr schreiben (State, Journal, Spiegel) — er kann den nächsten Takt nicht
   überschreiben. Nach 40 s beginnt der Takt keinen weiteren Nutzer. Fehler
   eines Nutzers stoppen die anderen nicht; ein Lesefehler am Broker-Doc gilt
   als Fehler, nie als „kein Broker".
6. Health schreiben, Lease freigeben.

## 4. Einstellungen je Nutzer

`settings.auto` hält nur, was nutzerabhängig ist: Risiko je Trade,
Positionsdeckel, Positionsanzahl, Tages-Notbremse, Drawdown-Sperre, Shorts,
optional eine Teilmenge der Plattform-Symbole und Telegram. Geschrieben wird
es ausschließlich über das Callable `saveStrategy` (serverseitig validiert);
Clients dürfen `settings.auto` nicht direkt schreiben. Fehlt `settings.auto`,
leitet der Takt die Werte aus den alten Feldern in `settings.strategy` ab.

Welche Strategie mit welchen Parametern gehandelt wird, entscheidet der
Champion für alle Nutzer. Es gibt keine Nutzer-Parameter für Strategien —
das war einer der Fehler des Vorgängers.

## 5. Betriebsregeln

- **Konto- oder Moduswechsel** (andere Schlüssel verbinden, trennen, Paper →
  Live): `connectBroker` archiviert den Engine-State nach
  `private/archiv/engineStates/{iso}`; erkennt der Takt trotzdem einen State
  eines anderen Alpaca-Kontos (`accountId`) oder Modus, archiviert er ihn
  selbst und startet im nächsten Takt mit leerem Buch. Positionen des alten
  Kontos bleiben dort samt Schutz-Stops — sie gehören nicht mehr zu diesem
  Buch; DAY-Beine verfallen dort am Sitzungsende (Journal-Notiz).
- **Flatten** wird je Position als laufender Exit vorgemerkt und gespeichert,
  bevor die erste Order geht — ein Zeitbudget oder Absturz mitten in der
  Sequenz verliert keine Position, der nächste Takt holt den Rest nach.
- **Eigene Fills nach Absturz** werden nur adoptiert, wenn die Runde
  nachweislich offen ist (kein Bein, kein eigener Exit gefüllt; Broker hält
  genau die Menge). Alles andere bleibt dem Abgleich (Halt `reconcile`).
- **Notbremse** (Tagesverlust, Drawdown): Der Glattstellungs-Exit wird in
  jedem Takt erneut angefordert, bis das Buch leer ist; laufende Exits sind
  im State persistiert und werden nach einem Fehlschlag wiederholt.
- **Fehlerserie**: `consecutiveErrors` zählt über Takte hinweg; erst ein
  fehlerfreier Takt setzt den Zähler zurück, `maxConsecutiveErrors` ⇒ Halt.
- **Not-Aus**: plattformweit der Kill-Switch `meta/live.killSwitch` (Admin),
  je Nutzer `engineCommand({action:'flatten'})` oder `halt`. Die HALT-Datei
  des Dauerprozesses gibt es hier nicht.
- **Champion fehlt** (`meta/champion` leer oder Symbol in `noTrade`): keine
  Einstiege, Exits und Stops laufen weiter. Das ist ein reguläres Ergebnis.
- **Health**: `meta/health.engine.failed` enthält nur gekürzte Nutzer-Hashes,
  keine Fehlertexte; der volle Fehler steht privat in
  `users/{uid}.engine.lastError` und im Log.
- **Gebühren**: `Trade.fees` folgt dem Kostenmodell (SEC-Gebühr und FINRA TAF
  auf Verkäufe, Krypto-Taker beidseitig) — dieselbe Rechnung wie im
  Simulator; Slippage steckt live im Fill-Kurs.
- **Kosten**: je Takt eine Nutzer-Abfrage, je laufendem Nutzer ein
  State-Read, ein State-Write und ein Journal-Batch; außerhalb der Sitzung
  praktisch nichts. Marktdaten einmal je Takt mit dem Plattform-Key.

## 6. Einrichtung (einmalig)

1. Secrets im Functions-Projekt: `BROKER_MASTER_KEY` (32 Byte, base64; an
   alle Callables und den Takt gebunden — muss VOR dem ersten Deploy
   existieren), `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` (Paper-Keys, nur für
   Marktdaten). `ALPACA_ALLOW_LIVE` bleibt `0`, bis die Live-Reife erreicht
   ist.
2. `node scripts/sync-engine-config.mjs` schreibt `meta/engineConfig` aus
   `config/platform.yaml` (läuft auch im Optimierer-Workflow). `broker.feed`
   kommt mit (Optimierer und Engine messen denselben Feed);
   `engine.barGraceSec` nicht — der Takt hält mindestens 20 s Karenz, damit
   ein Bucket erst mit vollständiger letzter Minutenbar schließt.
3. Repository-Secrets für den Optimierer-Workflow: `ALPACA_API_KEY`,
   `ALPACA_SECRET_KEY`, `FIREBASE_SERVICE_ACCOUNT`.
4. Deploy wie bisher (`deploy-functions.yml`); `check-scheduler.mjs` legt den
   Minuten-Job `engineTick` an und prüft ihn.
5. Erster Optimierer-Lauf per `workflow_dispatch`, danach nächtlich. Ohne
   Champion handelt niemand.
