# Wissensbibliothek — Theorie, Praxis, eigene Thesen

Owner-Anweisung vom 09.09.2026: Autotrd soll aus der gesamten erreichbaren
Literatur und aus der eigenen Praxis eine **wachsende, immer besser werdende
Strategie- und Wissensbibliothek** bilden und daraus Taktiken, Käufe,
Verkäufe und Haltedauern je Symbol ableiten und bewerten. Aktiv, nicht
hyperaktiv.

Diese Bibliothek ist der Ort dafür. Sie ist kein Prosa-Archiv, sondern ein
Arbeitsgerät mit vier Regeln:

1. **Jede Zahl verweist auf einen Lauf.** Ein Befund ohne Lauf-Nummer,
   Config und Datenbereich ist eine Meinung und wird als solche markiert.
2. **Jede These hat einen Status** — `offen`, `bestätigt`, `widerlegt`,
   `verworfen` — und eine Konsequenz. Eine bestätigte These ohne Konsequenz
   im Code oder in der Config ist unerledigt.
3. **Experimente werden VOR dem Lauf vorregistriert** (`vorregistrierung/`):
   Hypothese, Universum, Parameter, Annahmekriterien, was welches Ergebnis
   bedeutet. Das Commit-Datum ist der Beleg. Kriterien, die nach dem Lauf
   angepasst werden, sind keine — dann steht eine neue Vorregistrierung an.
4. **Literatur wird mit Vertrauensgrad geführt** (`hoch` = begutachtet und
   vielfach repliziert, `mittel` = begutachtet, Details aus dem Gedächtnis,
   `niedrig` = Praktiker, Preprint, Buch). Zahlen aus dem Gedächtnis sind vor
   Verwendung in einer Entscheidung nachzuschlagen. Nichts wird erfunden.

## Struktur

| Datei | Inhalt |
|---|---|
| `literatur.md` | Karten je Studie: Befund, Stichprobe, Effekt, Kosten, was danach kam, Bedeutung für Autotrd, Vertrauen. |
| `thesen.md` | Eigene Thesen T1 … Tn mit Status, Beleg und Konsequenz. Hier entsteht die „eigene Theorie". |
| `taktiken.md` | Je Strategiefamilie: Zweck, Eintritt, Austritt, erwartete Haltedauer, Aktivität, Kostenempfindlichkeit, woran sie stirbt, Messstand. |
| `aktivitaet.md` | Das Aktivitätsbudget — „aktiv, nicht hyperaktiv" in Zahlen, und wo es erzwungen und gemessen wird. |
| `befunde.md` | Laufendes Protokoll aller Messläufe, eine Zeile je Lauf. Wächst mit jedem Probe- und Optimierer-Lauf. |
| `vorregistrierung/` | Ein Dokument je Experiment, geschrieben vor dem Lauf. |
| `symbolprofile.md` | Was das nächtliche Profil je Symbol enthält und wie Taktik und Haltedauer daraus folgen (Entwurf, Phase 2). |

## Wie die Bibliothek wächst

- Jeder Messlauf (Probe oder Nacht) bekommt eine Zeile in `befunde.md` mit
  Lauf-Nummer, Config, Datenbereich, Urteil und den Kennzahlen gegen den
  Maßstab. Widerspricht das Ergebnis einer These, ändert sich deren Status
  im selben Commit.
- Neue Literatur bekommt eine Karte, bevor sie eine Taktik beeinflusst.
  Jede Karte endet mit „Bedeutung für Autotrd" — sonst ist sie Ballast.
- Eine Taktik wird nur aus einer These abgeleitet, die mindestens `offen`
  mit Vorregistrierung ist. Taktiken ohne These gibt es nicht.
- Die ausführbare Form der Bibliothek sind die Configs (`config/*.yaml`),
  die Strategien (`src/strategy/`) und der Champion (`meta/champion`). Die
  Bibliothek erklärt, WARUM sie so aussehen. Weichen Code und Bibliothek
  voneinander ab, gilt der Code, und die Bibliothek ist zu korrigieren.

## Was die Bibliothek nicht ist

Sie ersetzt keine Messung. Das Regelwerk (`CLAUDE.md` §0.9, §6) bleibt:
Eine gemessene Verbesserung gilt als Einbildung, bis sie out-of-sample nach
Kosten überlebt, und „nicht handeln" ist ein zulässiges Ergebnis. Was die
Bibliothek ändert, ist die Frage, WOMIT gemessen wird — und dass die
Antwort „nichts" nicht das Ende der Suche ist, sondern ein Befund, der die
nächste Vorregistrierung schärft.
