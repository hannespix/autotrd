# Master-Prompt für autotrd — Prompt-Strategie (Owner, 20.08.)

> **Kanonische Stelle:** Der kopierfertige Master-Prompt steht in
> **`MILESTONES.md` → „Übergabe-Prompt"** — dort arbeiten interaktive
> Sessions und `@claude`-Läufe nach demselben Maßstab. Diese Datei trägt die
> **Begründung**, die **Kurzvarianten** und das **Kalibrierungs-Protokoll**.
> Änderungen am Prompt zuerst in MILESTONES.md, dann hier nachziehen.

## Warum der CoD-Prompt nicht 1:1 übertragbar ist

Der Shooter-Prompt funktioniert wegen **einer** Eigenschaft: Der Maßstab ist
sichtbar. Ein Kritiker-Agent macht zwei Screenshots, vergleicht blind und sagt
„der da ist schlechter". Das ist ehrlich, weil das Urteil *außerhalb* des
Systems entsteht, das es beurteilt.

Bei autotrd zerfällt das in zwei Hälften:

| Achse | Maßstab | Kritiker |
|---|---|---|
| **Oberfläche & Chart** | sichtbar → 1:1 übertragbar | Blindvergleich gegen TradingView |
| **Engine, Kante, Prognose** | *nicht* sichtbar | Red Team, nicht „Gefällt-mir"-Kritiker |

Die zweite Hälfte ist die gefährliche. „Loop, bis der Kritiker begeistert ist"
heißt bei einem Handelssystem: *Loop, bis der Backtest schön aussieht* — und
das ist die exakte Definition von Overfitting. Das Repo sagt es selbst
(VISION §2.2 „Auto-Apply gibt es bewusst nicht", MO: „ein Suchraum ohne
Overfitting-Bremse findet zuverlässig Unsinn, der im Rückblick großartig
aussieht"). Der Master-Prompt übernimmt deshalb die **Struktur** des Originals
(Fan-out, /loop, harter externer Kritiker, Blindvergleich) und tauscht nur die
**Zielfunktion** der Engine-Hälfte aus: nicht Rendite im Rückblick, sondern
**Kante nach Kosten out-of-sample**.

Die Kritiker-Konvention (UI-Kritiker vs. Engine-Red-Team) steht dauerhaft in
**CLAUDE.md §11**, damit jede Session sie erbt, ohne dass sie mitgeschickt
werden muss.

## Zwei kürzere Varianten

**Nur Oberfläche (der 1:1-Fall — hier funktioniert der CoD-Prompt fast
wörtlich):**

> Lies ARCHITECTURE.md, CLAUDE.md und MILESTONES.md. Bring Chart und
> Oberfläche von autotrd auf TradingView-Niveau — Zeichenwerkzeuge,
> Chart-Vorlagen, Kerzen-Countdown, Bar-Replay, Multi-Pane-Sync, mobil bis
> 360 px. Fächere Sub-Agenten auf, eins je Teilstück, `/loop` auf jedes. Ein
> separater, unbestechlicher Kritiker-Agent vergleicht Screenshots **blind
> nebeneinander** mit TradingView bei derselben Aufgabe, Desktop und Handy.
> Erkennt er unseren, läuft der Loop weiter. Nachweis über `npm run
> chart:shot` und `frontend/e2e/smoke.mjs` — „kompiliert sauber" zählt
> nicht. Lightweight Charts v4 gepinnt, Zeichnung an `lineHost`,
> `prefers-reduced-motion` respektiert. `/loop`, fächere auf, ultracode.

**Nur Engine (hier ist der Kritiker ein Gegner, kein Fan):**

> Lies ARCHITECTURE.md, CLAUDE.md, MILESTONES.md — besonders MI, MF, MK und
> „Die unbequeme Zusammenfassung". Auftrag: die Kante je Trade über die
> Roundtrip-Kosten heben, in dieser Reihenfolge — erst Kante, dann Frequenz.
> Fächere Sub-Agenten auf (Konfluenz-Lesart, Klassen-Kante, Kostenmodell,
> Ausstiegslogik, Prognose-Güte). Für jedes Paket läuft ein
> **Red-Team-Agent**, der es *widerlegen* soll: Lookahead, Survivorship,
> fehlende Kosten, Stichprobengröße, Freiheitsgrade, In-Sample-Auswahl.
> Keine Verbesserung gilt, bevor sie out-of-sample nach Kosten überlebt.
> Kein Auto-Apply, kein Scharfschalten von `classAutoTune`, kein Anfassen
> von M14. „Nicht handeln" ist ein zulässiges Ergebnis. `/loop`, bis das Red
> Team kein Loch mehr findet.

## Kalibrierungs-Protokoll (Original → Repo-Stand 20.08.)

Der eingepflegte Master-Prompt weicht an vier Stellen bewusst vom
Original-Entwurf ab — jeweils, weil der Repo-Stand weitergezogen ist:

1. **Eingefrorene Zahlen raus.** „+0,143 % je Trade gegen 0,300 % Roundtrip,
   Deckung 0,48" war eine Momentaufnahme; seither haben Maker-Einstiege,
   Klassen-Regler und Kostenhürden die Lage verändert (Long live mit
   PF 1,23). Der Prompt verweist jetzt auf die LEBENDEN Quellen
   (Performance-Karte, `meta/health.trading`, „unbequeme Zusammenfassung")
   statt eine Zahl einzufrieren, die beim nächsten Deploy lügt.
2. **Paket 6 (Portfolio & Risiko):** Journal-Autoanlage und Depot-Zerlegung
   sind gebaut (M12) — der Prompt sagt „pflegen und vertiefen", damit kein
   Agent Bestehendes neu erfindet. Offen bleiben Multi-Wallet-Migration und
   das synchronisierte Drawdown-Panel.
3. **`chartkit.ts`:** Die einzige LWC-Importstelle heißt heute
   `frontend/src/chart.ts`. Der Prompt fordert das PRINZIP (eine
   Importstelle) statt des Dateinamens — sonst legt ein Agent eine zweite
   Datei neben die existierende.
4. **Grenzen-Absatz ergänzt** um die stehende Exit-Regel des Repos: „Exits
   werden nie gesperrt oder erschwert" (CLAUDE.md/Broker-Konventionen) —
   sie fehlte im Entwurf, gehört aber in jede Grenzen-Liste.

Nicht angefasst: Ton, Struktur, Kritiker-Mechanik, die Schlussformel
(„Fächere Sub-Agenten auf und ultracode") — sie ist das bewusste
Opt-in-Schlüsselwort für Multi-Agent-Orchestrierung.
