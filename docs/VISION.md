# VISION.md — autotrd: Das Experimentierlabor für Daytrader

Produktvision über die bestehende Roadmap (M2–M7) hinaus. Sie beantwortet vier
Fragen des Owners — *Wie erstellt man eigene Strategien in der App? Wie nutzt
man Indikatoren und Marker? Wie verknüpft und visualisiert man Märkte, News und
Indikatoren? Wie verknüpft und synchronisiert man Charts?* — und definiert die
Architektur-Zusätze dafür. Der Milestone-Schnitt dazu steht in
[MILESTONES.md](../MILESTONES.md) (M9–M14).

> Entstanden aus einem Sechs-Perspektiven-Entwurf (Trader-UX, Strategie-Builder,
> Charting, Alpaca, Daten-Fusion, Portfolio/Risiko) mit anschließender Synthese.
> Alles hier respektiert die bestehenden Grundsätze: zentrale Berechnung nach
> `market/**`, Geld schreibt nur der Server, Paper ist Default, Echtgeld bleibt
> mehrfach verriegelt, Kosten bleiben im Cent-Bereich.

---

## 1. Leitidee

autotrd ist der Arbeitsraum, in dem **alle Panels eine gemeinsame Aufmerksamkeit
haben**: Ein Klick auf ein Symbol, ein Signal oder eine News richtet Chart,
Indikatoren, Prognose, News und Order-Ticket gleichzeitig darauf aus — möglich,
weil alle Clients dieselben zentral berechneten `market/**`-Daten lesen.
Verknüpfung ist bei uns kein Feature-Aufsatz, sondern der Normalzustand des
Datenmodells. Statt einer Skriptsprache bekommen Experimentierfreudige ein
**getyptes Regel-JSON** mit Karten-Builder, Live-Vorschau, Backtest-on-Save,
Shadow-Konten und Sweep-Heatmaps — der komplette
Hypothese→Test→Beförderung-Loop im sicheren Paper-Rahmen. Und die App ist
**ehrlich**: Jeder Kurs trägt seinen Altersstempel, jede Prognose ihre gemessene
Trefferquote, jede Grenze des 5-Minuten-Takts wird benannt statt kaschiert.

**Die fünf Killer-Features:**

1. **Linked Workspaces** — Symbol-/Zeit-/Crosshair-Sync über Panels, Browser-
   Fenster und Monitore (Link-Gruppen A/B/C), Command-Palette (`Ctrl+K`) und
   Hotkey-Order-Ticket: vom Alert-Push zum bestätigten Paper-Trade in zwei
   Interaktionen.
2. **Strategie-Studio** — Strategien als deklarativer Bedingungsbaum in
   `shared/`, identisch ausgewertet von Builder-Vorschau, Scan-Engine und
   Backtest; mit Shadow-Modus, Versionierung, Parameter-Sweeps und fairem A/B.
3. **Der Tagesfilm** — Session-Replay, das eigene Trades, die *damaligen*
   Konfluenz-Signale, News-Marker und die KI-Tageserklärung auf einer Zeitachse
   vereint — und daraus ein halbautomatisches Journal speist.
4. **Ein Marktbild statt Datensilos** — Screener, Signal-Feed, Regime-Ampel,
   Korrelations-Heatmap und Forecast-Genauigkeits-Badges aus zentralen
   Fan-in-Dokumenten: je **ein** Read für den ganzen Markt.
5. **Zweigleisiges Alpaca-Paper** — internes PaperWallet ohne Hürde **plus**
   „Alpaca Paper Connect" mit echter Order-Mechanik (Bracket-Orders, Teilfills,
   sichtbare Status-Maschine) und Sekunden-Quotes für die gerade beobachteten
   Symbole. Echtgeld bleibt der letzte, verriegelte Schritt.

---

## 2. Eigene Strategien erstellen & bearbeiten (Strategie-Studio)

### 2.1 Strategie = Daten, nicht Code

Eine Strategie ist ein **deklarativer Bedingungsbaum** (Regel-JSON), definiert
und Zod-validiert in `shared/src/rules/`. Dieselbe pure `evaluate()`-Funktion
läuft im Builder (Live-Vorschau), in der Scan-Engine und im Backtest —
bit-identisch auf Client und Server. Keine Skriptsprache, kein `eval`, kein
Freitext: alles bleibt enumerier-, validier- und UI-renderbar.

```jsonc
{
  "name": "Momentum-Dip mit News-Filter",
  // Risiko-Hülle: liegt AUSSERHALB des Baums, von keiner Regel überschreibbar
  "risk": { "maxPositionPct": 10, "stopLossPct": 2, "takeProfitPct": 4,
            "maxOpenPositions": 3, "cooldownScans": 3 },
  "entry": { "long": {
    // Gates: harte Filter, müssen ALLE wahr sein
    "gates": [
      { "type": "timeWindow", "between": ["09:35","15:45"], "tz": "America/New_York" },
      { "type": "compare", "left": {"src":"price"}, "op": "gt",
        "right": {"src":"ind","id":"ema","params":{"window":200}} },
      { "type": "not", "child":
        { "type": "sentiment", "windowHours": 12, "op": "lt", "value": -0.5 } }
    ],
    // Gewichtete Stimmen — die Verallgemeinerung von minConfluence
    "vote": { "type": "weighted", "threshold": 3, "children": [
      { "weight": 1, "node": { "type":"compare",
          "left": {"src":"ind","id":"rsi","params":{"window":14}},
          "op":"lt", "right": {"src":"const","value":30} } },
      { "weight": 2, "node": { "type":"crossover",
          "a": {"src":"ind","id":"macd","field":"line"},
          "b": {"src":"ind","id":"macd","field":"signal"},
          "direction":"above", "withinBars":2 } },
      { "weight": 2, "node": { "type":"forecast", "horizonDays":5, "op":"gt", "valuePct":0.5 } },
      { "weight": 1, "node": { "type":"newsEvent", "anyTags":["earnings_beat","upgrade"], "windowHours":24 } }
    ] }
  } },
  "exit": { "long": { "type": "any", "children": [
    { "type":"compare", "left": {"src":"ind","id":"rsi","params":{"window":14}},
      "op":"gt", "right": {"src":"const","value":70} },
    { "type":"position", "field":"heldScans", "op":"gt", "value":78 }
  ] } }
}
```

Knoten-Typen (abschließend): Kombinatoren `all/any/weighted/not`; Blätter
`compare`, `crossover`, `priceLevel`, `changePct`, `timeWindow`, `sentiment`,
`newsEvent`, `forecast`, `position` (nur im Exit). Das heutige flache Schema
lebt als `kind:'classic'` weiter und wird mechanisch in den Baum kompiliert —
eine Wahrheit, keine zwei Strategiemodelle.

### 2.2 Bearbeiten: Karten-Builder statt Node-Spaghetti

Der No-Code-Builder rendert den Baum als **verschachtelte Glass-Cards** (Gates ·
Stimmen mit Gewicht-Badges und Threshold-Stepper · Exits) — Hierarchie kann
strukturell keinen Unsinn darstellen, funktioniert bis 360 px und passt zum
Frosted-Aurora-Stack. Dazu:

- **Live-Vorschau:** der `shared/`-Evaluator läuft über die Bars, die der Chart
  ohnehin liest → Signal-Marker + Haltebänder erscheinen beim Editieren sofort,
  ohne einen einzigen Server-Call. Label: „Vorschau, kein Backtest".
- **Presets** (`meta/strategyPresets`): 5 kuratierte Vorlagen, jede Knotenart in
  mindestens einer — Presets sind die Doku.
- **Lebenszyklus:** Entwurf → `publishStrategyVersion` (Callable, validiert) →
  **Backtest-on-Save** → optional **Shadow-Modus** (Strategie läuft beobachtend
  mit virtuellem Konto, ohne Trades) → Zuweisung auf ein Paper-Wallet →
  **A/B-Duell** und transaktionale „Beförderung".
- **Versionierung** append-only mit Diff-Ansicht und Rollback; jeder Trade
  trägt `strategyId+Version` für saubere Attribution.
- **Parameter-Sweeps:** ≤ 2 Parameter, ≤ 60 Kombis, Ergebnis als Heatmap —
  „Als neuen Entwurf übernehmen" ist ein Klick, **Auto-Apply gibt es bewusst
  nicht** (Overfitting-Falle).

Sicherheit: `users/{uid}/strategies/**` schreibt **nur** der Server (Callables);
die Risiko-Hülle (Pflicht-Stop-Loss, `maxPositionPct`-Clamp, Positionslimit,
Cooldown) liegt außerhalb des Baums und ist nicht komponierbar.

---

## 3. Indikatoren & Marker

### 3.1 Indikator-Registry — zentral UND experimentierfreudig

Der scheinbare Konflikt „freie Parameter vs. einmal zentral berechnen" wird
zweistufig gelöst:

1. **Katalog-Varianten** (`meta/indicatorCatalog`): kuratiertes Gitter
   (RSI 7/14/21 · EMA 9/20/50/200 · MACD 12-26-9 · BB 20/2 · …) wird zentral
   nach `market/{sym}/indicators/{date}` persistiert — einmal für alle Clients.
2. **Exotische Parameter** (RSI-11, EMA-137, …) sind trotzdem erlaubt: Engine
   und Chart haben die Bars ohnehin im Speicher; exotische Varianten werden
   **in-memory** gerechnet und nie persistiert. Teuer sind Fetches und Writes,
   nicht Mathe. Wilder-Glättung gilt in beiden Pfaden — es ist dieselbe
   `shared/`-Funktion (Parity-Pflicht aus CLAUDE.md).

Im Chart: Parameter-Dialog pro Indikator, eigene Farben, speicherbare
**Indikator-Sets** (`users/{uid}/indicatorSets`) — „mein RSI+MACD+VWAP-Setup"
ist ein Klick auf jedem Symbol.

### 3.2 Marker-Ebenen — eine Zeitachse, viele Wahrheiten

Ein `MarkerLayerManager` merged pro Chart mehrere ein-/ausblendbare Ebenen
(v4 erlaubt nur ein Marker-Array pro Serie, deshalb der Manager):

- **Signal-Marker** aus `market/{sym}/signals/{scanId}` (Konfluenz-Votes),
- **Trade-Marker** (eigene Ein-/Ausstiege mit P&L-Label),
- **News-/Event-Marker** sentiment-gefärbt aus `market/{sym}/events/{date}`,
  Klick → Bottom-Sheet mit Headlines + KI-Tageszusammenfassung,
- **Forecast-Band** als Fläche (Custom-Series-Primitive): die zentrale Prognose
  mit ihrem Unsicherheitskegel — daneben ein Badge mit der *gemessenen*
  Trefferquote dieser Parameter (`market/{sym}/forecastStats`).
- **Zeichenwerkzeuge** (Trendlinien, Levels, Rechteck-Zonen) als
  Plugin-Primitives mit Hit-Testing, persistiert in
  `users/{uid}/chartDrawings/{symbol}` — auf jedem Gerät wieder da.

---

## 4. Märkte, News, Indikatoren verknüpfen & visualisieren

Kern-Trick: **Fan-in-Dokumente** unter `market/_meta/**` — der Scan schreibt
marktweite Sichten als je EIN Dokument, jeder Client liest sie mit je einem
`onSnapshot`:

| Dokument | Inhalt | UI |
|---|---|---|
| `snapshot/current` | 166 Symbole × (Quote, Indikator-Kurzform, Signal, Regime) | **Screener** mit speicherbaren Filtern („RSI < 30 UND Vola hoch"), Sektor-/Assetklassen-**Heatmap** |
| `feed/current` | Ringpuffer der letzten Signale + News marktweit | **Signal-/News-Feed**, filterbar, Klick springt zum Chart-Marker |
| `regime/current` | Trend/Range/Vola-Ampel je Assetklasse | Regime-Leiste im Workspace-Kopf |
| `correlations/{30d\|90d}` | rollierende Korrelation/Beta der Anker-Symbole | **Korrelations-Heatmap**; Zellen-Klick öffnet die beiden Symbole als Compare-Overlay |
| `accuracy/current` | Forecast-Trefferquoten je Symbol | Genauigkeits-Badges, Self-Tuning wird sichtbar |

Dazu pro Symbol der **Event-Graph** `market/{sym}/events/{date}`
(News → Sentiment → Kursreaktion → Signal-/Forecast-Referenz) und das
**„Warum bewegt sich X?"-Panel**: KI-Tageszusammenfassung + Top-Events +
Konfluenz-Stand, komplett aus dem Cache — null zusätzliche LLM-Calls. Am
Symbol-Doc hängen `spark` (Sparkline-Punkte für Watchlist-Kacheln) und
`context` (Beta zum Index, Peer-Symbole) für Cross-Market-Bezüge
(BTC↔Tech, EURUSD↔DAX, Index↔Einzelwert).

---

## 5. Charts verknüpfen, synchronisieren, verbinden (ChartKit)

Ein eigenes Modul `frontend/src/charts/` kapselt Lightweight Charts v4.2
hinter einer Fassade (`chartkit.ts` ist der **einzige** Ort mit LWC-Import —
macht den späteren v5-Umstieg zur Ein-Datei-Änderung und erzwingt die
CLAUDE.md-Guards):

- **Multi-Pane-Stacks:** Preis + RSI + MACD + Volumen als gestapelte
  Chart-Instanzen; Sync über die *logische Range*
  (`subscribeVisibleLogicalRangeChange` → `setVisibleLogicalRange`) —
  pixelgenau, mit Feedback-Loop-Guard. Crosshair via
  `setCrosshairPosition()` gespiegelt, ein gemeinsames Fixed-Tooltip mit
  OHLCV + allen Indikatorwerten der Zeile. Preisskalen werden über
  `minimumWidth` bündig gehalten.
- **Sync zwischen getrennten Symbolen** (AAPL-Panel neben NVDA-Panel):
  **timestamp-basiert** (`setVisibleRange`), nicht bar-indexbasiert —
  unterschiedliche Handelskalender/Lücken machen logisches Syncen falsch.
- **Symbol-Link-Gruppen A/B/C:** jedes Panel trägt einen farbigen Link-Chip
  (Aurora-Farben); Watchlist-Klick wechselt alle Panels der Gruppe. Über
  Browser-Fenster/Monitore hinweg läuft derselbe Link-Bus per
  `BroadcastChannel` — und ein Leader-Tab hält die Firestore-Listener genau
  **einmal**: Multi-Monitor kostet keine zusätzlichen Reads.
- **Overlay-Compare:** mehrere Symbole normalisiert (% ab Anker; Anker per
  Alt-Klick setzbar) auf einer Prozent-Skala, Kalenderlücken über
  Whitespace-Punkte sauber gelöst; Compare-Sets („Mag7", „Krypto vs. NDX")
  speicherbar.
- **Lesekosten:** Charts laden `market/{sym}/ohlc/{res}_{chunk}`-Chunk-Docs —
  Erstladung 1–2 Reads statt 250+. Die `m5`-Chunks tragen zugleich den
  **Tagesfilm** (Session-Replay mit eigenen Trades, damaligen Signalen,
  News-Markern und KI-Abspann).

---

## 6. Alpaca-Integration (Wallets, Paper, Realtime)

**Zweigleisig, beide Gleise Paper:**

- **Gleis A — internes PaperWallet** (heute schon geplant, M4): sofort nutzbar,
  ohne Keys, mehrere Wallets pro User (z. B. eins je Strategie), serverseitig
  geführt.
- **Gleis B — Alpaca Paper Connect** (M13): User hinterlegt eigene Alpaca-
  **Paper**-Keys (PK-Präfix-Pflicht; Live-Keys werden nicht akzeptiert).
  Ablage ausschließlich KMS-verschlüsselt in `users/{uid}/private/broker`
  (`read/write: if false` — auch für den Owner). Orders laufen über
  `paper-api.alpaca.markets` (Basis-URL hartkodiert) mit echter Order-Mechanik:
  Market/Limit/Stop/**Bracket** (Stop-Loss+Take-Profit als eine Order), OCO,
  Trailing-Stop, Teilausführungen, `client_order_id` = Firestore-Doc-ID
  (Idempotenz — kein Retry erzeugt Doppel-Orders). Status-Maschine sichtbar im
  UI: `pending_new → new → partial_fill → filled`.
- **Realtime ehrlich gelöst:** Cloud Scheduler kann kein Websocket halten.
  Ein einzelner **Cloud-Run-Service `streamer`** ist der einzige
  Websocket-Halter der Plattform (Alpaca-Free erlaubt genau eine
  Daten-Verbindung) mit drei Modulen: (a) **Hot-Set-Quotes** — nur für gerade
  von eingeloggten Usern beobachtete Symbole (Presence), gedrosselt ≤ 1
  Write/2 s/Symbol; (b) **Preis-Alerts** in Sekunden (in-memory geprüft, nur
  Firing-Events werden geschrieben); (c) **trade_updates** für Gleis B.
  Fällt der Streamer aus, degradiert das UI sichtbar auf den 5-min-Stand
  („verzögert"-Badge) — keine Fehlerkaskade. Alle Calls mit dem zentralen
  Daten-Key laufen durch eine Cloud-Tasks-Queue (200 req/min-Limit strukturell
  eingehalten).
- **Echtgeld (M14, zuletzt):** dieselbe Order-Maschine, dieselben Guards, kein
  neuer Codepfad außer der Live-Basis-URL — hinter Doppel-Guard
  (`mode:'live'` **und** serverseitiges, nur vom Owner setzbares
  `liveApprovedAt`), mit plattformweitem Kill-Switch.

---

## 7. Portfolio, Risiko & Journal (Kurzfassung)

Multi-Wallets mit täglichen Equity-Snapshots und vorberechneten Kennzahlen
(Sharpe 30/90, Max-Drawdown, Win-Rate, Profit-Factor, Expectancy in R —
Dashboard = 1 Stats-Doc-Read). Serverseitige **Risiko-Guards**: Tages-Loss-Limit
mit Circuit Breaker (blockt neue Entries, optional `flattenAll`, Sofort-Push,
manueller Re-Arm), Positionslimits, fixed-fractional Sizing mit eingefrorenem
Initial-Stop (→ saubere R-Multiples). Jeder Trade erzeugt automatisch einen
**Journal-Eintrag** mit eingefrorenem Signal-Kontext (Votes, Indikatorwerte,
Mini-Chart) — der User ergänzt Notizen, Tags und Review-Grades; der
**Tagesfilm** (§5) ist die Tagesansicht dazu. Wochen-Reports optional per
Push/E-Mail, KI-Zusammenfassung aus gecachten Daten.

---

## 8. Bewusst weggelassen

1. **Eigene Skriptsprache / Indikator-Basar (100+).** Sandbox- und Pflegelast;
   das getypte Regel-JSON mit kuratierter Whitelist deckt Experimentierfreude
   ab und bleibt validier- und renderbar. Tiefe statt Breite.
2. **Level 2 / Orderbuch / Tick-Charts.** Mit IEX-Free-Feed und 5-min-Kanonik
   nicht seriös darstellbar — wir faken keine Markttiefe. Stattdessen überall
   Altersstempel und Quellen-Badges.
3. **Social-Feed / Copy-Trading.** Moderationslast + regulatorisches Minenfeld;
   geteilt werden nur bereinigte Workspace-Presets.
4. **Echtzeit-Streaming für alles über Firestore.** Würde das Kostenmodell
   zerstören; Realtime gibt es gezielt (Hot-Set, Alerts), die kanonische
   Wahrheit bleibt der 5-min-Scan.
5. **Auto-Apply von Sweep-Siegern / autonomes KI-Tuning der Live-Parameter.**
   Maschinen schlagen vor, nur der User befördert — der `ai_tuner`-Grundsatz
   gilt plattformweit.

---

## 9. Umsetzung

Der Milestone-Schnitt **M9–M14** steht in [MILESTONES.md](../MILESTONES.md):
M9 Linked Workspaces → M10/M11 Strategie-Studio → M12 Portfolio/Risiko/Tagesfilm
→ M13 Alpaca Paper Connect + Streamer → M14 Echtgeld (verriegelt, Owner-Go).
Voraussetzung bleibt M2–M7; am Coding-Loop (erster nicht abgehakter Milestone,
Verifikation, kleine deutsche Commits) ändert sich nichts.
