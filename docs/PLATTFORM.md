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
| Config | `meta/engineConfig` (global) + `users/{uid}.settings.auto` (Risiko je Nutzer) | Quelle: `config/platform.yaml` über `scripts/sync-engine-config.mjs`; `universe.symbols` kommt aus der nächtlichen Auswahl (§5a), der Kandidatenpool bleibt draußen |
| Champion | `meta/champion`, Berichte `meta/optimizeReports/berichte/{date}` | Vom nächtlichen Optimierer (`.github/workflows/optimize.yml`) veröffentlicht |
| Lease | `meta/engineLease` | Transaktion mit 90 s TTL — zwei Takte laufen nie gleichzeitig |
| Wächter | `wachhund` (alle 10 min) | Schlägt Alarm, wenn `meta/health.lastRunAt` älter als 10 Minuten ist (`TAKT_TOT_MIN`) oder ein voller Takt keine Kurse bekam; Telegram/Nachricht wie bisher |
| Health | `meta/health` | `lastRunAt`, `lastRunSkipped`, `engine.{users, ok, failed, durationMs}` — Nutzer nur als kurzer Hash, keine Fehlertexte; `healthz`, `wachhund` und `check-scheduler` lesen es |
| Öffentlich lesbar | `meta/champion`, `meta/engineConfig`, `meta/health`, `meta/optimizeReports/berichte/*` | Alles andere unter `meta/` (Lease, Depot-Bindungen) ist Serversache (Rules-Allowlist) |

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

## 5a. Wer gehandelt wird, entscheidet jede Nacht die Liquidität

Der Optimierer-Workflow beginnt seit dem 08.09.2026 mit einem eigenen
Schritt, `autotrd universe`:

1. Tagesbars für den **Kandidatenpool** aus `config/platform.yaml`
   (`universe.candidates`, derzeit 139 Werte quer über die Sektoren).
2. Rang nach **Median-Dollarumsatz** über 60 Handelstage. Median, weil ein
   einzelner Quartalszahlen-Tag ein sonst dünnes Symbol nicht hochtragen soll.
3. Filter: mindestens 45 Bars im Fenster, Kurs ≥ 5 $, Umsatz ≥ 2 Mio. $/Tag,
   letzte Bar höchstens 5 Tage alt (fängt Delisting und Dauer-Halt).
4. Die liquidesten `universe.maxSymbols` (30, die harte Grenze des
   IEX-Basisplans) gewinnen. Der Benchmark ist immer dabei; besteht er die
   Prüfung nicht, bricht der Schritt ab, statt ohne Marktfilter zu messen.
5. **Hysterese:** Wer schon dabei ist, behält den Platz bis Rang 35. Ohne das
   tauschte der Korb jede Nacht zwei Werte auf Rauschen aus, und die gepoolte
   Messung von gestern wäre mit der von heute nicht vergleichbar.

**Niemals nach dem Ergebnis der Strategie.** Ein Universum danach
zusammenzustellen, wo die Strategie funktioniert hat, und es anschließend auf
denselben Daten zu messen ist Selektionsbias in Reinform — der Fehler, an dem
das Vorgängersystem gestorben ist. `waehleUniverse` bekommt Bars und Regeln,
sonst nichts: Ihr Eingang hat kein Feld für PnL, Trades oder Champion. Ein Test
hält das fest (`test/universe/select.test.ts`).

**Zwei Einschränkungen, die dazugehören** (Red-Team, 08.09.2026 — die erste
Fassung dieses Abschnitts behauptete, die Auswahl „kenne keine Rendite", und
das war falsch):

1. *Dollarumsatz enthält den Kurs.* Umsatz ist Stückzahl × Kurs, und der Kurs
   ist das kumulierte Ergebnis vergangener Rendite — bei gleicher Stückzahl
   gewinnt der gestiegene Wert. `minPreis` und `maxAlterTage` wirken auf die
   letzte Bar und werfen genau die Werte raus, die abgestürzt oder verschwunden
   sind. Das bleibt so, weil ein Auto-Trader Dollar bewegt, keine Stückzahlen;
   die Kennzahl renditeneutral zu machen hieße, Liquidität schlechter zu
   messen, um eine Zahl schöner zu machen. Benannt statt wegdefiniert.
2. *Kein Point-in-Time-Universum.* Die Auswahl beschreibt den Stand am Tag des
   Laufs, der Walk-Forward wendet sie über `lookbackDays: 400` rückwärts an.
   Bezüglich der KORB-ZUGEHÖRIGKEIT sind die OOS-Folds damit nicht
   out-of-sample: Wer im Messzeitraum übernommen, delistet oder unter 5 $
   gefallen ist, kommt gar nicht vor. Die OOS-Zahlen sind deshalb optimistisch.
   Der saubere Weg wäre, je Fold mit den Daten bis Fold-Beginn neu zu wählen
   (`waehleUniverse` nimmt `jetzt` schon als Parameter); bis das steht, sagt es
   der Bericht in jedem Lauf.

Den **Pool** ändert weiterhin nur ein Commit. Automatisch läuft die Wahl
darin. Drei Stellen bewachen das:

- `ladeUniverseDatei` lehnt jede Auswahl ab, die ein Symbol außerhalb des
  Pools nennt, mehr als `maxSymbols` enthält oder den Benchmark vermissen
  lässt — dann bleibt `meta/engineConfig` unverändert stehen.
- Der Wächter (`wachhund.yml`) meldet als Fehler, wenn die Engine etwas
  handelt, das im Repo nicht als Kandidat steht.
- `test/scripts/plattformConfig.test.ts` verbietet gehebelte und inverse ETFs
  im Pool: Sie stehen ganz oben in jeder Umsatzliste und würden eine Auswahl
  nach Liquidität sofort dominieren, obwohl 3×-Produkte das ATR-Sizing
  sprengen.

Nachzulesen ist jede Nacht im Artefakt des Laufs: `var/reports/universe-*.md`
listet **jeden** Kandidaten mit Rang, Umsatz und Grund — auch den abgelehnten.

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
   ein Bucket erst mit vollständiger letzter Minutenbar schließt. Im
   nächtlichen Lauf kommt `--universe var/universe.json` dazu, damit die
   Engine genau den Korb handelt, den der Optimierer gerade gemessen hat.
3. Repository-Secrets für den Optimierer-Workflow: `ALPACA_API_KEY`,
   `ALPACA_SECRET_KEY`, `FIREBASE_SERVICE_ACCOUNT`.
4. Deploy wie bisher (`deploy-functions.yml`); `check-scheduler.mjs` legt den
   Minuten-Job `engineTick` an und prüft ihn.
5. Erster Optimierer-Lauf per `workflow_dispatch`, danach nächtlich. Ohne
   Champion handelt niemand.

## 7. Umstieg vom Altsystem — auf demselben Firebase-Projekt

Der Neubau läuft auf dem bestehenden Projekt (`.firebaserc`), mit denselben
Auth-Nutzern, Firestore-Dokumenten, Secrets, Domain und Deploy-Pipelines.
Ein Merge nach `main` löst Functions- und Frontend-Deploy wie bisher aus;
die alten Scan-/Prognose-/KI-Functions samt Scheduler-Jobs entfernt der
Functions-Deploy selbst (`--force`), `engineTick` legt er als Minutenjob an.

**Vor dem Merge (Owner):**

1. `firebase functions:secrets:set BROKER_MASTER_KEY` — muss existieren, sonst
   bricht der Deploy ab (neu: alle Callables binden es, `CALLABLE_OPTS`). Ob es
   schon da ist, sagt der Schritt „Secret-Diagnose" im letzten Deploy-Log.
   Gibt es das Secret bereits, dasselbe behalten. Neu anlegen ist unkritisch,
   solange nie eine Function den Schlüssel gebunden hatte: Dann liegen alle
   Broker-Geheimnisse als Klartext-Altbestand, den `entschluessle` unverändert
   zurückgibt. Ab jetzt verschlüsselt `connectBroker` beim nächsten Verbinden.
2. `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` als Functions-Secrets: stehen bereits,
   der alte `universumSync` band sie. Paper-Keys genügen (nur Marktdaten).
3. Dieselben beiden Paper-Keys als **GitHub-Repo-Secrets** für den Optimierer
   (`optimize.yml`). Das ist der einzige wirklich neue Schritt: Das Altsystem
   brauchte die Alpaca-Keys nur als Functions-Secrets (`universumSync`).
   `FIREBASE_SERVICE_ACCOUNT` gibt es bereits. Fehlen sie, überspringt der
   nächtliche Lauf sich mit einer Warnung — ohne Champion handelt niemand.
4. `ALPACA_ALLOW_LIVE` NICHT setzen — Echtgeld bleibt verriegelt.

**Nach dem Merge, in dieser Reihenfolge:**

1. Deploys abwarten (Functions inkl. Rules, Frontend). `check-scheduler`
   im Deploy-Log meldet den Job `engineTick`.
2. Einmalig den Workflow **„Umstieg (einmalig, von Hand)"** starten — erst
   mit `dry_run: true` (nur Bericht im Job-Log), dann mit `dry_run: false`.
   Er schreibt `meta/engineConfig`, schaltet die Engine für alle Nutzer außer
   Admins aus (`keep` für Ausnahmen) und verschiebt alte Positions-Spiegel
   nach `positionsArchiv`. Für einen kontrollierten Start mit EINEM Konto:
   `only` setzen (uid oder E-Mail) — dann bleibt nur dieses Konto an, auch
   Admins werden ausgeschaltet und schalten sich bewusst selbst wieder ein. Nichts wird gelöscht, was nicht archiviert wird.
   Lokal geht dasselbe mit `node scripts/umstieg.mjs [--dry-run]`, dann
   braucht es `GOOGLE_APPLICATION_CREDENTIALS`.
3. Optimierer-Workflow per `workflow_dispatch` starten. Erst mit
   `meta/champion` handelt jemand.
4. Eigenes Konto: Broker-Schlüssel prüfen, Einstellungen speichern, Engine
   einschalten, ersten Takt in der Engine-Karte beobachten.

**Was Nutzer wissen müssen:** Handel nur mit eigenem Alpaca-Paper-Schlüssel
(das interne Papierbuch gibt es nicht mehr, die Historie bleibt). Offene
Alpaca-Positionen aus dem Altsystem gelten als Fremdbestand — die Engine
steigt erst ein, wenn sie geschlossen sind; die alten Broker-Stops bleiben
wirksam. Risiko-Einstellungen werden aus den alten Feldern abgeleitet, bis
sie in der neuen Karte gespeichert werden.

**Rückweg:** Merge zurückdrehen, `main` neu deployen. Der Neubau legt nur
zusätzliche Dokumente an (`private/engineState`, Journal, Trades im alten
Schema, `positionsArchiv`); die Daten des Altsystems bleiben unverändert.
